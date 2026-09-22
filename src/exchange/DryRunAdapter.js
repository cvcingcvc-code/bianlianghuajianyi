const { EventEmitter } = require('node:events');
const { ExchangeAdapter } = require('./ExchangeAdapter');
const { assertSymbol } = require('../minimal/contracts');
class DryRunAdapter extends ExchangeAdapter {
  constructor({ balance = 10000, now = Date.now, staleMs = 15000 } = {}) {
    super(); this.mode = 'DRY_RUN'; this.now = now; this.staleMs = staleMs;
    this.wallet = balance; this.initial = balance; this.peak = balance; this.maxDrawdown = 0;
    this.positions = new Map(); this.market = new Map(); this.events = new EventEmitter();
    this.running = false; this.lastMessageAt = null; this.day = null; this.dayStart = balance;
    this.realizedPnl = 0; this.pending = new Map(); this.fills = [];
  }
  getMarketData(symbol) {
    assertSymbol(symbol);
    return this.market.get(symbol) || { symbol, price: null, candles: [], source: 'OFFICIAL_ARCHIVE_REPLAY', marketTime: null };
  }
  getPositions() { return [...this.positions.values()].map(p => ({ ...p })); }
  getPendingOrders() { return [...this.pending.values()].map(p => structuredClone(p)); }
  getAccountState() {
    const unrealized = this.getPositions().reduce((sum, p) => sum + ((this.market.get(p.symbol)?.price ?? p.entryPrice) - p.entryPrice) * p.quantity, 0);
    const equity = this.wallet + unrealized;
    this.peak = Math.max(this.peak, equity);
    this.maxDrawdown = Math.max(this.maxDrawdown, (this.peak - equity) / this.peak * 100);
    return { status: 'available', totalWalletBalance: this.wallet, equity, dailyPnl: equity - this.dayStart,
      realizedPnl: this.realizedPnl, maxDrawdown: this.maxDrawdown, openPositions: this.positions.size,
      day: this.day, simulated: true };
  }
  getConnectionStatus() {
    return { status: !this.running ? 'DISCONNECTED' : this.lastMessageAt === null || this.now() - this.lastMessageAt > this.staleMs ? 'STALE' : 'CONNECTED',
      lastMessageAt: this.lastMessageAt, source: 'OFFICIAL_ARCHIVE_REPLAY', transport: 'local replay', userData: 'NOT_REQUIRED' };
  }
  subscribeMarketData(listener) { this.events.on('market', listener); return () => this.events.off('market', listener); }
  executeOrder(order) {
    assertSymbol(order.symbol);
    if (!['OPEN', 'CLOSE'].includes(order.action) || !Number.isFinite(order.quantity) || order.quantity <= 0) throw new Error('Invalid dry-run order');
    if (order.action === 'CLOSE' && !this.positions.has(order.symbol)) throw new Error('Cannot close missing position');
    if (order.action === 'CLOSE' && order.quantity !== this.positions.get(order.symbol).quantity) throw new Error('Close quantity must match position');
    if (this.pending.has(order.symbol)) throw new Error('Order already pending');
    this.pending.set(order.symbol, structuredClone(order));
    return { status: 'QUEUED', mode: this.mode, reason: 'Fill at next 4h bar open', fill: null };
  }
  settleOrder(order, basePrice, timestamp, details = {}) {
    const { symbol, action } = order;
    const position = this.positions.get(symbol);
    if (action === 'CLOSE' && !position) { this.pending.delete(symbol); return; }
    const quantity = action === 'CLOSE' ? position.quantity : order.quantity;
    const price = basePrice * (action === 'OPEN' ? 1.0002 : 0.9998);
    const fee = quantity * price * 0.0004;
    let pnl = -fee;
    if (action === 'OPEN') {
      this.positions.set(symbol, { symbol, entryPrice: price, quantity, leverage: order.leverage,
        stopLossPrice: order.stopLossPrice, takeProfitPrice: order.takeProfitPrice });
    } else {
      pnl += (price - position.entryPrice) * quantity;
      this.positions.delete(symbol);
      this.pending.delete(symbol);
    }
    this.wallet += pnl; this.realizedPnl += pnl;
    const fill = { status: 'FILLED', mode: this.mode, symbol, price, quantity, fee, pnl, timestamp, action, ...details };
    this.fills.push(fill); if (this.fills.length > 100) this.fills.shift();
    this.events.emit('fill', { order, fill });
  }
  checkProtection(symbol, candle) {
    const position = this.positions.get(symbol);
    if (!position) return;
    const { stopLossPrice, takeProfitPrice, quantity } = position;
    const stop = Number.isFinite(stopLossPrice) && stopLossPrice > 0 && candle.low <= stopLossPrice;
    const take = Number.isFinite(takeProfitPrice) && takeProfitPrice > 0 && candle.high >= takeProfitPrice;
    if (!stop && !take) return;
    // OHLC cannot establish intrabar ordering: always prefer the stop when both touch.
    const exitReason = stop ? 'STOP_LOSS' : 'TAKE_PROFIT';
    const intrabarAmbiguous = stop && take;
    const reason = intrabarAmbiguous ? 'STOP_LOSS_AMBIGUOUS_BAR' : exitReason;
    const gap = stop ? candle.open <= stopLossPrice : candle.open >= takeProfitPrice;
    const basePrice = gap ? candle.open : stop ? stopLossPrice : takeProfitPrice;
    // Non-gap timestamp denotes bar-end detection, not a fabricated intrabar fill time.
    const timestamp = gap ? candle.openTime : candle.closeTime;
    const order = { symbol, action: 'CLOSE', side: 'SELL', quantity,
      signal: { symbol, direction: 'CLOSE', timestamp: candle.closeTime, reason } };
    this.settleOrder(order, basePrice, timestamp, { exitReason, intrabarAmbiguous, reason,
      timestampBasis: gap ? 'BAR_OPEN' : 'BAR_CLOSE_DETECTION' });
  }
  ingest(symbol, candle, { warmup = false } = {}) {
    assertSymbol(symbol);
    if (![candle.open, candle.high, candle.low, candle.close].every(n => Number.isFinite(n) && n > 0) || !Number.isFinite(candle.openTime) || !Number.isFinite(candle.closeTime)) throw new Error('Invalid candle');
    const previous = this.market.get(symbol);
    if (previous && candle.openTime <= previous.candles.at(-1).openTime) throw new Error('Duplicate or unordered candle');
    this.running = true; this.lastMessageAt = this.now();
    const day = new Date(candle.openTime).toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; this.dayStart = this.getAccountState().equity; this.realizedPnl = 0; }
    const order = this.pending.get(symbol);
    if (order && candle.openTime > order.signal.timestamp) {
      this.pending.delete(symbol);
      this.settleOrder(order, candle.open, candle.openTime);
    }
    // Orders queued on the previous close execute at this open before intrabar checks.
    // Newly filled positions are protected immediately, but queued entries are not positions.
    this.checkProtection(symbol, candle);
    this.market.set(symbol, { symbol, price: candle.close, candles: [...(previous?.candles || []), candle].slice(-60),
      source: 'OFFICIAL_ARCHIVE_REPLAY', marketTime: candle.closeTime });
    this.getAccountState();
    this.events.emit('market', { symbol, candle, warmup });
  }
  stop() { this.running = false; this.pending.clear(); }
}
module.exports = { DryRunAdapter };

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
    if (this.pending.has(order.symbol)) throw new Error('Order already pending');
    this.pending.set(order.symbol, structuredClone(order));
    return { status: 'QUEUED', mode: this.mode, reason: 'Fill at next 4h bar open', fill: null };
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
      const price = candle.open * (order.action === 'OPEN' ? 1.0002 : 0.9998);
      const fee = order.quantity * price * 0.0004;
      let pnl = -fee;
      if (order.action === 'OPEN') {
        this.positions.set(symbol, { symbol, entryPrice: price, quantity: order.quantity, leverage: order.leverage,
          stopLossPrice: order.stopLossPrice, takeProfitPrice: order.takeProfitPrice });
      } else {
        const p = this.positions.get(symbol);
        if (!p) throw new Error('Cannot close missing position');
        pnl += (price - p.entryPrice) * p.quantity; this.positions.delete(symbol);
      }
      this.wallet += pnl; this.realizedPnl += pnl;
      const fill = { status: 'FILLED', mode: this.mode, symbol, price, quantity: order.quantity, fee, pnl, timestamp: candle.openTime, action: order.action };
      this.fills.push(fill); if (this.fills.length > 100) this.fills.shift();
      this.events.emit('fill', { order, fill });
    }
    this.market.set(symbol, { symbol, price: candle.close, candles: [...(previous?.candles || []), candle].slice(-60),
      source: 'OFFICIAL_ARCHIVE_REPLAY', marketTime: candle.closeTime });
    this.getAccountState();
    this.events.emit('market', { symbol, candle, warmup });
  }
  stop() { this.running = false; this.pending.clear(); }
}
module.exports = { DryRunAdapter };

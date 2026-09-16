const { createHmac } = require('node:crypto');
const { ExchangeAdapter } = require('./ExchangeAdapter');
const { SYMBOLS, assertSymbol } = require('../minimal/contracts');
const { ReliableSocket } = require('../market/reliableSocket');
const { UserDataLifecycle } = require('./userDataLifecycle');
// Constants are deliberately not environment-configurable. No production order endpoint exists here.
const REST = 'https://demo-fapi.binance.com';
const STREAM = 'wss://demo-fstream.binance.com';
class TestnetAdapter extends ExchangeAdapter {
  constructor({ apiKey = '', secretKey = '', log = () => {}, fetchImpl = fetch, socketFactory } = {}) {
    super(); Object.assign(this, { apiKey, secretKey, log, fetchImpl, socketFactory });
    this.mode = 'TESTNET_VALIDATION'; this.market = new Map(); this.sockets = new Map(); this.listeners = new Set();
    this.account = { status: 'unavailable', equity: null, totalWalletBalance: 0, dailyPnl: null, maxDrawdown: null, openPositions: null, simulated: false };
    this.positions = []; this.userDataStatus = 'NOT_STARTED';
    this.userData = new UserDataLifecycle({ request: method => this.request('/fapi/v1/listenKey', {}, { method, keyOnly: true }),
      onUpdate: () => { void this.refreshAccount(); }, socketFactory, log });
  }
  async request(path, params = {}, { signed = false, method = 'GET', keyOnly = false } = {}) {
    const allowed = { '/fapi/v1/klines': 'GET', '/fapi/v3/account': 'GET', '/fapi/v3/positionRisk': 'GET', '/fapi/v1/order/test': 'POST' };
    if (!(path === '/fapi/v1/listenKey' && keyOnly && ['POST', 'PUT', 'DELETE'].includes(method)) && allowed[path] !== method) throw new Error('Testnet endpoint not allowed');
    const query = new URLSearchParams(params);
    if (keyOnly && !this.apiKey) throw new Error('Testnet credentials unavailable');
    if (signed) {
      if (!this.apiKey || !this.secretKey) throw new Error('Testnet credentials unavailable');
      query.set('timestamp', String(Date.now())); query.set('recvWindow', '5000');
      query.set('signature', createHmac('sha256', this.secretKey).update(query.toString()).digest('hex'));
    }
    const response = await this.fetchImpl(`${REST}${path}?${query}`, { method, redirect: 'error',
      headers: signed || keyOnly ? { 'X-MBX-APIKEY': this.apiKey } : {}, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Testnet HTTP ${response.status}`);
    const body = path === '/fapi/v1/listenKey' && method === 'DELETE' ? {} : await response.json();
    if (body.code < 0) throw new Error(`Testnet code ${body.code}`);
    return body;
  }
  async start() {
    this.stopped = false;
    for (const symbol of SYMBOLS) {
      try {
        const rows = await this.request('/fapi/v1/klines', { symbol, interval: '4h', limit: '61' });
        const candles = rows.filter(r => Number(r[6]) < Date.now()).map(r => ({ openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]), closeTime: Number(r[6]) }));
        this.market.set(symbol, { symbol, price: candles.at(-1)?.close ?? null, candles, marketTime: candles.at(-1)?.closeTime ?? null, source: 'BINANCE_TESTNET' });
        for (const candle of candles) for (const listener of this.listeners) listener({ symbol, candle, warmup: true });
      } catch { this.log({ level: 'error', component: 'testnet', event: 'warmup_failed', symbol }); }
      if (this.stopped) return;
      const socket = new ReliableSocket({ url: `${STREAM}/ws/${symbol.toLowerCase()}@kline_4h`, log: this.log, socketFactory: this.socketFactory,
        onMessage: data => {
          const k = data.k;
          if (data.s !== symbol || !k || !Number.isFinite(Number(k.c)) || Number(k.c) <= 0 || !Number.isFinite(data.E) || Math.abs(Date.now() - data.E) > 15000) return false;
          const market = this.getMarketData(symbol);
          market.price = Number(k.c); market.marketTime = data.E; this.market.set(symbol, market);
          if (k.x && Number(k.t) > (market.candles.at(-1)?.openTime ?? 0)) {
            const candle = { openTime: Number(k.t), open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c), volume: Number(k.v), closeTime: Number(k.T) };
            const gap = market.candles.length && candle.openTime !== market.candles.at(-1).openTime + 14400000;
            // After a missing bar, fail closed until a restart reloads the completed-bar warmup.
            if (gap) { market.continuity = 'GAP'; this.log({ level: 'error', component: 'testnet', event: 'candle_gap', symbol }); return false; }
            market.candles = [...market.candles, candle].slice(-60);
            for (const listener of this.listeners) listener({ symbol, candle, warmup: false });
          }
          return true;
        } });
      this.sockets.set(symbol, socket); socket.start();
    }
    // User/account lifecycle is separate from public market sockets, with REST reconciliation.
    await this.refreshAccount();
    if (this.stopped) return;
    if (this.apiKey && this.secretKey) await this.userData.start();
    if (this.stopped) return;
    this.accountTimer = setInterval(() => this.refreshAccount(), 30000); this.accountTimer.unref?.();
  }
  async refreshAccount() {
    if (this.syncing || this.stopped) return;
    if (!this.apiKey || !this.secretKey) { this.userDataStatus = 'UNAVAILABLE'; return; }
    this.syncing = true;
    try {
      const a = await this.request('/fapi/v3/account', {}, { signed: true });
      const positions = await this.request('/fapi/v3/positionRisk', {}, { signed: true });
      this.positions = positions.filter(p => Number(p.positionAmt) !== 0).map(p => ({ symbol: p.symbol, quantity: Math.abs(Number(p.positionAmt)), entryPrice: Number(p.entryPrice), leverage: 1 }));
      this.account = { status: 'available', totalWalletBalance: Number(a.totalWalletBalance), equity: Number(a.totalMarginBalance),
        dailyPnl: null, maxDrawdown: null, openPositions: this.positions.length, simulated: false, updatedAt: Date.now() };
      this.userDataStatus = 'REST_SYNCED';
    } catch { this.account.status = 'unavailable'; this.account.totalWalletBalance = 0; this.userDataStatus = 'UNAVAILABLE';
      this.log({ level: 'error', component: 'testnet_account', event: 'sync_failed' }); }
    finally { this.syncing = false; }
  }
  getMarketData(symbol) { assertSymbol(symbol); return this.market.get(symbol) || { symbol, price: null, candles: [], marketTime: null, source: 'BINANCE_TESTNET' }; }
  getAccountState() { return { ...this.account }; }
  getPositions() { return this.positions.map(p => ({ ...p })); }
  subscribeMarketData(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  getConnectionStatus() {
    const streams = Object.fromEntries(SYMBOLS.map(s => [s, this.sockets.get(s)?.getStatus() || { status: 'DISCONNECTED', lastMessageAt: null }]));
    const states = Object.values(streams);
    return { status: states.some(s => s.status === 'DISCONNECTED') ? 'DISCONNECTED' : states.some(s => s.status === 'STALE') || [...this.market.values()].some(m => m.continuity === 'GAP') ? 'STALE' : 'CONNECTED',
      lastMessageAt: states.every(s => s.lastMessageAt !== null) ? Math.min(...states.map(s => s.lastMessageAt)) : null,
      source: 'BINANCE_TESTNET', transport: 'WebSocket', streams, userData: { account: this.userDataStatus, ...this.userData.getStatus() } };
  }
  async executeOrder(order) {
    assertSymbol(order.symbol);
    if (!['OPEN', 'CLOSE'].includes(order.action) || !Number.isFinite(order.quantity) || order.quantity <= 0) throw new Error('Invalid testnet order');
    await this.request('/fapi/v1/order/test', { symbol: order.symbol, side: order.action === 'OPEN' ? 'BUY' : 'SELL', type: 'MARKET', quantity: String(order.quantity), ...(order.action === 'CLOSE' ? { reduceOnly: 'true' } : {}) }, { signed: true, method: 'POST' });
    return { status: 'VALIDATED_ONLY', mode: this.mode, reason: 'Testnet order/test accepted; no fill or position created', fill: null };
  }
  stop() { this.stopped = true; clearInterval(this.accountTimer); for (const socket of this.sockets.values()) socket.stop(); this.userDataStatus = 'STOPPED'; void this.userData.stop(); }
}
module.exports = { TestnetAdapter };

const fs = require('node:fs');
const { H4, M15, sha, guard } = require('./data');
const { COSTS } = require('../research/strategies/ethPredictionV2');
class Simulator {
  constructor({ scenario = 'BASE', identity = 'test', complete = true, state = null } = {}) {
    if (!COSTS[scenario]) throw new Error('Unknown costs');
    this.cost = COSTS[scenario];
    this.s = state ? structuredClone(state) : { schema: 1, identity, scenario, initial: 10000, cash: 10000, peak: 10000,
      maxDrawdown: 0, position: null, pending: null, lastTime: null, lastPrice: null, lastClose: null,
      ledger: [], trades: [], orders: [], seen: [], fundingSeen: [], complete, fundingProblems: [],
      state: 'IDLE', bars: 0, exposedBars: 0, decision: { action: 'WAIT', reason: 'NOT_STARTED' } };
    if (this.s.identity !== identity || this.s.scenario !== scenario) throw new Error('Snapshot identity mismatch');
    this.assertLedger();
  }
  equity(price = this.s.lastPrice) { const p = this.s.position; return this.s.cash + (p && Number.isFinite(price) ? p.sign * p.quantity * (price - p.entryPrice) : 0); }
  post(entry) { this.s.cash += entry.cashDelta; this.s.ledger.push({ seq: this.s.ledger.length + 1, ...entry, cash: this.s.cash }); }
  assertLedger() {
    let cash = this.s.initial;
    this.s.ledger.forEach((e, i) => { cash += e.cashDelta; if (e.seq !== i + 1 || !Number.isFinite(cash) || Math.abs(cash - e.cash) > 1e-7) throw new Error('Ledger corruption'); });
    if (Math.abs(cash - this.s.cash) > 1e-7 || (this.s.position && !(this.s.position.quantity > 0))) throw new Error('Account mismatch');
    return true;
  }
  queue(decision) {
    this.s.decision = decision;
    if (this.s.state === 'COMPLETED' || decision.action !== 'OPEN') return false;
    guard(decision.time);
    if (!['LONG', 'SHORT'].includes(decision.side)) throw new Error('Invalid direction');
    const id = `${decision.time}:${decision.side}`;
    if (this.s.seen.includes(id) || this.s.pending) return false;
    this.s.seen.push(id);
    const p = this.s.position;
    if (p?.side === decision.side) return false;
    this.s.pending = { ...decision, id, action: p ? 'CLOSE' : 'OPEN', reason: p ? 'REVERSE_SIGNAL' : decision.reason || 'MODEL_SIGNAL' };
    this.s.orders.push({ ...this.s.pending, status: 'QUEUED' }); return true;
  }
  open(order, c) {
    const record = this.s.orders.find(o => o.id === order.id);
    if (this.s.position || !(this.s.cash > 0) || this.s.maxDrawdown >= 0.1) { if (record) record.status = 'REJECTED_AT_EXECUTION'; return; }
    if (record) record.status = 'FILLED';
    const sign = order.side === 'LONG' ? 1 : -1, base = c.open;
    const price = base * (1 + sign * this.cost.slip), quantity = 0.25 * this.s.cash / price;
    const fee = quantity * price * this.cost.fee, slippage = Math.abs(price - base) * quantity;
    this.s.position = { id: order.id, side: order.side, sign, quantity, entryPrice: price, entryBase: base,
      entryTime: c.openTime, entryFee: fee, slippage, funding: 0, regime: order.regime || 'RANGE',
      stopLossPrice: price * (1 - sign * 0.01), takeProfitPrice: price * (1 + sign * 0.02), expires: c.openTime + H4 };
    this.post({ type: 'FILL', action: 'OPEN', orderId: order.id, side: order.side, time: c.openTime, quantity, price, basePrice: base,
      fee, slippage, cashDelta: -fee, reason: 'NEXT_BAR_OPEN' });
  }
  close(base, time, reason, ambiguous = false, basis = 'BAR_OPEN') {
    const p = this.s.position;
    if (!p) return;
    const price = base * (1 - p.sign * this.cost.slip), fee = p.quantity * price * this.cost.fee;
    const slippage = Math.abs(price - base) * p.quantity, pnl = p.sign * p.quantity * (price - p.entryPrice);
    const gross = p.sign * p.quantity * (base - p.entryBase);
    this.s.trades.push({ side: p.side, regime: p.regime, entryTime: p.entryTime, exitTime: time, quantity: p.quantity,
      entryPrice: p.entryPrice, exitPrice: price, gross, slippage: p.slippage + slippage, fees: p.entryFee + fee, funding: p.funding,
      net: pnl - p.entryFee - fee + p.funding, heldMs: time - p.entryTime, reason, intrabarAmbiguous: ambiguous });
    if (this.s.pending) {
      const record = this.s.orders.find(o => o.id === this.s.pending.id);
      if (record) record.status = reason === 'REVERSE_SIGNAL' ? 'FILLED' : 'CANCELLED_POSITION_CLOSED';
    }
    this.s.position = null; this.s.pending = null;
    this.post({ type: 'FILL', action: 'CLOSE', orderId: p.id, side: p.side, quantity: p.quantity, time, price, basePrice: base,
      fee, slippage, gross, cashDelta: pnl - fee, reason, intrabarAmbiguous: ambiguous, timestampBasis: basis });
  }
  protection(c) {
    const p = this.s.position;
    if (!p) return null;
    const stop = p.sign === 1 ? c.low <= p.stopLossPrice : c.high >= p.stopLossPrice;
    const take = p.sign === 1 ? c.high >= p.takeProfitPrice : c.low <= p.takeProfitPrice;
    if (!stop && !take) return null;
    const level = stop ? p.stopLossPrice : p.takeProfitPrice;
    const gap = p.sign === 1 ? stop ? c.open <= level : c.open >= level : stop ? c.open >= level : c.open <= level;
    return { base: gap ? c.open : level, time: gap ? c.openTime : c.closeTime, gap, ambiguous: stop && take,
      reason: stop ? take ? 'STOP_LOSS_AMBIGUOUS_BAR' : 'STOP_LOSS' : 'TAKE_PROFIT' };
  }
  funding(event, ambiguous = false) {
    if (this.s.fundingSeen.includes(event.time)) return;
    this.s.fundingSeen.push(event.time);
    const p = this.s.position;
    if (!p) return;
    if (!(event.markPrice > 0) || !Number.isFinite(event.rate)) {
      this.s.complete = false; this.s.fundingProblems.push(event.time);
      this.post({ type: 'FUNDING_MISSING', time: event.time, cashDelta: 0, amount: null, reason: 'NET_VALIDATION_INCOMPLETE' }); return;
    }
    const amount = -p.sign * p.quantity * event.markPrice * event.rate;
    const delta = ambiguous ? Math.min(0, amount) : amount;
    p.funding += delta;
    this.post({ type: 'FUNDING', time: event.time, rate: event.rate, markPrice: event.markPrice,
      markTime: event.markTime, amount: delta, excludedUncertainCredit: amount - delta, intrabarAmbiguous: ambiguous, cashDelta: delta });
  }
  step(c, events = []) {
    guard(c.openTime); guard(c.closeTime);
    if (this.s.state === 'COMPLETED' || (this.s.lastTime !== null && c.openTime <= this.s.lastTime)) return false;
    if (this.s.lastTime !== null && c.openTime !== this.s.lastTime + M15) throw new Error('Replay gap');
    if (c.closeTime !== c.openTime + M15 - 1 || ![c.open, c.high, c.low, c.close].every(Number.isFinite) || c.low <= 0 || c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)) throw new Error('Invalid execution candle');
    if (events.some(e => e.time < c.openTime || e.time > c.closeTime)) throw new Error('Funding outside candle');
    this.s.state = 'RUNNING';
    let exposed = !!this.s.position, closed = false;
    for (const e of events.filter(e => e.time === c.openTime)) this.funding(e);
    let hit = this.protection(c);
    if (hit?.gap) { this.close(hit.base, hit.time, hit.reason, hit.ambiguous); closed = true; }
    else if (this.s.position && (c.openTime >= this.s.position.expires || (this.s.pending?.action === 'CLOSE' && this.s.pending.time < c.openTime))) {
      this.close(c.open, c.openTime, c.openTime >= this.s.position.expires ? 'TIMEOUT' : 'REVERSE_SIGNAL'); closed = true;
    }
    const pending = this.s.pending;
    if (!closed && pending?.action === 'OPEN' && pending.time < c.openTime) { this.s.pending = null; this.open(pending, c); }
    exposed ||= !!this.s.position;
    hit = this.protection(c);
    if (hit?.gap) { this.close(hit.base, hit.time, hit.reason, hit.ambiguous); closed = true; }
    for (const e of events.filter(e => e.time > c.openTime)) this.funding(e, !!hit && !hit.gap);
    if (hit && !hit.gap && this.s.position) this.close(hit.base, hit.time, hit.reason, hit.ambiguous, 'BAR_CLOSE_DETECTION');
    this.s.lastTime = c.openTime; this.s.lastClose = c.closeTime; this.s.lastPrice = c.close;
    this.s.bars++; if (exposed) this.s.exposedBars++;
    const equity = this.equity(); this.s.peak = Math.max(this.s.peak, equity);
    this.s.maxDrawdown = Math.max(this.s.maxDrawdown, (this.s.peak - equity) / this.s.peak);
    return true;
  }
  finish() {
    if (this.s.state === 'COMPLETED') return;
    if (this.s.position) this.close(this.s.lastPrice, this.s.lastClose, 'END_OF_REPLAY', false, 'FINAL_CLOSE');
    if (this.s.pending) { const record = this.s.orders.find(o => o.id === this.s.pending.id); if (record) record.status = 'CANCELLED_END_OF_REPLAY'; }
    this.s.pending = null; this.s.state = 'COMPLETED';
    this.s.maxDrawdown = Math.max(this.s.maxDrawdown, (this.s.peak - this.equity()) / this.s.peak);
    this.assertLedger();
  }
  snapshot(file) {
    this.assertLedger(); const payload = JSON.stringify(this.s), temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ sha256: sha(payload), payload })); fs.renameSync(temp, file);
  }
  static restore(file, options) {
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (sha(envelope.payload) !== envelope.sha256) throw new Error('Snapshot checksum mismatch');
    return new Simulator({ ...options, state: JSON.parse(envelope.payload) });
  }
}
module.exports = { Simulator };

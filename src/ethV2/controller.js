const fs = require('node:fs');
const { Simulator } = require('./simulator');
const { decide } = require('../research/strategies/ethPredictionV2');
class Controller {
  constructor({ data, predictions, sessionFile, identity }) {
    this.candles = data.candles.filter(c => c.openTime >= Date.UTC(2023, 0, 1));
    this.forecasts = new Map(predictions.map(f => [f.time, f])); this.data = data; this.sessionFile = sessionFile;
    this.sim = fs.existsSync(sessionFile) ? Simulator.restore(sessionFile, { identity }) : new Simulator({ identity, complete: data.funding.complete });
    this.index = this.sim.s.bars; this.timer = null; this.error = null;
    this.events = new Map();
    for (const e of data.funding.events) { const key = Math.floor(e.time / 900000) * 900000; if (!this.events.has(key)) this.events.set(key, []); this.events.get(key).push(e); }
    if (this.sim.s.state === 'RUNNING') this.sim.s.state = 'PAUSED';
    this.latest = predictions.filter(f => f.time <= (this.sim.s.lastClose ?? 0)).at(-1) || null;
    this.save();
  }
  save() { this.sim.snapshot(this.sessionFile); }
  advance(count = 96) {
    if (this.sim.s.state === 'COMPLETED' || this.error) return;
    for (let i = 0; i < count && this.index < this.candles.length; i++) {
      const c = this.candles[this.index];
      this.sim.step(c, this.events.get(c.openTime) || []);
      const f = this.forecasts.get(c.closeTime);
      if (f) { this.latest = f; this.sim.queue(decide(f, { complete: this.data.funding.complete, equity: this.sim.equity(), drawdown: this.sim.s.maxDrawdown })); }
      this.index++;
    }
    if (this.index === this.candles.length) { this.sim.finish(); this.stopTimer(); }
    else if (!this.timer) this.sim.s.state = 'PAUSED';
    this.save();
  }
  start() {
    if (this.timer || this.sim.s.state === 'COMPLETED' || this.error) return;
    this.sim.s.state = 'RUNNING';
    this.timer = setInterval(() => { try { this.advance(); } catch (e) { this.error = e.message; this.stopTimer(); this.sim.s.state = 'ERROR'; } }, 250);
    this.save();
  }
  stopTimer() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  pause() { this.stopTimer(); if (!['COMPLETED', 'ERROR'].includes(this.sim.s.state)) this.sim.s.state = 'PAUSED'; this.save(); }
  status() {
    const s = this.sim.s, p = s.position;
    const sum = (type, key) => s.ledger.filter(e => e.type === type).reduce((a, e) => a + (e[key] || 0), 0);
    return { state: s.state, error: this.error, marketTime: s.lastClose, progress: this.index / this.candles.length,
      processed: this.index, total: this.candles.length, forecast: this.latest, decision: s.decision, position: p,
      cash: s.cash, equity: this.sim.equity(), realized: s.trades.reduce((a, t) => a + t.net, 0),
      unrealized: p ? p.sign * p.quantity * (s.lastPrice - p.entryPrice) : 0, fees: sum('FILL', 'fee'), slippage: sum('FILL', 'slippage'),
      funding: s.complete ? sum('FUNDING', 'cashDelta') : null, knownFunding: sum('FUNDING', 'cashDelta'), netComplete: s.complete,
      maxDrawdown: s.maxDrawdown, trades: s.trades.length, lastExit: s.trades.at(-1) || null,
      fills: s.ledger.filter(e => e.type === 'FILL').slice(-12), mode: 'UNVALIDATED_HISTORICAL_DIAGNOSTIC', validatedAutomaticOpening: false };
  }
}
module.exports = { Controller };

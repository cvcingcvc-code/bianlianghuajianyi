const { STEP, START, END } = require('./archive');
const COSTS = Object.freeze({ BASE: Object.freeze({ fee: 0.0004, slip: 0.0002 }), STRESS: Object.freeze({ fee: 0.0006, slip: 0.0005 }) });

function planGrid(snapshot) {
  const short = snapshot.forecasts['30m'], week = snapshot.forecasts['1w'];
  const wait = reason => ({ action: 'WAIT', reason, asOf: snapshot.asOf });
  if ([short, week].some(f => f.status !== 'AVAILABLE_UNCALIBRATED')) return wait('INSUFFICIENT_MATURE_LABELS');
  const p = short.estimate.upProbability, w = week.estimate.upProbability;
  const side = p >= 0.6 && w >= 0.6 ? 'LONG' : p <= 0.4 && w <= 0.4 ? 'SHORT' : null;
  if (!side) return wait('HORIZONS_DISAGREE_OR_WEAK');
  const lower = Math.min(snapshot.price, short.estimate.lowerPrice), upper = Math.max(snapshot.price, short.estimate.upperPrice);
  const ratio = (upper / lower) ** 0.25;
  if (![lower, upper, ratio].every(Number.isFinite) || lower <= 0 || ratio - 1 <= 2 * (COSTS.STRESS.fee + COSTS.STRESS.slip)) return wait('GRID_SPACING_BELOW_STRESS_COST');
  return { action: 'OPEN', side, asOf: snapshot.asOf, expiresAt: snapshot.asOf + 2 * STEP,
    lower, upper, levels: Array.from({ length: 5 }, (_, i) => lower * ratio ** i), spacing: ratio - 1 };
}

// A self-contained virtual account: no exchange adapter or credential access.
// Results exclude funding and are explicitly NOT a net-profit validation.
class PaperGrid {
  constructor({ capital = 1000, scenario = 'BASE' } = {}) {
    if (!Number.isFinite(capital) || capital <= 0 || !COSTS[scenario]) throw new Error('Invalid paper account');
    Object.assign(this, { initial: capital, cash: capital, scenario, costs: COSTS[scenario], active: null, pending: null,
      lastTime: null, fills: 0, opened: 0, closed: 0, fees: 0, peak: capital, maxDrawdown: 0, equity: capital, events: [] });
  }
  event(type, time, extra = {}) {
    this.events.push({ type, time, ...extra }); if (this.events.length > 100) this.events.shift();
  }
  mark(price) {
    const unrealized = this.active ? this.active.lots.reduce((sum, lot) => sum + (lot.entry === null ? 0 : this.active.sign * lot.quantity * (price - lot.entry)), 0) : 0;
    this.equity = this.cash + unrealized; this.peak = Math.max(this.peak, this.equity);
    this.maxDrawdown = Math.max(this.maxDrawdown, (this.peak - this.equity) / this.peak);
  }
  fill(lot, price, entering, time) {
    const sign = this.active.sign;
    const execution = price * (1 + (entering ? sign : -sign) * this.costs.slip);
    const fee = lot.quantity * execution * this.costs.fee;
    this.cash -= fee; this.fees += fee; this.fills++;
    if (entering) lot.entry = execution;
    else { this.cash += sign * lot.quantity * (execution - lot.entry); lot.entry = null; }
    this.event(entering ? 'ENTRY' : 'EXIT', time, { side: this.active.side, price: execution, quantity: lot.quantity });
  }
  close(price, time, reason) {
    if (!this.active) return;
    for (const lot of this.active.lots) if (lot.entry !== null) this.fill(lot, price, false, time);
    this.event('CLOSE_GRID', time, { reason }); this.closed++; this.active = null;
  }
  advance(bar) {
    if (!Number.isInteger(bar.openTime) || bar.openTime < START || bar.openTime % STEP || bar.closeTime >= END) throw new Error('Invalid timestamp or FINAL HOLDOUT IS LOCKED');
    if (this.lastTime !== null && bar.openTime !== this.lastTime + STEP) throw new Error('Paper bars must be continuous');
    if (![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) || bar.low <= 0 || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) || bar.closeTime !== bar.openTime + STEP - 1) throw new Error('Invalid paper candle');
    this.lastTime = bar.openTime;
    if (this.pending && bar.openTime <= this.pending.asOf) throw new Error('Next-bar execution required');
    if (this.active && (this.pending?.action === 'CLOSE' || bar.openTime > this.active.expiresAt)) this.close(bar.open, bar.openTime, 'SIGNAL_OR_EXPIRY');
    if (!this.active && this.pending?.action === 'OPEN') {
      const plan = this.pending;
      if (bar.openTime <= plan.expiresAt && bar.open > plan.lower && bar.open < plan.upper && this.cash > 0) {
        const sign = plan.side === 'LONG' ? 1 : -1;
        const quantity = this.cash * 0.25 / 4 / (plan.upper * (1 + this.costs.slip) * (1 + this.costs.fee));
        const lots = Array.from({ length: 4 }, (_, i) => ({ quantity, entry: null,
          buy: plan.levels[i], sell: plan.levels[i + 1] }));
        this.active = { ...plan, sign, lots }; this.opened++;
        this.event('OPEN_GRID', bar.openTime, { side: plan.side });
      } else this.event('SKIP_GAP_OR_EXPIRED', bar.openTime);
    }
    this.pending = null;
    const a = this.active;
    if (a) {
      // Conservative convention: range escape closes existing lots before any new fills.
      if (bar.low <= a.lower || bar.high >= a.upper) {
        const price = bar.open <= a.lower || bar.open >= a.upper ? bar.open :
          (a.side === 'LONG' ? (bar.low <= a.lower ? a.lower : a.upper) : (bar.high >= a.upper ? a.upper : a.lower));
        this.close(price, bar.openTime, 'RANGE_ESCAPE_INTRABAR');
      } else {
        for (const lot of a.lots) {
          if (lot.entry !== null) {
            if (a.sign === 1 && bar.high >= lot.sell) this.fill(lot, Math.max(bar.open, lot.sell), false, bar.openTime);
            else if (a.sign === -1 && bar.low <= lot.buy) this.fill(lot, Math.min(bar.open, lot.buy), false, bar.openTime);
          } else {
            if (a.sign === 1 && bar.low <= lot.buy) this.fill(lot, Math.min(bar.open, lot.buy), true, bar.openTime);
            else if (a.sign === -1 && bar.high >= lot.sell) this.fill(lot, Math.max(bar.open, lot.sell), true, bar.openTime);
          }
        }
      }
    }
    this.mark(bar.close);
  }
  decide(snapshot) {
    if (snapshot.asOf !== this.lastTime + STEP - 1) throw new Error('Decision must follow this closed bar');
    const plan = planGrid(snapshot);
    if (this.active) {
      if (plan.action !== 'OPEN' || plan.side !== this.active.side || snapshot.asOf >= this.active.expiresAt) this.pending = { action: 'CLOSE', asOf: snapshot.asOf };
    } else if (plan.action === 'OPEN') this.pending = plan;
    return plan;
  }
  summary() {
    return { mode: 'EXPLORATORY_PAPER_ONLY', scenario: this.scenario, initial: this.initial, equityBeforeFunding: this.equity,
      pnlBeforeFunding: this.equity - this.initial, fees: this.fees, funding: 'NOT_INCLUDED', netEdgeValidated: false,
      maxDrawdownBeforeFunding: this.maxDrawdown, gridsOpened: this.opened, gridsClosed: this.closed, fills: this.fills,
      active: this.active, pending: this.pending, recentEvents: this.events };
  }
}
module.exports = { planGrid, PaperGrid, COSTS };

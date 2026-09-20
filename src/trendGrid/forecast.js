const { START, END, STEP } = require('./archive');
const HORIZONS = { '30m': 2, '1w': 672 };
const MIN_SAMPLES = 30;
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
function quantile(sorted, p) {
  const x = (sorted.length - 1) * p, i = Math.floor(x);
  return sorted[i] + (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * (x - i);
}
class Distribution {
  constructor() { this.values = []; this.up = 0; }
  add(x) {
    let lo = 0, hi = this.values.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (this.values[m] < x) lo = m + 1; else hi = m; }
    this.values.splice(lo, 0, x); if (x > 0) this.up++;
  }
  summary(price) {
    const n = this.values.length;
    if (!n) return null;
    const q = p => quantile(this.values, p);
    return { samples: n, upProbability: this.up / n, medianReturn: q(0.5),
      lowerReturn: q(0.1), upperReturn: q(0.9),
      lowerPrice: price * Math.exp(q(0.1)), medianPrice: price * Math.exp(q(0.5)), upperPrice: price * Math.exp(q(0.9)) };
  }
}

// Online update accepts only the next closed bar; no API accepts future labels.
class Forecaster {
  constructor() {
    this.bars = []; this.states = []; this.returns = [];
    this.models = Object.fromEntries(Object.entries(HORIZONS).map(([key, horizon]) => [key,
      { horizon, all: new Distribution(), down: new Distribution(), flat: new Distribution(), up: new Distribution() }]));
  }
  update(bar) {
    const i = this.bars.length, previous = this.bars[i - 1];
    if (!Number.isFinite(bar.close) || bar.close <= 0 || !Number.isInteger(bar.openTime) || bar.openTime % STEP ||
        bar.openTime < START || bar.closeTime >= END || bar.closeTime !== bar.openTime + STEP - 1 ||
        (previous && bar.openTime !== previous.openTime + STEP)) throw new Error('Invalid closed 15m bar or FINAL HOLDOUT IS LOCKED');
    this.bars.push({ ...bar });
    this.returns.push(previous ? Math.log(bar.close / previous.close) : 0);
    let state = null;
    if (i >= 96) {
      const recent = this.returns.slice(i - 95, i + 1);
      const scale = Math.sqrt(mean(recent.map(r => r * r)) * 96);
      const score = scale ? Math.log(bar.close / this.bars[i - 96].close) / scale : 0;
      state = score > 1 ? 'up' : score < -1 ? 'down' : 'flat';
    }
    this.states.push(state);
    const forecasts = {};
    for (const [key, model] of Object.entries(this.models)) {
      const origin = i - model.horizon;
      // Aligned disjoint intervals; endpoint is the bar that just closed.
      if (origin >= 96 && origin % model.horizon === 0) {
        const value = Math.log(bar.close / this.bars[origin].close);
        model.all.add(value); model[this.states[origin]].add(value);
      }
      const estimate = state ? model[state].summary(bar.close) : null;
      const baseline = model.all.summary(bar.close);
      forecasts[key] = { horizonBars: model.horizon, asOf: bar.closeTime,
        targetTime: bar.closeTime + model.horizon * STEP, trend: state,
        status: estimate?.samples >= MIN_SAMPLES ? 'AVAILABLE_UNCALIBRATED' : 'INSUFFICIENT_DATA',
        estimate, baseline };
    }
    return { symbol: 'ETHUSDT', asOf: bar.closeTime, price: bar.close, trend: state, forecasts };
  }
}

function scoreRows(rows, eligible) {
  if (!rows.length) return { count: 0, eligible, availability: 0, pass: false };
  const brier = mean(rows.map(r => (r.p - r.up) ** 2));
  const baselineBrier = mean(rows.map(r => (r.baseP - r.up) ** 2));
  const mae = mean(rows.map(r => Math.abs(r.median - r.actual)));
  const baselineMae = mean(rows.map(r => Math.abs(r.actual)));
  const coverage = mean(rows.map(r => Number(r.actual >= r.low && r.actual <= r.high)));
  return { count: rows.length, eligible, availability: rows.length / eligible, brier, baselineBrier, mae, baselineMae, coverage,
    pass: rows.length >= 20 && rows.length / eligible >= 0.8 && brier < baselineBrier && mae < baselineMae };
}

function evaluate(candles, onSnapshot = () => {}) {
  const model = new Forecaster();
  const rows = { '30m': [], '1w': [] }, eligible = { '30m': {}, '1w': {} };
  let latest;
  for (let i = 0; i < candles.length; i++) {
    latest = model.update(candles[i]); onSnapshot(latest, candles[i], i);
    const year = new Date(latest.asOf).getUTCFullYear();
    if (year < 2023) continue;
    for (const [key, h] of Object.entries(HORIZONS)) {
      if (i % h || i + h >= candles.length) continue;
      eligible[key][year] = (eligible[key][year] || 0) + 1;
      const f = latest.forecasts[key];
      if (f.status === 'INSUFFICIENT_DATA') continue;
      const actual = Math.log(candles[i + h].close / candles[i].close);
      rows[key].push({ year, asOf: latest.asOf, actual, up: Number(actual > 0), p: f.estimate.upProbability,
        baseP: f.baseline.upProbability, median: f.estimate.medianReturn, low: f.estimate.lowerReturn, high: f.estimate.upperReturn });
    }
  }
  const horizons = {};
  for (const key of Object.keys(HORIZONS)) {
    const years = Object.fromEntries([2023, 2024, 2025].map(y => [y, scoreRows(rows[key].filter(r => r.year === y), eligible[key][y] || 0)]));
    const overall = scoreRows(rows[key], Object.values(eligible[key]).reduce((a, b) => a + b, 0));
    horizons[key] = { overall, years, pass: overall.pass && overall.count >= 100 && overall.coverage >= 0.7 && overall.coverage <= 0.9 && Object.values(years).every(y => y.pass) };
  }
  return { latest, horizons, forecastGate: Object.values(horizons).every(h => h.pass) ? 'PASS' : 'FAIL',
    liveEligible: false, scope: '2021-2025 chronological development; not current market or untouched holdout' };
}
module.exports = { Forecaster, evaluate, HORIZONS, MIN_SAMPLES };

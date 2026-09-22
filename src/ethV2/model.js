const { H4, END, guard } = require('./data');
const VERSION = 'eth-v2-ridge-1';
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const sigmoid = x => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
const logit = p => Math.log(Math.max(0.001, p) / Math.max(0.001, 1 - p));
function features(bars, i) {
  if (i < 24) return null;
  guard(bars[i].closeTime);
  const window = bars.slice(i - 23, i + 1), returns = window.map((c, j) => Math.log(c.close / bars[i - 24 + j].close));
  const average = mean(returns), vol = Math.sqrt(mean(returns.map(r => (r - average) ** 2)));
  const volume = mean(bars.slice(i - 5, i + 1).map(c => c.volume));
  const r24 = Math.log(bars[i].close / bars[i - 6].close);
  if (!(volume > 0)) return null;
  const x = [r24, Math.log(bars[i].close / mean(window.map(c => c.close))), vol, bars[i].volume / volume];
  return x.every(Number.isFinite) ? { x, regime: r24 > 0.01 ? 'UP' : r24 < -0.01 ? 'DOWN' : 'RANGE' } : null;
}
function samples(bars) {
  return bars.map((c, i) => {
    const f = features(bars, i);
    if (!f) return null;
    const next = bars[i + 1];
    if (next) { guard(next.closeTime); if (next.closeTime !== c.closeTime + H4) throw new Error('Noncontiguous target'); }
    return { ...f, index: i, time: c.closeTime, targetTime: c.closeTime + H4, price: c.close,
      y: next ? Math.log(next.close / c.close) : null };
  }).filter(Boolean);
}
function solve(matrix, rhs) {
  const a = matrix.map((r, i) => [...r, rhs[i]]), n = rhs.length;
  for (let k = 0; k < n; k++) {
    let pivot = k;
    for (let j = k + 1; j < n; j++) if (Math.abs(a[j][k]) > Math.abs(a[pivot][k])) pivot = j;
    [a[k], a[pivot]] = [a[pivot], a[k]];
    if (Math.abs(a[k][k]) < 1e-12) throw new Error('Singular fit');
    const d = a[k][k]; for (let j = k; j <= n; j++) a[k][j] /= d;
    for (let i = 0; i < n; i++) if (i !== k) { const v = a[i][k]; for (let j = k; j <= n; j++) a[i][j] -= v * a[k][j]; }
  }
  return a.map(r => r[n]);
}
function z(x, model) { return [1, ...x.map((v, j) => Math.max(-5, Math.min(5, (v - model.means[j]) / model.scales[j])))]; }
const location = (x, model) => z(x, model).reduce((s, v, i) => s + v * model.beta[i], 0);
function rawProbability(mu, residuals) {
  let lo = 0, hi = residuals.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (residuals[mid] <= -mu) lo = mid + 1; else hi = mid; }
  return (residuals.length - lo + 1) / (residuals.length + 2);
}
function fit(all, cutoff) {
  guard(cutoff);
  const calibrationStart = cutoff - 180 * 86400000;
  const mature = all.filter(s => s.targetTime < cutoff && Number.isFinite(s.y));
  const train = mature.filter(s => s.targetTime < calibrationStart);
  const calibration = mature.filter(s => s.time >= calibrationStart);
  if (train.length < 2000 || calibration.length < 300) return null;
  const model = { version: VERSION, cutoff, trainEnd: train.at(-1).targetTime, calibrationStart, calibrationEnd: calibration.at(-1).targetTime,
    samples: train.length, calibrationSamples: calibration.length,
    means: [0, 1, 2, 3].map(j => mean(train.map(s => s.x[j]))) };
  model.scales = model.means.map((v, j) => Math.sqrt(mean(train.map(s => (s.x[j] - v) ** 2))) || 1);
  const xx = Array.from({ length: 5 }, (_, i) => Array.from({ length: 5 }, (_, j) => i === j && i ? 1 : 0));
  const xy = Array(5).fill(0);
  for (const s of train) { const x = z(s.x, model); for (let i = 0; i < 5; i++) { xy[i] += x[i] * s.y; for (let j = 0; j < 5; j++) xx[i][j] += x[i] * x[j]; } }
  model.beta = solve(xx, xy);
  model.residuals = train.map(s => s.y - location(s.x, model)).sort((a, b) => a - b);
  const internal = calibration.map(s => ({ x: logit(rawProbability(location(s.x, model), model.residuals)), y: Number(s.y > 0) }));
  let a = 1, b = 0;
  for (let i = 0; i < 200; i++) {
    let ga = 0, gb = 0;
    for (const s of internal) { const error = sigmoid(a * s.x + b) - s.y; ga += error * s.x; gb += error; }
    a -= 0.1 * ga / internal.length; b -= 0.1 * gb / internal.length;
  }
  model.platt = { a, b }; model.unconditional = mean(mature.map(s => Number(s.y > 0)));
  const ys = mature.map(s => s.y).sort((a, b) => a - b);
  model.baselineInterval = [quantile(ys, 0.1), quantile(ys, 0.9)];
  return model;
}
function predict(sample, model) {
  guard(sample.time);
  if (!model || model.cutoff > sample.time || model.calibrationEnd >= model.cutoff || model.trainEnd >= model.calibrationStart) return { status: 'INSUFFICIENT_DATA', time: sample.time, targetTime: sample.targetTime, version: VERSION };
  const mu = location(sample.x, model), rawUp = rawProbability(mu, model.residuals);
  const up = sigmoid(model.platt.a * logit(rawUp) + model.platt.b);
  return { status: 'AVAILABLE', time: sample.time, targetTime: sample.targetTime, trainingCutoff: model.cutoff,
    trainingEnd: model.trainEnd, calibrationEnd: model.calibrationEnd, samples: model.samples, calibrationSamples: model.calibrationSamples,
    version: VERSION, calibration: 'INTERNAL_PLATT_NOT_CERTIFIED', calibrated: true,
    up, down: 1 - up, rawUp, median: mu + quantile(model.residuals, 0.5),
    lower: mu + quantile(model.residuals, 0.1), upper: mu + quantile(model.residuals, 0.9),
    price: sample.price, regime: sample.regime, unconditional: model.unconditional,
    trendUp: sample.x[0] >= 0 ? 0.55 : 0.45, trendMedian: sample.x[0] >= 0 ? 0.001 : -0.001,
    baselineInterval: model.baselineInterval };
}
function walkForward(bars) {
  const all = samples(bars), predictions = [], fits = [];
  let key = '', model = null;
  for (const s of all.filter(s => s.time >= Date.UTC(2023, 0, 1))) {
    const date = new Date(s.time), month = date.toISOString().slice(0, 7);
    if (month !== key) {
      key = month; model = fit(all, Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
      if (model) { const { residuals, ...summary } = model; fits.push(summary); }
    }
    predictions.push({ ...predict(s, model), actual: s.targetTime < END ? s.y : null });
  }
  return { predictions, fits };
}
module.exports = { VERSION, mean, quantile, features, samples, fit, predict, walkForward };

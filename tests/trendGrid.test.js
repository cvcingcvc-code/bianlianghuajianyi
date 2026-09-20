const test = require('node:test');
const assert = require('node:assert/strict');
const { STEP, END, validateCandles } = require('../src/trendGrid/archive');
const { Forecaster } = require('../src/trendGrid/forecast');
const { planGrid, PaperGrid, COSTS } = require('../src/trendGrid/grid');
const start = Date.UTC(2024, 0, 1);
// Arithmetic fixtures only. Never used as market evidence or included in reports.
function bar(i, values = {}) { return { openTime: start + i * STEP, closeTime: start + (i + 1) * STEP - 1,
  open: 100, high: 101, low: 99, close: 100, volume: 1, ...values }; }
function snapshot(i, p = 0.7, w = 0.7) {
  const f = probability => ({ status: 'AVAILABLE_UNCALIBRATED', estimate: { upProbability: probability, lowerPrice: 90, upperPrice: 110 } });
  return { asOf: bar(i).closeTime, price: 100, forecasts: { '30m': f(p), '1w': f(w) } };
}

test('data rejects gaps, bad OHLC and the holdout before research', () => {
  validateCandles([bar(0)], start, start + STEP);
  assert.throws(() => validateCandles([bar(1)], start, start + STEP));
  assert.throws(() => validateCandles([bar(0, { low: 101 })], start, start + STEP));
  assert.throws(() => validateCandles([], END, END + STEP), /HOLDOUT/);
});
test('labels mature only at the actual horizon endpoint and are non-overlapping', () => {
  const m = new Forecaster(); let f;
  for (let i = 0; i <= 1343; i++) f = m.update(bar(i));
  assert.equal(f.forecasts['1w'].baseline, null);
  f = m.update(bar(1344, { close: 110 }));
  assert.equal(f.forecasts['1w'].baseline.samples, 1);
  assert.equal(f.forecasts['1w'].baseline.medianReturn, Math.log(1.1));
  assert.equal(f.forecasts['1w'].status, 'INSUFFICIENT_DATA');
  assert.equal(f.forecasts['30m'].baseline.samples, (1344 - 98) / 2 + 1);
});
test('a saved forecast is invariant to future changes and has exact target times', () => {
  const a = new Forecaster(), b = new Forecaster(); let first, second;
  for (let i = 0; i < 200; i++) { first = a.update(bar(i)); second = b.update(bar(i)); }
  const before = JSON.stringify(first);
  a.update(bar(200, { close: 200 })); b.update(bar(200, { close: 50 }));
  assert.equal(JSON.stringify(first), before); assert.deepEqual(first, second);
  assert.equal(first.forecasts['30m'].targetTime - first.asOf, 30 * 60000);
  assert.equal(first.forecasts['1w'].targetTime - first.asOf, 7 * 86400000);
});
test('forecaster rejects duplicates, 4h cadence and holdout', () => {
  const m = new Forecaster(); m.update(bar(0));
  assert.throws(() => m.update(bar(0))); assert.throws(() => m.update(bar(16)));
  assert.throws(() => new Forecaster().update({ ...bar(0), openTime: END, closeTime: END + STEP - 1 }), /HOLDOUT/);
});
test('direction agreement, weak evidence and cost spacing control entry', () => {
  assert.equal(planGrid(snapshot(0)).side, 'LONG');
  assert.equal(planGrid(snapshot(0, 0.3, 0.3)).side, 'SHORT');
  assert.equal(planGrid(snapshot(0, 0.7, 0.3)).action, 'WAIT');
  assert.equal(planGrid(snapshot(0, 0.5, 0.5)).action, 'WAIT');
  const s = snapshot(0); s.forecasts['1w'].status = 'INSUFFICIENT_DATA';
  assert.equal(planGrid(s).action, 'WAIT');
  s.forecasts['1w'].status = 'AVAILABLE_UNCALIBRATED';
  s.forecasts['30m'].estimate.lowerPrice = 99.99; s.forecasts['30m'].estimate.upperPrice = 100.01;
  assert.equal(planGrid(s).reason, 'GRID_SPACING_BELOW_STRESS_COST');
  assert.deepEqual(COSTS.BASE, { fee: 0.0004, slip: 0.0002 });
});
test('grid activates next bar, no same-bar round trip, bounded allocation, no stacking', () => {
  const a = new PaperGrid(); a.advance(bar(0)); a.decide(snapshot(0));
  assert.equal(a.active, null); assert.equal(a.fills, 0);
  a.advance(bar(1));
  assert.equal(a.opened, 1); assert.ok(a.fills > 0);
  assert.ok(a.events.filter(e => e.type === 'ENTRY').every(e => e.time > snapshot(0).asOf));
  assert.equal(a.events.filter(e => e.type === 'EXIT').length, 0);
  assert.ok(a.active.lots.reduce((s, l) => s + l.quantity * a.active.upper, 0) <= 250);
  a.decide(snapshot(1)); assert.equal(a.pending, null); assert.equal(a.opened, 1);
});
test('adverse gap closes at actual gap, charges fees and creates no new fills', () => {
  const a = new PaperGrid(); a.advance(bar(0)); a.decide(snapshot(0)); a.advance(bar(1));
  const entries = a.events.filter(e => e.type === 'ENTRY');
  a.advance(bar(2, { open: 80, high: 81, low: 79, close: 80 }));
  assert.equal(a.active, null); assert.equal(a.closed, 1);
  const exits = a.events.filter(e => e.type === 'EXIT'); assert.equal(entries.length, exits.length);
  assert.ok(exits.every(e => e.price === 80 * (1 - COSTS.BASE.slip)));
  const expected = entries.reduce((sum, e, i) => sum + e.quantity * (exits[i].price - e.price) - e.quantity * (e.price + exits[i].price) * COSTS.BASE.fee, 1000);
  assert.ok(Math.abs(a.cash - expected) < 1e-9);
});
test('short gap loss, missing consensus and expiry close at next open', () => {
  const a = new PaperGrid(); a.advance(bar(0)); a.decide(snapshot(0, 0.3, 0.3)); a.advance(bar(1));
  assert.equal(a.active.side, 'SHORT');
  a.decide(snapshot(1, 0.7, 0.3)); assert.equal(a.pending.action, 'CLOSE');
  a.advance(bar(2, { open: 120, high: 121, low: 119, close: 120 }));
  assert.equal(a.active, null); assert.ok(a.cash < 1000);
  const b = new PaperGrid(); b.advance(bar(0)); b.decide(snapshot(0)); b.advance(bar(1));
  b.advance(bar(2)); b.decide(snapshot(2)); assert.equal(b.pending.action, 'CLOSE');
  b.advance(bar(3)); assert.equal(b.active, null);
});
test('gap outside band skips activation and all paper results disclose missing funding', () => {
  const a = new PaperGrid(); a.advance(bar(0)); a.decide(snapshot(0));
  a.advance(bar(1, { open: 120, high: 121, low: 119, close: 120 }));
  assert.equal(a.opened, 0); assert.equal(a.fills, 0);
  assert.equal(a.summary().funding, 'NOT_INCLUDED'); assert.equal(a.summary().netEdgeValidated, false);
  assert.throws(() => a.decide(snapshot(0))); assert.throws(() => new PaperGrid({ capital: -1 }));
});

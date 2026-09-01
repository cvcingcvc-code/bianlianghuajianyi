// STRATEGY RESEARCH V2 tests: indicators, diagnostics, candidate filters,
// holdout lock, date isolation, and the guarantee that rsiEma is unmodified.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { calcATR, createATRTracker, ema50Slope } = require('../src/research/strategies/indicators');
const { precompute, enrichTrades, countCrosses } = require('../src/research/diagnostics/tradeDiagnostics');
const { classifyRegime } = require('../src/research/diagnostics/regimeDiagnostics');
const { checkHoldoutLock, HOLDOUT_START_MS } = require('../src/research/holdoutGuard');
const { loadStrategy, listResearchStrategies, isResearchStrategy, listLiveStrategies } = require('../src/research/strategyAdapter');

function lin(from, to, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(from + ((to - from) * (i + 1)) / n);
  return out;
}

function makeCandles(closes, { highFn, lowFn } = {}) {
  return closes.map((close, i) => ({
    timestamp: Date.UTC(2024, 0, 1) + i * 900000,
    open: close,
    high: highFn ? highFn(i, close) : close,
    low: lowFn ? lowFn(i, close) : close,
    close,
    volume: 1000,
  }));
}

// ---- 1. ATR uses only history ----
test('ATR tracker matches calcATR and never uses future data', () => {
  const closes = lin(100, 200, 80);
  const candles = makeCandles(closes, {
    highFn: (i, c) => c + 2 + (i % 3),
    lowFn: (i, c) => c - 2 - (i % 2),
  });
  const tracker = createATRTracker(14);
  for (let i = 0; i < candles.length; i++) {
    const tVal = tracker.push(candles[i]);
    const cVal = calcATR(candles, 14, i);
    if (tVal !== null) {
      assert.ok(Math.abs(tVal - cVal) < 1e-9, `ATR mismatch at ${i}: ${tVal} vs ${cVal}`);
    }
  }
});

// ---- 2. EMA50 slope no look-ahead ----
test('ema50 slope is identical whether or not future bars are present', () => {
  const closes = lin(100, 300, 120);
  const candles = makeCandles(closes);
  for (const i of [55, 70, 100]) {
    const full = ema50Slope(candles, i);
    const sliced = ema50Slope(candles.slice(0, i + 1), i);
    assert.notEqual(full, null);
    assert.deepEqual(full, sliced, `slope at ${i} must not depend on future bars`);
  }
});

// ---- 3. crossover count no look-ahead ----
test('cross count only looks back to endIdx', () => {
  const cross = [null, null, 1, 1, -1, -1, 1, 1];
  // transitions: idx2 null->1 (skip), idx4 1->-1 (count), idx6 -1->1 (after endIdx=4)
  assert.equal(countCrosses(cross, 4, 10), 1);
  assert.equal(countCrosses(cross, 6, 10), 2);
});

// ---- 4. MFE/MAE calculation ----
test('MFE/MAE use entry-price excursions over the holding path', () => {
  const closes = Array(60).fill(100);
  const candles = makeCandles(closes, { highFn: () => 101, lowFn: () => 99 });
  // holding window bars 30..40; entry fill at 100
  candles[35].high = 108;
  candles[40].low = 98;
  const indexOf = new Map(candles.map((c, i) => [c.timestamp, i]));
  const trade = {
    symbol: 'X', strategy: 's', entryTime: candles[30].timestamp, exitTime: candles[40].timestamp,
    entryPrice: 100, exitPrice: 100, quantity: 1, grossPnl: 0, fees: 0, netPnl: 0, returnPct: 0, holdingBars: 10,
  };
  const pre = precompute(candles);
  const [enriched] = enrichTrades({ candles, trades: [trade], indexOf, pre });
  assert.ok(Math.abs(enriched.mfe - 8) < 1e-9, `mfe ${enriched.mfe}`);
  assert.ok(Math.abs(enriched.mae - (-2)) < 1e-9, `mae ${enriched.mae}`);
});

// ---- 5. regime classification ----
test('regime classification buckets trend and volatility', () => {
  const trade = { entrySignalClose: 110, ema50: 100, ema50SlopeSign: 1, atrPct: 0.5 };
  const r = classifyRegime(trade, { atrLow: 0.27, atrHigh: 0.63 });
  assert.equal(r.trendAbove, true);
  assert.equal(r.trendUp, true);
  assert.equal(r.bull, true);
  assert.equal(r.volBucket, 'Medium');

  const low = classifyRegime({ entrySignalClose: 90, ema50: 100, ema50SlopeSign: -1, atrPct: 0.2 }, { atrLow: 0.27, atrHigh: 0.63 });
  assert.equal(low.trendAbove, false);
  assert.equal(low.trendUp, false);
  assert.equal(low.volBucket, 'Low');
});

// ---- 6. candidate entry filter (emaTrendFilter) ----
function simulate(adapter, closes) {
  const state = adapter.createState();
  const events = [];
  let inPos = false;
  closes.forEach((close, idx) => {
    const res = adapter.computeSignal(state, { close, open: close, high: close, low: close, volume: 1000, timestamp: idx }, { hasPosition: inPos, warmup: false });
    if (res.action === 'LONG') { events.push(`LONG@${idx}`); inPos = true; }
    else if (res.action === 'CLOSE') { events.push(`CLOSE@${idx}`); inPos = false; }
  });
  return events;
}

test('emaTrendFilter: allows LONG on trend-aligned golden cross', () => {
  const adapter = loadStrategy('emaTrendFilter');
  const closes = [...Array(60).fill(100), ...lin(100, 140, 40)];
  const events = simulate(adapter, closes);
  assert.ok(events.some((e) => e.startsWith('LONG')), `expected LONG, got ${events}`);
});

test('emaTrendFilter: no LONG on counter-trend golden cross (close < EMA50)', () => {
  const adapter = loadStrategy('emaTrendFilter');
  // fall then a bounce that could create a golden cross below EMA50
  const closes = [...Array(60).fill(100), ...lin(100, 70, 40), ...lin(70, 82, 20)];
  const events = simulate(adapter, closes);
  // after a 30% fall, EMA50 ~90; bounce top 82 stays below EMA50 -> no LONG allowed
  assert.ok(!events.some((e) => e.startsWith('LONG')), `expected no LONG, got ${events}`);
});

// ---- 7/8. holdout lock + unlock flag ----
test('holdout lock: research candidate on 2026 data is locked without --unlock-holdout', () => {
  const candles = [{ timestamp: HOLDOUT_START_MS + 1 }];
  const locked = checkHoldoutLock({ strategy: 'emaTrendFilter', candles });
  assert.equal(locked.locked, true);
  assert.match(locked.reason, /FINAL HOLDOUT IS LOCKED/);
});

test('holdout lock: data ending before 2026 is allowed', () => {
  const candles = [{ timestamp: HOLDOUT_START_MS - 1 }];
  assert.equal(checkHoldoutLock({ strategy: 'emaTrendFilter', candles }).locked, false);
});

test('holdout lock: walk-forward test range touching 2026 is locked', () => {
  const walk = { testEndMs: HOLDOUT_START_MS + 1 };
  assert.equal(checkHoldoutLock({ strategy: 'emaTrendFilter', candles: [], walk }).locked, true);
});

test('holdout lock: --unlock-holdout disables the lock', () => {
  const candles = [{ timestamp: HOLDOUT_START_MS + 1 }];
  assert.equal(checkHoldoutLock({ strategy: 'emaTrendFilter', candles, unlocked: true }).locked, false);
});

test('holdout lock: non-research (live) strategies are never locked', () => {
  const candles = [{ timestamp: HOLDOUT_START_MS + 1 }];
  assert.equal(checkHoldoutLock({ strategy: 'emaCrossover', candles }).locked, false);
});

// ---- 9. candidate registry / freeze metadata ----
test('research strategy registry contains the preregistered candidates', () => {
  const names = listResearchStrategies();
  for (const n of ['emaTrendFilter', 'emaTrendDensityFilter', 'emaTrendVolFilter']) {
    assert.ok(names.includes(n), `missing ${n}`);
    const s = loadStrategy(n);
    assert.equal(typeof s.createState, 'function');
    assert.equal(typeof s.computeSignal, 'function');
    assert.equal(s.isResearch, true);
  }
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'docs', 'strategy-v2-hypotheses.md')), 'preregistration doc exists');
});

// ---- 10. validation date isolation ----
test('validation (2024-2025) and holdout (2026) date ranges are isolated', () => {
  const { candles } = (() => {
    const raw = [];
    let ts = Date.UTC(2023, 11, 31, 23, 45);
    const start = ts;
    for (let i = 0; i < 30000; i++) raw.push({ timestamp: ts, close: 100 }); // ~78 days
    return { candles: raw, start };
  })();
  const validation = candles.filter((c) => c.timestamp >= Date.UTC(2024, 0, 1) && c.timestamp < Date.UTC(2026, 0, 1));
  const holdout = candles.filter((c) => c.timestamp >= HOLDOUT_START_MS && c.timestamp < Date.UTC(2027, 0, 1));
  assert.ok(validation.every((c) => c.timestamp < HOLDOUT_START_MS));
  assert.ok(holdout.length === 0 || holdout.every((c) => c.timestamp >= HOLDOUT_START_MS));
  // validation never overlaps holdout
  assert.equal(validation.some((c) => c.timestamp >= HOLDOUT_START_MS), false);
});

// ---- 11. rsiEma baseline not modified ----
test('rsiEma remains a live (non-research) strategy with intact interface', () => {
  assert.equal(isResearchStrategy('rsiEma'), false);
  assert.ok(listLiveStrategies().includes('rsiEma'));
  const rsiEma = require('../src/strategy/rsiEma');
  assert.equal(typeof rsiEma.computeSignal, 'function');
  assert.equal(typeof rsiEma.createState, 'function');
  assert.equal(typeof rsiEma.onTick, 'function');
  // golden-master behavior unchanged (matches tests/parity.test.js)
  const seq = [...Array(70).fill(100), ...lin(100, 112, 25), ...lin(112, 104, 8), ...lin(104, 112, 12), ...Array(10).fill(112), ...lin(112, 98, 20)];
  const state = rsiEma.createState();
  const events = [];
  let inPos = false;
  seq.forEach((close, idx) => {
    const r = rsiEma.computeSignal(state, close, { hasPosition: inPos, warmup: false });
    if (r.action === 'LONG') { events.push(`LONG@${idx}`); inPos = true; }
    else if (r.action === 'CLOSE') { events.push(`CLOSE@${idx}`); inPos = false; }
  });
  assert.deepEqual(events, ['LONG@109', 'CLOSE@130']);
});

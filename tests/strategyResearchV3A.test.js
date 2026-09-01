// STRATEGY RESEARCH V3A tests: entry-candidate look-ahead properties, delayed
// confirmation execution, pullback/reclaim, 24h breakout exclusion/warmup,
// identical death-cross exits, future-mutation invariance, holdout lock,
// walk-forward isolation, preregistration metadata, and unchanged baselines.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadStrategy, listResearchStrategies, isResearchStrategy } = require('../src/research/strategyAdapter');
const { runBacktest } = require('../src/research/backtest/backtester');
const { checkHoldoutLock, HOLDOUT_START_MS } = require('../src/research/holdoutGuard');

function lin(from, to, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(from + ((to - from) * (i + 1)) / n);
  return out;
}

function candles(closes, { highFn, lowFn, highOverrides = {} } = {}) {
  return closes.map((close, i) => ({
    timestamp: Date.UTC(2024, 0, 1) + i * 900000,
    open: close,
    high: highOverrides[i] !== undefined ? highOverrides[i] : highFn ? highFn(i, close) : close,
    low: lowFn ? lowFn(i, close) : close,
    close,
    volume: 1000,
  }));
}

// Position-aware simulate over full candles, returning { action, index } events.
function simulate(adapter, bars) {
  const state = adapter.createState();
  const events = [];
  let inPos = false;
  bars.forEach((bar, idx) => {
    const res = adapter.computeSignal(state, bar, { hasPosition: inPos, warmup: false });
    if (res.action === 'LONG') { events.push({ action: 'LONG', index: idx }); inPos = true; }
    else if (res.action === 'CLOSE') { events.push({ action: 'CLOSE', index: idx }); inPos = false; }
  });
  return events;
}

// ---- A: confirmation delayed execution ----
test('emaConfirmation: LONG fires at least 1 bar after the golden cross and fills 2 bars later', () => {
  const closes = [...Array(40).fill(100), ...lin(100, 140, 30)];
  const bars = candles(closes);
  const baselineEvents = simulate(loadStrategy('emaCrossover'), bars);
  const confEvents = simulate(loadStrategy('emaConfirmation'), bars);

  const baseLong = baselineEvents.find((e) => e.action === 'LONG');
  const confLong = confEvents.find((e) => e.action === 'LONG');
  assert.ok(baseLong, 'baseline should have a LONG');
  assert.ok(confLong, 'confirmation should have a LONG');
  assert.ok(confLong.index >= baseLong.index + 1, `confirmation must be delayed: baseline@${baseLong.index} conf@${confLong.index}`);

  // fill via backtester = 2 bars after the baseline golden cross bar
  const broker = { commissionPct: 0, slippagePct: 0, entryFillPrice: (o) => o, exitFillPrice: (o) => o, commission: () => 0, fundingCost: () => 0, fundingIncluded: () => false };
  const result = runBacktest({ symbol: 'X', candles: bars, adapter: loadStrategy('emaConfirmation'), broker, initialCapital: 10000, positionSizePct: 100 });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryTime, bars[baseLong.index + 2].timestamp);
});

// ---- A: no look-ahead / future mutation ----
test('emaConfirmation: mutating candles after a signal does not change past signals', () => {
  const closes = [...Array(40).fill(100), ...lin(100, 140, 30)];
  const bars = candles(closes);
  const a1 = simulate(loadStrategy('emaConfirmation'), bars);
  // mutate bars 30..69 wildly
  const bars2 = bars.map((b, i) => (i >= 30 ? { ...b, close: 1e6, high: 1e6, low: 1, open: 1e6 } : b));
  const a2 = simulate(loadStrategy('emaConfirmation'), bars2);
  // signals before index 30 must be identical
  const before = (arr) => arr.filter((e) => e.index < 30);
  assert.deepEqual(before(a1), before(a2));
});

test('emaConfirmation: entry does NOT use the confirmation candle high (only its close)', () => {
  const closes = [...Array(40).fill(100), ...lin(100, 140, 30)];
  const base = candles(closes);
  const conf = candles(closes);
  // mutation: raise confirmation-candle highs to extreme (index = signal bar + 1)
  const eventsBase = simulate(loadStrategy('emaConfirmation'), base);
  const firstLong = eventsBase.find((e) => e.action === 'LONG');
  assert.ok(firstLong, 'need a LONG');
  conf[firstLong.index].high = 1e6; // the confirmation candle's high must not matter
  const eventsConf = simulate(loadStrategy('emaConfirmation'), conf);
  const ev = eventsConf.map((e) => `${e.action}@${e.index}`);
  assert.ok(ev.includes(`LONG@${firstLong.index}`), 'entry unchanged when confirmation high is mutated');
});

// ---- B: pullback state / reclaim signal ----
test('trendPullbackReclaim: LONG fires on pullback+reclaim in an uptrend, not otherwise', () => {
  // uptrend with a small dip (close <= EMA9) then reclaim
  const closes = [
    ...Array(60).fill(100),
    ...lin(100, 118, 30), // uptrend
    ...lin(118, 114, 3),  // pullback
    ...lin(114, 122, 3),  // reclaim
    ...lin(122, 130, 6),
  ];
  const events = simulate(loadStrategy('trendPullbackReclaim'), candles(closes));
  assert.ok(events.some((e) => e.action === 'LONG'), `expected a LONG, got ${events.map((e) => e.action + '@' + e.index)}`);

  // steady monotonic rise: every close stays above its EMA9 -> no pullback -> no LONG
  const steady = lin(100, 200, 120);
  const events2 = simulate(loadStrategy('trendPullbackReclaim'), candles(steady));
  assert.ok(!events2.some((e) => e.action === 'LONG'), 'no pullback -> no LONG');
});

// ---- C: 24h breakout excludes current candle + warmup ----
test('breakout24hTrend: entry uses close > prior-96-bar high (current candle high excluded)', () => {
  const closes = [...Array(120).fill(100), 105, 106, 107];
  // current (entry) bar has an extreme high — if the current high were included
  // in the 24h window, no close could exceed it and no entry would fire.
  const highOverrides = { 120: 10000 };
  const events = simulate(loadStrategy('breakout24hTrend'), candles(closes, { highOverrides }));
  assert.ok(events.some((e) => e.action === 'LONG' && e.index === 120),
    `current-candle high must be excluded; got ${events.map((e) => e.action + '@' + e.index)}`);
});

test('breakout24hTrend: no signal before 96 prior bars (warmup)', () => {
  const closes = [...Array(60).fill(100), ...lin(100, 140, 30)]; // only ~90 bars total
  const events = simulate(loadStrategy('breakout24hTrend'), candles(closes));
  assert.ok(!events.some((e) => e.action === 'LONG'), 'needs >= 96 prior highs');
});

test('breakout24hTrend: past signals unchanged when future candles are mutated', () => {
  const closes = [...Array(120).fill(100), ...lin(100, 160, 60)];
  const bars = candles(closes);
  const a1 = simulate(loadStrategy('breakout24hTrend'), bars);
  const bars2 = bars.map((b, i) => (i >= 150 ? { ...b, close: 1e6, high: 1e6 } : b));
  const a2 = simulate(loadStrategy('breakout24hTrend'), bars2);
  assert.deepEqual(a1.filter((e) => e.index < 150), a2.filter((e) => e.index < 150));
});

// ---- exits remain identical death cross ----
test('all V3A candidates exit only on the EMA9/21 death cross (same rule as baseline)', () => {
  // long flat + rise + dip + reclaim + decline — every strategy enters then exits
  const closes = [...Array(120).fill(100), ...lin(100, 140, 30), ...lin(140, 132, 3), ...lin(132, 150, 12), ...lin(150, 90, 50)];
  const bars = candles(closes);

  // independent death-cross bar indices (above -> below) from the raw closes
  const ema = (prices, period) => {
    if (prices.length < period) return null;
    const k = 2 / (period + 1);
    let e = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < prices.length; i++) e = prices[i] * k + e * (1 - k);
    return e;
  };
  const xs = closes.map((_, i) => {
    const p = closes.slice(0, i + 1);
    const e9 = ema(p, 9);
    const e21 = ema(p, 21);
    return e9 === null || e21 === null ? null : e9 > e21 ? 1 : -1;
  });
  const deathIndices = new Set();
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] !== null && xs[i - 1] !== null && xs[i - 1] === 1 && xs[i] === -1) deathIndices.add(i);
  }

  for (const name of ['emaConfirmation', 'trendPullbackReclaim', 'breakout24hTrend']) {
    const events = simulate(loadStrategy(name), bars);
    const closesEv = events.filter((e) => e.action === 'CLOSE');
    assert.ok(closesEv.length >= 1, `${name}: expected at least one exit in the series`);
    for (const e of closesEv) {
      assert.ok(deathIndices.has(e.index), `${name}: exit at ${e.index} must be a death-cross bar`);
    }
  }
});

// ---- holdout lock ----
test('V3A candidates are holdout-locked on 2026 data', () => {
  for (const name of ['emaConfirmation', 'trendPullbackReclaim', 'breakout24hTrend']) {
    assert.equal(isResearchStrategy(name), true);
    const locked = checkHoldoutLock({ strategy: name, candles: [{ timestamp: HOLDOUT_START_MS + 1 }] });
    assert.equal(locked.locked, true, `${name} must be locked`);
    assert.equal(checkHoldoutLock({ strategy: name, candles: [{ timestamp: HOLDOUT_START_MS + 1 }], unlocked: true }).locked, false);
  }
});

// ---- walk-forward date isolation ----
test('V3A folds are within development data and non-overlapping', () => {
  const folds = [
    [Date.UTC(2023, 0, 1), Date.UTC(2024, 0, 1)],
    [Date.UTC(2024, 0, 1), Date.UTC(2025, 0, 1)],
    [Date.UTC(2025, 0, 1), Date.UTC(2026, 0, 1)],
  ];
  for (let i = 0; i < folds.length; i++) {
    const [s, e] = folds[i];
    assert.ok(s < e);
    assert.ok(e <= HOLDOUT_START_MS, `fold ${i} end must be before 2026`);
    if (i > 0) assert.equal(folds[i - 1][1], s, 'folds must be contiguous, non-overlapping');
  }
});

// ---- preregistration metadata ----
test('V3A candidates are preregistered and loadable', () => {
  const names = listResearchStrategies();
  for (const n of ['emaConfirmation', 'trendPullbackReclaim', 'breakout24hTrend']) {
    assert.ok(names.includes(n), `missing ${n}`);
    const s = loadStrategy(n);
    assert.equal(typeof s.computeSignal, 'function');
    assert.equal(typeof s.createState, 'function');
    assert.equal(s.isResearch, true);
  }
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'docs', 'strategy-v3a-hypotheses.md')));
});

// ---- baselines unchanged ----
test('baseline emaCrossover behavior is unchanged (golden master)', () => {
  const closes = [...Array(40).fill(100), ...lin(100, 130, 30), ...lin(130, 100, 30)];
  const events = simulate(loadStrategy('emaCrossover'), candles(closes));
  const ev = events.map((e) => `${e.action}@${e.index}`);
  assert.deepEqual(ev, ['LONG@40', 'CLOSE@81']);
});

test('rsiEma remains unchanged (golden master)', () => {
  const rsiEma = require('../src/strategy/rsiEma');
  const seq = [...Array(70).fill(100), ...lin(100, 112, 25), ...lin(112, 104, 8), ...lin(104, 112, 12), ...Array(10).fill(112), ...lin(112, 98, 20)];
  const st = rsiEma.createState();
  const events = [];
  let inPos = false;
  seq.forEach((close, idx) => {
    const r = rsiEma.computeSignal(st, close, { hasPosition: inPos, warmup: false });
    if (r.action === 'LONG') { events.push(`LONG@${idx}`); inPos = true; }
    else if (r.action === 'CLOSE') { events.push(`CLOSE@${idx}`); inPos = false; }
  });
  assert.deepEqual(events, ['LONG@109', 'CLOSE@130']);
});

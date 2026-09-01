// STRATEGY RESEARCH V4 tests: resampling integrity (exact OHLCV, UTC alignment,
// incomplete-window rejection, future-mutation invariance), 1h/4h breakout
// windows, current-candle exclusion, next-bar execution, identical exits,
// holdout lock, and unchanged V3A baseline / sizing / cost model.

const { test } = require('node:test');
const assert = require('node:assert');
const { resample, TARGETS } = require('../src/research/data/resampler');
const { loadStrategy, isResearchStrategy } = require('../src/research/strategyAdapter');
const { runBacktest } = require('../src/research/backtest/backtester');
const { createBroker } = require('../src/research/backtest/brokerSimulator');
const { createPortfolio } = require('../src/research/backtest/portfolio');
const { checkHoldoutLock, HOLDOUT_START_MS } = require('../src/research/holdoutGuard');

const H1 = TARGETS['1h'];
const H4 = TARGETS['4h'];
const SRC = 900000;

// Build `n` 15m candles starting at a UTC hour boundary.
function make15m(count, start = Date.UTC(2024, 0, 1), closes = null, highFn = null) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const close = closes ? closes[i] : 100 + (i % 7);
    const high = highFn ? highFn(i) : close + 0.5;
    out.push({
      timestamp: start + i * SRC,
      open: close,
      high,
      low: close - 0.5,
      close,
      volume: 1000 + i,
    });
  }
  return out;
}

// ---- exact OHLCV aggregation ----
test('resample 1h: 4x15m -> exact open/high/low/close/volume/timestamp', () => {
  const src = make15m(4, Date.UTC(2024, 0, 1, 0, 0), [10, 12, 9, 11], (i) => [10, 13, 9.5, 11.5][i]);
  const { candles, incompleteWindows } = resample(src, H1);
  assert.equal(incompleteWindows.length, 0);
  assert.equal(candles.length, 1);
  const c = candles[0];
  assert.equal(c.timestamp, Date.UTC(2024, 0, 1, 0, 0));
  assert.equal(c.open, 10);
  assert.equal(c.high, 13);
  assert.equal(c.low, 8.5); // min(low) = min(9.5, 11.5, 8.5, 10.5)
  assert.equal(c.close, 11);
  assert.equal(c.volume, 1000 + 1001 + 1002 + 1003);
});

test('resample 4h: 16x15m -> exact OHLCV', () => {
  const src = make15m(16, Date.UTC(2024, 0, 1, 0, 0), null, (i) => 200 + i);
  const { candles, incompleteWindows } = resample(src, H4);
  assert.equal(incompleteWindows.length, 0);
  assert.equal(candles.length, 1);
  const c = candles[0];
  assert.equal(c.timestamp, Date.UTC(2024, 0, 1, 0, 0));
  assert.equal(c.open, src[0].close);
  assert.equal(c.high, 200 + 15); // max high
  assert.equal(c.low, src[0].close - 0.5);
  assert.equal(c.close, src[15].close);
  assert.equal(c.volume, src.reduce((a, x) => a + x.volume, 0));
});

// ---- UTC alignment ----
test('resample: strict UTC hour alignment (01:00 candle goes to next hour)', () => {
  // 15m candles: 00:00,00:15,00:30,00:45, then 01:00 (5th) belongs to the next hour
  const src = make15m(5, Date.UTC(2024, 0, 1, 0, 0));
  const { candles, incompleteWindows } = resample(src, H1);
  // hour 00:00 is complete (4 candles); hour 01:00 has only 1 candle -> incomplete
  assert.equal(candles.length, 1);
  assert.equal(candles[0].timestamp, Date.UTC(2024, 0, 1, 0, 0));
  assert.equal(incompleteWindows.length, 1);
  assert.equal(incompleteWindows[0].count, 1);
  assert.equal(incompleteWindows[0].expected, 4);
});

// ---- incomplete window rejection ----
test('resample: incomplete windows are discarded and reported, never fabricated', () => {
  const src = make15m(3, Date.UTC(2024, 0, 1, 0, 0)); // only 3 of 4 in the hour
  const { candles, incompleteWindows } = resample(src, H1);
  assert.equal(candles.length, 0);
  assert.equal(incompleteWindows.length, 1);
  assert.equal(incompleteWindows[0].count, 3);
});

// ---- future mutation no-lookahead ----
test('resample: mutating a future 15m candle never changes already-formed candles', () => {
  const src = make15m(40, Date.UTC(2024, 0, 1, 0, 0));
  const base = resample(src, H1).candles;
  const src2 = src.map((c, i) => (i >= 20 ? { ...c, close: 1e6, high: 1e6, low: 1, volume: 1e9 } : c));
  const mutated = resample(src2, H1).candles;
  const prefix = base.filter((c) => c.timestamp < Date.UTC(2024, 0, 1, 5, 0)); // bars formed before index 20
  for (const c of prefix) {
    const m = mutated.find((x) => x.timestamp === c.timestamp);
    assert.deepEqual(m, c, 'past 1h candle must be unchanged by future 15m mutations');
  }
});

// ---- 24h lookback = 24 bars (1h) / 6 bars (4h) ----
test('breakout24h1h uses a 24-bar (24h) lookback; breakout24h4h uses 6 bars', () => {
  const h1 = require('../src/research/strategies/breakout24h1h');
  const h4 = require('../src/research/strategies/breakout24h4h');
  assert.equal(h1.windowBars, 24);
  assert.equal(h4.windowBars, 6);
});

// ---- current candle excluded ----
test('breakout24h4h: entry close must beat prior-6-bar high; current high excluded', () => {
  // 4h candle series: 60 bars flat then rising; the FIRST breakout bar (60) has an extreme high
  const closes = [...Array(60).fill(100), ...lin(100, 150, 30)];
  const bars = closes.map((close, i) => ({
    timestamp: Date.UTC(2024, 0, 1) + i * H4,
    open: close,
    high: i === 60 ? 10000 : close + 0.5,
    low: close - 0.5,
    close,
    volume: 1000,
  }));
  const events = simulate(loadStrategy('breakout24h4h'), bars);
  // at bar 60, the current high (10000) must NOT be in the prior-6-bar window —
  // otherwise no close could beat it and no entry would fire
  assert.ok(events.some((e) => e.action === 'LONG' && e.index === 60),
    `current high must be excluded; got ${events.map((e) => e.action + '@' + e.index)}`);
});

function lin(from, to, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(from + ((to - from) * (i + 1)) / n);
  return out;
}

function simulate(adapter, bars) {
  const state = adapter.createState();
  const events = [];
  let inPos = false;
  bars.forEach((bar, idx) => {
    const r = adapter.computeSignal(state, bar, { hasPosition: inPos, warmup: false });
    if (r.action === 'LONG') { events.push({ action: 'LONG', index: idx }); inPos = true; }
    else if (r.action === 'CLOSE') { events.push({ action: 'CLOSE', index: idx }); inPos = false; }
  });
  return events;
}

function makeBar(closes, barMs) {
  return closes.map((close, i) => ({
    timestamp: Date.UTC(2024, 0, 1) + i * barMs,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 1000,
  }));
}

// ---- next-bar execution on 1h and 4h ----
test('next-bar execution: breakout24h1h fills at the next 1h open', () => {
  const closes = [...Array(80).fill(100), ...lin(100, 170, 50)];
  const bars = makeBar(closes, H1);
  const events = simulate(loadStrategy('breakout24h1h'), bars);
  const firstLong = events.find((e) => e.action === 'LONG');
  assert.ok(firstLong, 'expected a LONG');
  const broker = makeBroker();
  const result = runBacktest({ symbol: 'X', candles: bars, adapter: loadStrategy('breakout24h1h'), broker, initialCapital: 10000, positionSizePct: 25 });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryTime, bars[firstLong.index + 1].timestamp);
});

test('next-bar execution: breakout24h4h fills at the next 4h open', () => {
  const closes = [...Array(80).fill(100), ...lin(100, 170, 50)];
  const bars = makeBar(closes, H4);
  const events = simulate(loadStrategy('breakout24h4h'), bars);
  const firstLong = events.find((e) => e.action === 'LONG');
  assert.ok(firstLong, 'expected a LONG');
  const broker = makeBroker();
  const result = runBacktest({ symbol: 'X', candles: bars, adapter: loadStrategy('breakout24h4h'), broker, initialCapital: 10000, positionSizePct: 25 });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryTime, bars[firstLong.index + 1].timestamp);
});

function makeBroker() {
  return { commissionPct: 0, slippagePct: 0, entryFillPrice: (o) => o, exitFillPrice: (o) => o, commission: () => 0, fundingCost: () => 0, fundingIncluded: () => false };
}

// ---- same exit semantics ----
test('1h/4h breakout candidates exit only on EMA9/21 death cross', () => {
  for (const name of ['breakout24h1h', 'breakout24h4h']) {
    const closes = [...Array(80).fill(100), ...lin(100, 180, 60), ...lin(180, 100, 60)];
    const barMs = name === 'breakout24h1h' ? H1 : H4;
    const bars = makeBar(closes, barMs);
    const events = simulate(loadStrategy(name), bars);
    const closesEv = events.filter((e) => e.action === 'CLOSE');
    assert.ok(closesEv.length >= 1, `${name}: expected an exit`);
    // independent death-cross bars from closes
    const ema = (p, period) => {
      if (p.length < period) return null;
      const k = 2 / (period + 1);
      let e = p.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = period; i < p.length; i++) e = p[i] * k + e * (1 - k);
      return e;
    };
    const xs = closes.map((_, i) => {
      const p = closes.slice(0, i + 1);
      const e9 = ema(p, 9);
      const e21 = ema(p, 21);
      return e9 === null || e21 === null ? null : e9 > e21 ? 1 : -1;
    });
    for (const e of closesEv) {
      assert.ok(xs[e.index] !== null && xs[e.index] === -1 && xs[e.index - 1] === 1, `${name}: exit@${e.index} must be a death cross`);
    }
  }
});

// ---- 2026 inaccessible ----
test('V4 candidates are holdout-locked on 2026 data', () => {
  for (const name of ['breakout24h1h', 'breakout24h4h']) {
    assert.equal(isResearchStrategy(name), true);
    assert.equal(checkHoldoutLock({ strategy: name, candles: [{ timestamp: HOLDOUT_START_MS + 1 }] }).locked, true);
    assert.equal(checkHoldoutLock({ strategy: name, candles: [{ timestamp: HOLDOUT_START_MS + 1 }], unlocked: true }).locked, false);
  }
});

// ---- V3A baseline unchanged ----
test('V3A 15m breakout24hTrend is unchanged and still fires a breakout entry', () => {
  const closes = [...Array(120).fill(100), 105, 106, 107];
  const bars = closes.map((close, i) => ({
    timestamp: Date.UTC(2024, 0, 1) + i * SRC,
    open: close, high: close + 0.5, low: close - 0.5, close, volume: 1000,
  }));
  const events = simulate(loadStrategy('breakout24hTrend'), bars);
  assert.ok(events.some((e) => e.action === 'LONG' && e.index === 120));
});

// ---- positionSizePct unchanged (25% allocation, no leverage) ----
test('positionSizePct 25: 25% of equity deployed, no negative cash, no leverage', () => {
  const broker = createBroker({ commissionPct: 0.0004, slippagePct: 0 });
  const p = createPortfolio({ initialCapital: 10000, symbol: 'X', positionSizePct: 25, strategyName: 's' });
  p.openPosition({ timestamp: 0, close: 100, index: 0 }, 100, broker);
  assert.ok(Math.abs(p.state.cash - 7500) < 1e-6, `cash=${p.state.cash}`);
  const notional = p.state.position.quantity * p.state.position.entryPrice;
  assert.ok(notional < 2500, 'notional ~25% of equity, no leverage');
});

// ---- cost model unchanged ----
test('cost model unchanged: default commission 0.0004 and slippage 0.0002', () => {
  const broker = createBroker();
  assert.equal(broker.commissionPct, 0.0004);
  assert.equal(broker.slippagePct, 0.0002);
  assert.ok(Math.abs(broker.entryFillPrice(100) - 100.02) < 1e-9);
});

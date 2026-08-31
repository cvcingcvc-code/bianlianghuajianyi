const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { runBacktest } = require('../src/research/backtest/backtester');
const { createBroker } = require('../src/research/backtest/brokerSimulator');
const { computeMetrics } = require('../src/research/metrics/performance');
const { loadCandles } = require('../src/research/data/candleRepository');
const { loadStrategy } = require('../src/research/strategyAdapter');
const { makeCandles, stubAdapter } = require('./helpers');

// --- next-bar execution (test case 6) ---
test('next-bar execution: signal at close N -> fill at open N+1', () => {
  const candles = makeCandles(Array(40).fill(100), { openFn: (i) => 100 + (i % 3) });
  // LONG on the 20th computeSignal call (bar 19), CLOSE on the 25th (bar 24)
  const adapter = stubAdapter('stub', { 20: 'LONG', 25: 'CLOSE' });
  const broker = createBroker({ commissionPct: 0, slippagePct: 0 });
  const result = runBacktest({ symbol: 'BTCUSDT', candles, adapter, broker, initialCapital: 10000, positionSizePct: 100 });

  assert.equal(result.trades.length, 1);
  const t = result.trades[0];
  assert.equal(t.entryPrice, candles[20].open);
  assert.equal(t.entryTime, candles[20].timestamp);
  assert.equal(t.exitPrice, candles[25].open);
  assert.equal(t.exitTime, candles[25].timestamp);
});

// --- no look-ahead (test case 7) ---
test('no look-ahead: fill uses next-bar OPEN, never next-bar close', () => {
  const candles = makeCandles(Array(40).fill(100), { openFn: () => 100 });
  // Make bar 19 close = 111 (signal bar) and bar 20 close = 999 (would be a huge leak if used)
  candles[19].close = 111;
  candles[20].open = 100;
  candles[20].close = 999;

  const adapter = stubAdapter('stub', { 20: 'LONG', 25: 'CLOSE' }); // signal at bar 19 close
  const broker = createBroker({ commissionPct: 0, slippagePct: 0 });
  const result = runBacktest({ symbol: 'X', candles, adapter, broker, initialCapital: 10000, positionSizePct: 100 });

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryPrice, 100); // = bar 20 open, NOT bar 19 close (111) or bar 20 close (999)
});

// --- losing strategy (test case 14) ---
test('losing strategy: enter high, exit low, net negative', () => {
  const candles = makeCandles(Array(40).fill(100));
  for (let i = 20; i < 40; i++) candles[i].open = candles[i].close = 100 - (i - 19); // downtrend
  const adapter = stubAdapter('stub', { 20: 'LONG', 25: 'CLOSE' });
  const broker = createBroker({ commissionPct: 0.0004, slippagePct: 0.0002 });
  const result = runBacktest({ symbol: 'X', candles, adapter, broker, initialCapital: 10000, positionSizePct: 100 });

  assert.equal(result.trades.length, 1);
  assert.ok(result.trades[0].netPnl < 0, 'expected a losing trade');
  assert.ok(result.finalEquity < 10000, 'expected equity below initial');
});

// --- winning strategy (test case 15) ---
test('winning strategy: enter low, exit high, net positive', () => {
  const candles = makeCandles(Array(40).fill(100));
  for (let i = 20; i < 40; i++) candles[i].open = candles[i].close = 100 + (i - 19); // uptrend
  const adapter = stubAdapter('stub', { 20: 'LONG', 25: 'CLOSE' });
  const broker = createBroker({ commissionPct: 0.0004, slippagePct: 0.0002 });
  const result = runBacktest({ symbol: 'X', candles, adapter, broker, initialCapital: 10000, positionSizePct: 100 });

  assert.equal(result.trades.length, 1);
  assert.ok(result.trades[0].netPnl > 0, 'expected a winning trade');
  assert.ok(result.finalEquity > 10000, 'expected equity above initial');
});

// --- zero trades (test case 16) ---
test('zero trades: always HOLD -> flat equity, null metrics', () => {
  const adapter = stubAdapter('stub', {}); // always HOLD
  const broker = createBroker({ commissionPct: 0.0004, slippagePct: 0.0002 });
  const candles = makeCandles(Array(40).fill(100));
  const result = runBacktest({ symbol: 'X', candles, adapter, broker, initialCapital: 10000, positionSizePct: 100 });

  assert.equal(result.trades.length, 0);
  assert.equal(result.finalEquity, 10000);
  assert.equal(result.openPositionAtEnd, false);

  const metrics = computeMetrics({
    initialCapital: result.initialCapital,
    finalEquity: result.finalEquity,
    equityCurve: result.equityCurve,
    trades: result.trades,
    intervalMs: 900000,
    barsTotal: result.barsTotal,
    barsInPosition: result.barsInPosition,
  });
  assert.equal(metrics.tradeCount, 0);
  assert.equal(metrics.winRatePct, null);
  assert.equal(metrics.profitFactor, null);
});

// --- single trade (test case 17) ---
test('single trade: exactly one round trip recorded', () => {
  const adapter = stubAdapter('stub', { 20: 'LONG', 25: 'CLOSE' });
  const broker = createBroker({ commissionPct: 0, slippagePct: 0 });
  const candles = makeCandles(Array(40).fill(100));
  const result = runBacktest({ symbol: 'X', candles, adapter, broker, initialCapital: 10000, positionSizePct: 100 });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].holdingBars, 5);
});

// --- integration: real strategy on synthetic fixture (pipeline) ---
test('integration: emaCrossover backtest on synthetic fixture runs end-to-end', () => {
  const file = path.join(__dirname, 'fixtures', 'synthetic-15m.csv');
  const { candles } = loadCandles({ file });
  const adapter = loadStrategy('emaCrossover');
  const broker = createBroker({ commissionPct: 0.0004, slippagePct: 0.0002 });
  const result = runBacktest({ symbol: 'BTCUSDT', candles, adapter, broker, initialCapital: 10000, positionSizePct: 100 });
  assert.ok(Array.isArray(result.trades));
  assert.ok(Array.isArray(result.equityCurve));
  assert.equal(result.equityCurve.length, candles.length);
  assert.equal(typeof result.finalEquity, 'number');
});

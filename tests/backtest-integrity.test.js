// BACKTEST INTEGRITY AUDIT V2 tests.
// Verifies: position sizing, no implicit leverage, manual win/loss math,
// single-counting of fees and slippage, mark-to-market equity, forced end exit,
// total-return formula, expectancy units, gross/net profit factor, bar-level
// Sharpe/Sortino, exposure, buy-hold identity and max drawdown.

const { test } = require('node:test');
const assert = require('node:assert');
const { createPortfolio } = require('../src/research/backtest/portfolio');
const { createBroker } = require('../src/research/backtest/brokerSimulator');
const { runBacktest } = require('../src/research/backtest/backtester');
const { computeMetrics } = require('../src/research/metrics/performance');
const { maxDrawdown } = require('../src/research/metrics/drawdown');
const { buyAndHoldReference } = require('../src/research/experiments/runner');
const { makeCandles, stubAdapter } = require('./helpers');

const TOL = 1e-6;

function curve(equities, intervalMs = 900000) {
  return equities.map((e, i) => ({ timestamp: i * intervalMs, equity: e }));
}

// --- Manual winning trade (entry open 100 -> exit open 110) ---
test('manual winning trade: numbers match the independent formulas', () => {
  const broker = createBroker({ commissionPct: 0.0004, slippagePct: 0.0002 });
  const p = createPortfolio({ initialCapital: 10000, symbol: 'X', positionSizePct: 100, strategyName: 'stub' });
  p.openPosition({ timestamp: 1000, close: 100, index: 0 }, broker.entryFillPrice(100), broker);
  const t = p.closePosition({ timestamp: 2000, close: 110, index: 1 }, broker.exitFillPrice(110), broker);

  assert.ok(Math.abs(t.entryPrice - 100.02) < TOL, 'entry fill = 100 * (1+slip)');
  assert.ok(Math.abs(t.exitPrice - 109.978) < TOL, 'exit fill = 110 * (1-slip)');
  assert.ok(Math.abs(t.quantity - 99.94002798800496) < TOL);
  assert.ok(Math.abs(t.grossPnl - 995.2027987045547) < 1e-6);
  assert.ok(Math.abs(t.fees - 8.394882398970026) < 1e-6);
  assert.ok(Math.abs(t.netPnl - 986.8079163055846) < 1e-6);
  const finalEquity = p.state.cash; // flat after close
  assert.ok(Math.abs(finalEquity - 10986.807916305585) < 1e-6);
  assert.ok(Math.abs((finalEquity / 10000 - 1) * 100 - 9.868079163055853) < 1e-6);
});

// --- Manual losing trade (entry open 100 -> exit open 90) ---
test('manual losing trade: numbers match the independent formulas', () => {
  const broker = createBroker({ commissionPct: 0.0004, slippagePct: 0.0002 });
  const p = createPortfolio({ initialCapital: 10000, symbol: 'X', positionSizePct: 100, strategyName: 'stub' });
  p.openPosition({ timestamp: 1000, close: 100, index: 0 }, broker.entryFillPrice(100), broker);
  const t = p.closePosition({ timestamp: 2000, close: 90, index: 1 }, broker.exitFillPrice(90), broker);

  assert.ok(Math.abs(t.grossPnl - (-1003.1980009435935)) < 1e-6);
  assert.ok(Math.abs(t.fees - 7.595522079110767) < 1e-6);
  assert.ok(Math.abs(t.netPnl - (-1010.7935230227042)) < 1e-6);
  const finalEquity = p.state.cash;
  assert.ok(Math.abs(finalEquity - 8989.206476977295) < 1e-6);
  assert.ok(Math.abs((finalEquity / 10000 - 1) * 100 - (-10.10793523022705)) < 1e-6);
});

// --- Position sizing: no implicit leverage, no negative cash ---
test('position sizing: 100% outlay leaves cash >= 0 and notional <= equity (no leverage)', () => {
  const broker = createBroker({ commissionPct: 0.0004, slippagePct: 0.0002 });
  const p = createPortfolio({ initialCapital: 10000, symbol: 'X', positionSizePct: 100, strategyName: 'stub' });
  p.openPosition({ timestamp: 1000, close: 100, index: 0 }, broker.entryFillPrice(100), broker);
  assert.ok(p.state.cash >= 0, `cash must not go negative, got ${p.state.cash}`);
  const notional = p.state.position.quantity * p.state.position.entryPrice;
  assert.ok(notional < 10000, `notional ${notional} must be < equity`);
  assert.ok(p.state.position.quantity * p.state.position.entryPrice <= p.state.position.entryPrice * (10000 / p.state.position.entryPrice));
  assert.ok(p.state.position.quantity * p.state.position.entryPrice < 10000, 'no implicit leverage');
});

test('position sizing: 25% outlay leaves 75% cash', () => {
  const broker = createBroker({ commissionPct: 0.0004, slippagePct: 0 });
  const p = createPortfolio({ initialCapital: 10000, symbol: 'X', positionSizePct: 25, strategyName: 'stub' });
  p.openPosition({ timestamp: 0, close: 100, index: 0 }, 100, broker);
  assert.ok(Math.abs(p.state.cash - 7500) < TOL, `cash=${p.state.cash}`);
  assert.ok(Math.abs(p.state.position.quantity - 24.99000399960016) < TOL);
});

// --- Fee single counting ---
test('fee single counting: fees deducted once per fill; cash delta == netPnl == grossPnl - fees', () => {
  const broker = createBroker({ commissionPct: 0.0004, slippagePct: 0 });
  const p = createPortfolio({ initialCapital: 10000, symbol: 'X', positionSizePct: 100, strategyName: 'stub' });
  const before = p.state.cash;
  p.openPosition({ timestamp: 0, close: 100, index: 0 }, 100, broker);
  const entryFee = p.state.position.entryFees;
  const qty = p.state.position.quantity;
  const t = p.closePosition({ timestamp: 1, close: 110, index: 1 }, 110, broker);
  const exitFee = broker.commission(110 * qty);
  const cashDelta = p.state.cash - before;

  assert.ok(Math.abs(t.fees - (entryFee + exitFee)) < TOL, 'fees = entry fee (once) + exit fee (once)');
  assert.ok(Math.abs(t.netPnl - (t.grossPnl - t.fees)) < TOL, 'netPnl = grossPnl - fees (once)');
  assert.ok(Math.abs(cashDelta - t.netPnl) < TOL, 'cash moves by exactly netPnl (no double deduction)');
  assert.ok(t.fees > 0);
});

// --- Slippage single counting ---
test('slippage single counting: fills use open*(1+-slip) once; PnL derived from those fills', () => {
  const broker = createBroker({ commissionPct: 0, slippagePct: 0.0002 });
  const candles = makeCandles([100, 100, 110, 110], { openFn: (i) => [100, 100, 110, 110][i] });
  const adapter = stubAdapter('stub', { 1: 'LONG', 3: 'CLOSE' });
  const result = runBacktest({ symbol: 'X', candles, adapter, broker, initialCapital: 10000, positionSizePct: 100 });
  const t = result.trades[0];
  assert.ok(Math.abs(t.entryPrice - 100.02) < TOL);
  assert.ok(Math.abs(t.exitPrice - 109.978) < TOL);
  assert.ok(Math.abs(t.grossPnl - (t.exitPrice - t.entryPrice) * t.quantity) < TOL, 'grossPnl from fills, no extra slippage deduction');
});

// --- Mark-to-market equity ---
test('mark-to-market equity: equity = cash + quantity * close while in position', () => {
  const broker = createBroker({ commissionPct: 0, slippagePct: 0 });
  const p = createPortfolio({ initialCapital: 10000, symbol: 'X', positionSizePct: 100, strategyName: 'stub' });
  p.openPosition({ timestamp: 0, close: 100, index: 0 }, 100, broker);
  p.markToMarket({ timestamp: 1, close: 110 });
  assert.equal(p.state.cash, 0);
  assert.equal(p.state.equityCurve[0].equity, 11000); // 100 qty * 110 close
});

// --- Forced research exit at end ---
test('forced exit: open position at end is closed at last close and flagged forcedExit', () => {
  const broker = createBroker({ commissionPct: 0, slippagePct: 0 });
  const candles = makeCandles([100, 100, 105, 108]); // never a CLOSE signal
  const adapter = stubAdapter('stub', { 1: 'LONG' });
  const result = runBacktest({ symbol: 'X', candles, adapter, broker, initialCapital: 10000, positionSizePct: 100 });
  assert.equal(result.forcedExit, true);
  assert.equal(result.openPositionAtEnd, false);
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].forcedExit, true);
  assert.equal(result.trades[0].exitPrice, 108); // last close, slippage 0
  assert.ok(Math.abs(result.finalEquity - 10800) < TOL); // 100 qty * 108
});

// --- Total return formula ---
test('total return: 10000 -> 11000 equals exactly 10%', () => {
  const metrics = computeMetrics({
    initialCapital: 10000,
    finalEquity: 11000,
    equityCurve: curve([10000, 11000]),
    trades: [],
    intervalMs: 900000,
    barsTotal: 2,
    barsInPosition: 0,
  });
  assert.ok(Math.abs(metrics.totalReturnPct - 10) < 1e-9);
});

// --- Expectancy units ---
test('expectancy: outputs dollar and pct-per-trade explicitly', () => {
  const trades = [
    { netPnl: 20, grossPnl: 22, fees: 2, returnPct: 2 },
    { netPnl: -10, grossPnl: -9, fees: 1, returnPct: -1 },
  ];
  const metrics = computeMetrics({
    initialCapital: 10000,
    finalEquity: 10010,
    equityCurve: curve([10000, 10010]),
    trades,
    intervalMs: 900000,
    barsTotal: 2,
    barsInPosition: 0,
  });
  assert.equal(metrics.expectancyDollar, 5);
  assert.equal(metrics.expectancyPctPerTrade, 0.5);
  assert.equal(metrics.expectancy, 5); // backward-compat alias = dollar
});

// --- Gross / Net profit factor ---
test('profit factor: gross and net are separate and clearly labeled', () => {
  const trades = [
    { netPnl: 8, grossPnl: 10, fees: 2 },
    { netPnl: -7, grossPnl: -6, fees: 1 },
    { netPnl: 11, grossPnl: 12, fees: 1 },
    { netPnl: -4, grossPnl: -4, fees: 0 },
  ];
  const metrics = computeMetrics({
    initialCapital: 10000,
    finalEquity: 10008,
    equityCurve: curve([10000, 10008]),
    trades,
    intervalMs: 900000,
    barsTotal: 2,
    barsInPosition: 0,
  });
  assert.ok(Math.abs(metrics.grossProfitFactor - 2.2) < TOL); // 22 / 10
  assert.ok(Math.abs(metrics.netProfitFactor - (19 / 11)) < TOL); // 19 / 11
});

// --- Bar-level Sharpe & Sortino (deterministic) ---
test('sharpe/sortino: bar-level returns, annualized by 15m periodsPerYear', () => {
  const equities = [100, 110, 105, 112];
  const metrics = computeMetrics({
    initialCapital: 100,
    finalEquity: 112,
    equityCurve: curve(equities),
    trades: [],
    intervalMs: 900000,
    barsTotal: 4,
    barsInPosition: 0,
  });
  const returns = [];
  for (let i = 1; i < equities.length; i++) returns.push(equities[i] / equities[i - 1] - 1);
  const mu = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(returns.map((r) => (r - mu) ** 2).reduce((a, b) => a + b, 0) / returns.length);
  const downside = Math.sqrt(returns.map((r) => (r < 0 ? r * r : 0)).reduce((a, b) => a + b, 0) / returns.length);
  const ppy = 35040;
  assert.ok(Math.abs(metrics.sharpe - (mu / std) * Math.sqrt(ppy)) < 1e-9);
  assert.ok(Math.abs(metrics.sortino - (mu / downside) * Math.sqrt(ppy)) < 1e-9);
});

// --- Exposure = barsInMarket / totalBars ---
test('exposure: uses bars-in-market fraction, not trade count', () => {
  const broker = createBroker({ commissionPct: 0, slippagePct: 0 });
  const candles = makeCandles([100, 100, 100, 100]); // entry bar1 open, exit bar3 open
  const adapter = stubAdapter('stub', { 1: 'LONG', 3: 'CLOSE' });
  const result = runBacktest({ symbol: 'X', candles, adapter, broker, initialCapital: 10000, positionSizePct: 100 });
  const metrics = computeMetrics({
    initialCapital: 10000,
    finalEquity: result.finalEquity,
    equityCurve: result.equityCurve,
    trades: result.trades,
    intervalMs: 900000,
    barsTotal: result.barsTotal,
    barsInPosition: result.barsInPosition,
  });
  assert.equal(result.barsInPosition, 2); // bars 1 and 2
  assert.equal(metrics.exposurePct, 50); // 2 / 4
});

// --- Max drawdown independent check ---
test('max drawdown: [100,120,90,110,80,130] -> peak 120 (idx1), trough 80 (idx4), 33.33%', () => {
  const dd = maxDrawdown(curve([100, 120, 90, 110, 80, 130]));
  assert.ok(Math.abs(dd.maxDrawdownPct - (40 / 120) * 100) < 0.001, `got ${dd.maxDrawdownPct}`);
  assert.equal(dd.peakIndex, 1);
  assert.equal(dd.troughIndex, 4);
});

// --- Buy-hold identity (zero-cost) ---
test('buy-hold identity: zero-cost all-in LONG via backtester == BUY_AND_HOLD_REFERENCE', () => {
  const closes = [];
  for (let i = 0; i < 500; i++) closes.push(100 + (i % 7) * 0.5);
  // flat opens so entry timing (bar0 vs bar1 open) does not matter
  const candles = makeCandles(closes, { openFn: () => 100 });

  const ref = buyAndHoldReference(candles, { commissionPct: 0, slippagePct: 0 });

  const broker = createBroker({ commissionPct: 0, slippagePct: 0 });
  const adapter = stubAdapter('stub', { 1: 'LONG' }); // enter bar1 open, forced exit last close
  const result = runBacktest({ symbol: 'X', candles, adapter, broker, initialCapital: 10000, positionSizePct: 100 });

  const stratReturn = (result.finalEquity / 10000 - 1) * 100;
  assert.ok(Math.abs(stratReturn - ref.totalReturnPct) < 1e-6,
    `strategy ${stratReturn} vs reference ${ref.totalReturnPct}`);
});

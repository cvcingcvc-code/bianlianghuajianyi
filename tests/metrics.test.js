const { test } = require('node:test');
const assert = require('node:assert');
const { createPortfolio } = require('../src/research/backtest/portfolio');
const { createBroker } = require('../src/research/backtest/brokerSimulator');
const { computeMetrics } = require('../src/research/metrics/performance');
const { maxDrawdown } = require('../src/research/metrics/drawdown');

function curve(equities, intervalMs = 900000) {
  return equities.map((e, i) => ({ timestamp: i * intervalMs, equity: e }));
}

// --- PnL calculation (test case 10) ---
test('PnL: LONG round trip without costs', () => {
  const broker = createBroker({ commissionPct: 0, slippagePct: 0 });
  const p = createPortfolio({ initialCapital: 10000, symbol: 'X', positionSizePct: 100, strategyName: 'stub' });
  p.openPosition({ timestamp: 1000, close: 100, index: 0 }, 100, broker);
  const t = p.closePosition({ timestamp: 2000, close: 110, index: 1 }, 110, broker);
  assert.equal(t.quantity, 100);            // 10000 / 100
  assert.equal(t.grossPnl, 1000);           // (110-100) * 100
  assert.equal(t.fees, 0);
  assert.equal(t.netPnl, 1000);
  assert.equal(t.returnPct, 10);            // 1000 / 10000 * 100
  assert.equal(t.holdingBars, 1);
});

test('PnL: round trip at same price with commission + slippage loses money', () => {
  const broker = createBroker({ commissionPct: 0.0004, slippagePct: 0.0002 });
  const p = createPortfolio({ initialCapital: 10000, symbol: 'X', positionSizePct: 100, strategyName: 'stub' });
  p.openPosition({ timestamp: 1000, close: 100, index: 0 }, broker.entryFillPrice(100), broker);
  const t = p.closePosition({ timestamp: 2000, close: 100, index: 1 }, broker.exitFillPrice(100), broker);
  assert.ok(t.entryPrice > 100, 'entry fill must be above open due to slippage');
  assert.ok(t.exitPrice < 100, 'exit fill must be below open due to slippage');
  assert.ok(t.grossPnl < 0, 'round trip at same price must lose on slippage');
  assert.ok(t.fees > 0, 'fees must be charged on both fills');
  assert.ok(t.netPnl < 0, 'net must be negative after costs');
});

// --- Maximum Drawdown (test case 11) ---
test('maximum drawdown: tracked from running peak', () => {
  const dd = maxDrawdown(curve([100, 120, 110, 130, 80, 90]));
  assert.ok(Math.abs(dd.maxDrawdownPct - (50 / 130) * 100) < 0.001);
  assert.equal(dd.maxDrawdownAbs, 50);
  assert.equal(dd.peakIndex, 3);
  assert.equal(dd.troughIndex, 4);
});

test('maximum drawdown: monotonically rising curve has zero drawdown', () => {
  const dd = maxDrawdown(curve([100, 101, 102, 103]));
  assert.equal(dd.maxDrawdownPct, 0);
});

// --- Sharpe (test case 12) ---
test('sharpe: annualized by 15m frequency', () => {
  const equities = [100, 101, 102];
  const metrics = computeMetrics({
    initialCapital: 100,
    finalEquity: 102,
    equityCurve: curve(equities),
    trades: [],
    intervalMs: 900000,
    barsTotal: 3,
    barsInPosition: 0,
  });
  const returns = [101 / 100 - 1, 102 / 101 - 1];
  const mu = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(returns.map((r) => (r - mu) ** 2).reduce((a, b) => a + b, 0) / returns.length);
  const ppy = (365 * 24 * 60 * 60 * 1000) / 900000;
  const expected = (mu / std) * Math.sqrt(ppy);
  assert.ok(metrics.sharpe !== null);
  assert.ok(Math.abs(metrics.sharpe - expected) < 1e-9);
});

test('sharpe: null when equity is constant (zero variance)', () => {
  const metrics = computeMetrics({
    initialCapital: 100,
    finalEquity: 100,
    equityCurve: curve([100, 100, 100]),
    trades: [],
    intervalMs: 900000,
    barsTotal: 3,
    barsInPosition: 0,
  });
  assert.equal(metrics.sharpe, null);
  assert.equal(metrics.sortino, null);
});

// --- Profit Factor (test case 13) ---
test('profit factor and win rate', () => {
  const trades = [
    { netPnl: 10, fees: 0 },
    { netPnl: 6, fees: 0 },
    { netPnl: -4, fees: 0 },
    { netPnl: -4, fees: 0 },
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
  assert.equal(metrics.grossProfit, 16);
  assert.equal(metrics.grossLoss, -8);
  assert.equal(metrics.profitFactor, 2);
  assert.equal(metrics.winRatePct, 50);
  assert.equal(metrics.avgWin, 8);
  assert.equal(metrics.avgLoss, -4);
  assert.equal(metrics.maxConsecutiveLoss, 2);
});

test('metrics: null values when there are no trades', () => {
  const metrics = computeMetrics({
    initialCapital: 10000,
    finalEquity: 10000,
    equityCurve: curve([10000, 10000, 10000]),
    trades: [],
    intervalMs: 900000,
    barsTotal: 3,
    barsInPosition: 0,
  });
  assert.equal(metrics.tradeCount, 0);
  assert.equal(metrics.winRatePct, null);
  assert.equal(metrics.profitFactor, null);
  assert.equal(metrics.expectancy, null);
  assert.equal(metrics.maxConsecutiveLoss, null);
});

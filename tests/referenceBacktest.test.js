// Independent reference backtest.
//
// This file deliberately does NOT import portfolio.js / brokerSimulator.js /
// tradeLedger.js. It re-implements a single LONG -> CLOSE trade with plain
// arithmetic, then proves the production backtester produces the same numbers.
// Guards against a shared buggy function being reused by every test.

const { test } = require('node:test');
const assert = require('node:assert');
const { runBacktest } = require('../src/research/backtest/backtester');
const { makeCandles, stubAdapter } = require('./helpers');

// ---- Independent manual calculator (no research modules) ----
// Executes: LONG signal at bar 0 close -> fill at bar 1 open,
//           CLOSE signal at bar 2 close -> fill at bar 3 open.
// Fee-inclusive sizing identical in spirit to the documented research model.
function manualSim(candles, { initialCapital = 10000, commissionPct = 0.0004, slippagePct = 0.0002 } = {}) {
  const entryFill = candles[1].open * (1 + slippagePct);
  const exitFill = candles[3].open * (1 - slippagePct);

  const budget = initialCapital; // fraction = 1.0
  const notional = budget / (1 + commissionPct);
  const entryFee = notional * commissionPct;
  const quantity = notional / entryFill;

  const exitNotional = exitFill * quantity;
  const exitFee = exitNotional * commissionPct;
  const grossPnl = (exitFill - entryFill) * quantity;
  const fees = entryFee + exitFee;
  const netPnl = grossPnl - fees;
  const finalEquity = initialCapital + netPnl;
  const totalReturnPct = (finalEquity / initialCapital - 1) * 100;

  return {
    entryFill, exitFill, quantity, entryFee, exitNotional, exitFee,
    grossPnl, fees, netPnl, finalEquity, totalReturnPct,
  };
}

function buildCandles() {
  // opens: bar0=100, bar1=100 (entry fill bar), bar2=110, bar3=110 (exit fill bar)
  return makeCandles([100, 100, 110, 110], { openFn: (i) => [100, 100, 110, 110][i] });
}

// Minimal broker interface defined inline — deliberately NOT importing
// brokerSimulator.js so this file stays an independent reference.
function makeBroker({ commissionPct, slippagePct }) {
  return {
    commissionPct,
    slippagePct,
    entryFillPrice: (open) => open * (1 + slippagePct),
    exitFillPrice: (open) => open * (1 - slippagePct),
    commission: (notional) => notional * commissionPct,
    fundingCost: () => 0,
    fundingIncluded: () => false,
  };
}

test('independent reference: production backtester matches manual math (winning trade)', () => {
  const candles = buildCandles();
  const expected = manualSim(candles, { commissionPct: 0.0004, slippagePct: 0.0002 });

  const broker = makeBroker({ commissionPct: 0.0004, slippagePct: 0.0002 });
  // stub: LONG on the 1st computeSignal call (bar 0), CLOSE on the 3rd (bar 2)
  const adapter = stubAdapter('stub', { 1: 'LONG', 3: 'CLOSE' });
  const result = runBacktest({ symbol: 'X', candles, adapter, broker, initialCapital: 10000, positionSizePct: 100 });

  assert.equal(result.trades.length, 1);
  const t = result.trades[0];
  const tol = 1e-6;
  assert.ok(Math.abs(t.entryPrice - expected.entryFill) < tol, `entry ${t.entryPrice} vs ${expected.entryFill}`);
  assert.ok(Math.abs(t.exitPrice - expected.exitFill) < tol, `exit ${t.exitPrice} vs ${expected.exitFill}`);
  assert.ok(Math.abs(t.quantity - expected.quantity) < tol);
  assert.ok(Math.abs(t.grossPnl - expected.grossPnl) < 1e-6);
  assert.ok(Math.abs(t.fees - expected.fees) < 1e-6);
  assert.ok(Math.abs(t.netPnl - expected.netPnl) < 1e-6);
  assert.ok(Math.abs(result.finalEquity - expected.finalEquity) < 1e-6);
  assert.ok(Math.abs((result.finalEquity / 10000 - 1) * 100 - expected.totalReturnPct) < 1e-6);
});

test('independent reference: production backtester matches manual math (losing trade)', () => {
  const candles = buildCandles();
  // exit bar open = 90 instead of 110
  candles[2].open = 90;
  candles[3].open = 90;
  candles[2].high = 95; candles[3].high = 95;
  candles[2].low = 88; candles[3].low = 88;
  const expected = manualSim(candles, { commissionPct: 0.0004, slippagePct: 0.0002 });

  const broker = makeBroker({ commissionPct: 0.0004, slippagePct: 0.0002 });
  const adapter = stubAdapter('stub', { 1: 'LONG', 3: 'CLOSE' });
  const result = runBacktest({ symbol: 'X', candles, adapter, broker, initialCapital: 10000, positionSizePct: 100 });

  const t = result.trades[0];
  assert.ok(Math.abs(t.grossPnl - expected.grossPnl) < 1e-6);
  assert.ok(Math.abs(t.netPnl - expected.netPnl) < 1e-6);
  assert.ok(Math.abs(result.finalEquity - expected.finalEquity) < 1e-6);
});

test('independent reference: zero-cost trade has zero fees and exact gross PnL', () => {
  const candles = buildCandles();
  const expected = manualSim(candles, { commissionPct: 0, slippagePct: 0 });

  const broker = makeBroker({ commissionPct: 0, slippagePct: 0 });
  const adapter = stubAdapter('stub', { 1: 'LONG', 3: 'CLOSE' });
  const result = runBacktest({ symbol: 'X', candles, adapter, broker, initialCapital: 10000, positionSizePct: 100 });

  const t = result.trades[0];
  assert.equal(t.fees, 0);
  assert.equal(t.netPnl, t.grossPnl);
  assert.ok(Math.abs(t.grossPnl - expected.grossPnl) < 1e-6);
});

const { test } = require('node:test');
const assert = require('node:assert');
const { createBroker, createFundingProvider } = require('../src/research/backtest/brokerSimulator');

test('commission calculation (test case 8)', () => {
  const b = createBroker({ commissionPct: 0.0004, slippagePct: 0 });
  assert.ok(Math.abs(b.commission(1000) - 0.4) < 1e-12);
  assert.ok(Math.abs(b.commission(25000) - 10) < 1e-9);
});

test('slippage calculation (test case 9)', () => {
  const b = createBroker({ commissionPct: 0, slippagePct: 0.0002 });
  assert.ok(Math.abs(b.entryFillPrice(100) - 100.02) < 1e-9); // long entry: open x (1+slip)
  assert.ok(Math.abs(b.exitFillPrice(100) - 99.98) < 1e-9);   // exit: open x (1-slip)
});

test('broker: rejects invalid commission/slippage', () => {
  assert.throws(() => createBroker({ commissionPct: -0.1 }), /commissionPct/);
  assert.throws(() => createBroker({ commissionPct: 1 }), /commissionPct/);
  assert.throws(() => createBroker({ slippagePct: 1.5 }), /slippagePct/);
});

test('funding: default provider returns 0 and reports not included', () => {
  const b = createBroker();
  assert.equal(b.fundingCost({ symbol: 'X', quantity: 1 }, { timestamp: 0, close: 100 }), 0);
  assert.equal(b.fundingIncluded(), false);
});

test('funding: constant provider computes cost and reports included', () => {
  const bp = createBroker({
    fundingProvider: createFundingProvider({ type: 'constant', rate: 0.001 }),
  });
  assert.equal(bp.fundingIncluded(), true);
  assert.ok(Math.abs(bp.fundingCost({ symbol: 'X', quantity: 2 }, { timestamp: 0, close: 100 }) - 0.2) < 1e-9);
});

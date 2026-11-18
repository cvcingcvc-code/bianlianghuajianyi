const { test } = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');

const { processChartTicks } = require('../src/market/streams');
const { state } = require('../src/state/database');
const repository = require('../src/state/repository');
const orderExecutor = require('../src/execution/orderExecutor');
const positionTracker = require('../src/execution/positionTracker');
const riskManager = require('../src/risk/manager');
const feishuCommands = require('../src/logger/feishuCommands');
const circuitBreaker = require('../src/risk/circuitBreaker');

function createSilentLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    trade: () => {},
    signal: () => {},
  };
}

function resetMemoryState() {
  state.trades = [];
  state.positions = {};
  state.dailyStats = { date: new Date().toISOString().slice(0, 10), startBalance: 1000, currentBalance: 1000, realizedPnl: 0, tradeCount: 0, winningTrades: 0 };
  state.breakers = {};
  state.eventLog = [];
  state.appState = { schema_version: 1, consecutiveLosses: 0, apiErrors: 0, apiErrorWindowStart: 0 };
  state.orderIndex = {};
}

test('processChartTicks: open candle (isFinal=false) is NOT blacklisted before closing (isFinal=true)', () => {
  const seen = new Set();
  const emitted = [];
  const emitFn = (ev, payload) => emitted.push(payload);

  // Batch 1: 2 historical closed candles + 1 live open candle
  processChartTicks('BTCUSDT', '15m', {
    '1000': { open: '100', high: '101', low: '99', close: '100.5', volume: '10' },
    '2000': { open: '100.5', high: '102', low: '100', close: '101', volume: '12' },
    '3000': { open: '101', high: '103', low: '101', close: '102', volume: '5', isFinal: false },
  }, seen, emitFn);

  assert.equal(emitted.length, 3);
  assert.equal(emitted[0].warmup, true);
  assert.equal(emitted[0].isFinal, true);
  assert.equal(emitted[1].warmup, true);
  assert.equal(emitted[1].isFinal, true);
  assert.equal(emitted[2].warmup, false);
  assert.equal(emitted[2].isFinal, false);
  assert.equal(seen.has('3000'), false, 'open candle must not be marked finalized');

  // Batch 2: candle 3000 closes (isFinal undefined / true), candle 4000 opens
  emitted.length = 0;
  processChartTicks('BTCUSDT', '15m', {
    '1000': { open: '100', high: '101', low: '99', close: '100.5', volume: '10' },
    '2000': { open: '100.5', high: '102', low: '100', close: '101', volume: '12' },
    '3000': { open: '101', high: '104', low: '101', close: '103.5', volume: '25' },
    '4000': { open: '103.5', high: '104', low: '103', close: '103.8', volume: '2', isFinal: false },
  }, seen, emitFn);

  assert.equal(emitted.length, 2, 'closed candle 3000 and new open candle 4000 must emit; 1000 & 2000 skipped');
  assert.equal(emitted[0].close, 103.5);
  assert.equal(emitted[0].isFinal, true);
  assert.equal(emitted[0].warmup, false);
  assert.equal(seen.has('3000'), true);
});

test('orderExecutor: SL failure does NOT re-execute market buy and immediately unwinds with reduceOnly', async () => {
  resetMemoryState();
  const bus = new EventEmitter();
  const logger = createSilentLogger();
  let marketBuyCount = 0;
  let unwindSellCalls = [];
  let futuresOrderCalls = [];

  const mockBinance = {
    futuresLeverage: async () => {},
    futuresMarginType: async () => {},
    futuresMarketBuy: async () => {
      marketBuyCount++;
      return { avgPrice: '50000' };
    },
    futuresOrder: async (side, symbol, qty, price, params) => {
      futuresOrderCalls.push({ side, symbol, qty, price, params });
      throw new Error('Invalid trigger price');
    },
    futuresMarketSell: async (symbol, qty, params) => {
      unwindSellCalls.push({ symbol, qty, params });
      return { avgPrice: '49990' };
    },
  };

  orderExecutor.init({ dryRun: false, orderRetryAttempts: 2 }, mockBinance, repository, bus, logger);

  await orderExecutor.handleApproved({
    action: 'OPEN',
    symbol: 'BTCUSDT',
    side: 'BUY',
    quantity: 0.01,
    leverage: 10,
    stopLossPrice: 49000,
    takeProfitPrice: 52000,
    signal: { price: 50000 },
  });

  assert.equal(marketBuyCount, 1, 'market buy must execute ONLY ONCE even when SL retries');
  assert.equal(futuresOrderCalls.length, 2, 'SL order retried according to orderRetryAttempts');
  assert.equal(futuresOrderCalls[0].price, false);
  assert.equal(futuresOrderCalls[0].params.type, 'STOP_MARKET');
  assert.equal(futuresOrderCalls[0].params.reduceOnly, true);
  assert.equal(unwindSellCalls.length, 1, 'position must be immediately unwound on SL failure');
  assert.deepEqual(unwindSellCalls[0], { symbol: 'BTCUSDT', qty: 0.01, params: { reduceOnly: true } });
  assert.equal(repository.hasPosition('BTCUSDT'), false, 'unwound position must not remain open in state');
});

test('repository & positionTracker: WS ACCOUNT_UPDATE preserves SL/TP order IDs and removes closed positions', () => {
  resetMemoryState();
  const bus = new EventEmitter();
  positionTracker.init({}, repository, bus, createSilentLogger());

  repository.upsertPosition({
    symbol: 'ETHUSDT',
    side: 'LONG',
    entryPrice: 3000,
    quantity: 0.5,
    leverage: 10,
    stopLossPrice: 2940,
    takeProfitPrice: 3120,
    stopLossOrderId: 'SL_123',
    takeProfitOrderId: 'TP_456',
  });

  // Partial WS position update without order IDs
  bus.emit('accountUpdate', {
    a: {
      B: [{ a: 'USDT', wb: '1050.5', cw: '1050.5' }],
      P: [{ s: 'ETHUSDT', pa: '0.5', ep: '3000', up: '15.2' }],
    },
  });

  const pos = repository.getPosition('ETHUSDT');
  assert.equal(pos.stopLossOrderId, 'SL_123', 'SL order ID must be preserved across WS updates');
  assert.equal(pos.takeProfitOrderId, 'TP_456', 'TP order ID must be preserved across WS updates');
  assert.equal(pos.unrealizedPnl, 15.2);
  assert.equal(positionTracker.getAccountInfo().totalWalletBalance, 1050.5);

  // WS position update with 0 amount (exchange closed via SL/TP)
  let closedEvent = null;
  bus.on('positionClosed', (e) => { closedEvent = e; });
  bus.emit('accountUpdate', {
    a: { P: [{ s: 'ETHUSDT', pa: '0', ep: '0', up: '0' }] },
  });

  assert.equal(repository.hasPosition('ETHUSDT'), false, 'zeroed position must be removed');
  assert.ok(closedEvent && closedEvent.symbol === 'ETHUSDT');
});

test('feishuCommands: /close invokes real orderExecutor.closePosition instead of local-only delete', async () => {
  resetMemoryState();
  const bus = new EventEmitter();
  const logger = createSilentLogger();
  let marketSellCalled = false;
  let canceledOrders = [];

  const mockBinance = {
    futuresCancel: async (sym, oid) => { canceledOrders.push(oid); },
    futuresMarketSell: async () => {
      marketSellCalled = true;
      return { avgPrice: '3100' };
    },
  };

  repository.upsertPosition({
    symbol: 'ETHUSDT',
    side: 'LONG',
    entryPrice: 3000,
    quantity: 1,
    leverage: 5,
    stopLossOrderId: 'SL_1',
    takeProfitOrderId: 'TP_1',
  });

  orderExecutor.init({ dryRun: false, orderRetryAttempts: 1 }, mockBinance, repository, bus, logger);
  feishuCommands.init({ maxOpenPositions: 3 }, repository, bus, logger, orderExecutor, { getStatus: () => ({ name: 'rsiEma' }) });

  let replyMsg = '';
  await feishuCommands.handleMessage('/close ethusdt', (msg) => { replyMsg = msg; });

  assert.equal(marketSellCalled, true, 'must call exchange market sell');
  assert.deepEqual(canceledOrders, ['SL_1', 'TP_1'], 'must cancel existing protective orders');
  assert.equal(repository.hasPosition('ETHUSDT'), false);
  assert.match(replyMsg, /已执行平仓 ETHUSDT/);
});

test('riskManager & circuitBreaker: signal cooldown, SHORT symmetry, and circuitBreakerTripped event parity', () => {
  resetMemoryState();
  const bus = new EventEmitter();
  const logger = createSilentLogger();

  const mockPosTracker = {
    getAccountInfo: () => ({ totalWalletBalance: 1000 }),
    getSymbolInfo: () => ({ stepSize: 0.001, tickSize: 0.1, minQty: 0.001 }),
    getMarkPrices: () => ({ BTCUSDT: 50000 }),
  };

  orderExecutor.init({ dryRun: true, orderRetryAttempts: 1 }, {}, repository, bus, logger);
  riskManager.init({
    dailyLossCapPct: 5,
    maxOpenPositions: 3,
    positionSizePct: 5,
    maxLeverage: 10,
    maxNotionalPerTrade: 0,
    stopLossPct: 2,
    takeProfitPct: 4,
    signalCooldownSeconds: 300,
  }, repository, bus, logger, mockPosTracker);

  const approved = [];
  const rejected = [];
  bus.on('riskApproved', (d) => approved.push(d));
  bus.on('riskRejected', (d) => rejected.push(d));

  // 1. Symmetric SHORT entry approval
  bus.emit('strategySignal', { symbol: 'BTCUSDT', direction: 'SHORT', price: 50000, reason: 'test short' });
  assert.equal(approved.length, 1);
  assert.equal(approved[0].side, 'SELL');
  assert.equal(approved[0].stopLossPrice, 51000);
  assert.equal(approved[0].takeProfitPrice, 48000);

  // Close it, then immediately re-signal within 300s cooldown
  repository.removePosition('BTCUSDT');
  bus.emit('strategySignal', { symbol: 'BTCUSDT', direction: 'LONG', price: 50000, reason: 'cooldown test' });
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /Signal cooldown/);

  // 2. Circuit breaker emits circuitBreakerTripped with durationMinutes after 5 losses
  let trippedPayload = null;
  bus.on('circuitBreakerTripped', (p) => { trippedPayload = p; });
  for (let i = 0; i < 5; i++) {
    bus.emit('positionClosed', { symbol: 'ETHUSDT', pnl: -10 });
  }
  assert.ok(trippedPayload, 'circuitBreakerTripped must fire');
  assert.equal(trippedPayload.durationMinutes, 60);
  assert.equal(circuitBreaker.check(repository), true);
});

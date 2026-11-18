const { test } = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');

const { state } = require('../src/state/database');
const repository = require('../src/state/repository');
const orderExecutor = require('../src/execution/orderExecutor');
const positionTracker = require('../src/execution/positionTracker');

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
  state.dailyStats = {
    date: new Date().toISOString().slice(0, 10),
    startBalance: 0,
    currentBalance: 0,
    realizedPnl: 0,
    grossPnl: 0,
    totalCommission: 0,
    tradeCount: 0,
    winningTrades: 0,
  };
  state.breakers = {};
  state.eventLog = [];
  state.appState = { schema_version: 1, consecutiveLosses: 0, apiErrors: 0, apiErrorWindowStart: 0 };
  state.orderIndex = {};
  state.settledOrders = {};
}

test('P2-1: syncAccount backfills active SL/TP orderIds from futuresOpenOrders and clears stale IDs', async () => {
  resetMemoryState();
  const bus = new EventEmitter();
  const logger = createSilentLogger();

  // Pre-seed a stale ghost position and a BTC position with outdated order IDs
  repository.upsertPosition({ symbol: 'SOLUSDT', side: 'LONG', entryPrice: 150, quantity: 2, leverage: 5 });
  repository.upsertPosition({ symbol: 'BTCUSDT', side: 'LONG', entryPrice: 50000, quantity: 0.02, leverage: 10, stopLossOrderId: 'OLD_SL' });

  const mockBinance = {
    futuresAccount: async () => ({
      totalWalletBalance: '2000.00',
      availableBalance: '1900.00',
      totalUnrealizedProfit: '10.00',
      totalMarginBalance: '2010.00',
    }),
    futuresPositionRisk: async () => ([
      { symbol: 'BTCUSDT', positionAmt: '0.02', entryPrice: '50000', leverage: '10' },
      { symbol: 'ETHUSDT', positionAmt: '-0.5', entryPrice: '3000', leverage: '5' },
    ]),
    futuresOpenOrders: async () => ([
      { orderId: 9001, symbol: 'BTCUSDT', side: 'SELL', type: 'STOP_MARKET', status: 'NEW', stopPrice: '49000' },
      { orderId: 9002, symbol: 'BTCUSDT', side: 'SELL', type: 'TAKE_PROFIT_MARKET', status: 'NEW', stopPrice: '52000' },
      // ETHUSDT intentionally has NO open SL/TP orders on exchange
    ]),
    futuresExchangeInfo: async () => ({
      symbols: [
        {
          symbol: 'BTCUSDT',
          contractType: 'PERPETUAL',
          filters: [
            { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
            { filterType: 'PRICE_FILTER', tickSize: '0.1' },
          ],
        },
      ],
    }),
  };

  positionTracker.init(mockBinance, repository, bus, logger, { dryRun: false, stopLossPct: 2 });
  await positionTracker.syncAccount();

  assert.equal(repository.hasPosition('SOLUSDT'), false, 'ghost position removed');

  const btc = repository.getPosition('BTCUSDT');
  assert.equal(btc.stopLossOrderId, 9001);
  assert.equal(btc.stopLossPrice, 49000);
  assert.equal(btc.takeProfitOrderId, 9002);
  assert.equal(btc.takeProfitPrice, 52000);

  const eth = repository.getPosition('ETHUSDT');
  assert.equal(eth.side, 'SHORT');
  assert.equal(eth.stopLossOrderId, null, 'missing exchange SL sets stopLossOrderId to null');
  assert.equal(repository.getDailyStats().startBalance, 2000);
});

test('P2-2 & P2-3: reconcilePositions auto-repairs missing SL, removes ghosts, and runs on wsReconnected without resetting startBalance', async () => {
  resetMemoryState();
  repository.setStartBalance(1000); // Morning start balance = 1000 USDT

  const bus = new EventEmitter();
  const logger = createSilentLogger();
  const placedOrders = [];
  const alerts = [];
  bus.on('reconcileAlert', (a) => alerts.push(a));

  // Local ghost position that was closed while WS was disconnected
  repository.upsertPosition({ symbol: 'DOGEUSDT', side: 'LONG', entryPrice: 0.1, quantity: 100, leverage: 5 });

  const mockBinance = {
    futuresAccount: async () => ({
      totalWalletBalance: '1125.50', // Balance grew intraday; startBalance must stay 1000!
      availableBalance: '1000.00',
      totalUnrealizedProfit: '0',
      totalMarginBalance: '1125.50',
    }),
    futuresPositionRisk: async () => ([
      // Naked BTCUSDT LONG on exchange with NO stop-loss order!
      { symbol: 'BTCUSDT', positionAmt: '0.01', entryPrice: '50000', leverage: '10' },
    ]),
    futuresOpenOrders: async () => ([]),
    futuresOrder: async (side, symbol, qty, price, params) => {
      placedOrders.push({ side, symbol, qty, price, params });
      return { orderId: 'REPAIRED_SL_777' };
    },
  };

  const cfg = { dryRun: false, stopLossPct: 2, orderRetryAttempts: 1, reconcileIntervalSeconds: 300 };
  orderExecutor.init(cfg, mockBinance, repository, bus, logger);
  positionTracker.init(mockBinance, repository, bus, logger, cfg, orderExecutor);

  // Trigger via P2-3 wsReconnected event
  bus.emit('wsReconnected', { attempts: 1 });
  await new Promise((r) => setTimeout(r, 30));

  // 1. Naked BTCUSDT position got an automatic STOP_MARKET @ 49000 (2% below 50000)
  assert.equal(placedOrders.length, 1);
  assert.equal(placedOrders[0].side, 'SELL');
  assert.equal(placedOrders[0].symbol, 'BTCUSDT');
  assert.equal(placedOrders[0].qty, 0.01);
  assert.equal(placedOrders[0].params.type, 'STOP_MARKET');
  assert.equal(placedOrders[0].params.stopPrice, 49000);
  assert.equal(placedOrders[0].params.reduceOnly, true);

  const btc = repository.getPosition('BTCUSDT');
  assert.equal(btc.stopLossOrderId, 'REPAIRED_SL_777');
  assert.equal(btc.stopLossPrice, 49000);

  // 2. Local ghost DOGEUSDT was removed
  assert.equal(repository.hasPosition('DOGEUSDT'), false);

  // 3. Alerts fired for both self-healing SL and ghost cleanup
  assert.ok(alerts.some((a) => a.type === 'missing_sl_repaired' && a.symbol === 'BTCUSDT'));
  assert.ok(alerts.some((a) => a.type === 'ghost_position_removed' && a.symbol === 'DOGEUSDT'));

  // 4. Intraday balance updated to 1125.50 while startBalance stayed 1000
  const stats = repository.getDailyStats();
  assert.equal(stats.startBalance, 1000, 'startBalance must NOT be overwritten on reconnect');
  assert.equal(stats.currentBalance, 1125.5);
});

test('P2-4: accurate commission & realizedProfit accounting with REST+WS idempotency (no double-counting)', async () => {
  resetMemoryState();
  repository.setStartBalance(1000);

  const bus = new EventEmitter();
  const logger = createSilentLogger();

  const mockBinance = {
    futuresCancel: async () => {},
    futuresMarketSell: async () => ({
      orderId: 5002,
      avgPrice: '3000.50', // Gross diff = +0.50 USDT before fees
    }),
  };

  const cfg = { dryRun: false, orderRetryAttempts: 1 };
  orderExecutor.init(cfg, mockBinance, repository, bus, logger);
  positionTracker.init(mockBinance, repository, bus, logger, cfg, orderExecutor);

  // 1. Entry WS fill arrives with 1.20 USDT commission (duplicate WS event sent twice to verify idempotency)
  const entryWsEvent = {
    o: {
      i: 5001,
      s: 'ETHUSDT',
      S: 'BUY',
      o: 'MARKET',
      X: 'FILLED',
      q: '1',
      z: '1',
      ap: '3000',
      n: '1.20',
      N: 'USDT',
      rp: '0',
    },
  };
  bus.emit('orderUpdate', entryWsEvent);
  bus.emit('orderUpdate', entryWsEvent); // duplicate push

  let stats = repository.getDailyStats();
  assert.ok(Math.abs(stats.totalCommission - 1.2) < 1e-9);
  assert.ok(Math.abs(stats.realizedPnl - (-1.2)) < 1e-9, 'entry fee deducted once');
  assert.equal(stats.tradeCount, 0);

  // Seed open position
  repository.upsertPosition({ symbol: 'ETHUSDT', side: 'LONG', entryPrice: 3000, quantity: 1, leverage: 5 });

  // 2. Strategy closes via REST (orderId 5002): REST only knows gross +0.50, fee=0 initially -> provisional win
  await orderExecutor.handleApproved({ action: 'CLOSE', symbol: 'ETHUSDT', quantity: 1, reason: 'strategy_close' });

  stats = repository.getDailyStats();
  assert.equal(stats.tradeCount, 1);
  assert.equal(stats.winningTrades, 1, 'provisionally positive (+0.50) before WS fee arrives');
  assert.ok(Math.abs(stats.realizedPnl - (-0.7)) < 1e-9, '-1.20 + 0.50 = -0.70');

  // 3. 100ms later, WS ORDER_TRADE_UPDATE arrives for SAME orderId 5002 with exact realizedProfit=0.50 & commission=0.80
  // True close net PnL = 0.50 - 0.80 = -0.30 (actually a net LOSS on this close!)
  bus.emit('orderUpdate', {
    o: {
      i: 5002,
      s: 'ETHUSDT',
      S: 'SELL',
      o: 'MARKET',
      X: 'FILLED',
      R: true,
      q: '1',
      z: '1',
      ap: '3000.50',
      n: '0.80',
      N: 'USDT',
      rp: '0.50',
    },
  });

  stats = repository.getDailyStats();
  assert.equal(stats.tradeCount, 1, 'must NOT double-count tradeCount when WS follows REST');
  assert.equal(stats.winningTrades, 0, 'win count corrected from 1 -> 0 after 0.80 fee turns +0.50 gross into -0.30 net');
  assert.ok(Math.abs(stats.grossPnl - 0.5) < 1e-9);
  assert.ok(Math.abs(stats.totalCommission - 2.0) < 1e-9, '1.20 entry fee + 0.80 exit fee = 2.00');
  assert.ok(Math.abs(stats.realizedPnl - (-1.5)) < 1e-9, 'total net PnL = 0.50 gross - 2.00 fees = -1.50');
  assert.ok(Math.abs(stats.currentBalance - 998.5) < 1e-9);
});

const { test } = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');

const strategyEngine = require('../src/strategy/engine');
const breakout24h4h = require('../src/strategy/breakout24h4h');
const limits = require('../src/risk/limits');
const riskManager = require('../src/risk/manager');
const websocket = require('../src/market/websocket');
const { scanCsv, main: checkHoldoutMain } = require('../scripts/check-holdout-readiness');
const { state } = require('../src/state/database');
const repository = require('../src/state/repository');

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
    startBalance: 10000,
    currentBalance: 10000,
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

// -----------------------------------------------------------------------------
// P3-1: breakout24h4h live strategy adapter & strategyEngine registration
// -----------------------------------------------------------------------------
test('P3-1: strategyEngine registers and initializes breakout24h4h and breakout24h alias', () => {
  const bus = new EventEmitter();
  const logger = createSilentLogger();
  const mockRepo = { hasPosition: () => false };

  strategyEngine.init({ strategy: 'breakout24h4h', tradingPairs: ['BTCUSDT'] }, mockRepo, bus, logger);
  assert.equal(strategyEngine.getStatus().name, 'breakout24h4h');

  strategyEngine.init({ strategy: 'breakout24h', tradingPairs: ['ETHUSDT'] }, mockRepo, bus, logger);
  assert.equal(strategyEngine.getStatus().name, 'breakout24h4h');
});

test('P3-1: breakout24h4h adapter processes candles, emits LONG on breakout and tracks ATR', () => {
  const bus = new EventEmitter();
  const logger = createSilentLogger();
  let hasPos = false;
  const mockRepo = { hasPosition: (s) => hasPos };

  breakout24h4h.init({ tradingPairs: ['BTCUSDT'] });

  const signals = [];
  bus.on('strategySignal', (s) => signals.push(s));

  // Feed 55 upward-trending candles to establish EMA50 and past 24h highs (with warmup: true)
  let basePrice = 100;
  for (let i = 0; i < 55; i++) {
    basePrice += 1;
    const kline = {
      symbol: 'BTCUSDT',
      interval: '4h',
      open: basePrice - 0.5,
      high: basePrice + 0.5,
      low: basePrice - 0.5,
      close: basePrice,
      volume: 100,
      closeTime: 1700000000000 + i * 4 * 3600 * 1000,
      isFinal: true,
      warmup: true,
    };
    breakout24h4h.onTick(kline, mockRepo, bus, logger);
  }
  assert.equal(signals.length, 0, 'Warmup candles must produce no signals');

  // Next candle: sharp live breakout above all prior highs
  const breakoutPrice = 250;
  const breakoutKline = {
    symbol: 'BTCUSDT',
    interval: '4h',
    open: 200,
    high: breakoutPrice + 5,
    low: 195,
    close: breakoutPrice,
    volume: 500,
    closeTime: 1700000000000 + 56 * 4 * 3600 * 1000,
    isFinal: true,
    warmup: false,
  };
  breakout24h4h.onTick(breakoutKline, mockRepo, bus, logger);

  // A LONG signal should have been emitted
  const longSig = signals.find((s) => s.direction === 'LONG');
  assert.ok(longSig, 'Should emit a LONG signal on breakout');
  assert.equal(longSig.symbol, 'BTCUSDT');
  assert.equal(longSig.price, breakoutPrice);
  assert.ok(typeof longSig.atr === 'number' && longSig.atr > 0, 'Signal must include positive calculated ATR');

  // Now simulate having entered position and feed death-cross crash
  hasPos = true;
  signals.length = 0;
  for (let i = 0; i < 20; i++) {
    const crashKline = {
      symbol: 'BTCUSDT',
      interval: '4h',
      open: 150 - i * 5,
      high: 150 - i * 5,
      low: 140 - i * 5,
      close: 142 - i * 5,
      volume: 800,
      closeTime: 1700000000000 + (57 + i) * 4 * 3600 * 1000,
      isFinal: true,
      warmup: false,
    };
    breakout24h4h.onTick(crashKline, mockRepo, bus, logger);
    if (signals.some((s) => s.direction === 'CLOSE')) break;
  }
  const closeSig = signals.find((s) => s.direction === 'CLOSE');
  assert.ok(closeSig, 'Death cross must trigger CLOSE when holding position');

  // Verify non-final candles are ignored
  signals.length = 0;
  breakout24h4h.onTick({ ...breakoutKline, isFinal: false, close: 300 }, mockRepo, bus, logger);
  assert.equal(signals.length, 0, 'Non-final klines must produce no signals');

  // Verify getStatus reports health
  const status = breakout24h4h.getStatus();
  assert.ok(status.BTCUSDT.pricesCount > 0);
  assert.ok(status.BTCUSDT.highsCount > 0);
  assert.ok(status.BTCUSDT.currentAtr !== null);
});

// -----------------------------------------------------------------------------
// P3-2: Historical kline pre-warmup mechanism
// -----------------------------------------------------------------------------
test('P3-2: websocket.warmupKlines fetches candles via REST, tags them with warmup: true, and registers dedup', async () => {
  const bus = new EventEmitter();
  const logger = createSilentLogger();
  const emittedKlines = [];
  bus.on('kline', (k) => emittedKlines.push(k));

  websocket.init({ apiKey: '', secretKey: '', testnet: true, tradingPairs: ['BTCUSDT'] }, bus, logger);

  // Mock binance client returning 5 synthetic candles
  const mockBinance = {
    futuresCandles: async (sym, interval, opts) => {
      assert.equal(sym, 'BTCUSDT');
      assert.equal(interval, '4h');
      assert.equal(opts.limit, 5);
      return [
        [1000, '50000', '50500', '49500', '50200', '10', 1000 + 4 * 3600 * 1000],
        [2000, '50200', '50800', '50100', '50700', '12', 2000 + 4 * 3600 * 1000],
        [3000, '50700', '51000', '50600', '50900', '15', 3000 + 4 * 3600 * 1000],
        [4000, '50900', '51200', '50800', '51100', '11', 4000 + 4 * 3600 * 1000],
        [5000, '51100', '51500', '51000', '51400', '18', 5000 + 4 * 3600 * 1000],
      ];
    },
  };

  // Temporarily stub binance client
  const origBinance = websocket.getBinance();
  Object.assign(origBinance, mockBinance);

  const count = await websocket.warmupKlines(['BTCUSDT'], '4h', 5);
  assert.equal(count, 5);
  assert.equal(emittedKlines.length, 5);
  assert.equal(emittedKlines[0].warmup, true);
  assert.equal(emittedKlines[0].isFinal, true);
  assert.equal(emittedKlines[0].close, 50200);

  // Error handling: should gracefully return 0 on error without throwing
  origBinance.futuresCandles = async () => { throw new Error('Network timeout'); };
  const failCount = await websocket.warmupKlines(['BTCUSDT'], '4h', 5);
  assert.equal(failCount, 0);
});

// -----------------------------------------------------------------------------
// P3-3: ATR dynamic stop-loss & riskManager integration
// -----------------------------------------------------------------------------
test('P3-3: limits calculateAtrStopLoss and calculateAtrTakeProfit handle LONG and SHORT', () => {
  const entry = 50000;
  const atr = 1000;

  // LONG
  const slLong = limits.calculateAtrStopLoss(entry, atr, 2.0, 'LONG');
  const tpLong = limits.calculateAtrTakeProfit(entry, atr, 4.0, 'LONG');
  assert.equal(slLong, 48000); // 50000 - 2000
  assert.equal(tpLong, 54000); // 50000 + 4000

  // SHORT
  const slShort = limits.calculateAtrStopLoss(entry, atr, 2.0, 'SHORT');
  const tpShort = limits.calculateAtrTakeProfit(entry, atr, 4.0, 'SHORT');
  assert.equal(slShort, 52000); // 50000 + 2000
  assert.equal(tpShort, 46000); // 50000 - 4000
});

test('P3-3: riskManager uses ATR stop-loss when configured and falls back to percentage when ATR is missing', () => {
  resetMemoryState();
  const bus = new EventEmitter();
  const logger = createSilentLogger();

  const approved = [];
  bus.on('riskApproved', (a) => approved.push(a));

  const mockPositionTracker = {
    getAccountInfo: () => ({ totalWalletBalance: 10000 }),
    getSymbolInfo: () => ({ stepSize: 0.001, tickSize: 0.1 }),
    getMarkPrices: () => ({ BTCUSDT: 50000 }),
  };

  const config = {
    tradingPairs: ['BTCUSDT'],
    positionSizePct: 10,
    maxLeverage: 5,
    maxNotionalPerTrade: 0,
    stopLossMode: 'atr',
    stopLossAtrMultiplier: 2.0,
    takeProfitAtrMultiplier: 4.0,
    stopLossPct: 2.0,
    takeProfitPct: 4.0,
    signalCooldownSeconds: 0,
  };

  riskManager.init(config, repository, bus, logger, mockPositionTracker);

  // 1. Signal WITH ATR
  riskManager.handleSignal({
    symbol: 'BTCUSDT',
    direction: 'LONG',
    price: 50000,
    atr: 800,
  });

  assert.equal(approved.length, 1);
  assert.equal(approved[0].stopLossPrice, 48400); // 50000 - 800 * 2.0
  assert.equal(approved[0].takeProfitPrice, 53200); // 50000 + 800 * 4.0

  // 2. Clear state and test signal WITHOUT ATR (graceful fallback to stopLossPct=2%)
  resetMemoryState();
  approved.length = 0;
  riskManager.handleSignal({
    symbol: 'BTCUSDT',
    direction: 'LONG',
    price: 50000,
    atr: null,
  });

  assert.equal(approved.length, 1);
  assert.equal(approved[0].stopLossPrice, 49000); // 50000 * (1 - 0.02)
  assert.equal(approved[0].takeProfitPrice, 52000); // 50000 * (1 + 0.04)
});

// -----------------------------------------------------------------------------
// P3-4: 2026 Holdout readiness report and helper
// -----------------------------------------------------------------------------
test('P3-4: checkHoldoutMain executes and accurately reflects missing market data', async () => {
  const { allReady, results } = await checkHoldoutMain();
  // Since market csv files are gitignored in repository, allReady should be false
  assert.equal(allReady, false);
  assert.ok(results.BTCUSDT);
  assert.equal(results.BTCUSDT.marketStatus.exists, false);
  // Real funding csv files exist in repository
  assert.equal(results.BTCUSDT.fundingStatus.exists, true);
  assert.ok(results.BTCUSDT.fundingStatus.lineCount > 0);
});

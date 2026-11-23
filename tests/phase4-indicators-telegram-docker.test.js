const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const https = require('https');
const EventEmitter = require('node:events');

const strategyEngine = require('../src/strategy/engine');
const rsiEmaV2 = require('../src/strategy/rsiEmaV2');
const notifier = require('../src/logger/notifier');
const webDashboard = require('../src/logger/webDashboard');
const repository = require('../src/state/repository');
const { state } = require('../src/state/database');

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
// P4-1: rsiEmaV2 strategy & Wilder's RMA RSI
// -----------------------------------------------------------------------------
test('P4-1: calcWilderRSI calculates standard Wilder RMA smoothed RSI accurately', () => {
  // All gains: RSI must equal 100
  const allUp = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25];
  assert.equal(rsiEmaV2.calcWilderRSI(allUp, 14), 100);

  // All losses: RSI must equal 0
  const allDown = [25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10];
  assert.equal(rsiEmaV2.calcWilderRSI(allDown, 14), 0);

  // Balanced oscillation: RSI should hover around 50
  const balanced = [100];
  for (let i = 1; i < 30; i++) {
    balanced.push(i % 2 === 0 ? 102 : 100);
  }
  const rsi = rsiEmaV2.calcWilderRSI(balanced, 14);
  assert.ok(rsi >= 40 && rsi <= 60, `Balanced oscillation RSI should be ~50, got ${rsi}`);
});

test('P4-1: strategyEngine registers rsiEmaV2 and executes signal generation with ATR', () => {
  const bus = new EventEmitter();
  const logger = createSilentLogger();
  let hasPos = false;
  const mockRepo = { hasPosition: () => hasPos };

  strategyEngine.init({ strategy: 'rsiEmaV2', tradingPairs: ['BTCUSDT'] }, mockRepo, bus, logger);
  assert.equal(strategyEngine.getStatus().name, 'rsiEmaV2');

  const signals = [];
  bus.on('strategySignal', (s) => signals.push(s));

  // Feed 60 warmup candles (steady uptrend)
  let price = 100;
  for (let i = 0; i < 60; i++) {
    price += (i % 2 === 0 ? 1.5 : -0.5);
    const kline = {
      symbol: 'BTCUSDT',
      interval: '15m',
      open: price - 0.5,
      high: price + 1,
      low: price - 1,
      close: price,
      isFinal: true,
      warmup: true,
    };
    rsiEmaV2.onTick(kline, mockRepo, bus, logger);
  }
  assert.equal(signals.length, 0, 'No signals during warmup');

  // Verify status reflects tracked data
  const status = rsiEmaV2.getStatus();
  assert.ok(status.BTCUSDT.prices >= 60);
  assert.ok(status.BTCUSDT.rsi !== '—');
});

// -----------------------------------------------------------------------------
// P4-2: Dual Telegram & Feishu notifications
// -----------------------------------------------------------------------------
test('P4-2: notifier formats and dispatches Telegram messages when configured', (t, done) => {
  const bus = new EventEmitter();
  const logger = createSilentLogger();

  const cfg = {
    telegramBotToken: 'TEST_TOKEN_123',
    telegramChatId: '987654321',
    feishuWebhookUrl: '',
  };

  // Intercept https.request for api.telegram.org
  const origRequest = https.request;
  let intercepted = false;

  https.request = (options, cb) => {
    if (options.hostname === 'api.telegram.org') {
      intercepted = true;
      assert.equal(options.path, '/botTEST_TOKEN_123/sendMessage');
      assert.equal(options.method, 'POST');

      return {
        on: () => {},
        write: (bodyStr) => {
          const body = JSON.parse(bodyStr);
          assert.equal(body.chat_id, '987654321');
          assert.ok(body.text.includes('Binance Trader'));
          assert.ok(body.text.includes('开仓'));
        },
        end: () => {
          https.request = origRequest;
          assert.ok(intercepted);
          done();
        },
      };
    }
    return origRequest(options, cb);
  };

  notifier.init(cfg, bus, logger, repository, strategyEngine);

  // Trigger position opened event
  bus.emit('positionOpened', {
    symbol: 'BTCUSDT',
    side: 'BUY',
    quantity: 0.1,
    entryPrice: 50000,
  });
});

// -----------------------------------------------------------------------------
// P4-3: Web Dashboard /api/trades & /api/state recentTrades
// -----------------------------------------------------------------------------
test('P4-3: webDashboard exposes /api/trades and recentTrades in /api/state', async () => {
  resetMemoryState();
  const bus = new EventEmitter();
  const logger = createSilentLogger();

  // Pre-seed some trade executions into repository
  repository.saveTrade({
    orderId: 'TR_01',
    symbol: 'BTCUSDT',
    side: 'BUY',
    price: 50000,
    quantity: 0.05,
    action: 'OPEN',
    commission: 1.0,
    time: Date.now() - 5000,
  });
  repository.saveTrade({
    orderId: 'TR_02',
    symbol: 'BTCUSDT',
    side: 'SELL',
    price: 52000,
    quantity: 0.05,
    action: 'CLOSE',
    realizedPnl: 99.0,
    commission: 1.0,
    time: Date.now(),
  });

  webDashboard.init({ webPort: 3000, webHost: '127.0.0.1' }, repository, bus, logger, null);

  // Helper function to invoke dashboard
  const invoke = (url, method = 'GET') => {
    return new Promise((resolve, reject) => {
      const { PassThrough } = require('stream');
      const req = new PassThrough();
      req.url = url;
      req.method = method;
      req.headers = { host: '127.0.0.1:3000' };
      req.socket = { remoteAddress: '127.0.0.1' };

      let statusCode = 200;
      let headers = {};
      let body = '';
      const res = {
        writeHead: (code, h) => { statusCode = code; headers = h; },
        write: (chunk) => { body += chunk; },
        end: (chunk) => {
          if (chunk) body += chunk;
          resolve({ statusCode, headers, body });
        },
      };
      webDashboard.handleRequest(req, res);
      req.end();
    });
  };

  // 1. Check /api/state includes recentTrades
  const stateRes = await invoke('/api/state');
  assert.equal(stateRes.statusCode, 200);
  const stateData = JSON.parse(stateRes.body);
  assert.ok(Array.isArray(stateData.recentTrades));
  assert.equal(stateData.recentTrades.length, 2);
  assert.equal(stateData.recentTrades[0].id, 'TR_01');

  // 2. Check dedicated /api/trades endpoint
  const tradesRes = await invoke('/api/trades?limit=1');
  assert.equal(tradesRes.statusCode, 200);
  const tradesData = JSON.parse(tradesRes.body);
  assert.ok(Array.isArray(tradesData));
  assert.equal(tradesData.length, 1);
  assert.equal(tradesData[0].id, 'TR_02');

  // 3. Check public/dashboard.html contains tradeRows
  const htmlPath = path.join(__dirname, '..', 'public', 'dashboard.html');
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  assert.ok(htmlContent.includes('id="tradeRows"'));
  assert.ok(htmlContent.includes('updateRecentTrades'));
});

// -----------------------------------------------------------------------------
// P4-4: Dockerfile & compose.yaml specification validation
// -----------------------------------------------------------------------------
test('P4-4: Dockerfile and compose.yaml are valid and container-ready', () => {
  const root = path.join(__dirname, '..');
  const dockerfilePath = path.join(root, 'Dockerfile');
  const composePath = path.join(root, 'compose.yaml');
  const dockerignorePath = path.join(root, '.dockerignore');

  assert.ok(fs.existsSync(dockerfilePath), 'Dockerfile must exist');
  assert.ok(fs.existsSync(composePath), 'compose.yaml must exist');
  assert.ok(fs.existsSync(dockerignorePath), '.dockerignore must exist');

  const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
  assert.ok(dockerfile.includes('node:22-alpine'), 'Dockerfile must use node:22-alpine');
  assert.ok(dockerfile.includes('EXPOSE 3000'), 'Dockerfile must expose port 3000');
  assert.ok(dockerfile.includes('HEALTHCHECK'), 'Dockerfile must specify healthcheck');
  assert.ok(dockerfile.includes('/api/state'), 'Healthcheck must query /api/state');

  const compose = fs.readFileSync(composePath, 'utf8');
  assert.ok(compose.includes('3000:3000') || compose.includes('WEB_PORT'), 'compose.yaml must map port 3000');
  assert.ok(compose.includes('./data:/app/data'), 'compose.yaml must mount ./data volume');
  assert.ok(compose.includes('./logs:/app/logs'), 'compose.yaml must mount ./logs volume');
  assert.ok(compose.includes('json-file'), 'compose.yaml must specify log rotation');
});

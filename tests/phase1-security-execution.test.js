const { test } = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');
const { PassThrough } = require('node:stream');

const webDashboard = require('../src/logger/webDashboard');
const { syncFuturesServerTime } = require('../src/market/streams');
const { state } = require('../src/state/database');
const repository = require('../src/state/repository');
const orderExecutor = require('../src/execution/orderExecutor');

function invokeDashboard({ method = 'GET', url = '/', headers = {}, body = null, remoteAddress = '127.0.0.1' }) {
  return new Promise((resolve) => {
    const req = new PassThrough();
    req.method = method;
    req.url = url;
    req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    req.socket = { remoteAddress };

    let statusCode = 200;
    let resHeaders = {};
    const chunks = [];
    const res = {
      writeHead(code, hdrs = {}) {
        statusCode = code;
        resHeaders = hdrs;
      },
      write(chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      },
      end(chunk) {
        if (chunk !== undefined) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        resolve({ status: statusCode, headers: resHeaders, text, json });
      },
    };

    webDashboard.handleRequest(req, res);
    if (body !== null) {
      req.write(Buffer.from(body, 'utf8'));
    }
    req.end();
  });
}

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

test('P1-1 & P1-2 & P1-3: webDashboard loopback binding, admin token auth, Feishu verification, and 64KB body cap', async (t) => {
  resetMemoryState();
  const bus = new EventEmitter();
  const logger = createSilentLogger();
  const mockCmdHandler = {
    handleMessage: async (text, reply) => {
      reply(`echo:${text}`);
      return true;
    },
  };

  webDashboard.init({
    webPosOnly: true,
    webPort: 0, // ephemeral port to verify loopback bind address
    dashboardAdminToken: 'super-secret-admin-token',
    feishuVerificationToken: 'feishu-verify-token-123',
  }, repository, bus, logger, mockCmdHandler);

  const server = webDashboard.start();
  t.after(() => webDashboard.stop());

  await new Promise((resolve) => server.once('listening', resolve));
  const addr = server.address();
  assert.equal(addr.address, '127.0.0.1', 'P1-1: must bind strictly to 127.0.0.1 by default when webHost omitted');

  // 1. GET /api/state exposes authRequired boolean without leaking secret
  const stateRes = await invokeDashboard({ method: 'GET', url: '/api/state' });
  assert.equal(stateRes.status, 200);
  assert.equal(stateRes.json.authRequired, true);
  assert.equal(stateRes.text.includes('super-secret-admin-token'), false);

  // 2. POST /api/command without token -> 401
  const noAuthRes = await invokeDashboard({
    method: 'POST',
    url: '/api/command',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '/status' }),
  });
  assert.equal(noAuthRes.status, 401);

  // 3. POST /api/command with wrong token -> 401
  const badAuthRes = await invokeDashboard({
    method: 'POST',
    url: '/api/command',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
    body: JSON.stringify({ text: '/status' }),
  });
  assert.equal(badAuthRes.status, 401);

  // 4. POST /api/command with valid Bearer token -> 200
  const okAuthRes = await invokeDashboard({
    method: 'POST',
    url: '/api/command',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer super-secret-admin-token' },
    body: JSON.stringify({ text: '/status' }),
  });
  assert.equal(okAuthRes.status, 200);
  assert.equal(okAuthRes.json.reply, 'echo:/status');

  // 5. Non-loopback remote IP without configured token is blocked with 403
  const nonLoopbackCheck = webDashboard.authorizeCommand(
    { headers: {}, socket: { remoteAddress: '203.0.113.42' } },
    { dashboardAdminToken: '' }
  );
  assert.equal(nonLoopbackCheck.ok, false);
  assert.equal(nonLoopbackCheck.statusCode, 403);

  // 6. POST /feishu/callback rejects invalid verification token -> 401
  const badFeishu = await invokeDashboard({
    method: 'POST',
    url: '/feishu/callback',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'url_verification', token: 'forged-token', challenge: 'abc' }),
  });
  assert.equal(badFeishu.status, 401);

  // 7. POST /feishu/callback accepts valid verification token -> 200
  const goodFeishu = await invokeDashboard({
    method: 'POST',
    url: '/feishu/callback',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'url_verification', token: 'feishu-verify-token-123', challenge: 'xyz-ok' }),
  });
  assert.equal(goodFeishu.status, 200);
  assert.equal(goodFeishu.json.challenge, 'xyz-ok');

  // 8. Oversized payload (> 64KB) -> 413 Payload Too Large
  const hugePayload = JSON.stringify({ text: 'A'.repeat(70 * 1024) });
  const oversizedRes = await invokeDashboard({
    method: 'POST',
    url: '/api/command',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer super-secret-admin-token' },
    body: hugePayload,
  });
  assert.equal(oversizedRes.status, 413);
});

test('P1-4: syncFuturesServerTime computes server clock offset and updates client options', async () => {
  const simulatedDriftMs = 4200;
  const optionsSet = {};
  const mockBinance = {
    info: { timeOffset: 0 },
    futuresTime: async () => ({ serverTime: Date.now() + simulatedDriftMs }),
    setOption: (k, v) => { optionsSet[k] = v; },
  };

  const res = await syncFuturesServerTime(mockBinance, createSilentLogger());
  assert.ok(res);
  assert.ok(Math.abs(res.offset - simulatedDriftMs) < 200, `expected offset ~${simulatedDriftMs}, got ${res.offset}`);
  assert.equal(optionsSet.timeOffset, res.offset);
  assert.equal(optionsSet.useServerTime, true);
  assert.equal(mockBinance.info.timeOffset, res.offset);
});

test('P1-5: orderExecutor enforces MAX_SLIPPAGE via LIMIT IOC, handles partial fill qty and zero-fill expiry', async () => {
  resetMemoryState();
  const bus = new EventEmitter();
  const logger = createSilentLogger();
  const orderCalls = [];

  // Case A: Partial fill on LIMIT IOC -> SL/TP and position use actual filledQty (0.006 instead of 0.01)
  const mockBinancePartial = {
    futuresLeverage: async () => {},
    futuresMarginType: async () => {},
    futuresOrder: async (side, symbol, qty, price, params) => {
      orderCalls.push({ side, symbol, qty, price, params });
      if (params.type === 'LIMIT') {
        return { orderId: 'ENTRY_1', status: 'EXPIRED', executedQty: '0.006', avgPrice: '50120.5' };
      }
      return { orderId: `${params.type}_ID` };
    },
  };

  orderExecutor.init({ dryRun: false, orderRetryAttempts: 1, maxSlippage: 0.005 }, mockBinancePartial, repository, bus, logger);

  await orderExecutor.handleApproved({
    action: 'OPEN',
    symbol: 'BTCUSDT',
    side: 'BUY',
    quantity: 0.01,
    leverage: 10,
    stopLossPrice: 49000,
    takeProfitPrice: 52000,
    referencePrice: 50000,
    symbolInfo: { tickSize: 0.1, stepSize: 0.001 },
    signal: { price: 50000 },
  });

  assert.equal(orderCalls.length, 3, '1 LIMIT IOC entry + 1 SL + 1 TP');
  assert.equal(orderCalls[0].price, 50250, '50000 * (1 + 0.005) rounded to tickSize 0.1');
  assert.deepEqual(orderCalls[0].params, { type: 'LIMIT', timeInForce: 'IOC' });
  assert.equal(orderCalls[1].qty, 0.006, 'SL must protect actual filledQty 0.006');
  assert.equal(orderCalls[2].qty, 0.006, 'TP must match actual filledQty 0.006');

  const savedPos = repository.getPosition('BTCUSDT');
  assert.equal(savedPos.quantity, 0.006);
  assert.equal(savedPos.entryPrice, 50120.5);

  // Case B: Zero fill on LIMIT IOC due to excessive slippage -> aborts cleanly without SL/TP or state entry
  resetMemoryState();
  orderCalls.length = 0;
  let slippageEvent = null;
  bus.on('slippageRejected', (ev) => { slippageEvent = ev; });

  const mockBinanceZeroFill = {
    futuresLeverage: async () => {},
    futuresMarginType: async () => {},
    futuresOrder: async (side, symbol, qty, price, params) => {
      orderCalls.push({ side, symbol, qty, price, params });
      return { orderId: 'ENTRY_EXPIRED', status: 'EXPIRED', executedQty: '0', avgPrice: '0' };
    },
  };

  orderExecutor.init({ dryRun: false, orderRetryAttempts: 2, maxSlippage: 0.005 }, mockBinanceZeroFill, repository, bus, logger);

  await orderExecutor.handleApproved({
    action: 'OPEN',
    symbol: 'ETHUSDT',
    side: 'SELL',
    quantity: 0.5,
    leverage: 10,
    stopLossPrice: 3060,
    takeProfitPrice: 2880,
    referencePrice: 3000,
    symbolInfo: { tickSize: 0.01, stepSize: 0.001 },
    signal: { price: 3000 },
  });

  assert.equal(orderCalls.length, 1, 'zero-fill IOC must NOT retry or place SL/TP');
  assert.equal(orderCalls[0].price, 2985, 'SHORT limit price = 3000 * (1 - 0.005) = 2985');
  assert.ok(slippageEvent && slippageEvent.symbol === 'ETHUSDT');
  assert.equal(repository.hasPosition('ETHUSDT'), false);
});

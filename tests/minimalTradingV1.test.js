const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { once } = require('node:events');
const { sentimentGate, SentimentService } = require('../src/sentiment/service');
const { Collector } = require('../src/sentiment/collector');
const { unavailable } = require('../src/sentiment/aggregator');
const { DryRunAdapter } = require('../src/exchange/DryRunAdapter');
const { TestnetAdapter } = require('../src/exchange/TestnetAdapter');
const { LiveAdapter } = require('../src/exchange/LiveAdapter');
const { ReliableSocket } = require('../src/market/reliableSocket');
const { UserDataLifecycle } = require('../src/exchange/userDataLifecycle');
const { Pipeline } = require('../src/minimal/pipeline');
const { RiskBridge } = require('../src/minimal/riskBridge');
const { Replay, loadReplay } = require('../src/minimal/replay');
const { createServer } = require('../src/minimal/server');
const { resolveMode } = require('../src/minimal/main');
const rows = loadReplay();
const signal = Object.freeze({ symbol: 'ETHUSDT', direction: 'LONG', price: 3337.88, strategy: 'breakout24h4h', reason: 'breakout', timestamp: 1737676799999 });
const positive = { symbol: 'ETHUSDT', status: 'available', score: 0.8, label: 'bullish', confidence: 0.9, articleCount: 12, updatedAt: '2025-01-23T23:59:59.999Z' };
function initializedAdapter() { const adapter = new DryRunAdapter(); adapter.ingest('ETHUSDT', rows.ETHUSDT[0]); return adapter; }

test('sentiment unavailable retains null score, preserves original signal, never creates orders', async () => {
  const service = new SentimentService({ collector: new Collector({ provider: async () => { throw new Error('offline'); } }) });
  const value = await service.get('ETHUSDT');
  assert.equal(value.status, 'unavailable'); assert.equal(value.score, null);
  const gate = sentimentGate(signal, value);
  assert.equal(gate.technicalSignal, signal); assert.equal(gate.decision, 'ALLOW');
  assert.deepEqual(Object.keys(gate).sort(), ['decision', 'reason', 'sentiment', 'technicalSignal']);
  const adapter = initializedAdapter(); const risk = new RiskBridge(adapter, { config: { maxOpenPositions: 0 } });
  assert.equal(risk.evaluate(gate.technicalSignal).decision, 'REJECT');
  assert.equal(adapter.pending.size, 0); assert.equal(adapter.getPositions().length, 0); risk.stop();
});

test('strong bearish sentiment filters LONG, never blocks a CLOSE', () => {
  const bearish = { ...positive, score: -0.8, label: 'bearish' };
  assert.equal(sentimentGate(signal, bearish).decision, 'BLOCK');
  assert.equal(sentimentGate({ ...signal, direction: 'CLOSE' }, bearish).decision, 'ALLOW');
  assert.equal(sentimentGate(signal, { ...bearish, confidence: 0.2 }).decision, 'ALLOW');
});

test('positive sentiment cannot bypass actual existing Risk Manager position cap', () => {
  const adapter = initializedAdapter();
  const risk = new RiskBridge(adapter, { config: { maxOpenPositions: 0 } });
  const gate = sentimentGate(signal, positive);
  assert.equal(gate.decision, 'ALLOW');
  const result = risk.evaluate(gate.technicalSignal);
  assert.equal(result.decision, 'REJECT'); assert.match(result.reason, /Max positions/);
  assert.equal(adapter.pending.size, 0); risk.stop();
});

test('collector drops duplicate, expired, future and unrelated articles; lexicon aggregates real payload contract', async () => {
  const now = Date.parse(positive.updatedAt);
  const articles = Array.from({ length: 5 }, (_, i) => ({ symbol: 'ETHUSDT', title: 'Ethereum bullish inflow growth', url: `https://example.org/${i}`, publishedAt: new Date(now - 1000).toISOString() }));
  const collector = new Collector({ provider: async () => [...articles, articles[0], { ...articles[0], url: 'https://example.org/old', publishedAt: '2024-01-01' }, { ...articles[0], url: 'https://example.org/future', publishedAt: '2027-01-01' }, { ...articles[0], symbol: 'BTCUSDT' }] });
  const sentiment = await new SentimentService({ collector }).get('ETHUSDT', now);
  assert.equal(sentiment.articleCount, 5); assert.equal(sentiment.label, 'bullish'); assert.equal(sentiment.confidence, 1);
});

test('DryRunAdapter completes official ETH chain with zero network requests and next-bar fills', async () => {
  const originalFetch = global.fetch, originalSocket = global.WebSocket;
  let calls = 0;
  global.fetch = () => { calls++; throw new Error('Network forbidden'); };
  global.WebSocket = class { constructor() { calls++; throw new Error('Network forbidden'); } };
  const adapter = new DryRunAdapter(); const pipeline = new Pipeline({ adapter }); const replay = new Replay(adapter, pipeline);
  try {
    await replay.start(); replay.stop();
    const record = pipeline.signals.find(s => s.technicalSignal.symbol === 'ETHUSDT' && s.finalDecision === 'DRY_RUN_FILLED');
    assert.ok(record); assert.equal(record.technicalSignal.strategy, 'breakout24h4h');
    assert.equal(record.sentiment.status, 'unavailable'); assert.equal(record.sentiment.score, null);
    assert.equal(record.sentimentDecision.decision, 'ALLOW'); assert.equal(record.riskDecision.decision, 'APPROVE');
    assert.equal(record.execution.timestamp, record.technicalSignal.timestamp + 1);
    assert.ok(record.execution.fee > 0); assert.equal(calls, 0); assert.equal(pipeline.error, null);
    assert.equal(adapter.getPositions().length, 1);
  } finally { replay.stop(); pipeline.stop(); global.fetch = originalFetch; global.WebSocket = originalSocket; }
});

test('bearish sentiment prevents pipeline execution without mutating the technical LONG', async () => {
  const adapter = new DryRunAdapter();
  const pipeline = new Pipeline({ adapter, sentiment: { get: async symbol => ({ ...positive, symbol, score: -0.9, label: 'bearish' }) } });
  const replay = new Replay(adapter, pipeline);
  for (let i = 0; i < rows.ETHUSDT.length; i++) await replay.step(i < 60);
  const record = pipeline.signals.find(s => s.technicalSignal.symbol === 'ETHUSDT' && s.technicalSignal.direction === 'LONG');
  assert.ok(record); assert.equal(record.finalDecision, 'FILTERED'); assert.equal(record.riskDecision.decision, 'NOT_EVALUATED');
  assert.equal(adapter.fills.length, 0); pipeline.stop();
});

test('all 5 API contracts are stable, dashboard includes complete execution evidence', async () => {
  const adapter = new DryRunAdapter(); const pipeline = new Pipeline({ adapter }); const replay = new Replay(adapter, pipeline);
  await replay.start(); replay.stop();
  const server = createServer(pipeline); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const get = async route => { const r = await fetch(base + route); assert.equal(r.status, 200); return r.json(); };
    const status = await get('/api/status');
    assert.deepEqual(Object.keys(status).sort(), ['error', 'health', 'liveExecution', 'market', 'mode', 'risk', 'sentiment', 'strategy', 'updatedAt']);
    assert.equal(status.liveExecution, 'DISABLED'); assert.equal(status.market.status, 'CONNECTED');
    const market = await get('/api/market/ETHUSDT');
    assert.deepEqual(Object.keys(market).sort(), ['candles', 'marketTime', 'price', 'source', 'symbol']); assert.equal(market.candles.length, 60);
    const sentiment = await get('/api/sentiment/ETHUSDT');
    assert.deepEqual(Object.keys(sentiment).sort(), ['articleCount', 'confidence', 'label', 'reason', 'score', 'status', 'symbol', 'updatedAt']);
    assert.equal(sentiment.score, null);
    const { signals } = await get('/api/signals');
    assert.deepEqual(Object.keys(signals[0]).sort(), ['execution', 'finalDecision', 'reason', 'riskDecision', 'sentiment', 'sentimentDecision', 'technicalSignal']);
    assert.deepEqual(Object.keys(signals[0].technicalSignal).sort(), ['direction', 'price', 'reason', 'strategy', 'symbol', 'timestamp']);
    const dashboard = await get('/api/dashboard');
    assert.deepEqual(Object.keys(dashboard).sort(), ['market', 'metrics', 'positions', 'recentSignals', 'sentiment', 'status', 'strategyState']);
    assert.ok(dashboard.recentSignals.some(s => s.technicalSignal.symbol === 'ETHUSDT' && s.finalDecision === 'DRY_RUN_FILLED'));
    assert.equal((await fetch(base + '/api/market/SOLUSDT')).status, 400);
    assert.equal((await fetch(base + '/api/orders', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/api/unknown')).status, 404);
    const html = await fetch(base); assert.match(html.headers.get('content-security-policy'), /connect-src 'self'/); assert.match(await html.text(), /实盘已禁用/);
  } finally { server.close(); await once(server, 'close'); pipeline.stop(); }
});

test('Live execution always disabled regardless of environmental flags or legacy config', () => {
  for (const env of [{ V1_MODE: 'live' }, { BINANCE_TESTNET: 'false', DRY_RUN: 'false' }, { V1_MODE: 'LIVE', LIVE_ENABLED: 'true' }]) assert.throws(() => resolveMode(env), /LIVE DISABLED/);
  assert.equal(resolveMode({ DRY_RUN: 'false', LIVE_ENABLED: 'true' }), 'dry-run');
  const live = new LiveAdapter(); assert.equal(live.enabled, false);
  assert.throws(() => live.executeOrder(signal), /LIVE DISABLED/);
  const { init } = require('../src/execution/orderExecutor');
  let calls = 0;
  const malicious = new Proxy({}, { get() { calls++; throw new Error('SDK touched'); } });
  assert.throws(() => init({ dryRun: false, testnet: false }, malicious), /LIVE DISABLED/);
  assert.throws(() => init({ dryRun: false, testnet: true }, malicious), /LIVE DISABLED/); assert.equal(calls, 0);
});

test('TestnetAdapter pins host, refuses arbitrary/production order paths and only validates orders', async () => {
  const calls = [];
  const adapter = new TestnetAdapter({ apiKey: 'test', secretKey: 'test', fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({}) }; } });
  const result = await adapter.executeOrder({ symbol: 'ETHUSDT', action: 'OPEN', quantity: 0.1 });
  assert.equal(result.status, 'VALIDATED_ONLY'); assert.equal(result.fill, null);
  const url = new URL(calls[0].url); assert.equal(url.hostname, 'demo-fapi.binance.com'); assert.equal(url.pathname, '/fapi/v1/order/test');
  assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.method, 'POST');
  await assert.rejects(adapter.request('/fapi/v1/order', {}, { method: 'POST' }), /not allowed/);
  await assert.rejects(adapter.request('https://fapi.binance.com/fapi/v1/order'), /not allowed/);
  assert.equal(calls.length, 1); adapter.stop();
});

class FakeSocket extends EventEmitter {
  addEventListener(event, listener) { this.on(event, listener); }
  close() { this.emit('close'); }
}
test('WebSocket disconnect immediately updates status, reconnect uses exponential backoff, stale data is unhealthy', () => {
  let now = 100; const sockets = []; const logs = [];
  const ws = new ReliableSocket({ url: 'wss://example.invalid', now: () => now, staleMs: 1000, onMessage: data => data.valid,
    log: e => logs.push(e), socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; } });
  ws.start(); sockets[0].emit('open'); assert.equal(ws.getStatus().status, 'STALE');
  sockets[0].emit('message', { data: '{"valid":true}' }); assert.equal(ws.getStatus().status, 'CONNECTED'); assert.equal(ws.lastMessageAt, 100);
  now = 1200; assert.equal(ws.getStatus().status, 'STALE');
  sockets[0].emit('close'); assert.equal(ws.getStatus().status, 'DISCONNECTED'); assert.equal(logs[0].retryInMs, 1000);
  clearTimeout(ws.retryTimer); ws.retryTimer = null; ws.connect(); sockets[1].emit('close'); assert.equal(logs[1].retryInMs, 2000);
  assert.equal(logs[1].component, 'market_ws'); ws.stop(); assert.equal(ws.getStatus().status, 'DISCONNECTED');
});

test('WebSocket actually reconnects after close and shutdown cancels retries', async () => {
  const sockets = [];
  let reconnected;
  const ready = new Promise(resolve => { reconnected = resolve; });
  const ws = new ReliableSocket({ url: 'wss://example.invalid', baseDelayMs: 5, onMessage: () => true,
    socketFactory: () => { const s = new FakeSocket(); sockets.push(s); if (sockets.length === 2) reconnected(); return s; } });
  ws.start(); sockets[0].emit('close');
  const timer = setTimeout(() => reconnected(), 500);
  await ready; clearTimeout(timer);
  assert.equal(sockets.length, 2); sockets[1].emit('open'); sockets[1].emit('message', { data: '{}' });
  assert.equal(ws.getStatus().status, 'CONNECTED'); ws.stop(); assert.equal(ws.retryTimer, null);
});

test('stale/disconnected market is rejected before execution despite positive sentiment', () => {
  let now = 100;
  const adapter = new DryRunAdapter({ now: () => now, staleMs: 10 }); adapter.ingest('ETHUSDT', rows.ETHUSDT[0]);
  const risk = new RiskBridge(adapter); now = 111;
  assert.equal(adapter.getConnectionStatus().status, 'STALE'); assert.equal(risk.evaluate(signal).decision, 'REJECT');
  adapter.stop(); assert.equal(adapter.getConnectionStatus().status, 'DISCONNECTED'); risk.stop();
});

test('pending entry reserves the position slot before the next-bar fill', () => {
  const adapter = initializedAdapter(); const risk = new RiskBridge(adapter);
  const approved = risk.evaluate(signal); assert.equal(approved.decision, 'APPROVE');
  adapter.executeOrder(approved.order);
  const second = risk.evaluate({ ...signal, symbol: 'BTCUSDT' });
  assert.equal(second.decision, 'REJECT'); assert.match(second.reason, /Max positions/); risk.stop();
});

test('positive sentiment cannot bypass daily loss cap', () => {
  const adapter = initializedAdapter(); adapter.wallet = 9000;
  const risk = new RiskBridge(adapter);
  const result = risk.evaluate(sentimentGate(signal, positive).technicalSignal);
  assert.equal(result.decision, 'REJECT'); assert.match(result.reason, /Daily loss cap/); risk.stop();
});

test('user-data lease start, refresh, expiration and close are isolated from market sockets', async () => {
  const methods = []; const sockets = []; let updates = 0;
  const lifecycle = new UserDataLifecycle({ request: async method => { methods.push(method); return { listenKey: 'safe-test-key' }; }, onUpdate: () => { updates++; },
    socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; } });
  await lifecycle.start(); sockets[0].emit('open');
  assert.equal(lifecycle.getStatus().status, 'ACTIVE');
  await lifecycle.keepalive();
  sockets[0].emit('message', { data: '{"e":"ACCOUNT_UPDATE"}' }); assert.equal(updates, 1);
  sockets[0].emit('message', { data: '{"e":"listenKeyExpired"}' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sockets.length, 2); assert.deepEqual(methods, ['POST', 'PUT', 'POST']);
  await lifecycle.stop(); assert.equal(methods.at(-1), 'DELETE'); assert.equal(lifecycle.getStatus().status, 'STOPPED');
});

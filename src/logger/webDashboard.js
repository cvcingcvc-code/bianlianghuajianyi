const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_BODY_BYTES = 64 * 1024; // 64KB payload limit

let config, repo, eventBus, logger, feishuCommands;
let server, clients = [];
const state = { prices: {}, markPrices: {}, positions: [], balance: 0, pnl: 0, trades: 0, wins: 0, signals: [], lastSignal: null };
const priceHistory = {};
const MAX_HISTORY = 200;

function safeTokenEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected || !provided) {
    return false;
  }
  const h1 = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const h2 = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(h1, h2);
}

function isLoopbackAddress(addr) {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === 'localhost' || addr.startsWith('::ffff:127.');
}

function extractAdminToken(req) {
  const authHeader = req.headers?.authorization || '';
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (bearerMatch) return bearerMatch[1].trim();
  const headerToken = req.headers?.['x-admin-token'];
  return typeof headerToken === 'string' ? headerToken.trim() : '';
}

function authorizeCommand(req, cfg) {
  const expectedToken = cfg?.dashboardAdminToken || '';
  if (expectedToken) {
    const provided = extractAdminToken(req);
    if (!safeTokenEqual(provided, expectedToken)) {
      return { ok: false, statusCode: 401, error: 'Unauthorized: invalid or missing DASHBOARD_ADMIN_TOKEN' };
    }
    return { ok: true };
  }
  const remoteAddr = req.socket?.remoteAddress || '';
  if (!isLoopbackAddress(remoteAddr)) {
    return { ok: false, statusCode: 403, error: 'Forbidden: set DASHBOARD_ADMIN_TOKEN to allow non-loopback commands' };
  }
  return { ok: true };
}

function authorizeFeishuCallback(req, data, cfg) {
  const expectedToken = cfg?.feishuVerificationToken || '';
  if (expectedToken) {
    const incomingToken = String(data?.header?.token ?? data?.token ?? '');
    if (!safeTokenEqual(incomingToken, expectedToken)) {
      return { ok: false, statusCode: 401, error: 'Unauthorized: invalid FEISHU_VERIFICATION_TOKEN' };
    }
    return { ok: true };
  }
  const remoteAddr = req.socket?.remoteAddress || '';
  if (!isLoopbackAddress(remoteAddr)) {
    return { ok: false, statusCode: 403, error: 'Forbidden: set FEISHU_VERIFICATION_TOKEN for external Feishu callbacks' };
  }
  return { ok: true };
}

function init(cfg, repository, bus, log, cmdHandler) {
  config = cfg; repo = repository; eventBus = bus; logger = log;
  feishuCommands = cmdHandler;

  eventBus.on('ticker', (d) => {
    state.prices[d.symbol] = { price: d.price, change: d.change };
    if (!priceHistory[d.symbol]) priceHistory[d.symbol] = [];
    priceHistory[d.symbol].push({ time: Date.now(), price: d.price });
    if (priceHistory[d.symbol].length > MAX_HISTORY) priceHistory[d.symbol].shift();
    broadcast('tick', { prices: state.prices, history: { [d.symbol]: priceHistory[d.symbol] } });
  });

  eventBus.on('markPrice', (d) => {
    state.markPrices[d.symbol] = { markPrice: d.markPrice, fundingRate: d.fundingRate };
  });

  eventBus.on('positionOpened', () => updatePositions());
  eventBus.on('positionClosed', () => updatePositions());

  eventBus.on('strategySignal', (s) => {
    state.signals.unshift({ time: Date.now(), symbol: s.symbol, direction: s.direction, reason: s.reason });
    if (state.signals.length > 50) state.signals.length = 50;
    state.lastSignal = s;
  });

  eventBus.on('riskRejected', (s) => {
    state.signals.unshift({ time: Date.now(), symbol: s.signal.symbol, direction: s.signal.direction, reason: 'REJECTED: ' + s.reason });
    if (state.signals.length > 50) state.signals.length = 50;
  });
}

function updatePositions() {
  const positions = repo.getOpenPositions();
  state.positions = positions.map(p => {
    const cp = state.prices[p.symbol] ? state.prices[p.symbol].price : p.entryPrice;
    const pnl = (p.side === 'SHORT' ? p.entryPrice - cp : cp - p.entryPrice) * p.quantity;
    return { ...p, currentPrice: cp, unrealizedPnl: pnl };
  });
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const res of clients) {
    try { res.write(`data: ${msg}\n\n`); } catch (e) { /* client disconnected */ }
  }
}

function handleRequest(req, res) {
  const htmlPath = path.join(__dirname, '..', '..', 'public', 'dashboard.html');
  if (req.url === '/' && req.method === 'GET') {
    if (!fs.existsSync(htmlPath)) {
      res.writeHead(404);
      res.end('Dashboard HTML not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(htmlPath));
  } else if (req.url === '/api/state' && req.method === 'GET') {
    updatePositions();
    const stats = repo.getDailyStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      prices: state.prices,
      positions: state.positions,
      balance: stats.currentBalance || 0,
      pnl: stats.realizedPnl || 0,
      trades: stats.tradeCount || 0,
      wins: stats.winningTrades || 0,
      signals: state.signals.slice(0, 20),
      breakers: repo.getBreakerState(),
      priceHistory,
      authRequired: Boolean(config?.dashboardAdminToken),
    }));
  } else if (req.url === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    clients.push(res);
    req.on('close', () => { clients = clients.filter(c => c !== res); });
  } else if (req.url === '/api/command' && req.method === 'POST') {
    const auth = authorizeCommand(req, config);
    if (!auth.ok) {
      res.writeHead(auth.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: auth.error }));
      return;
    }
    readBody(req, MAX_BODY_BYTES).then(async (body) => {
      try {
        const data = JSON.parse(body);
        let reply = '';
        await feishuCommands.handleMessage(data.text || '', (r) => { reply = r; });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }).catch((err) => {
      const code = err.statusCode || 400;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
  } else if (req.url === '/feishu/callback' && req.method === 'POST') {
    readBody(req, MAX_BODY_BYTES).then((body) => {
      try {
        const data = JSON.parse(body);
        const auth = authorizeFeishuCallback(req, data, config);
        if (!auth.ok) {
          logger.warn(`Feishu callback rejected: ${auth.error}`);
          res.writeHead(auth.statusCode, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: auth.error }));
        }
        // URL verification
        if (data.type === 'url_verification') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ challenge: data.challenge }));
        }
        // Message event
        if (data.header?.event_type === 'im.message.receive_v1') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({}));
          const msgContent = JSON.parse(data.event?.message?.content || '{}');
          const text = msgContent.text || '';
          if (text && feishuCommands) {
            feishuCommands.handleMessage(text, (replyText) => sendFeishuReply(replyText));
          }
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
      } catch (e) {
        logger.warn(`Feishu callback error: ${e.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    }).catch((err) => {
      const code = err.statusCode || 400;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
}

function start() {
  const htmlPath = path.join(__dirname, '..', '..', 'public', 'dashboard.html');
  if (!fs.existsSync(htmlPath)) {
    logger.warn('Web dashboard HTML not found at public/dashboard.html');
    return null;
  }

  server = http.createServer(handleRequest);

  const port = config?.webPort !== undefined ? config.webPort : 3000;
  const host = config?.webHost || '127.0.0.1';
  if (!isLoopbackAddress(host) && !config?.dashboardAdminToken) {
    logger.warn(`SECURITY WARNING: Web dashboard bound to ${host}:${port} without DASHBOARD_ADMIN_TOKEN; remote /api/command calls are blocked`);
  }
  server.listen(port, host, () => {
    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : port;
    logger.info(`Web dashboard: http://${host}:${boundPort}`);
  });
  return server;
}

function stop() {
  for (const res of clients) { try { res.end(); } catch (e) { /* ignore */ } }
  clients = [];
  if (server) { server.close(); server = null; }
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        settled = true;
        req.resume(); // drain remaining socket data cleanly so HTTP 413 response can flush
        const err = new Error(`Payload Too Large (max ${maxBytes} bytes)`);
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function sendFeishuReply(text) {
  const url = config.feishuWebhookUrl;
  if (!url) return;
  const body = JSON.stringify({ msg_type: 'text', content: { text: `[Bot 回复] ${text}` } });
  const u = new (require('url')).URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const req = mod.request({
    hostname: u.hostname, port: u.port, path: u.pathname + u.search,
    method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 10000,
  }, () => { /* fire and forget */ });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

module.exports = {
  init, start, stop, handleRequest, readBody,
  safeTokenEqual, isLoopbackAddress, authorizeCommand, authorizeFeishuCallback,
  MAX_BODY_BYTES,
};

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

let config, repo, eventBus, logger, feishuCommands;
let server, clients = [];
const state = { prices: {}, markPrices: {}, positions: [], balance: 0, pnl: 0, trades: 0, wins: 0, signals: [], lastSignal: null };
const priceHistory = {};
const MAX_HISTORY = 200;

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
    const pnl = (cp - p.entryPrice) * p.quantity;
    return { ...p, currentPrice: cp, unrealizedPnl: pnl };
  });
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const res of clients) {
    try { res.write(`data: ${msg}\n\n`); } catch (e) { /* client disconnected */ }
  }
}

function start() {
  const htmlPath = path.join(__dirname, '..', '..', 'public', 'dashboard.html');
  if (!fs.existsSync(htmlPath)) {
    logger.warn('Web dashboard HTML not found at public/dashboard.html');
    return;
  }

  server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(htmlPath));
    } else if (req.url === '/api/state') {
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
      }));
    } else if (req.url === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
      clients.push(res);
      req.on('close', () => { clients = clients.filter(c => c !== res); });
    } else if (req.url === '/api/command' && req.method === 'POST') {
      readBody(req).then(body => {
        try {
          const data = JSON.parse(body);
          let reply = '';
          feishuCommands.handleMessage(data.text || '', (r) => { reply = r; });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ reply }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } else if (req.url === '/feishu/callback' && req.method === 'POST') {
      readBody(req).then(body => {
        try {
          const data = JSON.parse(body);
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
            const chatId = data.event?.message?.chat_id;
            if (text && feishuCommands) {
              feishuCommands.handleMessage(text, (replyText) => sendFeishuReply(replyText));
            }
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({}));
        } catch (e) {
          logger.warn(`Feishu callback error: ${e.message}`);
          res.writeHead(400);
          res.end('Bad request');
        }
      });
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  const port = config.webPort || 3000;
  server.listen(port, () => {
    logger.info(`Web dashboard: http://localhost:${port}`);
  });
}

function stop() {
  for (const res of clients) { try { res.end(); } catch (e) { /* ignore */ } }
  clients = [];
  if (server) { server.close(); server = null; }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
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
  }, (res) => { /* fire and forget */ });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

module.exports = { init, start, stop };

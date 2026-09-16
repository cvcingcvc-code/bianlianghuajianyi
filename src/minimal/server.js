const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SYMBOLS } = require('./contracts');
const assets = { '/': ['dashboard.html', 'text/html; charset=utf-8'], '/dashboard.js': ['dashboard.js', 'text/javascript; charset=utf-8'], '/dashboard.css': ['dashboard.css', 'text/css; charset=utf-8'] };
function createServer(pipeline) {
  return http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET') return json(405, { error: 'Only GET supported' });
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/status') return json(200, pipeline.status());
      if (url.pathname === '/api/signals') return json(200, { signals: pipeline.signals.slice(0, 100) });
      if (url.pathname === '/api/dashboard') return json(200, pipeline.dashboard());
      const match = url.pathname.match(/^\/api\/(market|sentiment)\/([^/]+)$/);
      if (match) {
        const symbol = match[2].toUpperCase();
        if (!SYMBOLS.includes(symbol)) return json(400, { error: 'Only BTCUSDT and ETHUSDT supported' });
        return json(200, match[1] === 'market' ? pipeline.adapter.getMarketData(symbol) : pipeline.sentiments[symbol]);
      }
      const asset = assets[url.pathname];
      if (!asset) return json(404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': asset[1] });
      res.end(fs.readFileSync(path.join(__dirname, '../../public/minimal', asset[0])));
    } catch { json(500, { error: 'Local API unavailable' }); }
  });
}
module.exports = { createServer };

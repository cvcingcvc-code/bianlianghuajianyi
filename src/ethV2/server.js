const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { sha } = require('./data');
const { ROOT, sourceFingerprint } = require('./provenance');
const { Controller } = require('./controller');
function createServer(controller, report) {
  return http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    const host = `127.0.0.1:${req.socket.localPort}`;
    if (req.headers.host !== host) return json(403, { error: '仅允许本地访问' });
    try {
      if (req.method === 'POST') {
        if (req.headers['x-eth-v2-control'] !== '1' || (req.headers.origin && req.headers.origin !== `http://${host}`)) return json(403, { error: '无效控制来源' });
        const action = { '/api/start': () => controller.start(), '/api/pause': () => controller.pause(), '/api/step': () => { if (controller.timer) throw new Error('请先暂停'); controller.advance(16); } }[req.url];
        if (!action) return json(404, { error: '无此操作' }); action(); return json(200, controller.status());
      }
      if (req.method !== 'GET') return json(405, { error: '方法不支持' });
      if (req.url === '/api/status') return json(200, controller.status());
      if (req.url === '/api/report') return json(200, report);
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      const asset = assets[req.url]; if (!asset) return json(404, { error: '页面不存在' });
      res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` }); res.end(fs.readFileSync(path.join(ROOT, 'public/eth-v2', asset[0])));
    } catch (e) { json(409, { error: e.message }); }
  });
}
function serve({ data, reportPath, sessionName, port }) {
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(sessionName)) throw new Error('Invalid session name');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')), source = sourceFingerprint();
  if (data.fingerprint !== report.dataFingerprint || source.sha256 !== report.source.sha256) throw new Error('Report/data/code mismatch; run a new versioned report');
  const forecastBytes = fs.readFileSync(path.join(path.dirname(reportPath), 'forecasts.json'));
  if (sha(forecastBytes) !== report.outputs['forecasts.json']) throw new Error('Forecast checksum mismatch');
  const folder = path.join(ROOT, 'data/eth-v2/sessions'); fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${sessionName}.json`), lock = `${file}.lock`;
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8')); let alive = true;
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e; }
    if (alive) throw new Error('Session already has a writer'); fs.unlinkSync(lock);
  }
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  let controller;
  try { controller = new Controller({ data, predictions: JSON.parse(forecastBytes), sessionFile: file, identity: `${data.fingerprint}:${source.sha256}` }); }
  catch (e) { fs.unlinkSync(lock); throw e; }
  const server = createServer(controller, report);
  const stop = () => { controller.pause(); server.close(); if (fs.existsSync(lock)) fs.unlinkSync(lock); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  server.on('error', e => { stop(); console.error(e.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`ETH V2 历史模拟 http://127.0.0.1:${port} / session=${sessionName}`));
  return { server, controller, stop };
}
module.exports = { createServer, serve };

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { loadHistory } = require('../src/trendGrid/archive');
const { evaluate } = require('../src/trendGrid/forecast');
const { PaperGrid, planGrid } = require('../src/trendGrid/grid');

async function run() {
  const args = process.argv.slice(2);
  if (args.some(a => !['--download', '--serve', '--exploratory-paper'].includes(a))) throw new Error('Usage: node scripts/trend-grid-v1.js [--download] [--exploratory-paper] [--serve]');
  const { candles, manifest } = await loadHistory({ acquire: args.includes('--download') });
  console.log(`Verified ${candles.length} official ETH 15m bars; holdout locked.`);
  const paper = args.includes('--exploratory-paper') ? [new PaperGrid(), new PaperGrid({ scenario: 'STRESS' })] : [];
  const decisions = {};
  const evaluation = evaluate(candles, (snapshot, candle) => {
    if (candle.openTime < Date.UTC(2023, 0, 1)) return;
    const plan = planGrid(snapshot), key = plan.action === 'OPEN' ? plan.side : plan.reason;
    decisions[key] = (decisions[key] || 0) + 1;
    for (const account of paper) { account.advance(candle); account.decide(snapshot); }
  });
  const last = candles[candles.length - 1];
  for (const account of paper) {
    account.close(last.close, last.closeTime, 'FORCED_END_OF_REPLAY'); account.pending = null; account.mark(last.close);
  }
  const report = { createdAt: new Date().toISOString(), preregistration: '50a56d9',
    codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    codeWorkingTree: execFileSync('git', ['status', '--short', '--', 'src/trendGrid', 'scripts/trend-grid-v1.js'], { encoding: 'utf8' }).trim(),
    ...evaluation, automaticOpening: 'DISABLED_PENDING_EXECUTION_VALIDATION', latestPlan: planGrid(evaluation.latest),
    decisions, paper: paper.map(p => p.summary()), manifest,
    limitations: ['Historical replay, not today’s ETH prediction.', 'Empirical distributions, not calibrated guarantees.',
      'Paper PnL excludes funding; no net edge claim.', 'OHLC cannot identify intrabar path; stops first, no same-bar lot round trip.',
      'No exchange filters, queue, liquidation or live execution.', 'Forecast failure cannot be rescued by exploratory grid PnL.'] };
  const folder = path.join(__dirname, '../reports/trend-grid-v1', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ report: path.join(folder, 'report.json'), forecastGate: report.forecastGate, horizons: report.horizons,
    decisions: report.decisions, paper: report.paper.map(({ recentEvents, active, pending, ...summary }) => summary) }, null, 2));
  if (args.includes('--serve')) {
    const server = http.createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'");
      if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
      if (req.url === '/api/report') { res.setHeader('Content-Type', 'application/json; charset=utf-8'); return res.end(JSON.stringify(report)); }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      const asset = assets[req.url];
      if (!asset) { res.writeHead(404); return res.end(); }
      res.setHeader('Content-Type', `${asset[1]}; charset=utf-8`);
      res.end(fs.readFileSync(path.join(__dirname, '../public/trend-grid', asset[0])));
    });
    server.listen(3001, '127.0.0.1', () => console.log('ETH trend grid: http://127.0.0.1:3001'));
  }
  return report;
}
if (require.main === module) run().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { run };

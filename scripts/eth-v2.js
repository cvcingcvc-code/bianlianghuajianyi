const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadData, sha } = require('../src/ethV2/data');
const { walkForward } = require('../src/ethV2/model');
const { forecastEvaluation, tradeEvaluation, runTrading } = require('../src/ethV2/evaluate');
const { ROOT, sourceFingerprint } = require('../src/ethV2/provenance');
function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--serve') options.serve = true;
    else if (['--report', '--session', '--port'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key.slice(2)] = args[++i];
    else throw new Error(`Unsupported option (holdout stays locked): ${key}`);
  }
  return options;
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const data = await loadData();
  if (options.serve) {
    const reportPath = options.report; if (!reportPath) throw new Error('--report is required');
    return require('../src/ethV2/server').serve({ data, reportPath, sessionName: options.session || 'default', port: Number(options.port || 3002) });
  }
  const source = sourceFingerprint(), git = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src/ethV2', 'src/research/strategies/ethPredictionV2.js', 'scripts/eth-v2.js'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (dirty) throw new Error('Commit V2 research code before official evaluation');
  const { predictions, fits } = walkForward(data.bars);
  const forecast = forecastEvaluation(predictions);
  const base = runTrading(data.candles, predictions, data.funding, { identity: data.fingerprint });
  const stress = runTrading(data.candles, predictions, data.funding, { scenario: 'STRESS', identity: data.fingerprint });
  const benchmark = runTrading(data.candles, predictions, data.funding, { benchmark: true, identity: data.fingerprint });
  const benchmarkStress = runTrading(data.candles, predictions, data.funding, { scenario: 'STRESS', benchmark: true, identity: data.fingerprint });
  const trading = tradeEvaluation(base.stats, stress.stats, benchmark.stats, forecast, data.funding.complete);
  const id = new Date().toISOString().replace(/[:.]/g, '-'), folder = path.join(ROOT, 'reports/eth-v2', id);
  fs.mkdirSync(folder, { recursive: true });
  const write = (file, obj) => { const bytes = JSON.stringify(obj, null, 2) + '\n'; fs.writeFileSync(path.join(folder, file), bytes, { flag: 'wx' }); return sha(bytes); };
  const outputs = { 'forecasts.json': write('forecasts.json', predictions), 'fits.json': write('fits.json', fits) };
  for (const [name, result] of Object.entries({ base, stress, benchmark, benchmarkStress })) outputs[`${name}-ledger.json`] = write(`${name}-ledger.json`, result.sim.s);
  const report = { id, createdAt: new Date().toISOString(), candidate: 'eth-v2-ridge-1', preregistration: '0c098ae', codeCommit: git, source,
    command: 'node scripts/eth-v2.js', mode: 'UNVALIDATED_HISTORICAL_DIAGNOSTIC', evidence: 'REUSED_2021_2025_DEVELOPMENT_DATA',
    dataFingerprint: data.fingerprint, data: { candles: data.candles.length, bars: data.bars.length, price: data.manifest,
      funding: { complete: data.funding.complete, events: data.funding.events.length, files: data.funding.files, problems: data.funding.problems, markLimit: data.funding.markLimit } },
    forecast, trading, base: base.stats, stress: stress.stats, benchmark: benchmark.stats, benchmarkStress: benchmarkStress.stats,
    cashBenchmark: { initial: 10000, final: 10000, net: 0, exposure: 0, costs: 0 }, decisions: base.decisions,
    latest: predictions.at(-1), outputs, validatedAutomaticOpening: false,
    limitations: ['Reused development data, not pristine holdout', 'Minute mark proxy, not exact settlement tick', 'OHLC touch approximation, not real limit fills',
      'Funding intrabar uncertainty handled adversely', 'Confidence intervals use approximate weekly blocks', 'No live exchange or credentials'] };
  write('report.json', report);
  fs.writeFileSync(path.join(folder, 'SUMMARY.md'), `# ETH V2 验证结果\n\n- 预测：${forecast.status}\n- 交易：${trading.status}\n- 候选交易数：${base.stats.count}\n- 数据问题：${data.funding.problems.join('; ') || '无'}\n- 预测失败原因：${forecast.failures.join('; ') || '无'}\n- 代码：${git}\n- 预登记：0c098ae\n- 复现：node scripts/eth-v2.js\n- 所有诊断均未验证，不得作为当前ETH预测或实盘授权。详见report.json。\n`, { flag: 'wx' });
  console.log(JSON.stringify({ folder, forecast: forecast.status, trading: trading.status, decisions: base.decisions, trades: base.stats.count, fundingProblems: data.funding.problems }, null, 2));
}
if (require.main === module) main().catch(e => { console.error(e.stack); process.exitCode = 1; });
module.exports = { main, parseArgs };

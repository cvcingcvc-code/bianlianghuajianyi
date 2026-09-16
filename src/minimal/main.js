const { DryRunAdapter } = require('../exchange/DryRunAdapter');
const { TestnetAdapter } = require('../exchange/TestnetAdapter');
const { denyLive } = require('../exchange/LiveAdapter');
const { Collector } = require('../sentiment/collector');
const { SentimentService } = require('../sentiment/service');
const { Pipeline } = require('./pipeline');
const { Replay } = require('./replay');
const { createServer } = require('./server');
function resolveMode(env) {
  const mode = env.V1_MODE || 'dry-run';
  if (!['dry-run', 'testnet'].includes(mode) || env.BINANCE_TESTNET === 'false') denyLive();
  return mode;
}
async function main() {
  const mode = resolveMode(process.env);
  const log = entry => console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...entry }));
  const adapter = mode === 'dry-run' ? new DryRunAdapter() : new TestnetAdapter({ apiKey: process.env.BINANCE_TESTNET_API_KEY, secretKey: process.env.BINANCE_TESTNET_SECRET_KEY, log });
  const sentiment = new SentimentService({ collector: new Collector({ file: process.env.V1_NEWS_FILE }), log });
  const pipeline = new Pipeline({ adapter, sentiment, log });
  const server = createServer(pipeline);
  const port = Number(process.env.PORT || 3000);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  log({ level: 'info', component: 'server', event: 'listening', url: `http://127.0.0.1:${port}`, mode: adapter.mode, live: 'DISABLED' });
  let replay;
  const stop = () => { replay?.stop(); pipeline.stop(); server.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (mode === 'dry-run') { replay = new Replay(adapter, pipeline); await replay.start(); }
    else await adapter.start();
  } catch (error) { stop(); throw error; }
  return { server, pipeline, stop };
}
if (require.main === module) main().catch(() => { console.error('V1 startup failed; LIVE DISABLED. Check mode, port and demo data.'); process.exitCode = 1; });
module.exports = { main, resolveMode };

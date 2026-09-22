const fs = require('node:fs');
const path = require('node:path');
const { sha } = require('./data');
const ROOT = path.join(__dirname, '../..');
function sourceFingerprint() {
  const paths = fs.readdirSync(__dirname).filter(f => f.endsWith('.js')).sort().map(f => `src/ethV2/${f}`)
    .concat(['src/research/strategies/ethPredictionV2.js', 'scripts/eth-v2.js', 'src/trendGrid/archive.js']);
  const files = paths.map(file => ({ file, sha256: sha(fs.readFileSync(path.join(ROOT, file))) }));
  return { files, sha256: sha(JSON.stringify(files)) };
}
module.exports = { ROOT, sourceFingerprint };

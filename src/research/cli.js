// Quant Research V1 CLI.
//
// Usage:
//   node src/research/cli.js --symbol BTCUSDT --strategy rsiEma --file data/market/BTCUSDT-15m.csv
//   node src/research/cli.js --symbol BTCUSDT --strategy emaCrossover --file data/market/BTCUSDT-15m.csv
//   node src/research/cli.js --compare --symbol BTCUSDT --file data/market/BTCUSDT-15m.csv
//   node src/research/cli.js --symbol BTCUSDT --strategy rsiEma --file ... \
//       --train-start 2023-01-01 --train-end 2024-12-31 --test-start 2025-01-01 --test-end 2025-12-31
//
// npm wrappers:
//   npm run research -- --symbol BTCUSDT --strategy rsiEma --file ...
//   npm run research:compare -- --file ... --symbol BTCUSDT

const { runSingle, runCompare, runDataQuality } = require('./experiments/runner');
const { listStrategies, isResearchStrategy } = require('./strategyAdapter');
const { loadCandles } = require('./data/candleRepository');

const HOLDOUT_START_MS = Date.UTC(2026, 0, 1); // FINAL HOLDOUT begins 2026-01-01

function usage() {
  return `
Quant Research V1

Usage:
  npm run research -- --symbol <SYMBOL> --strategy <emaCrossover|rsiEma> [options]
  npm run research:compare -- --symbol <SYMBOL> [options]

Options:
  --symbol <SYMBOL>            Trading pair, e.g. BTCUSDT (required)
  --strategy <NAME>            Strategy: ${listStrategies().join(' | ')} (required for single backtest)
  --file <PATH>                CSV file. Default: data/market/<SYMBOL>-15m.csv
  --compare                    Run batch comparison of all strategies instead of a single backtest
  --initial-capital <N>        Starting equity. Default 10000
  --commission <DECIMAL>       Commission per fill (0.0004 = 0.04%). Default 0.0004
  --slippage <DECIMAL>         Slippage per fill (0.0002 = 0.02%). Default 0.0002
  --position-size-pct <N>      % of equity per position (no leverage). Default 100
  --funding-rate <DECIMAL>     Constant funding rate per bar. Default 0 (not included)
  --train-start <DATE>         Walk-forward train start (e.g. 2023-01-01)
  --train-end <DATE>           Walk-forward train end (exclusive)
  --test-start <DATE>          Walk-forward test start
  --test-end <DATE>            Walk-forward test end (exclusive)
  --out-dir <PATH>             Output directory. Default reports/
  --help                       Show this help

Examples:
  npm run research -- --symbol BTCUSDT --strategy rsiEma --file data/market/BTCUSDT-15m.csv
  npm run research -- --symbol BTCUSDT --strategy emaCrossover --file data/market/BTCUSDT-15m.csv
  npm run research:compare -- --symbol BTCUSDT --file data/market/BTCUSDT-15m.csv
  npm run research -- --symbol BTCUSDT --strategy rsiEma --file data/market/BTCUSDT-15m.csv \
      --train-start 2023-01-01 --train-end 2024-12-31 --test-start 2025-01-01 --test-end 2025-12-31
`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) {
      throw new Error(`Unexpected positional argument: "${raw}" (all options must use --flag value)`);
    }
    let key = raw.slice(2);
    let value = null;
    const eq = key.indexOf('=');
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      value = argv[++i];
    } else {
      value = 'true';
    }
    args[key] = value;
  }
  return args;
}

function requireNumber(name, value, { min, max, integer = false }) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required option --${name}`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got "${value}"`);
  if (min !== undefined && n < min) throw new Error(`--${name} must be >= ${min}, got ${n}`);
  if (max !== undefined && n > max) throw new Error(`--${name} must be <= ${max}, got ${n}`);
  if (integer && !Number.isInteger(n)) throw new Error(`--${name} must be an integer, got ${n}`);
  return n;
}

function parseDate(name, value) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing date for --${name}`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`Cannot parse date for --${name}: "${value}" (expected e.g. 2023-01-01)`);
  }
  return ms;
}

function validateWalkForward(args) {
  const present = ['train-start', 'train-end', 'test-start', 'test-end'].filter((k) => args[k] !== undefined && args[k] !== 'true');
  if (present.length === 0) return null;
  if (present.length !== 4) {
    throw new Error(`Walk-forward requires all four of --train-start --train-end --test-start --test-end (got: ${present.join(', ')})`);
  }
  const trainStart = parseDate('train-start', args['train-start']);
  const trainEnd = parseDate('train-end', args['train-end']);
  const testStart = parseDate('test-start', args['test-start']);
  const testEnd = parseDate('test-end', args['test-end']);
  if (!(trainStart < trainEnd)) throw new Error('Walk-forward: train-start must be before train-end');
  if (!(trainEnd <= testStart)) throw new Error('Walk-forward: train and test ranges must not overlap (train-end <= test-start)');
  if (!(testStart < testEnd)) throw new Error('Walk-forward: test-start must be before test-end');
  return { trainStartMs: trainStart, trainEndMs: trainEnd, testStartMs: testStart, testEndMs: testEnd };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    process.exit(0);
  }
  const args = parseArgs(argv);

  const isCompare = args['compare'] === 'true' || args['compare'] === true;

  const symbol = args['symbol'];
  if (!symbol) throw new Error('Missing required option --symbol (e.g. BTCUSDT)');

  const initialCapital = requireNumber('initial-capital', args['initial-capital'] ?? '10000', { min: 1 });
  const commission = requireNumber('commission', args['commission'] ?? '0.0004', { min: 0, max: 1 });
  const slippage = requireNumber('slippage', args['slippage'] ?? '0.0002', { min: 0, max: 1 });
  const positionSizePct = requireNumber('position-size-pct', args['position-size-pct'] ?? '100', { min: 0.1, max: 100 });
  const fundingRate = requireNumber('funding-rate', args['funding-rate'] ?? '0', { min: 0, max: 1 });
  const outDir = args['out-dir'] || 'reports';

  const common = { symbol, file: args['file'], initialCapital, commissionPct: commission, slippagePct: slippage, positionSizePct, fundingRate, outDir };

  const isDataQuality = args['data-quality'] === 'true' || args['data-quality'] === true;
  if (isDataQuality) {
    await runDataQuality({ file: args['file'], symbol, interval: args['interval'] || '15m', outDir });
    return;
  }

  if (isCompare) {
    await runCompare(common);
    return;
  }

  const strategy = args['strategy'];
  if (!strategy) throw new Error('Missing required option --strategy');
  const valid = listStrategies();
  if (!valid.includes(strategy)) {
    throw new Error(`Unknown strategy "${strategy}". Available: ${valid.join(', ')}`);
  }

  // FINAL HOLDOUT protection: research candidate strategies may not be evaluated
  // on data at/after 2026-01-01 without an explicit --unlock-holdout.
  if (isResearchStrategy(strategy)) {
    const walk = validateWalkForward(args);
    let touchesHoldout = walk && walk.testEndMs > HOLDOUT_START_MS;
    if (!touchesHoldout) {
      const { candles } = loadCandles({ file: args['file'], symbol });
      if (candles.length && candles[candles.length - 1].timestamp >= HOLDOUT_START_MS) touchesHoldout = true;
    }
    if (touchesHoldout && args['unlock-holdout'] !== 'true') {
      console.error('FINAL HOLDOUT IS LOCKED');
      console.error(`Research candidate "${strategy}" may not be run on data >= 2026-01-01 without --unlock-holdout.`);
      process.exit(2);
    }
  }

  const walk = validateWalkForward(args);
  await runSingle({ ...common, strategy, ...(walk || {}) });
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`ERROR: ${err.message}`);
    console.error('Run with --help for usage.');
    process.exit(1);
  }
);

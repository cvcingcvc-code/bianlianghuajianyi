// Loads + validates historical OHLCV data from CSV into typed candles.
// Combines csvLoader (raw parse) and dataValidator (quality checks).
//
// Policy:
//   - Missing required columns            -> throw
//   - Duplicate timestamps                -> keep first, report as warning
//   - Timestamps not strictly ascending   -> throw
//   - Any invalid row (NaN / bad OHLC / close<=0 / negative volume) -> throw
//   - Empty result after cleaning         -> throw

const fs = require('fs');
const path = require('path');
const { parse, readFile, detectMissingColumns } = require('./csvLoader');
const { validateCandles, formatQualityReport } = require('./dataValidator');

const MARKET_DIR = path.join(__dirname, '..', '..', '..', 'data', 'market');

function ensureDataDirs() {
  fs.mkdirSync(MARKET_DIR, { recursive: true });
}

function defaultPathFor(symbol, interval = '15m') {
  return path.join(MARKET_DIR, `${symbol}-${interval}.csv`);
}

function normalizeTimestamp(value) {
  if (typeof value === 'number') return value;
  const s = String(value).trim();
  if (s === '') throw new Error(`timestamp is empty`);
  if (/^\d+$/.test(s)) return Number(s);
  const parsed = Date.parse(s);
  if (Number.isNaN(parsed)) {
    throw new Error(`cannot parse timestamp "${value}"`);
  }
  return parsed;
}

function toNumber(value, field) {
  if (value === '' || value === undefined || value === null) return NaN;
  const n = Number(value);
  return Number.isNaN(n) ? NaN : n;
}

// Build typed candles from parsed CSV rows (raw strings).
function rowsToCandles(columns, rows) {
  const idx = {
    timestamp: columns.indexOf('timestamp'),
    open: columns.indexOf('open'),
    high: columns.indexOf('high'),
    low: columns.indexOf('low'),
    close: columns.indexOf('close'),
    volume: columns.indexOf('volume'),
  };

  const candles = [];
  const seen = new Map();
  let duplicateCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const get = (key) => row[idx[key]];

    const candle = {
      timestamp: normalizeTimestamp(get('timestamp')),
      open: toNumber(get('open'), 'open'),
      high: toNumber(get('high'), 'high'),
      low: toNumber(get('low'), 'low'),
      close: toNumber(get('close'), 'close'),
      volume: toNumber(get('volume'), 'volume'),
    };

    if (seen.has(candle.timestamp)) {
      duplicateCount++;
      continue; // keep first occurrence
    }
    seen.set(candle.timestamp, true);
    candles.push(candle);
  }

  return { candles, duplicateCount };
}

// Load candles from a CSV file (or the default data/market/<SYMBOL>-<interval>.csv).
// Returns { candles, qualityReport }.
function loadCandles({ file, symbol, interval = '15m' }) {
  ensureDataDirs();

  const csvPath = file || defaultPathFor(symbol, interval);
  if (!fs.existsSync(csvPath)) {
    const hint = file
      ? ''
      : `\nExpected at default location: ${csvPath}\nCreate it with columns: timestamp,open,high,low,close,volume`;
    throw new Error(`Historical CSV not found: ${csvPath}${hint}`);
  }

  const { columns, rows } = readFile(csvPath);
  const missing = detectMissingColumns(columns);
  if (missing.length > 0) {
    throw new Error(
      `CSV ${path.basename(csvPath)} is missing required column(s): ${missing.join(', ')} ` +
        `(found: ${columns.join(', ')})`
    );
  }

  const { candles, duplicateCount } = rowsToCandles(columns, rows);
  if (candles.length === 0) {
    throw new Error(`CSV ${path.basename(csvPath)} contains no usable data rows`);
  }

  const validation = validateCandles(candles);
  const orderErrors = validation.errors.filter((e) => e.type === 'out-of-order');
  if (orderErrors.length > 0) {
    const first = orderErrors[0];
    throw new Error(
      `CSV ${path.basename(csvPath)}: timestamps are not strictly ascending ` +
        `(first violation: ${first.message})`
    );
  }

  if (validation.errors.length > 0) {
    const msgs = validation.errors.slice(0, 5).map((e) => `  - ${e.message}`).join('\n');
    const more = validation.errors.length > 5 ? `\n  ... and ${validation.errors.length - 5} more` : '';
    throw new Error(
      `CSV ${path.basename(csvPath)} contains invalid candle row(s) (${validation.errors.length}):\n${msgs}${more}`
    );
  }

  const qualityReport = {
    file: csvPath,
    candles,
    duplicateCount,
    warnings: validation.warnings,
    validation,
  };

  return { candles, qualityReport };
}

// Convenience: print the quality report to a string for logging / tests.
function formatReport(qualityReport) {
  return formatQualityReport(qualityReport);
}

module.exports = { loadCandles, ensureDataDirs, defaultPathFor, MARKET_DIR, formatReport };

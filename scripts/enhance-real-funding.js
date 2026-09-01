// Enhance real funding data: fill missing markPrice from candle close prices.
// Uses official Binance USD-M 15m candles already in data/market/.
//
// Usage: node scripts/enhance-real-funding.js

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REAL_DIR = path.join(ROOT, 'data', 'funding-real');
const MARKET_DIR = path.join(ROOT, 'data', 'market');

const ASSETS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'];
const HOLDOUT_START_MS = Date.UTC(2026, 0, 1);

function loadCandles(symbol) {
  const csvPath = path.join(MARKET_DIR, `${symbol}-15m.csv`);
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim());
  const header = lines[0].split(',').map((h) => h.trim());
  const timestampIdx = header.indexOf('timestamp');
  const closeIdx = header.indexOf('close');
  if (timestampIdx === -1 || closeIdx === -1) {
    console.log(`  WARNING: header missing timestamp/close: ${header.join(',')}`);
    return [];
  }
  const candles = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const timestamp = Number(values[timestampIdx]);
    const close = Number(values[closeIdx]);
    if (Number.isFinite(timestamp) && Number.isFinite(close)) {
      candles.push({ timestamp, close });
    }
  }
  candles.sort((a, b) => a.timestamp - b.timestamp);
  return candles;
}

function findCloseBefore(candles, targetMs) {
  let lo = 0;
  let hi = candles.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].timestamp <= targetMs) {
      best = candles[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function enhanceAsset(symbol) {
  const csvPath = path.join(REAL_DIR, `${symbol}.csv`);
  if (!fs.existsSync(csvPath)) {
    console.log(`${symbol}: CSV not found, skipping`);
    return null;
  }

  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim());
  const header = lines[0];
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    rows.push({
      symbol: values[0],
      fundingTime: Number(values[1]),
      fundingRate: Number(values[2]),
      markPrice: values[3] ? Number(values[3]) : null,
      rateType: values[4] || '',
      source: values[5] || '',
    });
  }

  const candles = loadCandles(symbol);
  console.log(`${symbol}: ${rows.length} events, ${candles.length} candles`);

  let filled = 0;
  let alreadyHad = 0;
  let noCandle = 0;

  for (const row of rows) {
    if (row.fundingTime >= HOLDOUT_START_MS) continue;
    if (row.markPrice != null && Number.isFinite(row.markPrice)) {
      alreadyHad++;
      continue;
    }
    const candle = findCloseBefore(candles, row.fundingTime);
    if (candle) {
      row.markPrice = candle.close;
      filled++;
    } else {
      noCandle++;
    }
  }

  // Rewrite CSV with enhanced markPrice
  const outLines = [header];
  for (const row of rows) {
    outLines.push([
      row.symbol, row.fundingTime, row.fundingRate,
      row.markPrice != null ? row.markPrice : '',
      row.rateType, row.source,
    ].join(','));
  }
  fs.writeFileSync(csvPath, outLines.join('\n') + '\n', 'utf8');

  console.log(`  Already had markPrice: ${alreadyHad}`);
  console.log(`  Filled from candle: ${filled}`);
  console.log(`  No candle found: ${noCandle}`);
  console.log(`  Enhanced CSV written: ${csvPath}`);

  return { symbol, total: rows.length, filled, alreadyHad, noCandle };
}

function main() {
  console.log('=== Enhancing real funding data with markPrice ===\n');
  const results = {};
  for (const symbol of ASSETS) {
    results[symbol] = enhanceAsset(symbol);
    console.log();
  }

  // Summary
  console.log('=== Summary ===');
  for (const [symbol, r] of Object.entries(results)) {
    if (!r) continue;
    const pct = ((r.filled + r.alreadyHad) / r.total * 100).toFixed(1);
    console.log(`${symbol}: ${r.filled + r.alreadyHad}/${r.total} (${pct}%) have markPrice`);
  }
}

main();

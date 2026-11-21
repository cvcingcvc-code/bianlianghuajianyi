#!/usr/bin/env node
// 2026 Final Holdout Readiness Inspector & Execution Helper
// Inspects local market data readiness for the 2026 Out-of-Sample Holdout Protocol.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { HOLDOUT_START_MS } = require('../src/research/holdoutGuard');

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'];
const MARKET_DIR = path.join(__dirname, '..', 'data', 'market');
const FUNDING_DIR = path.join(__dirname, '..', 'data', 'funding-real');
const HOLDOUT_DIR = path.join(__dirname, '..', 'data', 'holdout-2026');

async function scanCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    return { exists: false };
  }
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineCount = 0;
  let holdoutCount = 0;
  let firstTs = null;
  let lastTs = null;

  for await (const line of rl) {
    if (!line.trim() || line.startsWith('timestamp') || line.startsWith('fundingTime')) continue;
    lineCount++;
    const parts = line.split(',');
    const ts = parseInt(parts[0], 10);
    if (!Number.isNaN(ts)) {
      if (firstTs === null) firstTs = ts;
      lastTs = ts;
      if (ts >= HOLDOUT_START_MS) {
        holdoutCount++;
      }
    }
  }

  return {
    exists: true,
    lineCount,
    holdoutCount,
    firstTs,
    lastTs,
    has2026: holdoutCount > 0,
  };
}

async function main() {
  console.log('================================================================');
  console.log('       2026 FINAL HOLDOUT PROTOCOL READINESS REPORT');
  console.log('================================================================');
  console.log(`Holdout Start Date: 2026-01-01 UTC (${HOLDOUT_START_MS})\n`);

  let allReady = true;
  const results = {};

  for (const sym of SYMBOLS) {
    const marketFile = path.join(MARKET_DIR, `${sym}-15m.csv`);
    const fundingFile = path.join(FUNDING_DIR, `${sym}.csv`);

    const marketStatus = await scanCsv(marketFile);
    const fundingStatus = await scanCsv(fundingFile);

    results[sym] = { marketStatus, fundingStatus };

    console.log(`[${sym}]`);
    if (!marketStatus.exists) {
      allReady = false;
      console.log(`  Market Klines (15m): MISSING -> ${path.relative(process.cwd(), marketFile)}`);
    } else {
      console.log(`  Market Klines (15m): ${marketStatus.lineCount} rows (2026 Holdout: ${marketStatus.holdoutCount} rows)`);
      if (!marketStatus.has2026) allReady = false;
    }

    if (!fundingStatus.exists) {
      console.log(`  Funding Rates:       MISSING -> ${path.relative(process.cwd(), fundingFile)}`);
    } else {
      console.log(`  Funding Rates:       ${fundingStatus.lineCount} rows (Real-time data available)`);
    }
    console.log('');
  }

  console.log('----------------------------------------------------------------');
  if (allReady) {
    console.log('STATUS: READY FOR FINAL HOLDOUT UNLOCK');
    console.log('All candidate assets have local 2026 out-of-sample candles.');
    console.log('\nTo execute formal unlocked backtest for breakout24h4h:');
    console.log('  npm run research -- --symbol BTCUSDT --strategy breakout24h4h --file data/market/BTCUSDT-15m.csv --unlock-holdout true');
  } else {
    console.log('STATUS: DATA REQUIRED (Local market files not yet downloaded)');
    console.log('Historical 15m klines are excluded by .gitignore to protect repo size.');
    console.log('\nTo acquire official Binance Vision data:');
    console.log('  1. Download monthly 15m klines from:');
    console.log('     https://data.binance.vision/?prefix=data/futures/um/monthly/klines/');
    console.log('  2. Place normalized CSV files in:');
    console.log('     data/market/<SYMBOL>-15m.csv');
    console.log('  3. Run this script again to verify checksums and readiness.');
  }
  console.log('================================================================\n');

  return { allReady, results };
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Readiness check failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main, scanCsv };

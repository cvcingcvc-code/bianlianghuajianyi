// Download official Binance USD-M funding rate history for all 4 assets.
// Research-only. Output: data/funding/<SYMBOL>-funding.csv
//
// Usage: node scripts/download-funding-history.js

const path = require('node:path');
const fs = require('node:fs');
const { downloadFundingHistory, saveFundingCSV, HOLDOUT_START_MS } = require('../src/research/funding/fundingDownloader');
const { verifyFundingData } = require('../src/research/funding/fundingDataValidator');

const ROOT = path.join(__dirname, '..');
const FUNDING_DIR = path.join(ROOT, 'data', 'funding');

const ASSETS = [
  { symbol: 'BTCUSDT', startMs: Date.UTC(2021, 0, 1) },
  { symbol: 'ETHUSDT', startMs: Date.UTC(2021, 0, 1) },
  { symbol: 'BNBUSDT', startMs: Date.UTC(2020, 1, 10) },
  { symbol: 'SOLUSDT', startMs: Date.UTC(2020, 8, 14) },
];

const END_MS = Date.UTC(2025, 11, 31, 23, 59, 59, 999);

async function main() {
  if (!fs.existsSync(FUNDING_DIR)) fs.mkdirSync(FUNDING_DIR, { recursive: true });

  const reports = {};
  for (const asset of ASSETS) {
    console.log(`\n=== Downloading ${asset.symbol} ===`);
    console.log(`  Range: ${new Date(asset.startMs).toISOString()} → ${new Date(END_MS).toISOString()}`);

    const events = await downloadFundingHistory({
      symbol: asset.symbol,
      startMs: asset.startMs,
      endMs: END_MS,
      onProgress: ({ page, count, lastTime }) => {
        process.stdout.write(`  page ${page}: ${count} events (last: ${new Date(lastTime).toISOString()})\r`);
      },
    });

    console.log(`\n  Total: ${events.length} events`);

    const csvPath = path.join(FUNDING_DIR, `${asset.symbol}-funding.csv`);
    saveFundingCSV(events, csvPath);
    console.log(`  Saved: ${csvPath}`);

    const report = verifyFundingData({
      events,
      symbol: asset.symbol,
      expectedStartMs: asset.startMs,
      expectedEndMs: END_MS,
    });
    reports[asset.symbol] = report;
    console.log(`  Status: ${report.status}`);
    console.log(`  First: ${report.firstFundingTime ? new Date(report.firstFundingTime).toISOString() : 'N/A'}`);
    console.log(`  Last: ${report.lastFundingTime ? new Date(report.lastFundingTime).toISOString() : 'N/A'}`);
    console.log(`  Events: ${report.eventCount}`);
    console.log(`  Positive: ${report.positiveFundingEvents} | Negative: ${report.negativeFundingEvents} | Zero: ${report.zeroFundingEvents}`);
    console.log(`  Duplicates: ${report.duplicateCount} | Invalid rate: ${report.invalidRateCount} | Invalid ts: ${report.invalidTimestampCount}`);
  }

  console.log('\n=== SUMMARY ===');
  for (const [sym, r] of Object.entries(reports)) {
    console.log(`${sym}: ${r.status} (${r.eventCount} events)`);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });

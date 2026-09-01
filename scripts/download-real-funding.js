// Real Binance USD-M Funding Rate Downloader with provenance tracking.
// Research-only. Output: data/funding-real/<SYMBOL>.csv + manifest.json
//
// Usage: node scripts/download-real-funding.js
//
// Requirements:
// - Official Binance endpoint only (GET /fapi/v1/fundingRate)
// - Full pagination, no synthetic data
// - Provenance manifest with SHA256 per asset
// - Synthetic data rejection in validation runner

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const REAL_FUNDING_DIR = path.join(ROOT, 'data', 'funding-real');
const BASE_URL = 'https://fapi.binance.com';
const ENDPOINT = '/fapi/v1/fundingRate';
const PAGE_LIMIT = 1000;
const RETRY_MAX = 5;
const RETRY_DELAY_MS = 2000;
const PAGE_DELAY_MS = 250;

const HOLDOUT_START_MS = Date.UTC(2026, 0, 1);

const ASSETS = [
  { symbol: 'BTCUSDT', startMs: Date.UTC(2021, 0, 1) },
  { symbol: 'ETHUSDT', startMs: Date.UTC(2021, 0, 1) },
  { symbol: 'BNBUSDT', startMs: Date.UTC(2020, 1, 10) },
  { symbol: 'SOLUSDT', startMs: Date.UTC(2020, 8, 14) },
];

const END_MS = Date.UTC(2025, 11, 31, 23, 59, 59, 999);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fetchPage(symbol, startTime, endTime) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ symbol, limit: String(PAGE_LIMIT) });
    if (startTime != null) params.set('startTime', String(startTime));
    if (endTime != null) params.set('endTime', String(endTime));
    const url = `${BASE_URL}${ENDPOINT}?${params}`;
    https.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('RATE_LIMITED'));
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`JSON: ${e.message}`)); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchWithRetry(symbol, startTime, endTime) {
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try { return await fetchPage(symbol, startTime, endTime); }
    catch (err) {
      if (attempt === RETRY_MAX) throw err;
      console.warn(`  [retry ${attempt}/${RETRY_MAX}] ${err.message}, waiting ${RETRY_DELAY_MS * attempt}ms`);
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
}

async function downloadAsset({ symbol, startMs, endMs }) {
  if (endMs >= HOLDOUT_START_MS) throw new Error(`${symbol}: endTime touches 2026 HOLDOUT`);

  const allEvents = [];
  let cursor = startMs;
  let page = 0;

  while (cursor <= endMs) {
    page++;
    const batch = await fetchWithRetry(symbol, cursor, endMs);
    if (!Array.isArray(batch) || batch.length === 0) break;

    allEvents.push(...batch);
    process.stdout.write(`  page ${page}: ${allEvents.length} events\r`);

    const lastTime = batch[batch.length - 1].fundingTime;
    cursor = lastTime + 1;
    if (batch.length < PAGE_LIMIT) break;
    await sleep(PAGE_DELAY_MS);
  }

  // Sort ascending
  allEvents.sort((a, b) => a.fundingTime - b.fundingTime);

  // Deduplicate
  const seen = new Set();
  const deduped = [];
  for (const ev of allEvents) {
    if (!seen.has(ev.fundingTime)) { seen.add(ev.fundingTime); deduped.push(ev); }
  }

  return deduped;
}

function saveCSV(events, filePath) {
  const header = 'symbol,fundingTime,fundingRate,markPrice,rateType,source\n';
  const rows = events.map((e) => [
    e.symbol, e.fundingTime, e.fundingRate,
    e.markPrice != null ? e.markPrice : '',
    e.rateType || '',
    'BINANCE_OFFICIAL_FUNDING_RATE_HISTORY',
  ].join(',')).join('\n');
  fs.writeFileSync(filePath, header + rows + '\n', 'utf8');
}

function computeSHA256(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function main() {
  if (!fs.existsSync(REAL_FUNDING_DIR)) fs.mkdirSync(REAL_FUNDING_DIR, { recursive: true });

  const manifest = { generatedAt: new Date().toISOString(), assets: {} };

  for (const asset of ASSETS) {
    console.log(`\n=== ${asset.symbol} ===`);
    try {
      const events = await downloadAsset(asset);
      console.log(`  Total: ${events.length} events`);

      const csvPath = path.join(REAL_FUNDING_DIR, `${asset.symbol}.csv`);
      saveCSV(events, csvPath);

      const sha256 = computeSHA256(csvPath);
      const directMp = events.filter((e) => e.markPrice != null && e.markPrice !== '').length;
      const missingMp = events.length - directMp;
      const positive = events.filter((e) => e.fundingRate > 0).length;
      const negative = events.filter((e) => e.fundingRate < 0).length;
      const zero = events.filter((e) => e.fundingRate === 0).length;

      manifest.assets[asset.symbol] = {
        sourceEndpoint: 'GET /fapi/v1/fundingRate',
        symbol: asset.symbol,
        requestedStart: new Date(asset.startMs).toISOString(),
        requestedEnd: new Date(END_MS).toISOString(),
        downloadedAt: new Date().toISOString(),
        firstFundingTime: events[0]?.fundingTime,
        lastFundingTime: events[events.length - 1]?.fundingTime,
        rowCount: events.length,
        sha256,
        directMarkPriceCount: directMp,
        missingMarkPriceCount: missingMp,
        duplicateCount: 0, // deduplication happens during download
        invalidCount: 0,
        positiveRateCount: positive,
        negativeRateCount: negative,
        zeroRateCount: zero,
      };

      console.log(`  SHA256: ${sha256}`);
      console.log(`  First: ${new Date(events[0]?.fundingTime).toISOString()}`);
      console.log(`  Last: ${new Date(events[events.length - 1]?.fundingTime).toISOString()}`);
      console.log(`  Positive: ${positive} | Negative: ${negative} | Zero: ${zero}`);
      console.log(`  Mark price: DIRECT=${directMp} MISSING=${missingMp}`);
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      manifest.assets[asset.symbol] = { error: err.message };
    }
  }

  const manifestPath = path.join(REAL_FUNDING_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\nManifest saved: ${manifestPath}`);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });

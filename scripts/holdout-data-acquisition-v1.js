// Final Holdout Data Acquisition V1 — Download ALL 2026 data from data.binance.vision.
// Downloads monthly klines + monthly funding for 4 assets × 7 months (2026-01 → 2026-07).
// Merges into existing CSVs. Checksum-verified. Provenance tracked. NO strategy execution.

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MARKET_DIR = path.join(ROOT, 'data', 'market');
const FUNDING_DIR = path.join(ROOT, 'data', 'funding-real');
const HOLDOUT_DIR = path.join(ROOT, 'data', 'holdout-2026');
const RAW_DIR = path.join(ROOT, 'data', 'market', 'raw');

const ASSETS = [
  { symbol: 'BTCUSDT', devStartMs: Date.UTC(2021, 0, 1) },
  { symbol: 'ETHUSDT', devStartMs: Date.UTC(2021, 0, 1) },
  { symbol: 'BNBUSDT', devStartMs: Date.UTC(2020, 1, 10) },
  { symbol: 'SOLUSDT', devStartMs: Date.UTC(2020, 8, 14) },
];

const HOLDOUT_START_MS = Date.UTC(2026, 0, 1);
const HOLDOUT_END_MS = Date.UTC(2026, 7, 31, 23, 59, 59, 999); // 2026-07-31
const MONTHS = ['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07'];

const KLINE_BASE = 'https://data.binance.vision/data/futures/um/monthly/klines';
const FUNDING_BASE = 'https://data.binance.vision/data/futures/um/monthly/fundingRate';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function computeSHA256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function downloadFile(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 404) return resolve(null);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function unzipCSV(zipBuffer, tmpDir) {
  const zipPath = path.join(tmpDir, 'archive.zip');
  fs.writeFileSync(zipPath, zipBuffer);
  try {
    execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force"`, { stdio: 'pipe' });
  } catch (e) {
    try {
      execSync(`tar -xf "${zipPath}" -C "${tmpDir}"`, { stdio: 'pipe' });
    } catch (e2) {
      throw new Error(`Cannot extract ZIP: ${e2.message}`);
    }
  }
  const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.csv'));
  if (files.length === 0) throw new Error('No CSV in ZIP');
  return path.join(tmpDir, files[0]);
}

function normalizeKlineCSV(csvContent) {
  // data.binance.vision format: open_time,open,high,low,close,close_time,...
  // We need: timestamp,open,high,low,close,volume
  const lines = csvContent.split('\n').filter((l) => l.trim());
  if (lines.length <= 1) return null;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const ts = Number(cols[0]);
    const open = Number(cols[1]);
    const high = Number(cols[2]);
    const low = Number(cols[3]);
    const close = Number(cols[4]);
    const vol = Number(cols[5]);
    if (Number.isFinite(ts) && Number.isFinite(close)) {
      out.push(`${ts},${open},${high},${low},${close},${vol}`);
    }
  }
  return out.length > 0 ? out.join('\n') : null;
}

function normalizeFundingCSV(csvContent, symbol) {
  // data.binance.vision format: calc_time,funding_interval_hours,last_funding_rate
  // We need: symbol,fundingTime,fundingRate,markPrice,rateType,source
  const lines = csvContent.split('\n').filter((l) => l.trim());
  if (lines.length <= 1) return null;
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const fundingTime = Number(cols[0]);
    const fundingRate = Number(cols[2]);
    if (!Number.isFinite(fundingTime) || !Number.isFinite(fundingRate)) continue;
    out.push(`${symbol},${fundingTime},${fundingRate},,,"BINANCE_DATA_VISION_OFFICIAL_ARCHIVE"`);
  }
  return out.length > 0 ? out.join('\n') : null;
}

async function downloadKlines(symbol) {
  console.log(`\n=== ${symbol} KLINES ===`);
  const tmpDir = path.join(ROOT, 'data', '.tmp-kline-2026');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const allRows = [];
  const manifest = [];

  for (const ym of MONTHS) {
    const [y, m] = ym.split('-');
    const zipName = `${symbol}-15m-${ym}.zip`;
    const checksumName = `${zipName}.CHECKSUM`;
    const zipUrl = `${KLINE_BASE}/${symbol}/15m/${zipName}`;
    const checksumUrl = `${KLINE_BASE}/${symbol}/15m/${checksumName}`;

    process.stdout.write(`  ${ym}: `);
    try {
      const zipData = await downloadFile(zipUrl);
      if (!zipData) { console.log('404'); manifest.push({ month: ym, status: 'NOT_AVAILABLE' }); continue; }

      // Download checksum
      const checksumData = await downloadFile(checksumUrl);
      if (checksumData) {
        const expected = checksumData.toString('utf8').trim().split(/\s+/)[0].toLowerCase();
        const actual = computeSHA256(zipData);
        if (actual !== expected) {
          console.log(`CHECKSUM MISMATCH`); manifest.push({ month: ym, status: 'CHECKSUM_MISMATCH' }); continue;
        }
      }

      // Extract CSV
      const csvPath = unzipCSV(zipData, tmpDir);
      const rawCSV = fs.readFileSync(csvPath, 'utf8');
      const normalized = normalizeKlineCSV(rawCSV);

      // Clean tmp
      fs.readdirSync(tmpDir).forEach((f) => fs.unlinkSync(path.join(tmpDir, f)));

      if (normalized) {
        allRows.push(...normalized.split('\n'));
        console.log(`OK (${normalized.split('\n').length} rows)`);
        manifest.push({ month: ym, status: 'OK', rows: normalized.split('\n').length, sha256: computeSHA256(zipData), source: 'MONTHLY_ARCHIVE' });
      } else {
        console.log('EMPTY CSV'); manifest.push({ month: ym, status: 'EMPTY_CSV' });
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`); manifest.push({ month: ym, status: 'ERROR', error: err.message });
    }
    await sleep(200);
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}

  // Merge into existing CSV
  const existingPath = path.join(MARKET_DIR, `${symbol}-15m.csv`);
  const existingContent = fs.readFileSync(existingPath, 'utf8');
  const existingLines = existingContent.split('\n').filter((l) => l.trim());
  const header = existingLines[0];
  const existingRows = existingLines.slice(1);

  // Remove any existing 2026 rows
  const pre2026 = existingRows.filter((l) => {
    const ts = Number(l.split(',')[0]);
    return ts < HOLDOUT_START_MS;
  });

  // Combine: pre-2026 + new 2026
  const combined = [header, ...pre2026, ...allRows].join('\n') + '\n';
  fs.writeFileSync(existingPath, combined, 'utf8');

  const totalRows = pre2026.length + allRows.length;
  console.log(`  MERGED: ${pre2026.length} pre-2026 + ${allRows.length} new 2026 = ${totalRows} total`);

  return { manifest, totalRows, holdoutRows: allRows.length, existingPre2026: pre2026.length };
}

async function downloadFunding(symbol) {
  console.log(`\n=== ${symbol} FUNDING ===`);
  const tmpDir = path.join(ROOT, 'data', '.tmp-funding-2026');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const allRows = [];
  const manifest = [];

  for (const ym of MONTHS) {
    const zipName = `${symbol}-fundingRate-${ym}.zip`;
    const checksumName = `${zipName}.CHECKSUM`;
    const zipUrl = `${FUNDING_BASE}/${symbol}/${zipName}`;
    const checksumUrl = `${FUNDING_BASE}/${symbol}/${checksumName}`;

    process.stdout.write(`  ${ym}: `);
    try {
      const zipData = await downloadFile(zipUrl);
      if (!zipData) { console.log('404'); manifest.push({ month: ym, status: 'NOT_AVAILABLE' }); continue; }

      // Download checksum
      const checksumData = await downloadFile(checksumUrl);
      if (checksumData) {
        const expected = checksumData.toString('utf8').trim().split(/\s+/)[0].toLowerCase();
        const actual = computeSHA256(zipData);
        if (actual !== expected) {
          console.log(`CHECKSUM MISMATCH`); manifest.push({ month: ym, status: 'CHECKSUM_MISMATCH' }); continue;
        }
      }

      // Extract CSV
      const csvPath = unzipCSV(zipData, tmpDir);
      const rawCSV = fs.readFileSync(csvPath, 'utf8');
      const normalized = normalizeFundingCSV(rawCSV, symbol);

      // Clean tmp
      fs.readdirSync(tmpDir).forEach((f) => fs.unlinkSync(path.join(tmpDir, f)));

      if (normalized) {
        allRows.push(...normalized.split('\n'));
        console.log(`OK (${normalized.split('\n').length} events)`);
        manifest.push({ month: ym, status: 'OK', events: normalized.split('\n').length, sha256: computeSHA256(zipData), source: 'MONTHLY_ARCHIVE' });
      } else {
        console.log('EMPTY CSV'); manifest.push({ month: ym, status: 'EMPTY_CSV' });
      }
    } catch (err) {
      console.log(`ERROR: ${err.message}`); manifest.push({ month: ym, status: 'ERROR', error: err.message });
    }
    await sleep(200);
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}

  // Merge into existing CSV
  const existingPath = path.join(FUNDING_DIR, `${symbol}.csv`);
  const existingContent = fs.readFileSync(existingPath, 'utf8');
  const existingLines = existingContent.split('\n').filter((l) => l.trim());
  const header = existingLines[0];
  const existingRows = existingLines.slice(1);

  // Remove any existing 2026 rows
  const pre2026 = existingRows.filter((l) => {
    const ts = Number(l.split(',')[1]);
    return ts < HOLDOUT_START_MS;
  });

  // Combine: pre-2026 + new 2026
  const combined = [header, ...pre2026, ...allRows].join('\n') + '\n';
  fs.writeFileSync(existingPath, combined, 'utf8');

  const totalRows = pre2026.length + allRows.length;
  console.log(`  MERGED: ${pre2026.length} pre-2026 + ${allRows.length} new 2026 = ${totalRows} total`);

  return { manifest, totalRows, holdoutRows: allRows.length, existingPre2026: pre2026.length };
}

function loadCandleTimestamps(symbol) {
  const csvPath = path.join(MARKET_DIR, `${symbol}-15m.csv`);
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim());
  const header = lines[0].split(',');
  const tsIdx = header.indexOf('timestamp');
  return lines.slice(1).map((l) => Number(l.split(',')[tsIdx])).sort((a, b) => a - b);
}

function loadFundingEvents(symbol) {
  const csvPath = path.join(FUNDING_DIR, `${symbol}.csv`);
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim());
  const header = lines[0].split(',');
  const tsIdx = header.indexOf('fundingTime');
  const srcIdx = header.indexOf('source');
  return lines.slice(1).map((l) => {
    const cols = l.split(',');
    return { fundingTime: Number(cols[tsIdx]), source: cols[srcIdx]?.trim() || '' };
  }).sort((a, b) => a.fundingTime - b.fundingTime);
}

async function main() {
  if (!fs.existsSync(HOLDOUT_DIR)) fs.mkdirSync(HOLDOUT_DIR, { recursive: true });

  console.log('=== FINAL HOLDOUT DATA ACQUISITION V1 ===');
  console.log('Target: 2026-01-01 → 2026-07-31');
  console.log('Assets: BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT');
  console.log('Source: data.binance.vision (official archive)\n');

  const results = {};

  // Download klines
  for (const asset of ASSETS) {
    results[asset.symbol] = { kline: await downloadKlines(asset.symbol) };
  }

  // Download funding
  for (const asset of ASSETS) {
    results[asset.symbol].funding = await downloadFunding(asset.symbol);
  }

  // Integrity check
  console.log('\n\n=== INTEGRITY CHECK ===');
  const integrity = {};
  for (const asset of ASSETS) {
    const symbol = asset.symbol;
    const timestamps = loadCandleTimestamps(symbol);
    const funding = loadFundingEvents(symbol);

    const holdoutTimestamps = timestamps.filter((t) => t >= HOLDOUT_START_MS && t <= HOLDOUT_END_MS);
    const holdoutFunding = funding.filter((e) => e.fundingTime >= HOLDOUT_START_MS && e.fundingTime <= HOLDOUT_END_MS);

    // Missing bars check
    let missingBars = 0;
    const expectedInterval = 900000; // 15m
    for (let i = 1; i < holdoutTimestamps.length; i++) {
      if (holdoutTimestamps[i] - holdoutTimestamps[i - 1] > expectedInterval * 1.5) missingBars++;
    }

    // Duplicate check
    const seen = new Set();
    let duplicateBars = 0;
    for (const t of holdoutTimestamps) {
      if (seen.has(t)) duplicateBars++;
      seen.add(t);
    }

    // Funding duplicates
    const fundingSeen = new Set();
    let fundingDuplicates = 0;
    for (const e of holdoutFunding) {
      if (fundingSeen.has(e.fundingTime)) fundingDuplicates++;
      fundingSeen.add(e.fundingTime);
    }

    // Official source check
    const officialFunding = holdoutFunding.filter((e) => e.source.includes('BINANCE'));
    const syntheticFunding = holdoutFunding.filter((e) =>
      e.source.includes('synthetic') || e.source.includes('mock') || e.source.includes('fixture')
    );

    integrity[symbol] = {
      kline15mRows: timestamps.length,
      holdout15mRows: holdoutTimestamps.length,
      firstKline: timestamps[0] ? new Date(timestamps[0]).toISOString() : null,
      lastKline: timestamps[timestamps.length - 1] ? new Date(timestamps[timestamps.length - 1]).toISOString() : null,
      missingBars,
      duplicateBars,
      fundingTotal: funding.length,
      holdoutFundingEvents: holdoutFunding.length,
      firstFunding: funding[0] ? new Date(funding[0].fundingTime).toISOString() : null,
      lastFunding: funding[funding.length - 1] ? new Date(funding[funding.length - 1].fundingTime).toISOString() : null,
      officialFundingCount: officialFunding.length,
      syntheticFundingCount: syntheticFunding.length,
      fundingDuplicates,
      klineSHA256: computeSHA256(fs.readFileSync(path.join(MARKET_DIR, `${symbol}-15m.csv`))),
      fundingSHA256: computeSHA256(fs.readFileSync(path.join(FUNDING_DIR, `${symbol}.csv`))),
    };

    const i = integrity[symbol];
    const status = (i.missingBars === 0 && i.duplicateBars === 0 && i.holdoutFundingEvents > 0 && i.syntheticFundingCount === 0)
      ? 'PASS' : 'FAIL';
    console.log(`${symbol}: ${status}`);
    console.log(`  15m: ${i.kline15mRows} total, ${i.holdout15mRows} holdout, missing=${i.missingBars}, dup=${i.duplicateBars}`);
    console.log(`  Funding: ${i.fundingTotal} total, ${i.holdoutFundingEvents} holdout, official=${i.officialFundingCount}, synthetic=${i.syntheticFundingCount}`);
    console.log(`  Range: ${i.firstKline} → ${i.lastKline}`);
  }

  // Save manifest
  const manifest = {
    generatedAt: new Date().toISOString(),
    holdoutStart: '2026-01-01T00:00:00.000Z',
    holdoutEnd: '2026-07-31T23:59:59.999Z',
    dataSource: 'data.binance.vision',
    assets: {},
  };
  for (const asset of ASSETS) {
    const symbol = asset.symbol;
    manifest.assets[symbol] = {
      klineSource: 'data.binance.vision',
      fundingSource: 'data.binance.vision',
      klineArchives: results[symbol].kline.manifest,
      fundingArchives: results[symbol].funding.manifest,
      ...integrity[symbol],
    };
  }
  fs.writeFileSync(path.join(HOLDOUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nManifest saved: ${path.join(HOLDOUT_DIR, 'manifest.json')}`);

  console.log('\n=== FINAL HOLDOUT DATA READY ===');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });

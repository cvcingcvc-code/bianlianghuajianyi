// Official Binance Data Vision Funding Rate Archive Downloader.
// Downloads monthly ZIP archives from data.binance.vision.
// Checksum-verified. Provenance tracked. Synthetic data rejected.
//
// Usage: node scripts/download-real-funding-archive.js

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const REAL_DIR = path.join(ROOT, 'data', 'funding-real');
const BASE_URL = 'https://data.binance.vision/data/futures/um/monthly/fundingRate';

const ASSETS = [
  { symbol: 'BTCUSDT', startMs: Date.UTC(2021, 0, 1) },
  { symbol: 'ETHUSDT', startMs: Date.UTC(2021, 0, 1) },
  { symbol: 'BNBUSDT', startMs: Date.UTC(2020, 1, 1) },
  { symbol: 'SOLUSDT', startMs: Date.UTC(2020, 8, 1) },
];

const END_MS = Date.UTC(2025, 11, 31, 23, 59, 59, 999);
const HOLDOUT_START_MS = Date.UTC(2026, 0, 1);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

function computeSHA256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function unzipCSV(zipBuffer, tmpDir) {
  const zipPath = path.join(tmpDir, 'archive.zip');
  fs.writeFileSync(zipPath, zipBuffer);
  try {
    execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force"`, { stdio: 'pipe' });
  } catch (e) {
    // Try with tar if PowerShell fails
    try {
      execSync(`tar -xf "${zipPath}" -C "${tmpDir}"`, { stdio: 'pipe' });
    } catch (e2) {
      throw new Error(`Cannot extract ZIP: ${e2.message}`);
    }
  }
  // Find the CSV file
  const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.csv'));
  if (files.length === 0) throw new Error('No CSV in ZIP');
  return path.join(tmpDir, files[0]);
}

function parseFundingCSV(csvPath, symbol) {
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length <= 1) return { header: [], events: [] };

  const header = lines[0].split(',').map((h) => h.trim());
  const events = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const row = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = values[j]?.trim();
    }
    // Official archive uses: calc_time,funding_interval_hours,last_funding_rate
    // calc_time is epoch ms (may have trailing non-zero digits in some files)
    const fundingTime = Number(row.calc_time || row.fundingTime || row.calculate_time);
    const fundingRate = Number(row.last_funding_rate || row.fundingRate);
    if (!Number.isFinite(fundingTime) || !Number.isFinite(fundingRate)) continue;
    events.push({
      symbol,
      fundingTime,
      fundingRate,
      markPrice: row.markPrice ? Number(row.markPrice) : null,
      rateType: row.rateType || null,
      source: 'BINANCE_DATA_VISION_OFFICIAL_ARCHIVE',
    });
  }
  return { header, events };
}

function dedupEvents(events) {
  const seen = new Set();
  return events.filter((e) => {
    if (seen.has(e.fundingTime)) return false;
    seen.add(e.fundingTime);
    return true;
  });
}

function filterToDevRange(events, startMs) {
  return events.filter((e) => e.fundingTime >= startMs && e.fundingTime < HOLDOUT_START_MS);
}

async function main() {
  if (!fs.existsSync(REAL_DIR)) fs.mkdirSync(REAL_DIR, { recursive: true });

  const tmpDir = path.join(ROOT, 'data', '.tmp-funding');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const manifest = { generatedAt: new Date().toISOString(), assets: {} };
  const allResults = {};

  for (const asset of ASSETS) {
    console.log(`\n=== ${asset.symbol} ===`);
    const allEvents = [];
    const archiveLog = [];

    // Generate month range
    const months = [];
    let y = new Date(asset.startMs).getUTCFullYear();
    let m = new Date(asset.startMs).getUTCMonth();
    while (Date.UTC(y, m + 1, 1) <= END_MS + 31 * 86400000) {
      months.push({ year: y, month: m + 1 });
      m++;
      if (m > 11) { m = 0; y++; }
    }

    for (const { year, month } of months) {
      const mm = String(month).padStart(2, '0');
      const zipName = `${asset.symbol}-fundingRate-${year}-${mm}.zip`;
      const checksumName = `${zipName}.CHECKSUM`;
      const zipUrl = `${BASE_URL}/${asset.symbol}/${zipName}`;
      const checksumUrl = `${BASE_URL}/${asset.symbol}/${checksumName}`;

      process.stdout.write(`  ${year}-${mm}: `);

      try {
        const zipData = await downloadFile(zipUrl);
        if (!zipData) {
          console.log('404 NOT_AVAILABLE');
          archiveLog.push({ month: `${year}-${mm}`, status: 'NOT_AVAILABLE' });
          continue;
        }

        // Download checksum
        const checksumData = await downloadFile(checksumUrl);
        if (checksumData) {
          const expected = checksumData.toString('utf8').trim().split(/\s+/)[0].toLowerCase();
          const actual = computeSHA256(zipData);
          if (actual !== expected) {
            console.log(`CHECKSUM MISMATCH (expected ${expected}, got ${actual})`);
            archiveLog.push({ month: `${year}-${mm}`, status: 'CHECKSUM_MISMATCH' });
            continue;
          }
        }

        // Extract CSV
        const csvPath = unzipCSV(zipData, tmpDir);
        const { header, events } = parseFundingCSV(csvPath, asset.symbol);

        // Clean tmp
        fs.readdirSync(tmpDir).forEach((f) => fs.unlinkSync(path.join(tmpDir, f)));

        const filtered = filterToDevRange(events, asset.startMs);
        allEvents.push(...filtered);

        console.log(`OK (${filtered.length} rows, header: ${header.join(',')})`);
        archiveLog.push({
          month: `${year}-${mm}`,
          status: 'OK',
          rows: filtered.length,
          sha256: computeSHA256(zipData),
          header: header.join(','),
        });
      } catch (err) {
        console.log(`ERROR: ${err.message}`);
        archiveLog.push({ month: `${year}-${mm}`, status: 'ERROR', error: err.message });
      }

      await sleep(200); // rate limit
    }

    // Deduplicate across months
    const deduped = dedupEvents(allEvents);
    deduped.sort((a, b) => a.fundingTime - b.fundingTime);

    console.log(`  Total: ${deduped.length} events (from ${allEvents.length} raw)`);

    // Save CSV
    const csvPath = path.join(REAL_DIR, `${asset.symbol}.csv`);
    const header = 'symbol,fundingTime,fundingRate,markPrice,rateType,source\n';
    const rows = deduped.map((e) => [
      e.symbol, e.fundingTime, e.fundingRate,
      e.markPrice != null ? e.markPrice : '',
      e.rateType || '',
      e.source,
    ].join(',')).join('\n');
    fs.writeFileSync(csvPath, header + rows + '\n', 'utf8');

    const sha256 = computeSHA256(fs.readFileSync(csvPath));
    const positive = deduped.filter((e) => e.fundingRate > 0).length;
    const negative = deduped.filter((e) => e.fundingRate < 0).length;
    const zero = deduped.filter((e) => e.fundingRate === 0).length;
    const directMp = deduped.filter((e) => e.markPrice != null).length;

    manifest.assets[asset.symbol] = {
      sourceEndpoint: 'data.binance.vision',
      symbol: asset.symbol,
      requestedStart: new Date(asset.startMs).toISOString(),
      requestedEnd: new Date(END_MS).toISOString(),
      downloadedAt: new Date().toISOString(),
      firstFundingTime: deduped[0]?.fundingTime,
      lastFundingTime: deduped[deduped.length - 1]?.fundingTime,
      rowCount: deduped.length,
      sha256,
      directMarkPriceCount: directMp,
      missingMarkPriceCount: deduped.length - directMp,
      duplicateCount: allEvents.length - deduped.length,
      invalidCount: deduped.filter((e) => !Number.isFinite(e.fundingRate)).length,
      positiveRateCount: positive,
      negativeRateCount: negative,
      zeroRateCount: zero,
      archives: archiveLog,
    };

    console.log(`  SHA256: ${sha256}`);
    console.log(`  +${positive} / -${negative} / =${zero}`);
    console.log(`  Mark price: DIRECT=${directMp} MISSING=${deduped.length - directMp}`);

    allResults[asset.symbol] = deduped;
  }

  // Save manifest
  const manifestPath = path.join(REAL_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\nManifest saved: ${manifestPath}`);

  // Cleanup tmp
  try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });

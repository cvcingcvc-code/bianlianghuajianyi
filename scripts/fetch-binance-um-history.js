// Fetch official Binance USD-M futures (um) kline history from data.binance.vision.
//
//   node scripts/fetch-binance-um-history.js [--symbols BTCUSDT,ETHUSDT]
//       [--start 2021-01] [--end auto] [--interval 15m] [--check-only]
//
// Downloads monthly zip files + official .CHECKSUM files, verifies SHA256,
// extracts the kline CSV, and writes a normalized combined CSV:
//   data/market/<SYMBOL>-<interval>.csv        (timestamp,open,high,low,close,volume)
// Raw artifacts are kept under:
//   data/market/raw/<SYMBOL>/<SYMBOL>-<interval>-<YYYY-MM>.zip(.CHECKSUM)(.csv)
//
// If a checksum fails the file is NOT used and the run exits non-zero.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const BASE_URL = 'https://data.binance.vision/data/futures/um/monthly/klines';
const ROOT = path.join(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'data', 'market', 'raw');
const MARKET_DIR = path.join(ROOT, 'data', 'market');

const RETRIES = 4;
const RETRY_DELAY_MS = 1500;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    let key = raw.slice(2);
    let value = 'true';
    const eq = key.indexOf('=');
    if (eq !== -1) { value = key.slice(eq + 1); key = key.slice(0, eq); }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) value = argv[++i];
    args[key] = value;
  }
  return args;
}

async function fetchText(url) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
      if (res.status === 404) return null;
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }
  }
  throw new Error(`fetch failed for ${url}: ${lastErr && lastErr.message}`);
}

async function fetchBuffer(url) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      if (res.status === 404) return null;
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }
  }
  throw new Error(`fetch failed for ${url}: ${lastErr && lastErr.message}`);
}

// Parse the .CHECKSUM file: "<sha256hex>  <filename>"
function parseChecksum(text) {
  const line = (text || '').trim().split('\n')[0];
  const m = line.match(/^([0-9a-f]{64})\s+/i);
  if (!m) throw new Error(`Cannot parse checksum line: "${line}"`);
  return m[1].toLowerCase();
}

// Minimal ZIP extraction (single file entry, deflate or stored).
function extractZipFirstEntry(zipBuffer) {
  if (zipBuffer.length < 22) throw new Error('zip too small');
  // Find End Of Central Directory
  let eocd = -1;
  for (let i = zipBuffer.length - 22; i >= 0; i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('EOCD not found');
  const entryCount = zipBuffer.readUInt16LE(eocd + 10);
  const cdOffset = zipBuffer.readUInt32LE(eocd + 16);

  let entry = null;
  let offset = cdOffset;
  for (let e = 0; e < entryCount; e++) {
    if (zipBuffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = zipBuffer.readUInt16LE(offset + 10);
    const compSize = zipBuffer.readUInt32LE(offset + 20);
    const nameLen = zipBuffer.readUInt16LE(offset + 28);
    const extraLen = zipBuffer.readUInt16LE(offset + 30);
    const commentLen = zipBuffer.readUInt16LE(offset + 32);
    const localOffset = zipBuffer.readUInt32LE(offset + 42);
    const name = zipBuffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    if (name.endsWith('.csv') && !entry) {
      // read local header
      if (zipBuffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('bad local header');
      const lNameLen = zipBuffer.readUInt16LE(localOffset + 26);
      const lExtraLen = zipBuffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const compData = zipBuffer.slice(dataStart, dataStart + compSize);
      const raw = method === 8
        ? zlib.inflateRawSync(compData)
        : method === 0 ? compData : null;
      if (raw === null) throw new Error(`unsupported compression method ${method}`);
      entry = { name, content: raw.toString('utf8') };
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  if (!entry) throw new Error('no CSV entry found in zip');
  return entry;
}

// Binance monthly klines files are headerless in some months and carry an
// "open_time" header in others. Normalize each data line to
// timestamp,open,high,low,close,volume (no header in the output — the header
// is added once when assembling the combined file).
function normalizeKlines(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out = [];
  for (const line of lines) {
    const p = line.split(',');
    if (p.length < 6) continue;
    // skip any header row (first field not a number)
    if (!/^\d+$/.test(p[0].trim())) continue;
    out.push([p[0], p[1], p[2], p[3], p[4], p[5]].join(','));
  }
  return out.join('\n');
}

function monthKey(ym) { return `${ym.y}-${String(ym.m).padStart(2, '0')}`; }

async function latestAvailableMonth(symbol, interval, startYm) {
  const now = new Date();
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth() + 1;
  // walk backwards from current month until checksum exists
  for (let guard = 0; guard < 36; guard++) {
    const key = monthKey({ y, m });
    const csUrl = `${BASE_URL}/${symbol}/${interval}/${symbol}-${interval}-${key}.zip.CHECKSUM`;
    const cs = await fetchText(csUrl);
    if (cs !== null) return { y, m };
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  throw new Error(`Could not find an available month for ${symbol}`);
}

async function downloadSymbol({ symbol, interval, startYm, endYm, checkOnly }) {
  const symRawDir = path.join(RAW_DIR, symbol);
  fs.mkdirSync(symRawDir, { recursive: true });

  let start = startYm;
  let end = endYm || await latestAvailableMonth(symbol, interval, startYm);

  const normalizedChunks = [];
  const months = [];
  let failures = 0;

  let y = start.y, m = start.m;
  const guard = 500;
  let g = 0;
  while (g++ < guard) {
    const key = monthKey({ y, m });
    const base = `${symbol}-${interval}-${key}`;
    const zipUrl = `${BASE_URL}/${symbol}/${interval}/${base}.zip`;
    const csUrl = zipUrl + '.CHECKSUM';
    const zipPath = path.join(symRawDir, `${base}.zip`);
    const csPath = path.join(symRawDir, `${base}.zip.CHECKSUM`);
    const csvPath = path.join(symRawDir, `${base}.csv`);

    if (!fs.existsSync(zipPath) || !fs.existsSync(csPath)) {
      console.log(`  [${symbol}] ${key}: downloading`);
      const [zipBuf, csText] = await Promise.all([fetchBuffer(zipUrl), fetchText(csUrl)]);
      if (zipBuf === null || csText === null) {
        // reached end of availability
        if (endYm) throw new Error(`Month ${key} not available but required by --end`);
        break;
      }
      const expected = parseChecksum(csText);
      const actual = crypto.createHash('sha256').update(zipBuf).digest('hex');
      if (actual !== expected) {
        console.error(`  [${symbol}] ${key}: CHECKSUM MISMATCH (expected ${expected}, got ${actual}). File NOT used.`);
        failures++;
        if (!checkOnly) {
          // still write the file for diagnosis but skip it
          fs.writeFileSync(zipPath, zipBuf);
          fs.writeFileSync(csPath, csText);
        }
        if (failures >= 3) {
          throw new Error(`${symbol} ${key}: too many checksum failures, aborting`);
        }
        // advance to next month anyway (do not block the whole series on one bad file)
      } else {
        fs.writeFileSync(zipPath, zipBuf);
        fs.writeFileSync(csPath, csText);
        console.log(`  [${symbol}] ${key}: OK (${(zipBuf.length / 1024 / 1024).toFixed(2)} MB)`);
        months.push(key);
        if (!checkOnly) {
          const entry = extractZipFirstEntry(zipBuf);
          fs.writeFileSync(csvPath, entry.content, 'utf8');
          const normalized = normalizeKlines(entry.content);
          if (normalized) normalizedChunks.push(normalized);
        }
      }
    } else {
      console.log(`  [${symbol}] ${key}: cached`);
      if (!checkOnly) {
        const csText = fs.readFileSync(csPath, 'utf8');
        const expected = parseChecksum(csText);
        const actual = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
        if (actual !== expected) {
          console.error(`  [${symbol}] ${key}: cached CHECKSUM MISMATCH. File NOT used.`);
          failures++;
        } else {
          months.push(key);
          if (!fs.existsSync(csvPath)) {
            const entry = extractZipFirstEntry(fs.readFileSync(zipPath));
            fs.writeFileSync(csvPath, entry.content, 'utf8');
          }
          normalizedChunks.push(normalizeKlines(fs.readFileSync(csvPath, 'utf8')));
        }
      }
    }

    if (y === end.y && m === end.m) break;
    m += 1;
    if (m === 13) { m = 1; y += 1; }
  }

  if (months.length === 0) throw new Error(`${symbol}: no verified months downloaded`);

  if (!checkOnly) {
    const combined = 'timestamp,open,high,low,close,volume\n' + normalizedChunks.join('\n') + '\n';
    const finalPath = path.join(MARKET_DIR, `${symbol}-${interval}.csv`);
    fs.writeFileSync(finalPath, combined, 'utf8');
    const first = months[0];
    const last = months[months.length - 1];
    console.log(`  [${symbol}] combined ${months.length} months (${first}..${last}) -> ${finalPath} (${(combined.length / 1024 / 1024).toFixed(2)} MB)`);
  }

  return { symbol, months, failures, lastMonth: months[months.length - 1] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const symbols = (args['symbols'] || 'BTCUSDT,ETHUSDT').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const interval = args['interval'] || '15m';
  const startStr = args['start'] || '2021-01';
  const sm = startStr.match(/^(\d{4})-(\d{2})$/);
  if (!sm) throw new Error(`--start must be YYYY-MM, got "${startStr}"`);
  const startYm = { y: Number(sm[1]), m: Number(sm[2]) };
  const endYm = args['end'] && args['end'] !== 'auto'
    ? (() => { const em = args['end'].match(/^(\d{4})-(\d{2})$/); if (!em) throw new Error('--end must be YYYY-MM'); return { y: Number(em[1]), m: Number(em[2]) }; })()
    : null;
  const checkOnly = args['check-only'] === 'true' || args['check-only'] === true;

  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(MARKET_DIR, { recursive: true });

  let anyFailures = false;
  for (const symbol of symbols) {
    console.log(`=== Fetching ${symbol} ${interval} ===`);
    const res = await downloadSymbol({ symbol, interval, startYm, endYm, checkOnly });
    if (res.failures > 0) anyFailures = true;
    console.log(`  verified months: ${res.months.length} | last: ${res.lastMonth} | failures: ${res.failures}`);
  }

  if (anyFailures) {
    console.error('\nWARNING: one or more files failed checksum verification and were excluded.');
    process.exitCode = 1;
  }
  console.log('\nDONE');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inflateRawSync } = require('node:zlib');
const ROOT = path.join(__dirname, '../../data/market/raw/trend-grid-v1');
const STEP = 900000;
const START = Date.UTC(2021, 0, 1);
const END = Date.UTC(2026, 0, 1);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function unzip(bytes, expectedName) {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 10) !== 1) throw new Error('Expected single-entry ZIP');
  const p = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad central directory');
  const name = bytes.toString('utf8', p + 46, p + 46 + bytes.readUInt16LE(p + 28));
  if (name !== expectedName) throw new Error('Unexpected archive member');
  const local = bytes.readUInt32LE(p + 42);
  if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('Bad local header');
  const offset = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
  const compressed = bytes.subarray(offset, offset + bytes.readUInt32LE(p + 20));
  const method = bytes.readUInt16LE(p + 10);
  const raw = method === 8 ? inflateRawSync(compressed) : method === 0 ? compressed : null;
  if (!raw || raw.length !== bytes.readUInt32LE(p + 24)) throw new Error('Invalid ZIP payload');
  return raw.toString('utf8');
}

function validateCandles(candles, start = START, end = END) {
  if (!(start >= START && end <= END && end > start)) throw new Error('FINAL HOLDOUT IS LOCKED');
  if (candles.length !== (end - start) / STEP) throw new Error('Incomplete 15m history');
  candles.forEach((c, i) => {
    if (c.openTime !== start + i * STEP || c.closeTime !== c.openTime + STEP - 1 ||
        ![c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) ||
        c.low <= 0 || c.volume < 0 || c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)) {
      throw new Error(`Invalid or discontinuous candle ${i}`);
    }
  });
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Official archive HTTP ${res.status}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function loadHistory({ acquire = false, progress = () => {} } = {}) {
  fs.mkdirSync(ROOT, { recursive: true });
  const candles = [], files = [];
  for (let y = 2021; y <= 2025; y++) for (let m = 1; m <= 12; m++) {
    const month = `${y}-${String(m).padStart(2, '0')}`;
    const name = `ETHUSDT-15m-${month}`;
    const url = `https://data.binance.vision/data/futures/um/monthly/klines/ETHUSDT/15m/${name}.zip`;
    const file = path.join(ROOT, `${name}.zip`), checksumFile = `${file}.CHECKSUM`;
    if ((!fs.existsSync(file) || !fs.existsSync(checksumFile)) && acquire) {
      const [bytes, checksum] = await Promise.all([download(url), download(`${url}.CHECKSUM`)]);
      if (sha(bytes) !== checksum.toString('utf8').trim().split(/\s+/)[0].toLowerCase()) throw new Error('Download checksum mismatch');
      if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { flag: 'wx' });
      if (!fs.existsSync(checksumFile)) fs.writeFileSync(checksumFile, checksum, { flag: 'wx' });
    }
    const bytes = fs.readFileSync(file);
    const checksum = fs.readFileSync(checksumFile, 'utf8').trim().split(/\s+/)[0].toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(checksum) || sha(bytes) !== checksum) throw new Error('Cached checksum mismatch');
    const lines = unzip(bytes, `${name}.csv`).trim().split(/\r?\n/);
    if (lines[0].startsWith('open_time,')) lines.shift();
    const rows = lines.map(line => {
      const r = line.split(',').map(Number);
      return { openTime: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5], closeTime: r[6] };
    });
    validateCandles(rows, Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1));
    candles.push(...rows); files.push({ month, url, sha256: checksum, bars: rows.length });
    progress(month);
  }
  validateCandles(candles);
  return { candles, manifest: { source: 'data.binance.vision', interval: '15m', symbol: 'ETHUSDT', start: START, endExclusive: END, files } };
}
module.exports = { loadHistory, validateCandles, START, END, STEP };

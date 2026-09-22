const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inflateRawSync } = require('node:zlib');
const { loadHistory } = require('../trendGrid/archive');
const H4 = 14400000, M15 = 900000, START = Date.UTC(2021, 0, 1), END = Date.UTC(2026, 0, 1);
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
function guard(time) { if (!Number.isFinite(time) || time < START || time >= END) throw new Error('V2_DATA_RANGE_LOCKED'); }
function zipCSV(file) {
  const bytes = fs.readFileSync(file), expected = fs.readFileSync(`${file}.CHECKSUM`, 'utf8').trim().split(/\s+/)[0].toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected) || sha(bytes) !== expected) throw new Error(`CHECKSUM_MISMATCH: ${file}`);
  let e = bytes.length - 22;
  while (e >= 0 && bytes.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0 || bytes.readUInt16LE(e + 10) !== 1) throw new Error('Invalid single-member ZIP');
  const c = bytes.readUInt32LE(e + 16), local = bytes.readUInt32LE(c + 42);
  const offset = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
  const compressed = bytes.subarray(offset, offset + bytes.readUInt32LE(c + 20));
  const method = bytes.readUInt16LE(c + 10);
  const raw = method === 8 ? inflateRawSync(compressed) : method === 0 ? compressed : null;
  if (!raw || raw.length !== bytes.readUInt32LE(c + 24)) throw new Error('Invalid ZIP payload');
  const lines = raw.toString('utf8').trim().split(/\r?\n/);
  return { rows: lines.slice(/^\d/.test(lines[0]) ? 0 : 1).map(l => l.split(',').map(Number)), sha256: expected };
}
function aggregate(candles) {
  const out = [];
  for (let i = 0; i < candles.length; i += 16) {
    const g = candles.slice(i, i + 16);
    if (g.length !== 16 || g[0].openTime % H4) throw new Error('Incomplete 4h window');
    g.forEach((c, j) => { guard(c.closeTime); if (c.openTime !== g[0].openTime + j * M15) throw new Error('Discontinuous data'); });
    out.push({ openTime: g[0].openTime, closeTime: g[15].closeTime, open: g[0].open, close: g[15].close,
      high: Math.max(...g.map(c => c.high)), low: Math.min(...g.map(c => c.low)), volume: g.reduce((s, c) => s + c.volume, 0) });
  }
  return out;
}
function loadFunding(root = path.join(__dirname, '../../data/eth-v2/raw')) {
  const events = [], files = [], problems = [];
  for (let y = 2021; y <= 2025; y++) for (let m = 1; m <= 12; m++) {
    const month = `${y}-${String(m).padStart(2, '0')}`, start = Date.UTC(y, m - 1, 1), end = Date.UTC(y, m, 1);
    try {
      const name = `ETHUSDT-fundingRate-${month}.zip`, funding = zipCSV(path.join(root, name));
      files.push({ name, sha256: funding.sha256, url: `https://data.binance.vision/data/futures/um/monthly/fundingRate/ETHUSDT/${name}` });
      let marks = new Map();
      if (y >= 2023) {
        const markName = `ETHUSDT-1m-${month}.zip`, mark = zipCSV(path.join(root, `mark-${markName}`));
        files.push({ name: `mark-${markName}`, sha256: mark.sha256, url: `https://data.binance.vision/data/futures/um/monthly/markPriceKlines/ETHUSDT/1m/${markName}` });
        for (const r of mark.rows) {
          guard(r[0]);
          if (r[0] < start || r[0] >= end || marks.has(r[0]) || !Number.isFinite(r[1]) || r[1] <= 0) throw new Error('Invalid mark candle');
          marks.set(r[0], r[1]);
        }
      }
      for (const [time, intervalHours, rate] of funding.rows) {
        guard(time);
        if (time < start || time >= end || !Number.isFinite(rate) || !Number.isFinite(intervalHours) || intervalHours <= 0) throw new Error('Invalid funding row');
        const previous = events.at(-1);
        if (previous && (time <= previous.time || Math.abs(time - previous.time - intervalHours * 3600000) > 1000)) problems.push(`Funding interval discontinuity ${time}`);
        const markTime = Math.floor(time / 60000) * 60000, markPrice = marks.get(markTime) ?? null;
        if (y >= 2023 && markPrice === null) problems.push(`Missing settlement mark ${time}`);
        events.push({ time, rate, intervalHours, markTime, markPrice, markSource: 'OFFICIAL_MINUTE_OPEN_PROXY' });
      }
      if (!funding.rows.length || funding.rows[0][0] - start > 8 * 3600000 || end - funding.rows.at(-1)[0] > 8 * 3600000 + 1000) problems.push(`Incomplete funding endpoints ${month}`);
    } catch (e) { problems.push(`${month}: ${e.message}`); }
  }
  return { events, files, problems, complete: problems.length === 0, markLimit: 'Official minute open <=60s before settlement; not exact tick mark' };
}
async function loadData() {
  const { candles, manifest } = await loadHistory();
  const funding = loadFunding();
  return { candles, bars: aggregate(candles), funding, manifest, fingerprint: sha(JSON.stringify({ manifest, files: funding.files, problems: funding.problems })) };
}
module.exports = { H4, M15, START, END, sha, guard, zipCSV, aggregate, loadFunding, loadData };

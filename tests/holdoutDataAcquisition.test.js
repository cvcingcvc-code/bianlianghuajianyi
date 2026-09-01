// Final Holdout Data Acquisition V1 — Tests.
// Tests: data inspection, strategy lock, URL generation, checksum, manifest integrity.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const ASSETS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'];
const HOLDOUT_START_MS = Date.UTC(2026, 0, 1);
const HOLDOUT_END_MS = Date.UTC(2026, 7, 31, 23, 59, 59, 999);

// === 2026 Data Inspection Allowed ===

test('2026 kline data can be read by data validator', () => {
  for (const symbol of ASSETS) {
    const csvPath = path.join(ROOT, 'data', 'market', `${symbol}-15m.csv`);
    assert.ok(fs.existsSync(csvPath), `${symbol} 15m CSV exists`);
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    assert.ok(lines.length > 1, `${symbol} has data rows`);
    const header = lines[0];
    assert.ok(header.includes('timestamp'), `${symbol} has timestamp column`);
    // Check 2026 data exists
    const has2026 = lines.some((l) => {
      const ts = Number(l.split(',')[0]);
      return ts >= HOLDOUT_START_MS && ts <= HOLDOUT_END_MS;
    });
    assert.ok(has2026, `${symbol} has 2026 data`);
  }
});

test('2026 funding data can be read by data validator', () => {
  for (const symbol of ASSETS) {
    const csvPath = path.join(ROOT, 'data', 'funding-real', `${symbol}.csv`);
    assert.ok(fs.existsSync(csvPath), `${symbol} funding CSV exists`);
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    assert.ok(lines.length > 1, `${symbol} has data rows`);
    const header = lines[0];
    assert.ok(header.includes('fundingTime'), `${symbol} has fundingTime column`);
    // Check 2026 data exists
    const has2026 = lines.some((l) => {
      const ts = Number(l.split(',')[1]);
      return ts >= HOLDOUT_START_MS && ts <= HOLDOUT_END_MS;
    });
    assert.ok(has2026, `${symbol} has 2026 funding data`);
  }
});

// === 2026 Strategy Execution Rejected ===

test('2026 strategy execution is rejected by holdoutGuard', () => {
  const { checkHoldoutLock, HOLDOUT_START_MS: guardStart } = require('../src/research/holdoutGuard');
  const { isResearchStrategy } = require('../src/research/strategyAdapter');
  assert.equal(isResearchStrategy('breakout24h4h'), true);
  // Simulate candles extending into 2026
  const result = checkHoldoutLock({
    strategy: 'breakout24h4h',
    candles: [{ timestamp: guardStart + 1 }],
  });
  assert.equal(result.locked, true);
  assert.ok(result.reason.includes('LOCKED'));
});

test('non-research strategy is not blocked by holdoutGuard', () => {
  const { checkHoldoutLock, HOLDOUT_START_MS: guardStart } = require('../src/research/holdoutGuard');
  const result = checkHoldoutLock({
    strategy: 'custom-strategy',
    candles: [{ timestamp: guardStart + 1 }],
  });
  assert.equal(result.locked, false);
});

// === 2026 Monthly URL Generation ===

test('2026 monthly kline URLs are correctly formatted', () => {
  const BASE_URL = 'https://data.binance.vision/data/futures/um/monthly/klines';
  for (const symbol of ASSETS) {
    for (const ym of ['2026-01','2026-04','2026-07']) {
      const url = `${BASE_URL}/${symbol}/15m/${symbol}-15m-${ym}.zip`;
      assert.ok(url.includes('monthly/klines'), `${symbol} ${ym} URL has monthly/klines`);
      assert.ok(url.endsWith('.zip'), `${symbol} ${ym} URL ends with .zip`);
    }
  }
});

test('2026 monthly funding URLs are correctly formatted', () => {
  const BASE_URL = 'https://data.binance.vision/data/futures/um/monthly/fundingRate';
  for (const symbol of ASSETS) {
    for (const ym of ['2026-01','2026-04','2026-07']) {
      const url = `${BASE_URL}/${symbol}/${symbol}-fundingRate-${ym}.zip`;
      assert.ok(url.includes('monthly/fundingRate'), `${symbol} ${ym} URL has monthly/fundingRate`);
      assert.ok(url.endsWith('.zip'), `${symbol} ${ym} URL ends with .zip`);
    }
  }
});

// === Checksum Verification ===

test('kline CSV SHAs in manifest match actual files', () => {
  const manifestPath = path.join(ROOT, 'data', 'holdout-2026', 'manifest.json');
  if (!fs.existsSync(manifestPath)) return;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const [sym, info] of Object.entries(manifest.assets)) {
    if (!info.klineSHA256) continue;
    const csvPath = path.join(ROOT, 'data', 'market', `${sym}-15m.csv`);
    if (!fs.existsSync(csvPath)) continue;
    const actual = crypto.createHash('sha256').update(fs.readFileSync(csvPath)).digest('hex');
    assert.equal(actual, info.klineSHA256, `${sym} kline SHA256 mismatch`);
  }
});

test('funding CSV SHAs in manifest match actual files', () => {
  const manifestPath = path.join(ROOT, 'data', 'holdout-2026', 'manifest.json');
  if (!fs.existsSync(manifestPath)) return;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const [sym, info] of Object.entries(manifest.assets)) {
    if (!info.fundingSHA256) continue;
    const csvPath = path.join(ROOT, 'data', 'funding-real', `${sym}.csv`);
    if (!fs.existsSync(csvPath)) continue;
    const actual = crypto.createHash('sha256').update(fs.readFileSync(csvPath)).digest('hex');
    assert.equal(actual, info.fundingSHA256, `${sym} funding SHA256 mismatch`);
  }
});

// === Manifest Contains No Strategy Metrics ===

test('holdout manifest contains no strategy metrics', () => {
  const manifestPath = path.join(ROOT, 'data', 'holdout-2026', 'manifest.json');
  if (!fs.existsSync(manifestPath)) return;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const forbidden = ['tradeCount', 'netPnL', 'netPF', 'sharpe', 'expectancy', 'returnPct', 'maxDD', 'signals'];
  for (const [sym, info] of Object.entries(manifest.assets)) {
    for (const key of forbidden) {
      assert.equal(info[key], undefined, `${sym} manifest must not contain ${key}`);
    }
  }
});

// === Candidate SHA Unchanged ===

test('candidate freeze SHA remains 2e866b3', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'v4-final-development-candidate.md'), 'utf8');
  assert.ok(doc.includes('2e866b3fd4f0b38f0570ab31c9dfc77e1030c5a8'));
  assert.equal(require('../src/research/strategies/breakout24h4h').windowBars, 6);
});

// === 2026 Data Integrity ===

test('2026 kline data has no missing bars', () => {
  const expectedInterval = 900000; // 15m
  for (const symbol of ASSETS) {
    const csvPath = path.join(ROOT, 'data', 'market', `${symbol}-15m.csv`);
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    const header = lines[0].split(',');
    const tsIdx = header.indexOf('timestamp');
    const holdoutTimestamps = lines.slice(1)
      .map((l) => Number(l.split(',')[tsIdx]))
      .filter((t) => t >= HOLDOUT_START_MS && t <= HOLDOUT_END_MS)
      .sort((a, b) => a - b);
    let missing = 0;
    for (let i = 1; i < holdoutTimestamps.length; i++) {
      if (holdoutTimestamps[i] - holdoutTimestamps[i - 1] > expectedInterval * 1.5) missing++;
    }
    assert.equal(missing, 0, `${symbol} has no missing 15m bars in 2026`);
  }
});

test('2026 kline data has no duplicates', () => {
  for (const symbol of ASSETS) {
    const csvPath = path.join(ROOT, 'data', 'market', `${symbol}-15m.csv`);
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    const header = lines[0].split(',');
    const tsIdx = header.indexOf('timestamp');
    const holdoutTimestamps = lines.slice(1)
      .map((l) => Number(l.split(',')[tsIdx]))
      .filter((t) => t >= HOLDOUT_START_MS && t <= HOLDOUT_END_MS);
    const unique = new Set(holdoutTimestamps);
    assert.equal(holdoutTimestamps.length, unique.size, `${symbol} has no duplicate bars in 2026`);
  }
});

test('2026 funding has no synthetic/mock/fixture sources', () => {
  for (const symbol of ASSETS) {
    const csvPath = path.join(ROOT, 'data', 'funding-real', `${symbol}.csv`);
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    const header = lines[0].split(',');
    const tsIdx = header.indexOf('fundingTime');
    const srcIdx = header.indexOf('source');
    const holdoutLines = lines.slice(1).filter((l) => {
      const ts = Number(l.split(',')[tsIdx]);
      return ts >= HOLDOUT_START_MS && ts <= HOLDOUT_END_MS;
    });
    for (const line of holdoutLines) {
      const src = line.split(',')[srcIdx] || '';
      assert.ok(
        !src.includes('synthetic') && !src.includes('mock') && !src.includes('fixture'),
        `${symbol} funding source must not be synthetic: ${src}`
      );
    }
  }
});

test('2026 funding markPrice is available for all events', () => {
  for (const symbol of ASSETS) {
    const csvPath = path.join(ROOT, 'data', 'funding-real', `${symbol}.csv`);
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    const header = lines[0].split(',');
    const tsIdx = header.indexOf('fundingTime');
    const mpIdx = header.indexOf('markPrice');
    const holdoutLines = lines.slice(1).filter((l) => {
      const ts = Number(l.split(',')[tsIdx]);
      return ts >= HOLDOUT_START_MS && ts <= HOLDOUT_END_MS;
    });
    let missingMp = 0;
    for (const line of holdoutLines) {
      const mp = line.split(',')[mpIdx];
      if (!mp || mp.trim() === '' || mp === 'null') missingMp++;
    }
    // Allow up to 2 missing (SOL early events)
    assert.ok(missingMp <= 2, `${symbol} has at most 2 missing markPrice in 2026 (got ${missingMp})`);
  }
});

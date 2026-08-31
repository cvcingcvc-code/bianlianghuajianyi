const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateCandles } = require('../src/research/data/dataValidator');
const { loadCandles } = require('../src/research/data/candleRepository');

function candle(overrides) {
  return Object.assign(
    { timestamp: 0, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
    overrides
  );
}

function tmpCsv(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-test-'));
  const file = path.join(dir, 'test.csv');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

test('invalid candle detection: NaN fields flagged', () => {
  const v = validateCandles([candle({ open: NaN }), candle({ close: Number.NaN })]);
  assert.ok(v.errors.some((e) => e.type === 'nan'));
});

test('invalid candle detection: bad OHLC relationship flagged', () => {
  const v = validateCandles([candle({ high: 95, low: 90 })]);
  assert.ok(v.errors.some((e) => e.type === 'ohlc'));
});

test('invalid candle detection: non-positive close flagged', () => {
  const v = validateCandles([candle({ close: 0 }), candle({ close: -5 })]);
  assert.equal(v.errors.filter((e) => e.type === 'non-positive-close').length, 2);
});

test('duplicate timestamp detection', () => {
  const v = validateCandles([
    candle({ timestamp: 100 }),
    candle({ timestamp: 200 }),
    candle({ timestamp: 100 }),
  ]);
  assert.equal(v.warnings.filter((w) => w.type === 'duplicate-timestamp').length, 1);
});

test('out-of-order timestamps flagged as error', () => {
  const v = validateCandles([candle({ timestamp: 300 }), candle({ timestamp: 200 })]);
  assert.ok(v.errors.some((e) => e.type === 'out-of-order'));
});

test('loadCandles: valid fixture loads and reports quality', () => {
  const file = path.join(__dirname, 'fixtures', 'synthetic-15m.csv');
  const { candles, qualityReport } = loadCandles({ file });
  assert.equal(candles.length, 60);
  assert.equal(qualityReport.validation.errors.length, 0);
});

test('loadCandles: throws on missing required column', () => {
  const file = tmpCsv('ts,open,high,low,close,volume\n1,2,3,4,5,6\n');
  assert.throws(() => loadCandles({ file }), /missing required column\(s\)/);
});

test('loadCandles: throws on out-of-order timestamps', () => {
  const file = tmpCsv('timestamp,open,high,low,close,volume\n300,2,3,1,2,6\n200,2,3,1,2,6\n');
  assert.throws(() => loadCandles({ file }), /not strictly ascending/);
});

test('loadCandles: throws on invalid candle row', () => {
  const file = tmpCsv('timestamp,open,high,low,close,volume\n100,2,3,1,-2,6\n');
  assert.throws(() => loadCandles({ file }), /invalid candle/);
});

test('loadCandles: dedupes duplicate timestamps and reports count', () => {
  const file = tmpCsv(
    'timestamp,open,high,low,close,volume\n' +
      '100,2,3,1,2,6\n' +
      '100,2,3,1,2,6\n' +
      '200,2,3,1,2,6\n'
  );
  const { candles, qualityReport } = loadCandles({ file });
  assert.equal(candles.length, 2);
  assert.equal(qualityReport.duplicateCount, 1);
});

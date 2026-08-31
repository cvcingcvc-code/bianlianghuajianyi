const { test } = require('node:test');
const assert = require('node:assert');
const { splitCandles } = require('../src/research/experiments/runner');

function makeCandles(count, start = Date.UTC(2023, 0, 1), interval = 900000) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      timestamp: start + i * interval,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1000,
    });
  }
  return out;
}

// Walk-forward date split (test case 18)
test('walk-forward split: strict separation with no overlap', () => {
  // ~2.3 years of 15m bars so both a full train year and a full test year have data
  const candles = makeCandles(80000, Date.UTC(2023, 0, 1), 900000);
  const trainStartMs = Date.UTC(2023, 0, 1);
  const trainEndMs = Date.UTC(2024, 0, 1);
  const testStartMs = Date.UTC(2024, 0, 1);
  const testEndMs = Date.UTC(2025, 0, 1);

  const { train, test } = splitCandles(candles, { trainStartMs, trainEndMs, testStartMs, testEndMs });

  assert.ok(train.length > 0 && test.length > 0);
  assert.ok(train.every((c) => c.timestamp >= trainStartMs && c.timestamp < trainEndMs));
  assert.ok(test.every((c) => c.timestamp >= testStartMs && c.timestamp < testEndMs));

  const trainMax = Math.max(...train.map((c) => c.timestamp));
  const testMin = Math.min(...test.map((c) => c.timestamp));
  assert.ok(trainMax < testMin, 'train and test must not overlap');
});

test('walk-forward split: respects arbitrary boundaries', () => {
  // 500 bars of 6h spans ~125 days, crossing three months in 2023
  const candles = makeCandles(500, Date.UTC(2023, 6, 1), 6 * 3600 * 1000);
  const trainStartMs = Date.UTC(2023, 6, 1);   // Jul 1
  const trainEndMs = Date.UTC(2023, 7, 1);     // Aug 1
  const testStartMs = Date.UTC(2023, 7, 1);    // Aug 1
  const testEndMs = Date.UTC(2023, 9, 1);      // Oct 1

  const { train, test } = splitCandles(candles, { trainStartMs, trainEndMs, testStartMs, testEndMs });
  assert.ok(train.length > 0 && test.length > 0);
  assert.ok(train.every((c) => c.timestamp >= trainStartMs && c.timestamp < trainEndMs));
  assert.ok(test.every((c) => c.timestamp >= testStartMs && c.timestamp < testEndMs));
  // train + test together must equal every bar strictly before the end of the test window
  assert.equal(
    train.length + test.length,
    candles.filter((c) => c.timestamp < testEndMs).length
  );
});

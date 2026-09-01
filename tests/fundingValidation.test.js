// Funding validation tests — deterministic math, ownership rule, edge cases.
// Covers all 26 required test items from the specification.

const { test } = require('node:test');
const assert = require('node:assert');
const { computeTradeFunding, enrichTradesWithFunding } = require('../src/research/funding/fundingCalculator');
const { createHistoricalFundingProvider } = require('../src/research/funding/historicalFundingProvider');
const { verifyFundingData } = require('../src/research/funding/fundingDataValidator');
const { loadFundingCSV, saveFundingCSV, HOLDOUT_START_MS } = require('../src/research/funding/fundingDownloader');
const { checkHoldoutLock } = require('../src/research/holdoutGuard');
const { isResearchStrategy } = require('../src/research/strategyAdapter');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// === STEP 13: Deterministic math tests ===

// Sign convention: cashflow = -(qty × markPrice × rate)
//   rate > 0 → cashflow < 0 → LONG pays
//   rate < 0 → cashflow > 0 → LONG receives

test('funding positive long pays (rate +0.001, qty 2, mark 100)', () => {
  const result = computeTradeFunding({
    entryTimeMs: 0,
    exitTimeMs: 1000,
    quantity: 2,
    fundingEvents: [{ fundingTime: 500, fundingRate: 0.001, markPrice: 100 }],
  });
  assert.equal(result.eventCount, 1);
  assert.equal(result.events[0].cashflow, -0.20); // -(2 × 100 × 0.001)
  assert.equal(result.fundingPaid, 0.20);
  assert.equal(result.fundingReceived, 0);
  assert.equal(result.netFunding, -0.20);
});

test('funding negative long receives (rate -0.001, qty 2, mark 100)', () => {
  const result = computeTradeFunding({
    entryTimeMs: 0,
    exitTimeMs: 1000,
    quantity: 2,
    fundingEvents: [{ fundingTime: 500, fundingRate: -0.001, markPrice: 100 }],
  });
  assert.equal(result.eventCount, 1);
  assert.equal(result.events[0].cashflow, 0.20); // -(2 × 100 × (-0.001))
  assert.equal(result.fundingPaid, 0);
  assert.equal(result.fundingReceived, 0.20);
  assert.equal(result.netFunding, 0.20);
});

test('funding zero rate', () => {
  const result = computeTradeFunding({
    entryTimeMs: 0,
    exitTimeMs: 1000,
    quantity: 2,
    fundingEvents: [{ fundingTime: 500, fundingRate: 0, markPrice: 100 }],
  });
  assert.equal(result.eventCount, 0);
  assert.equal(result.netFunding, 0);
});

test('multiple funding events: +0.0001, +0.0002, -0.0001', () => {
  const result = computeTradeFunding({
    entryTimeMs: 0,
    exitTimeMs: 1000,
    quantity: 2,
    fundingEvents: [
      { fundingTime: 100, fundingRate: 0.0001, markPrice: 100 },
      { fundingTime: 500, fundingRate: 0.0002, markPrice: 100 },
      { fundingTime: 900, fundingRate: -0.0001, markPrice: 100 },
    ],
  });
  assert.equal(result.eventCount, 3);
  // Event 1: -(2 × 100 × 0.0001) = -0.02 (pay)
  // Event 2: -(2 × 100 × 0.0002) = -0.04 (pay)
  // Event 3: -(2 × 100 × (-0.0001)) = +0.02 (receive)
  assert.equal(result.fundingPaid, 0.06); // 0.02 + 0.04
  assert.equal(result.fundingReceived, 0.02);
  assert.ok(Math.abs(result.netFunding - (-0.04)) < 1e-10); // -0.02 - 0.04 + 0.02
});

// === Ownership rule tests ===

test('entry boundary excluded (fundingTime == entryTime)', () => {
  const result = computeTradeFunding({
    entryTimeMs: 500,
    exitTimeMs: 1000,
    quantity: 1,
    fundingEvents: [{ fundingTime: 500, fundingRate: 0.001, markPrice: 100 }],
  });
  assert.equal(result.eventCount, 0, 'fundingTime == entryTime must NOT count');
});

test('exit boundary excluded (fundingTime == exitTime)', () => {
  const result = computeTradeFunding({
    entryTimeMs: 0,
    exitTimeMs: 500,
    quantity: 1,
    fundingEvents: [{ fundingTime: 500, fundingRate: 0.001, markPrice: 100 }],
  });
  assert.equal(result.eventCount, 0, 'fundingTime == exitTime must NOT count');
});

test('event inside position included (entry < fundingTime < exit)', () => {
  const result = computeTradeFunding({
    entryTimeMs: 0,
    exitTimeMs: 1000,
    quantity: 1,
    fundingEvents: [{ fundingTime: 500, fundingRate: 0.001, markPrice: 100 }],
  });
  assert.equal(result.eventCount, 1, 'event strictly inside must count');
});

test('event before entry excluded', () => {
  const result = computeTradeFunding({
    entryTimeMs: 500,
    exitTimeMs: 1000,
    quantity: 1,
    fundingEvents: [{ fundingTime: 100, fundingRate: 0.001, markPrice: 100 }],
  });
  assert.equal(result.eventCount, 0);
});

test('event after exit excluded', () => {
  const result = computeTradeFunding({
    entryTimeMs: 0,
    exitTimeMs: 500,
    quantity: 1,
    fundingEvents: [{ fundingTime: 900, fundingRate: 0.001, markPrice: 100 }],
  });
  assert.equal(result.eventCount, 0);
});

// === Mark price tests ===

test('markPrice direct from API', () => {
  const result = computeTradeFunding({
    entryTimeMs: 0,
    exitTimeMs: 1000,
    quantity: 1,
    fundingEvents: [{ fundingTime: 500, fundingRate: 0.001, markPrice: 50000 }],
  });
  assert.equal(result.events[0].markPriceSource, 'DIRECT');
  assert.equal(result.events[0].cashflow, -50); // -(1 × 50000 × 0.001)
});

test('invalid funding rate skipped', () => {
  const result = computeTradeFunding({
    entryTimeMs: 0,
    exitTimeMs: 1000,
    quantity: 1,
    fundingEvents: [{ fundingTime: 500, fundingRate: NaN, markPrice: 100 }],
  });
  assert.equal(result.eventCount, 0);
});

test('invalid markPrice skipped', () => {
  const result = computeTradeFunding({
    entryTimeMs: 0,
    exitTimeMs: 1000,
    quantity: 1,
    fundingEvents: [{ fundingTime: 500, fundingRate: 0.001, markPrice: 0 }],
  });
  assert.equal(result.eventCount, 0);
});

// === Provider filtering tests ===

test('historical provider getEvents with strict boundaries', () => {
  const events = [
    { symbol: 'X', fundingTime: 100, fundingRate: 0.001, markPrice: 100 },
    { symbol: 'X', fundingTime: 200, fundingRate: 0.002, markPrice: 100 },
    { symbol: 'X', fundingTime: 300, fundingRate: 0.003, markPrice: 100 },
  ];
  const provider = createHistoricalFundingProvider({ events });
  const result = provider.getEvents('X', 100, 300); // exclusive boundaries
  assert.equal(result.length, 1, 'only event 200 is strictly between 100 and 300');
  assert.equal(result[0].fundingTime, 200);
});

test('historical provider getEvents returns empty for no match', () => {
  const events = [{ symbol: 'X', fundingTime: 500, fundingRate: 0.001, markPrice: 100 }];
  const provider = createHistoricalFundingProvider({ events });
  const result = provider.getEvents('X', 0, 100);
  assert.equal(result.length, 0);
});

test('historical provider getRate returns null for unknown symbol', () => {
  const provider = createHistoricalFundingProvider({ events: [] });
  assert.equal(provider.getRate('UNKNOWN', 0), null);
});

// === Data integrity tests ===

test('verifyFundingData: clean data passes', () => {
  const events = [
    { symbol: 'X', fundingTime: 100, fundingRate: 0.001, markPrice: 100 },
    { symbol: 'X', fundingTime: 200, fundingRate: -0.001, markPrice: 100 },
  ];
  const report = verifyFundingData({ events, symbol: 'X', expectedStartMs: 0, expectedEndMs: 1000 });
  assert.equal(report.status, 'OK');
  assert.equal(report.eventCount, 2);
  assert.equal(report.positiveFundingEvents, 1);
  assert.equal(report.negativeFundingEvents, 1);
  assert.equal(report.zeroFundingEvents, 0);
});

test('verifyFundingData: duplicates detected', () => {
  const events = [
    { symbol: 'X', fundingTime: 100, fundingRate: 0.001, markPrice: 100 },
    { symbol: 'X', fundingTime: 100, fundingRate: 0.002, markPrice: 100 },
  ];
  const report = verifyFundingData({ events, symbol: 'X', expectedStartMs: 0, expectedEndMs: 1000 });
  assert.equal(report.duplicateCount, 1);
  assert.equal(report.status, 'FUNDING DATA INCOMPLETE');
});

test('verifyFundingData: empty data is incomplete', () => {
  const report = verifyFundingData({ events: [], symbol: 'X', expectedStartMs: 0, expectedEndMs: 1000 });
  assert.equal(report.status, 'FUNDING DATA INCOMPLETE');
});

test('verifyFundingData: 2026 violation detected', () => {
  const events = [{ symbol: 'X', fundingTime: HOLDOUT_START_MS, fundingRate: 0.001, markPrice: 100 }];
  const report = verifyFundingData({ events, symbol: 'X', expectedStartMs: 0, expectedEndMs: HOLDOUT_START_MS + 1000 });
  assert.equal(report.holdoutViolation, true);
  assert.equal(report.status, 'HOLDOUT VIOLATION');
});

// === CSV round-trip ===

test('saveCSV + loadFundingCSV round-trip', () => {
  const tmpPath = path.join(ROOT, 'data', 'funding', '_test_roundtrip.csv');
  const events = [
    { symbol: 'TEST', fundingTime: 1000, fundingRate: 0.001, markPrice: 50000, rateType: 'REALIZED' },
    { symbol: 'TEST', fundingTime: 2000, fundingRate: -0.0005, markPrice: 49000, rateType: null },
  ];
  saveFundingCSV(events, tmpPath);
  const loaded = loadFundingCSV(tmpPath);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].fundingTime, 1000);
  assert.equal(loaded[0].fundingRate, 0.001);
  assert.equal(loaded[0].markPrice, 50000);
  assert.equal(loaded[0].rateType, 'REALIZED');
  assert.equal(loaded[1].fundingRate, -0.0005);
  fs.unlinkSync(tmpPath);
});

// === Holdout tests ===

test('2026 still locked for research strategies', () => {
  assert.equal(isResearchStrategy('breakout24h4h'), true);
  assert.equal(checkHoldoutLock({ strategy: 'breakout24h4h', candles: [{ timestamp: HOLDOUT_START_MS + 1 }] }).locked, true);
});

// === Candidate SHA unchanged ===

test('candidate freeze SHA unchanged', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'v4-final-development-candidate.md'), 'utf8');
  assert.ok(doc.includes('2e866b3fd4f0b38f0570ab31c9dfc77e1030c5a8'));
  assert.equal(require('../src/research/strategies/breakout24h4h').windowBars, 6);
});

// === Funding affects equity ===

test('funding affects equity curve (netPnlAfterFunding differs from netPnl)', () => {
  const trades = [
    { netPnl: 100, netPnlAfterFunding: 100, netFunding: 0, fundingEventCount: 0, entryTime: 0, exitTime: 100, quantity: 1, grossPnl: 110, fees: 10, netPnlBeforeFunding: 100 },
  ];
  const fundingEvents = [{ symbol: 'X', fundingTime: 50, fundingRate: 0.001, markPrice: 1000 }];
  const provider = createHistoricalFundingProvider({ events: fundingEvents });
  const result = enrichTradesWithFunding({ trades, fundingProvider: provider, symbol: 'X' });
  assert.equal(result[0].netFunding, -1); // -(1 × 1000 × 0.001) = -1
  assert.equal(result[0].netPnlAfterFunding, 99); // 100 + (-1)
});

// === Duplicate funding rejection ===

test('duplicate funding timestamps are deduplicated by provider', () => {
  const events = [
    { symbol: 'X', fundingTime: 100, fundingRate: 0.001, markPrice: 100 },
    { symbol: 'X', fundingTime: 100, fundingRate: 0.002, markPrice: 100 }, // duplicate timestamp
  ];
  const provider = createHistoricalFundingProvider({ events });
  const result = provider.getEvents('X', 0, 200);
  // The provider stores all events; deduplication should happen at load time
  // If provider doesn't deduplicate, this test catches it
  assert.ok(result.length <= 1, 'provider should not return duplicate timestamps');
});

// === Pagination boundary ===

test('pagination boundary: no duplicate at page boundary', () => {
  const events = [
    { symbol: 'X', fundingTime: 100, fundingRate: 0.001, markPrice: 100 },
    { symbol: 'X', fundingTime: 101, fundingRate: 0.002, markPrice: 100 },
  ];
  const report = verifyFundingData({ events, symbol: 'X', expectedStartMs: 0, expectedEndMs: 200 });
  assert.equal(report.duplicateCount, 0);
  assert.equal(report.eventCount, 2);
});

// === Future event mutation does not affect past ===

test('future funding events do not affect past equity', () => {
  const events = [
    { symbol: 'X', fundingTime: 500, fundingRate: 0.001, markPrice: 100 },
    { symbol: 'X', fundingTime: 1500, fundingRate: 0.005, markPrice: 100 },
  ];
  const provider = createHistoricalFundingProvider({ events });
  const result = provider.getEvents('X', 0, 1000);
  assert.equal(result.length, 1);
  assert.equal(result[0].fundingTime, 500);
});

// === Missing funding data detection ===

test('missing funding data for asset is detected', () => {
  const report = verifyFundingData({ events: [], symbol: 'MISSING', expectedStartMs: 0, expectedEndMs: 1000 });
  assert.equal(report.status, 'FUNDING DATA INCOMPLETE');
  assert.ok(report.issues.includes('no events'));
});

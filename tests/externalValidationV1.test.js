// CROSS-ASSET EXTERNAL VALIDATION V1 tests: data normalization, checksum
// re-verification, listing-date handling, 4h aggregation reuse, warmup,
// asset isolation, 2026 rejection, freeze metadata, sizing/cost unchanged,
// and the pure external survival gate (pass/fail, 60% buckets, low sample,
// concentration, 2025 regime).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadCandles } = require('../src/research/data/candleRepository');
const { resample, TARGETS } = require('../src/research/data/resampler');
const { loadStrategy, isResearchStrategy } = require('../src/research/strategyAdapter');
const { runBacktest } = require('../src/research/backtest/backtester');
const { checkHoldoutLock, HOLDOUT_START_MS } = require('../src/research/holdoutGuard');
const { assetGate, stressGate, yearPass, samplePass, yearConcentration, check2025Regime } = require('../src/research/externalGate');

const ROOT = path.join(__dirname, '..');

function load15m(symbol) {
  return loadCandles({ file: path.join(ROOT, 'data', 'market', `${symbol}-15m.csv`), symbol }).candles;
}

// ---- official data normalization ----
test('BNB official data normalization: loads, sorted, contains 2026', () => {
  const candles = load15m('BNBUSDT');
  assert.ok(candles.length > 0);
  assert.equal(candles[0].timestamp, 1581321600000); // 2020-02-10 08:00 UTC
  assert.ok(candles.some((c) => c.timestamp >= HOLDOUT_START_MS), 'BNB now contains 2026 candles');
  for (let i = 1; i < candles.length; i++) assert.ok(candles[i].timestamp > candles[i - 1].timestamp);
});

test('SOL official data normalization: loads, sorted, contains 2026', () => {
  const candles = load15m('SOLUSDT');
  assert.ok(candles.length > 0);
  assert.equal(candles[0].timestamp, 1600066800000); // 2020-09-14 07:00 UTC
  assert.ok(candles.some((c) => c.timestamp >= HOLDOUT_START_MS), 'SOL now contains 2026 candles');
});

// ---- checksum re-verification ----
test('checksum validation: every downloaded official zip matches its .CHECKSUM', () => {
  for (const symbol of ['BNBUSDT', 'SOLUSDT']) {
    const dir = path.join(ROOT, 'data', 'market', 'raw', symbol);
    assert.ok(fs.existsSync(dir), `raw dir for ${symbol}`);
    const zips = fs.readdirSync(dir).filter((f) => f.endsWith('.zip'));
    assert.ok(zips.length >= 60, `${symbol}: expected many monthly zips, got ${zips.length}`);
    for (const zip of zips) {
      const csFile = path.join(dir, `${zip}.CHECKSUM`);
      assert.ok(fs.existsSync(csFile), `missing CHECKSUM for ${zip}`);
      const expected = fs.readFileSync(csFile, 'utf8').trim().split(/\s+/)[0].toLowerCase();
      const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, zip))).digest('hex');
      assert.equal(actual, expected, `${symbol}/${zip} checksum mismatch`);
    }
  }
});

// ---- listing-date handling ----
test('listing-date handling: first 4h candle is after the first 15m, first year is partial', () => {
  for (const symbol of ['BNBUSDT', 'SOLUSDT']) {
    const dev = load15m(symbol);
    const h4 = resample(dev, TARGETS['4h']);
    assert.ok(h4.candles[0].timestamp >= dev[0].timestamp);
    const firstYear = new Date(h4.candles[0].timestamp).getUTCFullYear();
    // first year (2020) has far fewer 4h bars than a full year (~2190)
    const firstYearBars = h4.candles.filter((c) => new Date(c.timestamp).getUTCFullYear() === firstYear).length;
    assert.ok(firstYearBars < 2100, `${symbol}: first year must be partial, got ${firstYearBars} bars`);
  }
});

// ---- 4h aggregation reuse ----
test('4h aggregation reuses the V4 resampler (16x15m) on external data', () => {
  for (const symbol of ['BNBUSDT', 'SOLUSDT']) {
    const dev = load15m(symbol);
    const h4 = resample(dev, TARGETS['4h']);
    const fullYears = new Set(dev.map((c) => new Date(c.timestamp).getUTCFullYear()).filter((y) => y > new Date(dev[0].timestamp).getUTCFullYear()));
    for (const y of fullYears) {
      const yBars = h4.candles.filter((c) => new Date(c.timestamp).getUTCFullYear() === y).length;
      if (y < 2026) {
        assert.ok(yBars >= 2100 && yBars <= 2200, `${symbol} ${y}: ~2190 4h bars expected, got ${yBars}`);
      } else {
        // 2026 is partial (7 months), expect ~1260 bars
        assert.ok(yBars >= 1200 && yBars <= 1350, `${symbol} ${y}: ~1270 4h bars expected for partial year, got ${yBars}`);
      }
    }
  }
});

// ---- warmup date handling ----
test('warmup: first trade occurs only after EMA/breakout warmup', () => {
  const dev = load15m('BNBUSDT');
  const h4 = resample(dev, TARGETS['4h']).candles.slice(0, 300);
  const broker = { commissionPct: 0, slippagePct: 0, entryFillPrice: (o) => o, exitFillPrice: (o) => o, commission: () => 0, fundingCost: () => 0, fundingIncluded: () => false };
  const result = runBacktest({ symbol: 'BNBUSDT', candles: h4, adapter: loadStrategy('breakout24h4h'), broker, initialCapital: 10000, positionSizePct: 25 });
  for (const t of result.trades) {
    const idx = h4.findIndex((c) => c.timestamp === t.entryTime);
    assert.ok(idx >= 50, `first trade must come after indicator warmup (idx ${idx})`);
  }
});

// ---- external asset isolation ----
test('external assets are isolated (independent accounts)', () => {
  const bnb = resample(load15m('BNBUSDT'), TARGETS['4h']).candles.slice(0, 400);
  const sol = resample(load15m('SOLUSDT'), TARGETS['4h']).candles.slice(0, 400);
  const broker = { commissionPct: 0, slippagePct: 0, entryFillPrice: (o) => o, exitFillPrice: (o) => o, commission: () => 0, fundingCost: () => 0, fundingIncluded: () => false };
  const r1 = runBacktest({ symbol: 'BNBUSDT', candles: bnb, adapter: loadStrategy('breakout24h4h'), broker, initialCapital: 10000, positionSizePct: 25 });
  const r2 = runBacktest({ symbol: 'SOLUSDT', candles: sol, adapter: loadStrategy('breakout24h4h'), broker, initialCapital: 10000, positionSizePct: 25 });
  // each run uses ONLY its own candles (independent account, no shared equity)
  assert.equal(r1.equityCurve.length, 400);
  assert.equal(r2.equityCurve.length, 400);
  assert.ok(Array.isArray(r1.trades));
  assert.ok(Array.isArray(r2.trades));
  // equity paths are independent (different data -> different final equity)
  assert.ok(r1.equityCurve[r1.equityCurve.length - 1].equity !== r2.equityCurve[r2.equityCurve.length - 1].equity);
});

// ---- 2026 rejection ----
test('2026 holdout guard blocks strategy execution on 2026 data', () => {
  assert.equal(isResearchStrategy('breakout24h4h'), true);
  assert.equal(checkHoldoutLock({ strategy: 'breakout24h4h', candles: [{ timestamp: HOLDOUT_START_MS + 1 }] }).locked, true);
  // Data now exists but strategy execution is still locked
  for (const symbol of ['BNBUSDT', 'SOLUSDT']) {
    const dev = load15m(symbol);
    assert.ok(dev.some((c) => c.timestamp >= HOLDOUT_START_MS), `${symbol} has 2026 data (but strategy is locked)`);
  }
});

// ---- freeze metadata ----
test('candidate freeze metadata: frozen doc exists and references freeze SHA 2e866b3', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'v4-final-development-candidate.md'), 'utf8');
  assert.ok(doc.includes('2e866b3fd4f0b38f0570ab31c9dfc77e1030c5a8'), 'freeze SHA must be referenced');
  assert.equal(require('../src/research/strategies/breakout24h4h').windowBars, 6);
});

// ---- position size / cost unchanged ----
test('position size 25% and cost model are unchanged for external validation', () => {
  const { createBroker } = require('../src/research/backtest/brokerSimulator');
  const { createPortfolio } = require('../src/research/backtest/portfolio');
  const broker = createBroker({ commissionPct: 0.0004, slippagePct: 0 });
  const p = createPortfolio({ initialCapital: 10000, symbol: 'X', positionSizePct: 25, strategyName: 's' });
  p.openPosition({ timestamp: 0, close: 100, index: 0 }, 100, broker);
  assert.ok(Math.abs(p.state.cash - 7500) < 1e-6);
  assert.equal(createBroker().commissionPct, 0.0004);
  assert.equal(createBroker().slippagePct, 0.0002);
});

// ---- external gate: pass & fail ----
test('external gate: asset-level pass/fail', () => {
  assert.equal(assetGate({ baseNetExp: 0.5, baseNetPF: 1.4, baseSharpe: 1 }), true);
  assert.equal(assetGate({ baseNetExp: -0.1, baseNetPF: 1.4, baseSharpe: 1 }), false); // negative exp
  assert.equal(assetGate({ baseNetExp: 0.5, baseNetPF: 1.02, baseSharpe: 1 }), false); // NetPF <= 1.05
  assert.equal(assetGate({ baseNetExp: 0.5, baseNetPF: 1.4, baseSharpe: -0.2 }), false); // Sharpe <= 0
});

test('external gate: stress gate', () => {
  assert.equal(stressGate({ stressNetExp: 0.1, stressNetPF: 1.1 }), true);
  assert.equal(stressGate({ stressNetExp: -0.05, stressNetPF: 1.1 }), false);
  assert.equal(stressGate({ stressNetExp: 0.1, stressNetPF: 0.9 }), false);
});

// ---- 60% bucket calculation ----
test('year consistency: >=60% of complete buckets must be positive', () => {
  assert.equal(yearPass([0.5, 0.3, 0.2, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1]), false); // 3/10 = 30%
  assert.equal(yearPass([0.5, 0.3, 0.2, 0.1, 0.05, 0.02, -0.1, -0.1, -0.1, -0.1]), true); // 6/10 = 60%
  assert.equal(yearPass([0.5, 0.3, 0.2, 0.1, 0.05, 0.02, 0.01, -0.1, -0.1, -0.1]), true); // 7/10 = 70%
});

// ---- low sample rejection ----
test('sample gate: <100 trades on any external asset fails', () => {
  assert.equal(samplePass({ BNBUSDT: { count: 212 }, SOLUSDT: { count: 196 } }), true);
  assert.equal(samplePass({ BNBUSDT: { count: 212 }, SOLUSDT: { count: 60 } }), false);
});

// ---- year concentration diagnostic ----
test('year concentration: >60% single-year contribution flags HIGH concentration', () => {
  const c1 = yearConcentration([{ netPnL: 600, symbol: 'X', year: 2021 }, { netPnL: 200, symbol: 'X', year: 2022 }, { netPnL: 100, symbol: 'X', year: 2023 }]);
  assert.ok(Math.abs(c1.ratio - 0.6667) < 0.001);
  assert.equal(c1.flag, true); // 600/900 > 0.6
  const c2 = yearConcentration([{ netPnL: 400, symbol: 'X', year: 2021 }, { netPnL: 300, symbol: 'X', year: 2022 }, { netPnL: 300, symbol: 'X', year: 2023 }]);
  assert.equal(c2.flag, false); // 400/1000 = 0.4
});

// ---- 2025 regime ----
test('2025 regime check: systematic only when all assets negative', () => {
  assert.equal(check2025Regime([-0.74, -0.75, 0.35, -0.64]), 'mixed (not systematic)');
  assert.equal(check2025Regime([-0.74, -0.75, -0.64, -0.9]), 'SYSTEMATIC 2025 REGIME FAILURE');
});

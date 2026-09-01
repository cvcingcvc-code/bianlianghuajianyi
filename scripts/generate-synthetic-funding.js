// Synthetic funding data generator for code validation.
// Research-only. Generates realistic funding rate history based on
// known Binance USD-M funding patterns.
//
// THIS IS FOR CODE VALIDATION ONLY — not for final strategy validation.
// Real funding data must be downloaded from Binance API for actual validation.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FUNDING_DIR = path.join(ROOT, 'data', 'funding');

// Realistic funding rate distributions by asset and period
// Based on known Binance historical patterns
const FUNDING_PATTERNS = {
  BTCUSDT: {
    startMs: Date.UTC(2021, 0, 1),
    // bull: positive rates (longs pay shorts), bear: negative rates
    periods: [
      { start: Date.UTC(2021, 0, 1), end: Date.UTC(2021, 4, 1), mean: 0.0003, std: 0.0002 },
      { start: Date.UTC(2021, 4, 1), end: Date.UTC(2021, 11, 1), mean: 0.0005, std: 0.0003 },
      { start: Date.UTC(2021, 11, 1), end: Date.UTC(2022, 5, 1), mean: -0.0002, std: 0.0003 },
      { start: Date.UTC(2022, 5, 1), end: Date.UTC(2022, 11, 1), mean: -0.0003, std: 0.0002 },
      { start: Date.UTC(2022, 11, 1), end: Date.UTC(2023, 6, 1), mean: 0.0001, std: 0.0001 },
      { start: Date.UTC(2023, 6, 1), end: Date.UTC(2024, 0, 1), mean: 0.0002, std: 0.0001 },
      { start: Date.UTC(2024, 0, 1), end: Date.UTC(2024, 6, 1), mean: 0.0003, std: 0.0002 },
      { start: Date.UTC(2024, 6, 1), end: Date.UTC(2025, 0, 1), mean: 0.0002, std: 0.0001 },
      { start: Date.UTC(2025, 0, 1), end: Date.UTC(2025, 11, 31), mean: 0.0001, std: 0.0002 },
    ],
    markPriceMultiplier: 1,
  },
  ETHUSDT: {
    startMs: Date.UTC(2021, 0, 1),
    periods: [
      { start: Date.UTC(2021, 0, 1), end: Date.UTC(2021, 5, 1), mean: 0.0004, std: 0.0003 },
      { start: Date.UTC(2021, 5, 1), end: Date.UTC(2021, 11, 1), mean: 0.0006, std: 0.0004 },
      { start: Date.UTC(2021, 11, 1), end: Date.UTC(2022, 6, 1), mean: -0.0002, std: 0.0003 },
      { start: Date.UTC(2022, 6, 1), end: Date.UTC(2022, 12, 1), mean: -0.0004, std: 0.0002 },
      { start: Date.UTC(2022, 12, 1), end: Date.UTC(2023, 6, 1), mean: 0.0001, std: 0.0001 },
      { start: Date.UTC(2023, 6, 1), end: Date.UTC(2024, 0, 1), mean: 0.0002, std: 0.0001 },
      { start: Date.UTC(2024, 0, 1), end: Date.UTC(2024, 6, 1), mean: 0.0003, std: 0.0002 },
      { start: Date.UTC(2024, 6, 1), end: Date.UTC(2025, 0, 1), mean: 0.0002, std: 0.0001 },
      { start: Date.UTC(2025, 0, 1), end: Date.UTC(2025, 11, 31), mean: 0.0001, std: 0.0002 },
    ],
    markPriceMultiplier: 0.06,
  },
  BNBUSDT: {
    startMs: Date.UTC(2020, 1, 10),
    periods: [
      { start: Date.UTC(2020, 1, 10), end: Date.UTC(2021, 0, 1), mean: 0.0001, std: 0.0001 },
      { start: Date.UTC(2021, 0, 1), end: Date.UTC(2021, 5, 1), mean: 0.0003, std: 0.0002 },
      { start: Date.UTC(2021, 5, 1), end: Date.UTC(2021, 11, 1), mean: 0.0004, std: 0.0003 },
      { start: Date.UTC(2021, 11, 1), end: Date.UTC(2022, 6, 1), mean: -0.0001, std: 0.0002 },
      { start: Date.UTC(2022, 6, 1), end: Date.UTC(2022, 12, 1), mean: -0.0002, std: 0.0001 },
      { start: Date.UTC(2022, 12, 1), end: Date.UTC(2023, 6, 1), mean: 0.0001, std: 0.0001 },
      { start: Date.UTC(2023, 6, 1), end: Date.UTC(2024, 0, 1), mean: 0.0001, std: 0.0001 },
      { start: Date.UTC(2024, 0, 1), end: Date.UTC(2024, 6, 1), mean: 0.0002, std: 0.0001 },
      { start: Date.UTC(2024, 6, 1), end: Date.UTC(2025, 0, 1), mean: 0.0001, std: 0.0001 },
      { start: Date.UTC(2025, 0, 1), end: Date.UTC(2025, 11, 31), mean: 0.0001, std: 0.0001 },
    ],
    markPriceMultiplier: 0.002,
  },
  SOLUSDT: {
    startMs: Date.UTC(2020, 8, 14),
    periods: [
      { start: Date.UTC(2020, 8, 14), end: Date.UTC(2021, 0, 1), mean: 0.0001, std: 0.0001 },
      { start: Date.UTC(2021, 0, 1), end: Date.UTC(2021, 5, 1), mean: 0.0005, std: 0.0003 },
      { start: Date.UTC(2021, 5, 1), end: Date.UTC(2021, 11, 1), mean: 0.0007, std: 0.0004 },
      { start: Date.UTC(2021, 11, 1), end: Date.UTC(2022, 6, 1), mean: -0.0003, std: 0.0003 },
      { start: Date.UTC(2022, 6, 1), end: Date.UTC(2022, 12, 1), mean: -0.0005, std: 0.0003 },
      { start: Date.UTC(2022, 12, 1), end: Date.UTC(2023, 6, 1), mean: 0.0001, std: 0.0001 },
      { start: Date.UTC(2023, 6, 1), end: Date.UTC(2024, 0, 1), mean: 0.0002, std: 0.0001 },
      { start: Date.UTC(2024, 0, 1), end: Date.UTC(2024, 6, 1), mean: 0.0004, std: 0.0002 },
      { start: Date.UTC(2024, 6, 1), end: Date.UTC(2025, 0, 1), mean: 0.0002, std: 0.0001 },
      { start: Date.UTC(2025, 0, 1), end: Date.UTC(2025, 11, 31), mean: 0.0001, std: 0.0002 },
    ],
    markPriceMultiplier: 0.003,
  },
};

// Seed-based PRNG for reproducibility
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Box-Muller transform for normal distribution
function normalRandom(rng, mean, std) {
  const u1 = rng();
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
  return mean + std * z;
}

// Get approximate mark price for a given asset and timestamp
function getApproxMarkPrice(symbol, timestampMs) {
  const config = FUNDING_PATTERNS[symbol];
  // Use a simple model: base price * (1 + trend)
  const basePrices = { BTCUSDT: 30000, ETHUSDT: 2000, BNBUSDT: 300, SOLUSDT: 50 };
  const base = basePrices[symbol] || 100;
  const yearsSince2021 = (timestampMs - Date.UTC(2021, 0, 1)) / (365.25 * 24 * 3600 * 1000);
  const trend = 1 + 0.3 * yearsSince2021 + 0.2 * Math.sin(yearsSince2021 * 2);
  return base * trend * config.markPriceMultiplier;
}

// Generate funding events for an asset (every 8 hours, matching real Binance schedule)
function generateFundingEvents(symbol, startMs, endMs, seed = 42) {
  const config = FUNDING_PATTERNS[symbol];
  const rng = mulberry32(seed + symbol.length * 1000);
  const events = [];

  // Binance funding times: 00:00, 08:00, 16:00 UTC
  const FUNDING_INTERVAL = 8 * 60 * 60 * 1000;
  let t = startMs;
  // Align to next 8h boundary
  const firstBoundary = Math.ceil(t / FUNDING_INTERVAL) * FUNDING_INTERVAL;
  t = Math.max(t, firstBoundary);

  while (t <= endMs) {
    // Find which period we're in
    let period = config.periods[0];
    for (const p of config.periods) {
      if (t >= p.start && t < p.end) {
        period = p;
        break;
      }
    }

    const rate = normalRandom(rng, period.mean, period.std);
    const clampedRate = Math.max(-0.003, Math.min(0.003, rate)); // Binance limits
    const markPrice = getApproxMarkPrice(symbol, t);

    events.push({
      symbol,
      fundingTime: t,
      fundingRate: Math.round(clampedRate * 100000) / 100000,
      markPrice: Math.round(markPrice * 100) / 100,
      rateType: 'REALIZED',
    });

    t += FUNDING_INTERVAL;
  }

  return events;
}

function saveCSV(events, filePath) {
  const header = 'symbol,fundingTime,fundingRate,markPrice,rateType\n';
  const rows = events.map((e) => `${e.symbol},${e.fundingTime},${e.fundingRate},${e.markPrice},${e.rateType}`).join('\n');
  fs.writeFileSync(filePath, header + rows + '\n', 'utf8');
}

function main() {
  if (!fs.existsSync(FUNDING_DIR)) fs.mkdirSync(FUNDING_DIR, { recursive: true });

  const endMs = Date.UTC(2025, 11, 31, 23, 59, 59, 999);

  for (const [symbol, config] of Object.entries(FUNDING_PATTERNS)) {
    const events = generateFundingEvents(symbol, config.startMs, endMs);
    const csvPath = path.join(FUNDING_DIR, `${symbol}-funding.csv`);
    saveCSV(events, csvPath);

    const pos = events.filter((e) => e.fundingRate > 0).length;
    const neg = events.filter((e) => e.fundingRate < 0).length;
    const zero = events.filter((e) => e.fundingRate === 0).length;
    console.log(`${symbol}: ${events.length} events | +${pos} / -${neg} / =${zero} | saved to ${csvPath}`);
  }
}

main();

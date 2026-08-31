// Validation of typed OHLCV candles + data quality report.
//
// A "candle" is an object: { timestamp: number(ms), open, high, low, close, volume }
//
// Classification:
//   - errors   : rows that must be rejected (NaN, non-positive close, invalid OHLC
//                relationships) or a hard failure of the whole series
//                (timestamps not strictly ascending).
//   - warnings : recoverable issues (duplicate timestamps, large gaps) that are
//                reported but do not necessarily invalidate the series.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Validate a candle array. Returns { errors, warnings, stats }.
// - errors: array of { index, type, message }
// - warnings: array of { index, type, message }
// - stats: summary object for the quality report
function validateCandles(candles) {
  const errors = [];
  const warnings = [];
  const seenTs = new Map();
  let lastTs = null;
  let nanCount = 0;
  let invalidOhlcCount = 0;
  let nonPositiveCloseCount = 0;
  let duplicateCount = 0;
  let gapCount = 0;
  const gaps = [];

  if (!Array.isArray(candles) || candles.length === 0) {
    return {
      errors: [{ index: -1, type: 'empty', message: 'no candles provided' }],
      warnings: [],
      stats: { total: 0, valid: 0, nanCount: 0, invalidOhlcCount: 0, nonPositiveCloseCount: 0, duplicateCount: 0, gapCount: 0, medianIntervalMs: null },
    };
  }

  candles.forEach((c, i) => {
    const row = i;
    const ts = c.timestamp;

    // --- numeric validity (NaN / non-finite) ---
    for (const f of ['open', 'high', 'low', 'close', 'volume']) {
      const v = c[f];
      if (v === undefined || v === null || Number.isNaN(v) || !Number.isFinite(v)) {
        errors.push({ index: i, type: 'nan', field: f, message: `row ${row}: "${f}" is not a finite number (got ${v})` });
        nanCount++;
      }
    }

    // --- non-positive close ---
    if (typeof c.close === 'number' && !(c.close > 0)) {
      errors.push({ index: i, type: 'non-positive-close', message: `row ${row}: close must be > 0 (got ${c.close})` });
      nonPositiveCloseCount++;
    }

    // --- OHLC relationships ---
    if (c.high < c.low) {
      errors.push({ index: i, type: 'ohlc', message: `row ${row}: high (${c.high}) < low (${c.low})` });
      invalidOhlcCount++;
    } else if (c.high < c.open || c.high < c.close) {
      errors.push({ index: i, type: 'ohlc', message: `row ${row}: high (${c.high}) must be >= open/close` });
      invalidOhlcCount++;
    } else if (c.low > c.open || c.low > c.close) {
      errors.push({ index: i, type: 'ohlc', message: `row ${row}: low (${c.low}) must be <= open/close` });
      invalidOhlcCount++;
    }

    // --- volume ---
    if (typeof c.volume === 'number' && c.volume < 0) {
      errors.push({ index: i, type: 'negative-volume', message: `row ${row}: volume must be >= 0 (got ${c.volume})` });
    }

    // --- timestamp ordering (strictly ascending) ---
    if (typeof ts === 'number' && Number.isFinite(ts)) {
      if (lastTs !== null && ts <= lastTs) {
        errors.push({
          index: i,
          type: 'out-of-order',
          message: `row ${row}: timestamp ${ts} is not strictly greater than previous (${lastTs})`,
        });
      }
      lastTs = ts;
    }

    // --- duplicate timestamps ---
    if (seenTs.has(ts)) {
      warnings.push({ index: i, type: 'duplicate-timestamp', message: `row ${row}: duplicate timestamp ${ts}` });
      duplicateCount++;
    }
    seenTs.set(ts, i);
  });

  // --- gap detection (informational) ---
  let medianIntervalMs = null;
  if (candles.length >= 3) {
    const deltas = [];
    for (let i = 1; i < candles.length; i++) {
      if (typeof candles[i].timestamp === 'number' && typeof candles[i - 1].timestamp === 'number') {
        deltas.push(candles[i].timestamp - candles[i - 1].timestamp);
      }
    }
    if (deltas.length > 0) {
      deltas.sort((a, b) => a - b);
      medianIntervalMs = deltas[Math.floor(deltas.length / 2)];
      for (let i = 1; i < candles.length; i++) {
        if (typeof candles[i].timestamp === 'number' && typeof candles[i - 1].timestamp === 'number') {
          const d = candles[i].timestamp - candles[i - 1].timestamp;
          if (d > medianIntervalMs * 5) {
            warnings.push({ index: i, type: 'gap', message: `row ${i}: gap of ${d}ms between candles` });
            gapCount++;
            gaps.push(d);
          }
        }
      }
    }
  }

  const valid = candles.length - errors.length;
  return {
    errors,
    warnings,
    stats: {
      total: candles.length,
      valid,
      nanCount,
      invalidOhlcCount,
      nonPositiveCloseCount,
      duplicateCount,
      gapCount,
      medianIntervalMs,
      largestGapMs: gaps.length ? Math.max(...gaps) : null,
    },
  };
}

// Produce a human-readable quality report string.
function formatQualityReport(report) {
  const lines = [];
  lines.push('=== Data Quality Report ===');
  if (report.candles && report.candles.length > 0) {
    const first = report.candles[0];
    const last = report.candles[report.candles.length - 1];
    lines.push(`  Rows: ${report.candles.length}`);
    lines.push(`  Range: ${iso(first.timestamp)} -> ${iso(last.timestamp)}`);
  }
  const v = report.validation;
  if (v) {
    lines.push(`  Median interval: ${v.stats.medianIntervalMs != null ? Math.round(v.stats.medianIntervalMs / 1000) + 's' : 'N/A'}`);
    lines.push(`  Errors: ${v.errors.length}`);
    for (const e of v.errors.slice(0, 10)) lines.push(`    - ${e.message}`);
    if (v.errors.length > 10) lines.push(`    ... and ${v.errors.length - 10} more`);
    lines.push(`  Warnings: ${v.warnings.length}`);
    for (const w of v.warnings.slice(0, 10)) lines.push(`    - ${w.message}`);
    if (v.warnings.length > 10) lines.push(`    ... and ${v.warnings.length - 10} more`);
  }
  return lines.join('\n');
}

function iso(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return 'N/A';
  return new Date(ms).toISOString();
}

module.exports = { validateCandles, formatQualityReport, MS_PER_DAY };

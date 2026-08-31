// K-line continuity analysis: checks that candles form an unbroken chain at a
// fixed interval (e.g. every 900000 ms for 15m). Never fills gaps — gaps are
// counted and reported so the caller decides whether results are usable.

// Analyze continuity of a candle array (must already be sorted ascending).
// Returns:
//   expectedBars, actualBars, duplicateBars, missingBars, gapCount,
//   largestGapMs, firstTimestamp, lastTimestamp, gaps[{ at, delta, missing }]
function analyzeContinuity(candles, intervalMs) {
  const stats = {
    intervalMs,
    expectedBars: 0,
    actualBars: candles.length,
    duplicateBars: 0,
    missingBars: 0,
    gapCount: 0,
    largestGapMs: 0,
    firstTimestamp: candles.length ? candles[0].timestamp : null,
    lastTimestamp: candles.length ? candles[candles.length - 1].timestamp : null,
    gaps: [],
  };

  if (candles.length === 0 || intervalMs <= 0) return stats;

  const expected = Math.floor((stats.lastTimestamp - stats.firstTimestamp) / intervalMs) + 1;
  stats.expectedBars = expected;

  const seen = new Set();
  let prevTs = null;
  let explicitMissing = 0;
  for (const c of candles) {
    if (seen.has(c.timestamp)) stats.duplicateBars++;
    seen.add(c.timestamp);

    if (prevTs !== null) {
      const delta = c.timestamp - prevTs;
      if (delta !== intervalMs) {
        stats.gapCount++;
        const missing = Math.max(0, Math.round(delta / intervalMs) - 1);
        explicitMissing += missing;
        if (delta > stats.largestGapMs) stats.largestGapMs = delta;
        stats.gaps.push({ at: c.timestamp, delta, missing });
      }
    }
    prevTs = c.timestamp;
  }

  const uniqueActual = seen.size;
  stats.missingBars = Math.max(explicitMissing, expected - uniqueActual);
  return stats;
}

// Build the reports/data-quality-<SYMBOL>.md content.
function buildDataQualityMd({ symbol, interval, candles, qualityReport, continuity }) {
  const L = [];
  const iso = (ms) => (typeof ms === 'number' && !Number.isNaN(ms) ? new Date(ms).toISOString() : 'N/A');
  L.push(`# Data Quality Report — ${symbol}`);
  L.push('');
  L.push(`- Interval: ${interval}`);
  L.push(`- Rows loaded: ${candles.length}`);
  L.push(`- First timestamp: ${iso(continuity.firstTimestamp)}`);
  L.push(`- Last timestamp: ${iso(continuity.lastTimestamp)}`);
  L.push('');
  L.push('## Continuity');
  L.push('');
  L.push('| Metric | Value |');
  L.push('| --- | --- |');
  L.push(`| expectedBars | ${continuity.expectedBars} |`);
  L.push(`| actualBars | ${continuity.actualBars} |`);
  L.push(`| duplicateBars | ${continuity.duplicateBars} |`);
  L.push(`| missingBars | ${continuity.missingBars} |`);
  L.push(`| gapCount | ${continuity.gapCount} |`);
  L.push(`| largestGap | ${continuity.largestGapMs ? continuity.largestGapMs + ' ms' : 'none'} |`);
  L.push('');
  if (continuity.gapCount > 0) {
    L.push('## Gaps');
    L.push('');
    L.push('| At | Delta (ms) | Missing bars |');
    L.push('| --- | --- | --- |');
    for (const g of continuity.gaps.slice(0, 50)) {
      L.push(`| ${iso(g.at)} | ${g.delta} | ${g.missing} |`);
    }
    if (continuity.gaps.length > 50) L.push(`| ... and ${continuity.gaps.length - 50} more |`);
    L.push('');
    L.push('> **DATA CONTINUITY WARNING**: missing bars detected. Results derived from this file are NOT marked VALIDATED unless the gaps are confirmed harmless or the data is re-fetched.');
  } else {
    L.push('> No gaps detected — data is continuous for the loaded range.');
  }
  L.push('');
  L.push('## Validation');
  L.push('');
  L.push(`- Validation errors: ${qualityReport.validation.errors.length}`);
  L.push(`- Validation warnings: ${qualityReport.validation.warnings.length}`);
  if (qualityReport.validation.errors.length > 0) {
    for (const e of qualityReport.validation.errors.slice(0, 10)) L.push(`  - ${e.message}`);
  }
  L.push(`- Duplicate timestamps dropped on load: ${qualityReport.duplicateCount}`);
  L.push('');
  return L.join('\n');
}

module.exports = { analyzeContinuity, buildDataQualityMd };

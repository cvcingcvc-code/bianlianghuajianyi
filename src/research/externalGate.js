// External Validation Survival Gate — pure, testable logic (CROSS-ASSET
// EXTERNAL VALIDATION V1). Pre-registered rules; see
// docs/cross-asset-external-validation-v1.md.

// Asset-level gate (BASE): NetExpectancy>0 AND NetPF>1.05 AND Sharpe>0.
function assetGate(a) {
  return a.baseNetExp > 0 && a.baseNetPF > 1.05 && a.baseSharpe > 0;
}

// Stress gate: NetExpectancy>=0 AND NetPF>=1.0.
function stressGate(a) {
  return a.stressNetExp >= 0 && a.stressNetPF >= 1.0;
}

// Year consistency: >= 60% of complete asset-year buckets have BASE NetExp > 0.
function yearPass(buckets) {
  if (buckets.length === 0) return false;
  const pos = buckets.filter((b) => b > 0).length;
  return pos / buckets.length >= 0.6;
}

// Sample gate: each external asset needs >= 100 trades.
function samplePass(assets) {
  return Object.values(assets).every((a) => a.count >= 100);
}

// Year concentration diagnostic: bestYearNetPnL / totalPositiveNetPnL.
// > 60% -> HIGH YEAR CONCENTRATION (P1 flag, not an automatic fail).
function yearConcentration(years) {
  // years: [{ netPnL, symbol, year }]
  const positive = years.filter((y) => y.netPnL > 0);
  const total = positive.reduce((a, y) => a + y.netPnL, 0);
  if (total <= 0 || positive.length === 0) return { ratio: null, flag: false, best: null };
  const best = positive.reduce((m, y) => (y.netPnL > m.netPnL ? y : m), positive[0]);
  const ratio = best.netPnL / total;
  return { ratio, flag: ratio > 0.6, best };
}

// 2025 cross-asset regime check.
function check2025Regime(values) {
  const v = values.filter((x) => x !== null && x !== undefined);
  if (v.length === 0) return 'INSUFFICIENT DATA';
  return v.every((x) => x < 0) ? 'SYSTEMATIC 2025 REGIME FAILURE' : 'mixed (not systematic)';
}

module.exports = { assetGate, stressGate, yearPass, samplePass, yearConcentration, check2025Regime };

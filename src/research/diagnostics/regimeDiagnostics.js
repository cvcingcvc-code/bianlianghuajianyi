// Regime classification for diagnostics. All inputs are entry-time features that
// were computable at the time of entry (no look-ahead).

// Classify a trade into simple, interpretable market-state regimes.
// - trendAbove : close > EMA50
// - trendUp    : EMA50 slope > 0 (ema50_t > ema50_{t-1})
// - bull       : trendAbove AND trendUp
// - volBucket  : 'Low' | 'Medium' | 'High' by ATR14% thresholds (from DISCOVERY distribution)
function classifyRegime(trade, { atrLow, atrHigh }) {
  const close = trade.entrySignalClose;
  const trendAbove = close !== null && close !== undefined && trade.ema50 !== null && close > trade.ema50;
  const trendUp = trade.ema50SlopeSign === 1;
  const atr = trade.atrPct;
  let volBucket = 'Medium';
  if (atr !== null && atr !== undefined) {
    if (atr <= atrLow) volBucket = 'Low';
    else if (atr >= atrHigh) volBucket = 'High';
  } else {
    volBucket = null;
  }
  return { trendAbove, trendUp, bull: trendAbove === true && trendUp === true, volBucket };
}

// Distribution helpers used by the analysis reports.
function quantileSorted(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function quartileBuckets(values) {
  const sorted = values.filter((v) => v !== null && v !== undefined && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return {
    q1: quantileSorted(sorted, 0.25),
    q2: quantileSorted(sorted, 0.5),
    q3: quantileSorted(sorted, 0.75),
  };
}

module.exports = { classifyRegime, quantileSorted, quartileBuckets };

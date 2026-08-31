// Maximum drawdown computation from an equity curve.
// equityCurve: [{ timestamp, equity }]

function maxDrawdown(equityCurve) {
  if (!Array.isArray(equityCurve) || equityCurve.length === 0) {
    return { maxDrawdownPct: null, maxDrawdownAbs: null, peakIndex: null, troughIndex: null };
  }

  let peak = equityCurve[0].equity;
  let peakIndex = 0;
  let maxPct = 0;
  let maxAbs = 0;
  let mddPeak = 0;
  let mddTrough = 0;

  for (let i = 0; i < equityCurve.length; i++) {
    const e = equityCurve[i].equity;
    if (e > peak) {
      peak = e;
      peakIndex = i;
    }
    const ddAbs = peak - e;
    const ddPct = peak > 0 ? (ddAbs / peak) * 100 : 0;
    if (ddPct > maxPct) {
      maxPct = ddPct;
      maxAbs = ddAbs;
      mddPeak = peakIndex;
      mddTrough = i;
    }
  }

  return { maxDrawdownPct: maxPct, maxDrawdownAbs: maxAbs, peakIndex: mddPeak, troughIndex: mddTrough };
}

module.exports = { maxDrawdown };

// Trade diagnostics: enrich each backtest trade with entry-context features and
// MAE/MFE. All entry features use ONLY data known at entry fill time (i.e. up to
// the signal bar = entry bar index - 1). MAE/MFE use the holding price path
// (entry bar .. exit bar), which is realized, not look-ahead.

const { trueRange } = require('../strategies/indicators');

// EMA series (index i = EMA over values[0..i]), matches calcEMA seed semantics.
function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  out[period - 1] = seed / period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

// Wilder ATR series (index i = ATR over candles[0..i]).
function atrSeries(candles, period) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const trs = new Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i++) trs[i] = trueRange(candles, i);
  let seed = 0;
  for (let i = 1; i <= period; i++) seed += trs[i];
  out[period] = seed / period;
  for (let i = period + 1; i < candles.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + trs[i]) / period;
  }
  return out;
}

// Cross series: 1 = EMA9>EMA21, -1 = EMA9<EMA21, null = insufficient data.
function crossSeries(ema9, ema21) {
  const out = new Array(ema9.length).fill(null);
  for (let i = 0; i < ema9.length; i++) {
    if (ema9[i] !== null && ema21[i] !== null) out[i] = ema9[i] > ema21[i] ? 1 : -1;
  }
  return out;
}

// Number of crossovers (state changes) within [endIdx-windowBars+1, endIdx].
function countCrosses(cross, endIdx, windowBars) {
  let n = 0;
  const start = Math.max(1, endIdx - windowBars + 1);
  for (let i = start; i <= endIdx; i++) {
    if (cross[i] !== null && cross[i - 1] !== null && cross[i] !== cross[i - 1]) n++;
  }
  return n;
}

function precompute(candles) {
  const closes = candles.map((c) => c.close);
  const ema9 = emaSeries(closes, 9);
  const ema21 = emaSeries(closes, 21);
  const ema50 = emaSeries(closes, 50);
  const atr14 = atrSeries(candles, 14);
  const cross = crossSeries(ema9, ema21);
  return { candles, closes, ema9, ema21, ema50, atr14, cross };
}

// Volatility: std of per-bar close returns over the last `window` bars ending at endIdx.
function rollingReturnVolPct(closes, endIdx, window = 24) {
  const start = Math.max(1, endIdx - window + 1);
  const rets = [];
  for (let i = start; i <= endIdx; i++) {
    if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
  }
  if (rets.length < 2) return null;
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - mu) ** 2, 0) / rets.length;
  return Math.sqrt(v) * 100;
}

// Enrich trades with diagnostics. `indexOf` maps entryTime/exitTime -> bar index.
// Returns a new array of trade objects with extra fields.
function enrichTrades({ candles, trades, indexOf, pre }) {
  const P = pre || precompute(candles);
  return trades.map((t) => {
    const entryIdx = indexOf.get(t.entryTime);
    const exitIdx = indexOf.get(t.exitTime);
    const featIdx = Math.max(0, entryIdx - 1); // signal bar (data known at fill)

    const entryPrice = t.entryPrice;
    const grossReturnPct = entryPrice > 0 ? (t.exitPrice / entryPrice - 1) * 100 : null;
    const netReturnPct = t.returnPct;
    const costPct = grossReturnPct !== null && netReturnPct !== null ? grossReturnPct - netReturnPct : null;

    // MFE/MAE over the holding path (entry bar .. exit bar)
    let mfe = 0;
    let mae = 0;
    for (let i = Math.max(0, entryIdx); i <= Math.min(exitIdx, candles.length - 1); i++) {
      const hp = (candles[i].high / entryPrice - 1) * 100;
      const lp = (candles[i].low / entryPrice - 1) * 100;
      if (hp > mfe) mfe = hp;
      if (lp < mae) mae = lp;
    }

    const closeFeat = candles[featIdx] ? candles[featIdx].close : null;
    const ema9e = P.ema9[featIdx];
    const ema21e = P.ema21[featIdx];
    const ema50e = P.ema50[featIdx];
    const emaSpreadPct = closeFeat && ema9e !== null && ema21e !== null ? ((ema9e - ema21e) / closeFeat) * 100 : null;
    const ema50Prev = P.ema50[featIdx - 1];
    const ema50SlopePct = ema50e !== null && ema50Prev !== null && ema50Prev !== 0 ? ((ema50e - ema50Prev) / ema50Prev) * 100 : null;
    const ema50SlopeSign = ema50SlopePct === null ? null : ema50SlopePct > 0 ? 1 : -1;

    const atrE = P.atr14[featIdx];
    const atrPct = atrE && closeFeat ? (atrE / closeFeat) * 100 : null;
    const entryVolatilityPct = rollingReturnVolPct(P.closes, featIdx);

    const idx24 = featIdx - 96;
    const idx72 = featIdx - 288;
    const prev24hReturnPct = idx24 >= 0 && P.closes[idx24] > 0 ? (P.closes[featIdx] / P.closes[idx24] - 1) * 100 : null;
    const prev72hReturnPct = idx72 >= 0 && P.closes[idx72] > 0 ? (P.closes[featIdx] / P.closes[idx72] - 1) * 100 : null;

    const entryVolume = candles[featIdx] ? candles[featIdx].volume : null;
    const volStart = Math.max(0, featIdx - 96);
    let volSum = 0;
    for (let i = volStart; i < featIdx; i++) volSum += candles[i].volume;
    const denom = featIdx - volStart;
    const avgVol = denom > 0 ? volSum / denom : null;
    const volumeRatio = avgVol && avgVol > 0 && entryVolume !== null ? entryVolume / avgVol : null;

    return {
      ...t,
      entryIdx,
      exitIdx,
      entrySignalClose: closeFeat,
      grossReturnPct,
      netReturnPct,
      costPct,
      mfe,
      mae,
      ema9: ema9e,
      ema21: ema21e,
      ema50: ema50e,
      emaSpreadPct,
      ema50SlopePct,
      ema50SlopeSign,
      atrPct,
      entryVolatilityPct,
      prev24hReturnPct,
      prev72hReturnPct,
      entryVolume,
      volumeRatio,
      crossesLast24h: countCrosses(P.cross, featIdx, 96),
      crossesLast72h: countCrosses(P.cross, featIdx, 288),
    };
  });
}

module.exports = { precompute, enrichTrades, emaSeries, atrSeries, crossSeries, countCrosses };

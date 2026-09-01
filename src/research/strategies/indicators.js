// Shared technical indicators for research strategies and diagnostics.
// The EMA/RSI formulas are verbatim copies of the live strategy implementations
// (src/strategy/emaCrossover.js / rsiEma.js) so research signals stay identical.

// EMA — identical to src/strategy/emaCrossover.js calcEMA.
function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

// RSI (simple SMA-based) — identical to src/strategy/rsiEma.js calcRSI.
function calcRSI(prices, period) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function trueRange(candles, i) {
  const h = candles[i].high;
  const l = candles[i].low;
  const pc = candles[i - 1].close;
  return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
}

// Wilder ATR over candles[0..endIdx] (inclusive). Uses only data at/before endIdx.
function calcATR(candles, period, endIdx) {
  if (endIdx < 1 || endIdx - 1 + 1 < period) return null;
  const trs = [];
  for (let i = 1; i <= endIdx; i++) trs.push(trueRange(candles, i));
  if (trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

// EMA50 slope at endIdx: ema50(endIdx) vs ema50(endIdx-1).
// Returns { sign: 1 | -1 | 0, pct } (null when insufficient data).
function ema50Slope(candles, endIdx) {
  if (endIdx < 51) return null;
  const closesEnd = candles.slice(0, endIdx + 1).map((c) => c.close);
  const closesPrev = candles.slice(0, endIdx).map((c) => c.close);
  const now = calcEMA(closesEnd, 50);
  const prev = calcEMA(closesPrev, 50);
  if (now === null || prev === null || prev === 0) return null;
  const pct = ((now - prev) / prev) * 100;
  return { sign: pct > 0 ? 1 : pct < 0 ? -1 : 0, pct };
}

// Incremental Wilder ATR tracker for use inside strategy computeSignal loops.
// push(candle) -> current ATR (or null until enough history). Matches calcATR.
function createATRTracker(period = 14) {
  return {
    period,
    lastClose: null,
    trs: [],
    atr: null,
    push(candle) {
      if (this.lastClose === null) {
        this.lastClose = candle.close;
        return null;
      }
      const h = candle.high;
      const l = candle.low;
      const pc = this.lastClose;
      this.lastClose = candle.close;
      const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      this.trs.push(tr);
      if (this.trs.length < this.period) return null;
      if (this.trs.length === this.period) {
        this.atr = this.trs.reduce((a, b) => a + b, 0) / this.period;
      } else {
        this.atr = (this.atr * (this.period - 1) + tr) / this.period;
      }
      return this.atr;
    },
  };
}

module.exports = { calcEMA, calcRSI, calcATR, ema50Slope, trueRange, createATRTracker };

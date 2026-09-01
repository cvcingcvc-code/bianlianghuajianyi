// STRATEGY RESEARCH V2 — Candidate 3: EMA Trend Filter + Volatility (ATR) Filter.
//
// Pre-registered hypothesis (see docs/strategy-v2-hypotheses.md):
//   = Candidate 1 (emaTrendFilter) PLUS: block entries when entry ATR% is in the
//     High regime (DISCOVERY top quartile). DISCOVERY showed High-ATR entries
//     have the worst gross edge (-0.06% vs +0.01% for Low/Medium).
//   Entry  : Candidate-1 conditions AND atrPct < ATR_PCT_MAX.
//   Exit   : original EMA9/21 death cross, position open.
//
// ATR_PCT_MAX is pre-registered from the DISCOVERY distribution (Q3), not scanned.

const { calcEMA, createATRTracker } = require('./indicators');

const PRICE_BUFFER_SIZE = 60; // matches live emaCrossover
const ATR_PERIOD = 14;
const ATR_PCT_MAX = 0.629; // DISCOVERY atrPct Q3 (see reports/v2/volatility-regime-analysis.md)
const NAME = 'emaTrendVolFilter';

function name() { return NAME; }

function createState() {
  return { prices: [], lastCrossState: null, ema50Prev: null, atr: createATRTracker(ATR_PERIOD) };
}

function computeSignal(state, candle, opts = {}) {
  const close = candle.close;
  const hasPosition = !!opts.hasPosition;
  const warmup = !!opts.warmup;

  const atr = state.atr.push(candle);
  const atrPct = atr !== null && close > 0 ? (atr / close) * 100 : null;

  state.prices.push(close);
  if (state.prices.length > PRICE_BUFFER_SIZE) state.prices.shift();
  const prices = state.prices;
  if (prices.length < 50) return { action: 'HOLD', reason: null };

  const ema9 = calcEMA(prices, 9);
  const ema21 = calcEMA(prices, 21);
  const ema50 = calcEMA(prices, 50);
  if (ema9 === null || ema21 === null || ema50 === null) return { action: 'HOLD', reason: null };

  const currentCross = ema9 > ema21 ? 'above' : 'below';
  const previousCross = state.lastCrossState;
  state.lastCrossState = currentCross;

  const slopeUp = state.ema50Prev !== null && ema50 > state.ema50Prev;
  state.ema50Prev = ema50;

  if (warmup) return { action: 'HOLD', reason: null };

  if (previousCross === 'below' && currentCross === 'above') {
    if (!hasPosition && close > ema50 && slopeUp && atrPct !== null && atrPct < ATR_PCT_MAX) {
      return { action: 'LONG', reason: `golden cross + trend filter + atrPct<${ATR_PCT_MAX} (${atrPct.toFixed(3)}%)` };
    }
  } else if (previousCross === 'above' && currentCross === 'below') {
    if (hasPosition) {
      return { action: 'CLOSE', reason: 'death cross' };
    }
  }
  return { action: 'HOLD', reason: null };
}

module.exports = { name, createState, computeSignal, ATR_PCT_MAX, ATR_PERIOD };

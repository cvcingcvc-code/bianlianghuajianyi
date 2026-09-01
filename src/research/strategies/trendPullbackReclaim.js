// STRATEGY RESEARCH V3A — Candidate B: TREND_PULLBACK_RECLAIM.
//
// Pre-registered (docs/strategy-v3a-hypotheses.md):
//   Entry (only when flat): close > EMA50 AND EMA50 slope > 0 AND EMA9 > EMA21,
//     AND the previous candle closed at/below EMA9 while the current candle
//     closes back above EMA9 (pullback then reclaim). Fills at the next open.
//   Exit : original EMA9/21 death cross (identical to baseline).
//
// No ATR/RSI/volume thresholds are used. Only current + previous bar data.

const { calcEMA } = require('./indicators');

const PRICE_BUFFER_SIZE = 60; // matches live emaCrossover
const NAME = 'trendPullbackReclaim';

function name() { return NAME; }

function createState() {
  return { prices: [], lastCrossState: null, ema50Prev: null, prevClose: null, prevEma9: null };
}

function computeSignal(state, candle, opts = {}) {
  const close = candle.close;
  const hasPosition = !!opts.hasPosition;
  const warmup = !!opts.warmup;

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

  const prevClose = state.prevClose;
  const prevEma9 = state.prevEma9;
  state.prevClose = close;
  state.prevEma9 = ema9;
  state.ema50Prev = ema50;

  if (warmup) return { action: 'HOLD', reason: null };

  let action = 'HOLD';
  let reason = null;

  const pullbackReclaim = prevClose !== null && prevEma9 !== null && prevClose <= prevEma9 && close > ema9;

  if (!hasPosition && close > ema50 && slopeUp && ema9 > ema21 && pullbackReclaim) {
    action = 'LONG';
    reason = 'pullback reclaim in uptrend';
  } else if (previousCross === 'above' && currentCross === 'below') {
    if (hasPosition) {
      action = 'CLOSE';
      reason = 'death cross';
    }
  }

  return { action, reason };
}

module.exports = { name, createState, computeSignal };

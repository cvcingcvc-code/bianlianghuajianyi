// STRATEGY RESEARCH V2 — Candidate 1: EMA Trend Filter.
//
// Pre-registered hypothesis (see docs/strategy-v2-hypotheses.md):
//   Entry  : original EMA9/21 golden cross (below->above) AND close > EMA50
//            AND EMA50 slope > 0 (ema50_t > ema50_{t-1}), and no position.
//   Exit   : original EMA9/21 death cross (above->below), position open.
// Rationale: filter out counter-trend crossovers in bear/range regimes.
//
// Uses the SAME 60-bar price buffer and EMA formula as the live emaCrossover,
// so without the trend filter its signals are byte-identical to the baseline.

const { calcEMA } = require('./indicators');

const PRICE_BUFFER_SIZE = 60; // matches live emaCrossover
const NAME = 'emaTrendFilter';

function name() { return NAME; }

function createState() {
  return { prices: [], lastCrossState: null, ema50Prev: null };
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
  state.ema50Prev = ema50;

  if (warmup) return { action: 'HOLD', reason: null };

  if (previousCross === 'below' && currentCross === 'above') {
    if (!hasPosition && close > ema50 && slopeUp) {
      return { action: 'LONG', reason: 'golden cross + trend filter (close>EMA50 & EMA50 slope>0)' };
    }
  } else if (previousCross === 'above' && currentCross === 'below') {
    if (hasPosition) {
      return { action: 'CLOSE', reason: 'death cross' };
    }
  }
  return { action: 'HOLD', reason: null };
}

module.exports = { name, createState, computeSignal };

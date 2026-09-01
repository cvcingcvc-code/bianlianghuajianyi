// STRATEGY RESEARCH V2 — Candidate 2: EMA Trend Filter + Crossover Density Filter.
//
// Pre-registered hypothesis (see docs/strategy-v2-hypotheses.md):
//   = Candidate 1 (emaTrendFilter) PLUS: block a new LONG entry when too many
//     EMA9/21 crossovers happened in the prior 24h (whipsaw regime).
//   Entry  : Candidate-1 conditions AND crossesInPrior24h < DENSITY_MAX_CROSSES.
//   Exit   : original EMA9/21 death cross, position open.
//
// "crossesInPrior24h" counts crossovers strictly BEFORE the current bar's cross
// (the current golden cross is the trigger, not the whipsaw being filtered).
// Window and threshold are pre-registered, not scanned.

const { calcEMA } = require('./indicators');

const PRICE_BUFFER_SIZE = 60; // matches live emaCrossover
const NAME = 'emaTrendDensityFilter';
const DENSITY_WINDOW_MS = 24 * 3600 * 1000; // 24h
const DENSITY_MAX_CROSSES = 4; // block when >= 4 crosses in 24h (incl. current) — "too many crossovers"

function name() { return NAME; }

function createState() {
  return { prices: [], lastCrossState: null, ema50Prev: null, crossTimes: [] };
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

  // Record the crossover that happened at this bar (if any) BEFORE the entry
  // decision, so the density count includes the current cross — matching the
  // diagnostics definition of "crosses in the last 24h".
  if (previousCross !== null && previousCross !== currentCross) {
    state.crossTimes.push(candle.timestamp);
    state.crossTimes = state.crossTimes.filter((t) => t > candle.timestamp - 72 * 3600 * 1000);
  }

  if (warmup) return { action: 'HOLD', reason: null };

  let action = 'HOLD';
  let reason = null;

  if (previousCross === 'below' && currentCross === 'above') {
    if (!hasPosition && close > ema50 && slopeUp) {
      const in24h = state.crossTimes.filter((t) => t > candle.timestamp - DENSITY_WINDOW_MS).length;
      if (in24h < DENSITY_MAX_CROSSES) {
        action = 'LONG';
        reason = `golden cross + trend filter + density<${DENSITY_MAX_CROSSES} (24h=${in24h})`;      }
    }
  } else if (previousCross === 'above' && currentCross === 'below') {
    if (hasPosition) {
      action = 'CLOSE';
      reason = 'death cross';
    }
  }

  return { action, reason };
}

module.exports = { name, createState, computeSignal, DENSITY_WINDOW_MS, DENSITY_MAX_CROSSES };

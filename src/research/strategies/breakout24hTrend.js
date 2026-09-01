// STRATEGY RESEARCH V3A — Candidate C: 24H_BREAKOUT_TREND.
//
// Pre-registered (docs/strategy-v3a-hypotheses.md):
//   Entry (only when flat): close > EMA50 AND EMA50 slope > 0 AND
//     close > max(high[t-96 .. t-1])  (the previous 96 completed 15m candles'
//     highest high — the CURRENT candle's high is excluded). Fills at next open.
//   Exit : original EMA9/21 death cross (identical to baseline).
//
// 96 bars = 15m x 96 = 24 hours, pre-registered. No window scanning.

const { calcEMA } = require('./indicators');

const PRICE_BUFFER_SIZE = 60; // matches live emaCrossover
const HIGH_BUFFER_SIZE = 120; // holds enough prior highs for the 96-bar window
const BREAKOUT_WINDOW = 96; // 24h at 15m
const NAME = 'breakout24hTrend';

function name() { return NAME; }

function createState() {
  return { prices: [], highs: [], lastCrossState: null, ema50Prev: null };
}

function computeSignal(state, candle, opts = {}) {
  const close = candle.close;
  const hasPosition = !!opts.hasPosition;
  const warmup = !!opts.warmup;

  // previous 24h high = max of the 96 completed highs BEFORE this candle
  const priorHighs = state.highs;
  const prev24hHigh = priorHighs.length > 0 ? Math.max(...priorHighs.slice(-BREAKOUT_WINDOW)) : null;
  state.highs.push(candle.high);
  if (state.highs.length > HIGH_BUFFER_SIZE) state.highs.shift();

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

  let action = 'HOLD';
  let reason = null;

  // warmup for the 96-bar window: need at least 96 prior completed highs
  if (priorHighs.length >= BREAKOUT_WINDOW) {
    if (!hasPosition && close > ema50 && slopeUp && prev24hHigh !== null && close > prev24hHigh) {
      action = 'LONG';
      reason = `24h breakout (close ${close.toFixed(2)} > prev24hHigh ${prev24hHigh.toFixed(2)})`;
    }
  }

  if (action === 'HOLD' && previousCross === 'above' && currentCross === 'below') {
    if (hasPosition) {
      action = 'CLOSE';
      reason = 'death cross';
    }
  }

  return { action, reason };
}

module.exports = { name, createState, computeSignal, BREAKOUT_WINDOW };

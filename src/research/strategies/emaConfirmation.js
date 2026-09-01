// STRATEGY RESEARCH V3A — Candidate A: EMA_CONFIRMATION.
//
// Pre-registered (docs/strategy-v3a-hypotheses.md):
//   Entry: on an EMA9 bullish crossover of EMA21, do NOT buy. Record the
//          crossover candle's high. Wait for the NEXT full candle; only if that
//          candle closes with EMA9 > EMA21 AND close > crossover-candle high,
//          emit LONG (fills at the following open).
//   Exit : original EMA9/21 death cross (identical to baseline emaCrossover).
//
// No look-ahead: the confirmation check uses only the confirmation candle's
// close and the (already known) crossover candle high.

const { calcEMA } = require('./indicators');

const PRICE_BUFFER_SIZE = 60; // matches live emaCrossover so cross sequence is identical
const NAME = 'emaConfirmation';

function name() { return NAME; }

function createState() {
  return { prices: [], lastCrossState: null, pendingConfirm: null };
}

function computeSignal(state, candle, opts = {}) {
  const close = candle.close;
  const hasPosition = !!opts.hasPosition;
  const warmup = !!opts.warmup;

  state.prices.push(close);
  if (state.prices.length > PRICE_BUFFER_SIZE) state.prices.shift();
  const prices = state.prices;
  if (prices.length < 21) return { action: 'HOLD', reason: null };

  const ema9 = calcEMA(prices, 9);
  const ema21 = calcEMA(prices, 21);
  if (ema9 === null || ema21 === null) return { action: 'HOLD', reason: null };

  const currentCross = ema9 > ema21 ? 'above' : 'below';
  const previousCross = state.lastCrossState;
  state.lastCrossState = currentCross;

  if (warmup) return { action: 'HOLD', reason: null };

  let action = 'HOLD';
  let reason = null;

  // Evaluate a pending confirmation on THIS (next) candle first.
  if (state.pendingConfirm) {
    if (!hasPosition && ema9 > ema21 && close > state.pendingConfirm.high) {
      action = 'LONG';
      reason = `EMA confirmation (close ${close.toFixed(2)} > crossover high ${state.pendingConfirm.high.toFixed(2)})`;
    }
    state.pendingConfirm = null;
  }

  // Detect crossovers with the same sequence as the baseline.
  if (previousCross === 'below' && currentCross === 'above') {
    // golden cross: record for confirmation, do NOT buy now
    state.pendingConfirm = { high: candle.high };
  } else if (previousCross === 'above' && currentCross === 'below') {
    state.pendingConfirm = null; // reversal voids any pending confirmation
    if (hasPosition) {
      action = 'CLOSE';
      reason = 'death cross';
    }
  }

  return { action, reason };
}

module.exports = { name, createState, computeSignal };

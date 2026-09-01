// Shared 24-calendar-hour breakout trend strategy factory (STRATEGY RESEARCH V4).
//
// The economic hypothesis is identical to the frozen V3A breakout24hTrend, but
// the lookback is expressed in calendar hours so it works on any timeframe:
//   previous24hHigh = max of the `windowBars` most recent COMPLETED bars' highs,
//   EXCLUDING the current candle. windowBars = 24h / barMs:
//     15m -> 96 bars, 1h -> 24 bars, 4h -> 6 bars.
//
// Entry (only when flat): close > EMA50 AND EMA50 slope > 0 AND
//   close > previous24hHigh. Fills at the NEXT bar open.
// Exit: original EMA9/21 death cross (same semantics on any timeframe).

const { calcEMA } = require('./indicators');

function createBreakout24h({ windowBars, name }) {
  const PRICE_BUFFER_SIZE = 60;
  const HIGH_BUFFER_SIZE = Math.max(windowBars + 24, 40);

  return {
    name: () => name,
    createState: () => ({ prices: [], highs: [], lastCrossState: null, ema50Prev: null }),
    computeSignal(state, candle, opts = {}) {
      const close = candle.close;
      const hasPosition = !!opts.hasPosition;
      const warmup = !!opts.warmup;

      const priorHighs = state.highs;
      const prevHigh = priorHighs.length > 0 ? Math.max(...priorHighs.slice(-windowBars)) : null;
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

      if (priorHighs.length >= windowBars) {
        if (!hasPosition && close > ema50 && slopeUp && prevHigh !== null && close > prevHigh) {
          action = 'LONG';
          reason = `24h breakout (close ${close.toFixed(2)} > prev24hHigh ${prevHigh.toFixed(2)})`;
        }
      }

      if (action === 'HOLD' && previousCross === 'above' && currentCross === 'below') {
        if (hasPosition) {
          action = 'CLOSE';
          reason = 'death cross';
        }
      }

      return { action, reason };
    },
  };
}

module.exports = { createBreakout24h };

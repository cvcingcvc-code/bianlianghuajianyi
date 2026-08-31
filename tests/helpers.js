// Shared test helpers (not a test file itself).

// Build an OHLCV candle array from a list of closes.
// `openFn` may override the open price per bar (used to test next-bar fills).
function makeCandles(closes, { start = Date.UTC(2024, 0, 1), interval = 900000, openFn = null } = {}) {
  return closes.map((close, i) => {
    const open = openFn ? openFn(i) : close;
    return {
      timestamp: start + i * interval,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volume: 1000,
    };
  });
}

// Stub strategy adapter for deterministic backtest tests.
// actionsByCall maps "computeSignal call index (1-based)" -> 'LONG' | 'CLOSE' | 'HOLD'.
function stubAdapter(name, actionsByCall = {}) {
  return {
    name,
    createState: () => ({ calls: 0 }),
    computeSignal: (state) => {
      state.calls++;
      return { action: actionsByCall[state.calls] || 'HOLD', reason: 'test' };
    },
  };
}

module.exports = { makeCandles, stubAdapter };

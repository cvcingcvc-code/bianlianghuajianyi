// breakout24h4h Live Strategy Adapter
// Wraps the frozen research candidate src/research/strategies/breakout24h4h.js
// into the live execution engine contract: { name, init, onTick, getStatus, createState, computeSignal }

const { DIRECTION } = require('../utils/constants');
const researchCandidate = require('../research/strategies/breakout24h4h');
const { createATRTracker } = require('../research/strategies/indicators');

const state = {
  symStates: {},
  atrTrackers: {},
};

function name() {
  return 'breakout24h4h';
}

function createState() {
  return researchCandidate.createState();
}

function computeSignal(symState, candle, opts = {}) {
  return researchCandidate.computeSignal(symState, candle, opts);
}

function init(config) {
  state.symStates = {};
  state.atrTrackers = {};
  const pairs = config.tradingPairs || ['BTCUSDT'];
  for (const sym of pairs) {
    state.symStates[sym] = createState();
    state.atrTrackers[sym] = createATRTracker(14);
  }
}

function onTick(kline, repo, eventBus, logger) {
  const { symbol, open, high, low, close, volume, isFinal, warmup, closeTime } = kline;
  if (!isFinal) return;

  if (!state.symStates[symbol]) {
    state.symStates[symbol] = createState();
    state.atrTrackers[symbol] = createATRTracker(14);
  }

  const symState = state.symStates[symbol];
  const tracker = state.atrTrackers[symbol];

  const candle = {
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume || 0),
    timestamp: closeTime || Date.now(),
  };

  // Keep ATR tracker in sync on finalized candle
  const currentAtr = tracker.push(candle);

  const hasPosition = repo && typeof repo.hasPosition === 'function' ? repo.hasPosition(symbol) : false;
  const { action, reason } = computeSignal(symState, candle, {
    hasPosition,
    warmup: !!warmup,
  });

  if (warmup) return;

  if (action === 'LONG') {
    logger?.signal?.(`24H BREAKOUT: ${symbol} @ ${close} (${reason})`);
    eventBus?.emit('strategySignal', {
      symbol,
      direction: DIRECTION.LONG,
      price: Number(close),
      reason,
      atr: currentAtr || null,
    });
  } else if (action === 'CLOSE') {
    logger?.signal?.(`DEATH CROSS EXIT: ${symbol} @ ${close} (${reason})`);
    eventBus?.emit('strategySignal', {
      symbol,
      direction: DIRECTION.CLOSE,
      price: Number(close),
      reason,
      atr: currentAtr || null,
    });
  }
}

function getStatus() {
  const status = {};
  for (const [sym, st] of Object.entries(state.symStates)) {
    const tracker = state.atrTrackers[sym];
    status[sym] = {
      pricesCount: st.prices ? st.prices.length : 0,
      highsCount: st.highs ? st.highs.length : 0,
      lastCrossState: st.lastCrossState || 'unknown',
      ema50Prev: st.ema50Prev !== null ? Number(st.ema50Prev.toFixed(2)) : null,
      currentAtr: tracker?.atr !== null && tracker?.atr !== undefined ? Number(tracker.atr.toFixed(2)) : null,
    };
  }
  return status;
}

module.exports = {
  name,
  init,
  onTick,
  getStatus,
  createState,
  computeSignal,
};

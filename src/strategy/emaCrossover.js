// EMA Crossover Strategy — 9/21 EMA Long-only MVP
const { DIRECTION } = require('../utils/constants');

const PRICE_BUFFER_SIZE = 60;
const state = { prices: {}, emaCache: {}, lastCrossState: {} };

function name() { return 'emaCrossover'; }

function init(config) {
  for (const symbol of config.tradingPairs) {
    state.prices[symbol] = [];
    state.lastCrossState[symbol] = null;
  }
}

// Create a fresh per-symbol strategy state (used by real-time onTick and backtest).
function createState() {
  return { prices: [], lastCrossState: null };
}

// Pure signal computation. `symState` is a per-symbol state object produced by
// createState() (mutated in place). Returns { action, reason } where action is
// one of 'LONG' | 'CLOSE' | 'HOLD'. Position gating is handled by the caller via
// opts.hasPosition. No look-ahead: only uses `close` and prior closes.
function computeSignal(symState, close, opts = {}) {
  const hasPosition = !!opts.hasPosition;
  const warmup = !!opts.warmup;

  symState.prices.push(close);
  if (symState.prices.length > PRICE_BUFFER_SIZE) symState.prices.shift();

  const prices = symState.prices;
  if (prices.length < 21) return { action: 'HOLD', reason: null };

  const fastEma = calcEMA(prices, 9);
  const slowEma = calcEMA(prices, 21);
  if (fastEma === null || slowEma === null) return { action: 'HOLD', reason: null };

  const currentCross = fastEma > slowEma ? 'above' : 'below';
  const previousCross = symState.lastCrossState;

  // Always track cross state, but only generate signals on live data
  symState.lastCrossState = currentCross;

  if (warmup) return { action: 'HOLD', reason: null };

  if (previousCross === 'below' && currentCross === 'above') {
    if (!hasPosition) {
      return { action: 'LONG', reason: 'EMA 9/21 golden cross' };
    }
  } else if (previousCross === 'above' && currentCross === 'below') {
    if (hasPosition) {
      return { action: 'CLOSE', reason: 'EMA 9/21 death cross' };
    }
  }
  return { action: 'HOLD', reason: null };
}

function onTick(kline, repo, eventBus, logger) {
  const { symbol, close, isFinal, warmup } = kline;
  if (!isFinal || !state.prices[symbol]) return;

  const symState = { prices: state.prices[symbol], lastCrossState: state.lastCrossState[symbol] };
  const { action, reason } = computeSignal(symState, close, {
    hasPosition: repo.hasPosition(symbol),
    warmup,
  });
  state.prices[symbol] = symState.prices;
  state.lastCrossState[symbol] = symState.lastCrossState;

  if (action === 'LONG') {
    logger.signal(`GOLDEN CROSS: ${symbol} @ ${close}`);
    eventBus.emit('strategySignal', { symbol, direction: DIRECTION.LONG, price: close, reason });
  } else if (action === 'CLOSE') {
    logger.signal(`DEATH CROSS: ${symbol} @ ${close}`);
    eventBus.emit('strategySignal', { symbol, direction: DIRECTION.CLOSE, price: close, reason });
  }
}

function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

function getStatus() {
  const s = {};
  for (const [sym, cs] of Object.entries(state.lastCrossState)) {
    s[sym] = { prices: state.prices[sym]?.length || 0, crossState: cs || 'unknown' };
  }
  return s;
}

module.exports = { name, init, onTick, getStatus, createState, computeSignal };

// RSI + EMA Trend Strategy — Long-only with momentum + trend confirmation
const { DIRECTION } = require('../utils/constants');

const PRICE_BUFFER_SIZE = 60;
const RSI_PERIOD = 14;
const EMA_FAST = 9;
const EMA_SLOW = 21;
const EMA_TREND = 50;

const state = { prices: {}, rsi: {}, emaFast: {}, emaSlow: {}, emaTrend: {}, lastSignal: {}, rsiPrev: {}, emaFastPrev: {}, emaSlowPrev: {} };

function name() { return 'rsiEma'; }

function init(config) {
  for (const symbol of config.tradingPairs) {
    state.prices[symbol] = [];
    state.rsi[symbol] = null;
    state.emaFast[symbol] = null;
    state.emaSlow[symbol] = null;
    state.emaTrend[symbol] = null;
    state.lastSignal[symbol] = null;
    state.rsiPrev[symbol] = null;
    state.emaFastPrev[symbol] = null;
    state.emaSlowPrev[symbol] = null;
  }
}

// Create a fresh per-symbol strategy state (used by real-time onTick and backtest).
function createState() {
  return {
    prices: [], rsi: null, emaFast: null, emaSlow: null, emaTrend: null,
    lastSignal: null, rsiPrev: null, emaFastPrev: null, emaSlowPrev: null,
  };
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
  if (prices.length < Math.max(RSI_PERIOD + 1, EMA_TREND + 1)) return { action: 'HOLD', reason: null };

  const rsi = calcRSI(prices, RSI_PERIOD);
  const emaFast = calcEMA(prices, EMA_FAST);
  const emaSlow = calcEMA(prices, EMA_SLOW);
  const emaTrend = calcEMA(prices, EMA_TREND);

  symState.rsi = rsi;
  symState.emaFast = emaFast;
  symState.emaSlow = emaSlow;
  symState.emaTrend = emaTrend;

  if (warmup) { trackState(symState, rsi, emaFast, emaSlow); return { action: 'HOLD', reason: null }; }

  const trendUp = close > emaTrend;
  const fastAboveSlow = emaFast > emaSlow;
  const rsiOversold = rsi < 35;
  const rsiRecovering = rsi > 40 && symState.rsiPrev !== null && symState.rsiPrev <= 40;
  const rsiWeakening = rsi < 60 && symState.rsiPrev !== null && symState.rsiPrev >= 60;

  let action = 'HOLD';
  let reason = null;

  // Entry: trend up + EMA golden cross + RSI recovering from oversold zone
  if (!hasPosition && trendUp && fastAboveSlow && rsiRecovering && rsi < 55) {
    action = 'LONG';
    reason = `RSI-EMA: RSI${rsi.toFixed(0)} cross>40 + EMA gold cross`;
    symState.lastSignal = 'LONG';
  }

  // Exit: EMA death cross OR RSI dropping from overbought
  if (hasPosition) {
    const emaDeathCross = !fastAboveSlow && symState.emaFastPrev !== null && symState.emaFastPrev > symState.emaSlowPrev;
    const rsiTakeProfit = rsiWeakening && rsi > 65;

    if (emaDeathCross || rsiTakeProfit) {
      action = 'CLOSE';
      reason = emaDeathCross ? 'EMA death cross' : `RSI${rsi.toFixed(0)} cross<60 (take profit)`;
      symState.lastSignal = 'CLOSE';
    }
  }

  trackState(symState, rsi, emaFast, emaSlow);
  return { action, reason };
}

function onTick(kline, repo, eventBus, logger) {
  const { symbol, close, isFinal, warmup } = kline;
  if (!isFinal || !state.prices[symbol]) return;

  const symState = {
    prices: state.prices[symbol],
    rsi: state.rsi[symbol],
    emaFast: state.emaFast[symbol],
    emaSlow: state.emaSlow[symbol],
    emaTrend: state.emaTrend[symbol],
    lastSignal: state.lastSignal[symbol],
    rsiPrev: state.rsiPrev[symbol],
    emaFastPrev: state.emaFastPrev[symbol],
    emaSlowPrev: state.emaSlowPrev[symbol],
  };

  const { action, reason } = computeSignal(symState, close, {
    hasPosition: repo.hasPosition(symbol),
    warmup,
  });

  state.prices[symbol] = symState.prices;
  state.rsi[symbol] = symState.rsi;
  state.emaFast[symbol] = symState.emaFast;
  state.emaSlow[symbol] = symState.emaSlow;
  state.emaTrend[symbol] = symState.emaTrend;
  state.lastSignal[symbol] = symState.lastSignal;
  state.rsiPrev[symbol] = symState.rsiPrev;
  state.emaFastPrev[symbol] = symState.emaFastPrev;
  state.emaSlowPrev[symbol] = symState.emaSlowPrev;

  if (action === 'LONG') {
    logger.signal(`RSI-EMA LONG: ${symbol} @ ${close} | RSI:${symState.rsi.toFixed(1)} EMA9:${symState.emaFast.toFixed(2)} EMA21:${symState.emaSlow.toFixed(2)}`);
    eventBus.emit('strategySignal', { symbol, direction: DIRECTION.LONG, price: close, reason });
  } else if (action === 'CLOSE') {
    logger.signal(`RSI-EMA CLOSE: ${symbol} @ ${close} | ${reason}`);
    eventBus.emit('strategySignal', { symbol, direction: DIRECTION.CLOSE, price: close, reason });
  }
}

function trackState(symState, rsi, emaFast, emaSlow) {
  symState.rsiPrev = rsi;
  symState.emaFastPrev = emaFast;
  symState.emaSlowPrev = emaSlow;
}

function calcRSI(prices, period) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
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
  for (const [sym, cs] of Object.entries(state.lastSignal)) {
    s[sym] = {
      prices: state.prices[sym]?.length || 0,
      rsi: state.rsi[sym]?.toFixed(1) || '—',
      emaFast: state.emaFast[sym]?.toFixed(2) || '—',
      emaSlow: state.emaSlow[sym]?.toFixed(2) || '—',
      lastSignal: cs || 'waiting',
    };
  }
  return s;
}

module.exports = { name, init, onTick, getStatus, createState, computeSignal };

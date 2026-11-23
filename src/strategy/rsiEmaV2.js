// RSI + EMA Trend Strategy V2 — Professional grade with Wilder's RMA RSI & 300-bar EMA convergence
const { DIRECTION } = require('../utils/constants');
const { createATRTracker } = require('../research/strategies/indicators');

const PRICE_BUFFER_SIZE = 300;
const RSI_PERIOD = 14;
const EMA_FAST = 9;
const EMA_SLOW = 21;
const EMA_TREND = 50;

const state = {
  prices: {},
  rsi: {},
  emaFast: {},
  emaSlow: {},
  emaTrend: {},
  lastSignal: {},
  rsiPrev: {},
  emaFastPrev: {},
  emaSlowPrev: {},
  emaFastPeriod: EMA_FAST,
  emaSlowPeriod: EMA_SLOW,
  atrTrackers: {},
};

function name() {
  return 'rsiEmaV2';
}

function init(config) {
  state.emaFastPeriod = config.emaFast || EMA_FAST;
  state.emaSlowPeriod = config.emaSlow || EMA_SLOW;
  state.atrTrackers = {};
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
    state.atrTrackers[symbol] = createATRTracker(14);
  }
}

// Create a fresh per-symbol strategy state
function createState() {
  return {
    prices: [],
    rsi: null,
    emaFast: null,
    emaSlow: null,
    emaTrend: null,
    lastSignal: null,
    rsiPrev: null,
    emaFastPrev: null,
    emaSlowPrev: null,
  };
}

// Pure signal computation using Wilder's RSI and expanded historical buffer
function computeSignal(symState, close, opts = {}) {
  const hasPosition = !!opts.hasPosition;
  const warmup = !!opts.warmup;
  const fastPeriod = opts.emaFast || EMA_FAST;
  const slowPeriod = opts.emaSlow || EMA_SLOW;
  const maxBuffer = Math.max(PRICE_BUFFER_SIZE, slowPeriod + 10);

  symState.prices.push(close);
  if (symState.prices.length > maxBuffer) symState.prices.shift();

  const prices = symState.prices;
  if (prices.length < Math.max(RSI_PERIOD + 1, EMA_TREND + 1, slowPeriod)) {
    return { action: 'HOLD', reason: null };
  }

  const rsi = calcWilderRSI(prices, RSI_PERIOD);
  const emaFast = calcEMA(prices, fastPeriod);
  const emaSlow = calcEMA(prices, slowPeriod);
  const emaTrend = calcEMA(prices, EMA_TREND);

  symState.rsi = rsi;
  symState.emaFast = emaFast;
  symState.emaSlow = emaSlow;
  symState.emaTrend = emaTrend;

  if (warmup || rsi === null || emaFast === null || emaSlow === null || emaTrend === null) {
    trackState(symState, rsi, emaFast, emaSlow);
    return { action: 'HOLD', reason: null };
  }

  const trendUp = close > emaTrend;
  const fastAboveSlow = emaFast > emaSlow;
  const rsiRecovering = rsi > 40 && symState.rsiPrev !== null && symState.rsiPrev <= 40;
  const rsiWeakening = rsi < 60 && symState.rsiPrev !== null && symState.rsiPrev >= 60;

  let action = 'HOLD';
  let reason = null;

  // Entry: trend up + EMA golden cross + RSI recovering from oversold zone
  if (!hasPosition && trendUp && fastAboveSlow && rsiRecovering && rsi < 55) {
    action = 'LONG';
    reason = `RSI-EMA-V2: WilderRSI${rsi.toFixed(1)} cross>40 + EMA gold cross`;
    symState.lastSignal = 'LONG';
  }

  // Exit: EMA death cross OR RSI dropping from overbought
  if (hasPosition) {
    const emaDeathCross = !fastAboveSlow && symState.emaFastPrev !== null && symState.emaFastPrev > symState.emaSlowPrev;
    const rsiTakeProfit = rsiWeakening;

    if (emaDeathCross || rsiTakeProfit) {
      action = 'CLOSE';
      reason = emaDeathCross ? 'EMA death cross' : `WilderRSI${rsi.toFixed(1)} cross<60 (take profit)`;
      symState.lastSignal = 'CLOSE';
    }
  }

  trackState(symState, rsi, emaFast, emaSlow);
  return { action, reason };
}

function onTick(kline, repo, eventBus, logger) {
  const { symbol, open, high, low, close, isFinal, warmup } = kline;
  if (!isFinal || !state.prices[symbol]) return;

  if (!state.atrTrackers[symbol]) {
    state.atrTrackers[symbol] = createATRTracker(14);
  }
  const atr = state.atrTrackers[symbol].push({
    open: Number(open || close),
    high: Number(high || close),
    low: Number(low || close),
    close: Number(close),
  });

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
    emaFast: state.emaFastPeriod,
    emaSlow: state.emaSlowPeriod,
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
    logger?.signal?.(`RSI-EMA-V2 LONG: ${symbol} @ ${close} | WilderRSI:${symState.rsi.toFixed(1)} EMA9:${symState.emaFast.toFixed(2)} EMA21:${symState.emaSlow.toFixed(2)}`);
    eventBus?.emit('strategySignal', {
      symbol,
      direction: DIRECTION.LONG,
      price: close,
      reason,
      atr: atr || null,
    });
  } else if (action === 'CLOSE') {
    logger?.signal?.(`RSI-EMA-V2 CLOSE: ${symbol} @ ${close} | ${reason}`);
    eventBus?.emit('strategySignal', {
      symbol,
      direction: DIRECTION.CLOSE,
      price: close,
      reason,
      atr: atr || null,
    });
  }
}

function trackState(symState, rsi, emaFast, emaSlow) {
  symState.rsiPrev = rsi;
  symState.emaFastPrev = emaFast;
  symState.emaSlowPrev = emaSlow;
}

// Standard Wilder's RMA smoothed RSI
function calcWilderRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let sumGain = 0;
  let sumLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) sumGain += diff;
    else sumLoss -= diff;
  }
  let avgGain = sumGain / period;
  let avgLoss = sumLoss / period;

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
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
      rsi: state.rsi[sym] !== null && state.rsi[sym] !== undefined ? state.rsi[sym].toFixed(1) : '—',
      emaFast: state.emaFast[sym] !== null && state.emaFast[sym] !== undefined ? state.emaFast[sym].toFixed(2) : '—',
      emaSlow: state.emaSlow[sym] !== null && state.emaSlow[sym] !== undefined ? state.emaSlow[sym].toFixed(2) : '—',
      atr: state.atrTrackers[sym]?.atr !== null && state.atrTrackers[sym]?.atr !== undefined ? state.atrTrackers[sym].atr.toFixed(2) : '—',
      lastSignal: cs || 'waiting',
    };
  }
  return s;
}

module.exports = {
  name,
  init,
  onTick,
  getStatus,
  createState,
  computeSignal,
  calcWilderRSI,
  calcEMA,
};

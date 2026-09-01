// Adapter that exposes strategies to the backtester through a uniform interface:
//
//   { name, createState(), computeSignal(state, candle, { hasPosition, warmup }) -> { action, reason } }
//
// The backtester always passes the FULL candle ({ open, high, low, close, volume,
// timestamp, index }). Legacy live strategies (src/strategy/*) only consume
// `.close`, so the adapter wraps them (passing candle.close). Research-only
// candidate strategies (src/research/strategies/*) consume the full candle.
//
// Both the real-time engine (via each live strategy's onTick) and the backtester
// call the SAME computeSignal for the legacy strategies, so live logic and
// backtest logic cannot drift apart.

const LIVE_STRATEGY_MODULES = {
  emaCrossover: () => require('../strategy/emaCrossover'),
  rsiEma: () => require('../strategy/rsiEma'),
};

// Research-only candidate strategies (STRATEGY RESEARCH V2 / V3A). They are NOT
// registered in the live strategy engine (src/strategy/engine.js).
const RESEARCH_STRATEGY_MODULES = {
  emaTrendFilter: () => require('./strategies/emaTrendFilter'),
  emaTrendDensityFilter: () => require('./strategies/emaTrendDensityFilter'),
  emaTrendVolFilter: () => require('./strategies/emaTrendVolFilter'),
  emaConfirmation: () => require('./strategies/emaConfirmation'),
  trendPullbackReclaim: () => require('./strategies/trendPullbackReclaim'),
  breakout24hTrend: () => require('./strategies/breakout24hTrend'),
};

const STRATEGY_MODULES = { ...LIVE_STRATEGY_MODULES, ...RESEARCH_STRATEGY_MODULES };

function listStrategies() {
  return Object.keys(STRATEGY_MODULES);
}

function listLiveStrategies() {
  return Object.keys(LIVE_STRATEGY_MODULES);
}

function listResearchStrategies() {
  return Object.keys(RESEARCH_STRATEGY_MODULES);
}

function isResearchStrategy(name) {
  return Object.prototype.hasOwnProperty.call(RESEARCH_STRATEGY_MODULES, name);
}

function isValidStrategy(name) {
  return Object.prototype.hasOwnProperty.call(STRATEGY_MODULES, name);
}

function loadStrategy(name) {
  const load = STRATEGY_MODULES[name];
  if (!load) {
    throw new Error(`Unknown strategy "${name}". Available strategies: ${listStrategies().join(', ')}`);
  }
  const strategy = load();
  if (typeof strategy.computeSignal !== 'function' || typeof strategy.createState !== 'function') {
    throw new Error(`Strategy "${name}" does not expose computeSignal/createState (research interface missing)`);
  }
  const isResearch = isResearchStrategy(name);
  return {
    name: strategy.name(),
    createState: () => strategy.createState(),
    // Legacy strategies consume `close` (a number); research candidates consume the full candle.
    computeSignal: isResearch
      ? (state, candle, opts) => strategy.computeSignal(state, candle, opts)
      : (state, candle, opts) => strategy.computeSignal(state, candle.close, opts),
    isResearch,
  };
}

module.exports = {
  loadStrategy,
  listStrategies,
  listLiveStrategies,
  listResearchStrategies,
  isResearchStrategy,
  isValidStrategy,
};

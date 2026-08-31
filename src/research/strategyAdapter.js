// Adapter that exposes the live strategies (src/strategy/*) to the backtester
// through a small, pure interface:
//
//   { name, createState(), computeSignal(state, close, { hasPosition, warmup }) -> { action, reason } }
//
// Both the real-time engine (via each strategy's onTick) and the backtester call
// the SAME computeSignal, so live logic and backtest logic cannot drift apart.

const STRATEGY_MODULES = {
  emaCrossover: () => require('../strategy/emaCrossover'),
  rsiEma: () => require('../strategy/rsiEma'),
};

function listStrategies() {
  return Object.keys(STRATEGY_MODULES);
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
  return {
    name: strategy.name(),
    createState: () => strategy.createState(),
    computeSignal: (state, close, opts) => strategy.computeSignal(state, close, opts),
  };
}

module.exports = { loadStrategy, listStrategies, isValidStrategy };

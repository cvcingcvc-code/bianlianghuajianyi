const strategy = require('../research/strategies/breakout24h4h');
const { signalContract } = require('./contracts');
class StrategyBridge {
  constructor() { this.states = new Map(); }
  evaluate(symbol, candle, options) {
    if (!this.states.has(symbol)) this.states.set(symbol, strategy.createState());
    const result = strategy.computeSignal(this.states.get(symbol), candle, options);
    return signalContract(symbol, result, candle);
  }
}
module.exports = { StrategyBridge };

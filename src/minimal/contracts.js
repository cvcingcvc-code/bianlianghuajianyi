const SYMBOLS = Object.freeze(['BTCUSDT', 'ETHUSDT']);
function assertSymbol(symbol) {
  if (!SYMBOLS.includes(symbol)) throw new Error('Unsupported symbol');
  return symbol;
}
function signalContract(symbol, result, candle) {
  assertSymbol(symbol);
  if (!['LONG', 'CLOSE', 'HOLD'].includes(result.action) || !Number.isFinite(candle.close) || candle.close <= 0 || !Number.isFinite(candle.closeTime)) throw new Error('Invalid technical signal');
  return Object.freeze({ symbol, direction: result.action, price: candle.close,
    strategy: 'breakout24h4h', reason: result.reason || 'No completed-bar setup', timestamp: candle.closeTime });
}
module.exports = { SYMBOLS, assertSymbol, signalContract };

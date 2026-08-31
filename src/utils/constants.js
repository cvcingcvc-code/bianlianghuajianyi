// Order side
const SIDE = Object.freeze({ BUY: 'BUY', SELL: 'SELL' });

// Position side
const POSITION_SIDE = Object.freeze({ LONG: 'LONG', SHORT: 'SHORT' });

// Order type
const ORDER_TYPE = Object.freeze({
  MARKET: 'MARKET',
  LIMIT: 'LIMIT',
  STOP_LOSS_LIMIT: 'STOP_LOSS_LIMIT',
  TAKE_PROFIT_LIMIT: 'TAKE_PROFIT_LIMIT',
});

// Margin type
const MARGIN_TYPE = Object.freeze({ ISOLATED: 'ISOLATED', CROSSED: 'CROSSED' });

// Signal direction
const DIRECTION = Object.freeze({ LONG: 'LONG', CLOSE: 'CLOSE' });

// Order status
const ORDER_STATUS = Object.freeze({
  NEW: 'NEW',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  CANCELED: 'CANCELED',
  EXPIRED: 'EXPIRED',
});

// Circuit breaker reasons
const BREAKER = Object.freeze({
  CONSECUTIVE_LOSS: 'consecutive_loss',
  API_ERROR: 'api_error',
  MANUAL: 'manual',
});

// Minimum notional value per trade (USD)
const MIN_NOTIONAL = 5.5;

// Margin ratio safety threshold (%)
const MIN_MARGIN_RATIO = 200;

module.exports = {
  SIDE,
  POSITION_SIDE,
  ORDER_TYPE,
  MARGIN_TYPE,
  DIRECTION,
  ORDER_STATUS,
  BREAKER,
  MIN_NOTIONAL,
  MIN_MARGIN_RATIO,
};

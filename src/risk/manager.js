const limits = require('./limits');
const breaker = require('./circuitBreaker');
const { DIRECTION } = require('../utils/constants');

let config, repo, eventBus, logger, positionTracker;
let tradingPaused = false;

function init(cfg, repository, bus, log, posTracker) {
  config = cfg;
  repo = repository;
  eventBus = bus;
  logger = log;
  positionTracker = posTracker;

  breaker.init(repo, eventBus, logger);
  eventBus.on('strategySignal', handleSignal);
  eventBus.on('tradingPaused', () => { tradingPaused = true; logger.warn('Trading PAUSED via Feishu'); });
  eventBus.on('tradingResumed', () => { tradingPaused = false; logger.info('Trading RESUMED via Feishu'); });
  logger.info('Risk Manager initialized');
}

function handleSignal(signal) {
  logger.signal(`Signal: ${signal.symbol} ${signal.direction} (${signal.reason})`);

  // 0. Trading paused — only allow CLOSE
  if (tradingPaused && signal.direction !== 'CLOSE') {
    reject(signal, 'Trading paused (Feishu)'); return;
  }

  // 1. Circuit breaker
  if (breaker.check(repo)) { reject(signal, 'Circuit breaker tripped'); return; }

  // 2. Daily loss cap
  if (signal.direction === DIRECTION.LONG && repo.isDailyLossCapExceeded(config.dailyLossCapPct)) {
    reject(signal, 'Daily loss cap exceeded');
    eventBus.emit('dailyLimitReached', { loss: repo.getDailyStats().realizedPnl, cap: config.dailyLossCapPct });
    return;
  }

  // 3. Max positions
  if (signal.direction === DIRECTION.LONG && repo.getPositionCount() >= config.maxOpenPositions) {
    reject(signal, `Max positions (${config.maxOpenPositions})`); return;
  }

  // 4. Duplicate
  if (signal.direction === DIRECTION.LONG && repo.hasPosition(signal.symbol)) {
    reject(signal, `Already have ${signal.symbol} position`); return;
  }

  // Close signal — verify we have the position
  if (signal.direction === DIRECTION.CLOSE) {
    if (!repo.hasPosition(signal.symbol)) { logger.warn(`Close signal for ${signal.symbol} but no position`); return; }
    const pos = repo.getPosition(signal.symbol);
    eventBus.emit('riskApproved', { signal, action: 'CLOSE', symbol: signal.symbol, quantity: pos.quantity, side: 'SELL' });
    logger.signal(`Close approved: ${signal.symbol}`);
    return;
  }

  const accountInfo = positionTracker.getAccountInfo();
  const balance = accountInfo ? accountInfo.totalWalletBalance : 0;
  const price = signal.price || 0;
  if (balance <= 0 || price <= 0) { reject(signal, 'Invalid balance/price'); return; }

  const { quantity, notional } = limits.calculatePositionSize(
    balance, config.positionSizePct, price, config.maxLeverage, config.maxNotionalPerTrade
  );

  if (!limits.checkMinNotional(quantity, price)) { reject(signal, 'Notional too small'); return; }

  const symbolInfo = positionTracker.getSymbolInfo(signal.symbol);
  const qty = limits.roundToLotSize(quantity, symbolInfo);
  if (qty <= 0) { reject(signal, 'Quantity zero after rounding'); return; }

  // 7. Margin ratio
  const openPositions = repo.getOpenPositions();
  const simulated = [...openPositions, { symbol: signal.symbol, entryPrice: price, quantity: qty, leverage: config.maxLeverage }];
  const ratio = limits.calculateMarginRatio(balance, simulated);
  if (ratio < 200) { reject(signal, `Margin ratio ${ratio.toFixed(1)}% < 200%`); return; }

  // 8. Stop-loss
  const slPrice = limits.roundPrice(limits.calculateStopLoss(price, config.stopLossPct, DIRECTION.LONG), symbolInfo);
  // 9. Take-profit
  const tpPrice = limits.roundPrice(limits.calculateTakeProfit(price, config.takeProfitPct, DIRECTION.LONG), symbolInfo);

  if (slPrice >= price) { reject(signal, 'SL above entry'); return; }
  if (tpPrice <= price) { reject(signal, 'TP below entry'); return; }
  const risk = price - slPrice;
  const reward = tpPrice - price;
  if (reward < risk) { reject(signal, `R:R < 1:1`); return; }

  logger.signal(`APPROVED: ${signal.symbol} LONG qty=${qty} sl=${slPrice} tp=${tpPrice}`);
  eventBus.emit('riskApproved', { signal, action: 'OPEN', symbol: signal.symbol, side: 'BUY', quantity: qty, leverage: config.maxLeverage, stopLossPrice: slPrice, takeProfitPrice: tpPrice, notional: qty * price });
}

function reject(signal, reason) {
  logger.warn(`REJECTED [${signal.symbol} ${signal.direction}]: ${reason}`);
  eventBus.emit('riskRejected', { signal, reason });
}

module.exports = { init };

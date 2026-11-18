const limits = require('./limits');
const breaker = require('./circuitBreaker');
const orderExecutor = require('../execution/orderExecutor');
const { DIRECTION, MIN_MARGIN_RATIO } = require('../utils/constants');

let config, repo, eventBus, logger, positionTracker;
let tradingPaused = false;
let lastSignalAt = {};

function init(cfg, repository, bus, log, posTracker) {
  config = cfg;
  repo = repository;
  eventBus = bus;
  logger = log;
  positionTracker = posTracker;
  tradingPaused = false;
  lastSignalAt = {};

  breaker.init(repo, eventBus, logger);
  eventBus.on('strategySignal', handleSignal);
  eventBus.on('tradingPaused', () => { tradingPaused = true; logger.warn('Trading PAUSED via Feishu'); });
  eventBus.on('tradingResumed', () => { tradingPaused = false; logger.info('Trading RESUMED via Feishu'); });
  logger.info('Risk Manager initialized');
}

function handleSignal(signal) {
  logger.signal(`Signal: ${signal.symbol} ${signal.direction} (${signal.reason})`);

  // 0. Trading paused — only allow CLOSE
  if (tradingPaused && signal.direction !== DIRECTION.CLOSE) {
    reject(signal, 'Trading paused (Feishu)'); return;
  }

  // 1. Circuit breaker (allow CLOSE even if breaker tripped so open risk can be exited)
  if (signal.direction !== DIRECTION.CLOSE && breaker.check(repo)) {
    reject(signal, 'Circuit breaker tripped'); return;
  }

  // 1.5 Prevent duplicate concurrent in-flight orders
  if (orderExecutor.isPending(signal.symbol)) {
    reject(signal, `Order already in-flight for ${signal.symbol}`); return;
  }

  // Close signal — verify we have the position
  if (signal.direction === DIRECTION.CLOSE) {
    if (!repo.hasPosition(signal.symbol)) { logger.warn(`Close signal for ${signal.symbol} but no position`); return; }
    const pos = repo.getPosition(signal.symbol);
    const closeSide = pos.side === 'SHORT' ? 'BUY' : 'SELL';
    eventBus.emit('riskApproved', { signal, action: 'CLOSE', symbol: signal.symbol, quantity: pos.quantity, side: closeSide });
    logger.signal(`Close approved: ${signal.symbol}`);
    return;
  }

  const isEntry = signal.direction === DIRECTION.LONG || signal.direction === DIRECTION.SHORT;
  if (!isEntry) {
    reject(signal, `Unsupported direction: ${signal.direction}`); return;
  }

  // 2. Signal cooldown enforcement
  const cooldownMs = (config.signalCooldownSeconds || 0) * 1000;
  const now = Date.now();
  if (cooldownMs > 0 && lastSignalAt[signal.symbol] && (now - lastSignalAt[signal.symbol] < cooldownMs)) {
    const remainSec = Math.ceil((cooldownMs - (now - lastSignalAt[signal.symbol])) / 1000);
    reject(signal, `Signal cooldown (${remainSec}s remaining)`);
    return;
  }

  // 3. Daily loss cap
  if (repo.isDailyLossCapExceeded(config.dailyLossCapPct)) {
    reject(signal, 'Daily loss cap exceeded');
    eventBus.emit('dailyLimitReached', { loss: repo.getDailyStats().realizedPnl, cap: config.dailyLossCapPct });
    return;
  }

  // 4. Max positions (open + pending in-flight)
  if ((repo.getPositionCount() + orderExecutor.getPendingCount()) >= config.maxOpenPositions) {
    reject(signal, `Max positions (${config.maxOpenPositions})`); return;
  }

  // 5. Duplicate position check
  if (repo.hasPosition(signal.symbol)) {
    reject(signal, `Already have ${signal.symbol} position`); return;
  }

  const accountInfo = positionTracker.getAccountInfo();
  const balance = accountInfo ? accountInfo.totalWalletBalance : 0;
  const price = signal.price || 0;
  if (balance <= 0 || price <= 0) { reject(signal, 'Invalid balance/price'); return; }

  const { quantity } = limits.calculatePositionSize(
    balance, config.positionSizePct, price, config.maxLeverage, config.maxNotionalPerTrade
  );

  if (!limits.checkMinNotional(quantity, price)) { reject(signal, 'Notional too small'); return; }

  const symbolInfo = positionTracker.getSymbolInfo(signal.symbol);
  const qty = limits.roundToLotSize(quantity, symbolInfo);
  if (qty <= 0) { reject(signal, 'Quantity zero after rounding'); return; }

  // 7. Margin ratio (using real-time markPrices when available)
  const openPositions = repo.getOpenPositions();
  const simulated = [...openPositions, { symbol: signal.symbol, entryPrice: price, quantity: qty, leverage: config.maxLeverage }];
  const markPrices = typeof positionTracker.getMarkPrices === 'function' ? positionTracker.getMarkPrices() : undefined;
  const ratio = limits.calculateMarginRatio(balance, simulated, markPrices);
  if (ratio < MIN_MARGIN_RATIO) { reject(signal, `Margin ratio ${ratio.toFixed(1)}% < ${MIN_MARGIN_RATIO}%`); return; }

  // 8 & 9. Stop-loss & Take-profit (symmetric LONG / SHORT)
  const isLong = signal.direction === DIRECTION.LONG;
  const slPrice = limits.roundPrice(limits.calculateStopLoss(price, config.stopLossPct, signal.direction), symbolInfo);
  const tpPrice = limits.roundPrice(limits.calculateTakeProfit(price, config.takeProfitPct, signal.direction), symbolInfo);

  if (isLong && slPrice >= price) { reject(signal, 'SL above entry'); return; }
  if (isLong && tpPrice <= price) { reject(signal, 'TP below entry'); return; }
  if (!isLong && slPrice <= price) { reject(signal, 'SL below entry for SHORT'); return; }
  if (!isLong && tpPrice >= price) { reject(signal, 'TP above entry for SHORT'); return; }

  const risk = Math.abs(price - slPrice);
  const reward = Math.abs(tpPrice - price);
  if (reward < risk) { reject(signal, 'R:R < 1:1'); return; }

  lastSignalAt[signal.symbol] = now;
  const orderSide = isLong ? 'BUY' : 'SELL';
  logger.signal(`APPROVED: ${signal.symbol} ${signal.direction} qty=${qty} sl=${slPrice} tp=${tpPrice}`);
  eventBus.emit('riskApproved', {
    signal, action: 'OPEN', symbol: signal.symbol, side: orderSide,
    quantity: qty, leverage: config.maxLeverage,
    stopLossPrice: slPrice, takeProfitPrice: tpPrice, notional: qty * price,
  });
}

function reject(signal, reason) {
  logger.warn(`REJECTED [${signal.symbol} ${signal.direction}]: ${reason}`);
  eventBus.emit('riskRejected', { signal, reason });
}

module.exports = { init, handleSignal };

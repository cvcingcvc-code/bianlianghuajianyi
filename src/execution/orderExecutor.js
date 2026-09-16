const { ORDER_TYPE, MARGIN_TYPE } = require('../utils/constants');
const breaker = require('../risk/circuitBreaker');
const sleep = require('../utils/sleep');

let binance, config, repo, eventBus, logger;

function init(cfg, bn, repository, bus, log) {
  // Legacy SDK order path cannot prove endpoint isolation; only simulation remains enabled.
  if (!cfg.dryRun) require('../exchange/LiveAdapter').denyLive();
  config = cfg; binance = bn; repo = repository; eventBus = bus; logger = log;
  eventBus.on('riskApproved', handleApproved);
  logger.info('Order Executor initialized');
}

async function handleApproved(data) {
  if (config.dryRun) { simulate(data); return; }
  require('../exchange/LiveAdapter').denyLive();
  if (data.action === 'CLOSE') await executeClose(data);
  else if (data.action === 'OPEN') await executeOpen(data);
}

function simulate(data) {
  if (data.action === 'CLOSE') {
    logger.trade(`[DRY RUN] Close ${data.symbol} qty=${data.quantity}`);
    repo.removePosition(data.symbol);
    eventBus.emit('positionClosed', { symbol: data.symbol, pnl: 0, pnlPct: 0, reason: 'strategy_close' });
    return;
  }
  const entryPrice = data.signal.price || 0;
  logger.trade(`[DRY RUN] Open ${data.symbol} LONG qty=${data.quantity} sl=${data.stopLossPrice} tp=${data.takeProfitPrice}`);
  repo.upsertPosition({ symbol: data.symbol, side: 'LONG', entryPrice, quantity: data.quantity, leverage: data.leverage, stopLossPrice: data.stopLossPrice, takeProfitPrice: data.takeProfitPrice });
  eventBus.emit('positionOpened', { symbol: data.symbol, side: 'LONG', quantity: data.quantity, entryPrice });
}

async function executeOpen(data, attempt = 0) {
  const { symbol, quantity, leverage, stopLossPrice, takeProfitPrice } = data;
  try {
    await binance.futuresLeverage(symbol, leverage);
    await binance.futuresMarginType(symbol, MARGIN_TYPE.ISOLATED);
    logger.trade(`BUY ${symbol} qty=${quantity}`);
    const order = await binance.futuresMarketBuy(symbol, quantity);

    // Protective orders
    const slResp = await binance.futuresOrder('SELL', symbol, quantity, false, ORDER_TYPE.STOP_LOSS_LIMIT, { stopPrice: stopLossPrice, price: stopLossPrice * 0.995 });
    logger.trade(`SL placed: ${symbol} @ ${stopLossPrice}`);
    const tpResp = await binance.futuresOrder('SELL', symbol, quantity, false, ORDER_TYPE.TAKE_PROFIT_LIMIT, { stopPrice: takeProfitPrice, price: takeProfitPrice * 0.995 });
    logger.trade(`TP placed: ${symbol} @ ${takeProfitPrice}`);

    const fillPrice = order.avgPrice ? parseFloat(order.avgPrice) : (data.signal.price || 0);
    repo.upsertPosition({ symbol, side: 'LONG', entryPrice: fillPrice, quantity, leverage, stopLossPrice, takeProfitPrice, stopLossOrderId: slResp.orderId, takeProfitOrderId: tpResp.orderId });

    eventBus.emit('positionOpened', { symbol, side: 'LONG', quantity, entryPrice: fillPrice, sl: stopLossPrice, tp: takeProfitPrice });
    breaker.resetApiErrors(repo);
  } catch (err) {
    logger.error(`Open failed (${attempt + 1}): ${symbol}`, err.message);
    breaker.trackApiError(repo, eventBus, logger);
    if (attempt < config.orderRetryAttempts - 1) {
      await sleep(500 * Math.pow(2, attempt));
      return executeOpen(data, attempt + 1);
    }
  }
}

async function executeClose(data) {
  const { symbol, quantity } = data;
  try {
    const pos = repo.getPosition(symbol);
    if (pos) {
      try { if (pos.stopLossOrderId) await binance.futuresCancel(symbol, pos.stopLossOrderId); } catch (e) {}
      try { if (pos.takeProfitOrderId) await binance.futuresCancel(symbol, pos.takeProfitOrderId); } catch (e) {}
    }

    logger.trade(`SELL ${symbol} qty=${quantity}`);
    const order = await binance.futuresMarketSell(symbol, quantity);

    const entryPrice = pos ? pos.entryPrice : 0;
    const exitPrice = order.avgPrice ? parseFloat(order.avgPrice) : 0;
    const pnl = (exitPrice - entryPrice) * quantity;
    const pnlPct = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;

    repo.updateDailyPnl(pnl, pnl > 0);
    repo.removePosition(symbol);
    eventBus.emit('positionClosed', { symbol, pnl, pnlPct, entryPrice, exitPrice, reason: 'strategy_close' });
  } catch (err) {
    logger.error(`Close failed: ${symbol}`, err.message);
    breaker.trackApiError(repo, eventBus, logger);
  }
}

module.exports = { init };

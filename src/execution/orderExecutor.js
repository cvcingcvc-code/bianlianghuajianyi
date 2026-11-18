const { ORDER_TYPE, MARGIN_TYPE, POSITION_SIDE } = require('../utils/constants');
const breaker = require('../risk/circuitBreaker');
const sleep = require('../utils/sleep');

let binance, config, repo, eventBus, logger;
const inFlightSymbols = new Set();

function init(cfg, bn, repository, bus, log) {
  config = cfg; binance = bn; repo = repository; eventBus = bus; logger = log;
  inFlightSymbols.clear();
  eventBus.on('riskApproved', handleApproved);
  logger.info('Order Executor initialized');
}

function isPending(symbol) {
  return inFlightSymbols.has(symbol);
}

function getPendingCount() {
  return inFlightSymbols.size;
}

async function handleApproved(data) {
  const { symbol } = data;
  if (inFlightSymbols.has(symbol)) {
    logger.warn(`Order already in-flight for ${symbol}, skipping duplicate ${data.action}`);
    return;
  }
  inFlightSymbols.add(symbol);
  try {
    if (config.dryRun) { simulate(data); return; }
    if (data.action === 'CLOSE') await executeClose(data);
    else if (data.action === 'OPEN') await executeOpen(data);
  } finally {
    inFlightSymbols.delete(symbol);
  }
}

function simulate(data) {
  if (data.action === 'CLOSE') {
    logger.trade(`[DRY RUN] Close ${data.symbol} qty=${data.quantity}`);
    repo.removePosition(data.symbol);
    eventBus.emit('positionClosed', { symbol: data.symbol, pnl: 0, pnlPct: 0, reason: data.reason || 'strategy_close' });
    return;
  }
  const posSide = data.side === 'SELL' ? POSITION_SIDE.SHORT : POSITION_SIDE.LONG;
  const entryPrice = data.signal?.price || 0;
  logger.trade(`[DRY RUN] Open ${data.symbol} ${posSide} qty=${data.quantity} sl=${data.stopLossPrice} tp=${data.takeProfitPrice}`);
  repo.upsertPosition({
    symbol: data.symbol,
    side: posSide,
    entryPrice,
    quantity: data.quantity,
    leverage: data.leverage,
    stopLossPrice: data.stopLossPrice,
    takeProfitPrice: data.takeProfitPrice,
  });
  eventBus.emit('positionOpened', { symbol: data.symbol, side: posSide, quantity: data.quantity, entryPrice });
}

async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 0; attempt < config.orderRetryAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      logger.error(`${label} failed (${attempt + 1}/${config.orderRetryAttempts})`, err.message);
      breaker.trackApiError(repo, eventBus, logger);
      if (attempt < config.orderRetryAttempts - 1) {
        await sleep(500 * Math.pow(2, attempt));
      }
    }
  }
  throw lastErr;
}

async function executeOpen(data) {
  const { symbol, side = 'BUY', quantity, leverage, stopLossPrice, takeProfitPrice } = data;
  const isLong = side === 'BUY';
  const posSide = isLong ? POSITION_SIDE.LONG : POSITION_SIDE.SHORT;
  const closeSide = isLong ? 'SELL' : 'BUY';

  // Phase 1: Leverage, isolated margin, and market entry (retry only if market order has NOT executed)
  let order;
  try {
    order = await withRetry(async () => {
      await binance.futuresLeverage(symbol, leverage);
      try {
        await binance.futuresMarginType(symbol, MARGIN_TYPE.ISOLATED);
      } catch (marginErr) {
        if (!String(marginErr?.message || '').includes('No need to change margin type')) {
          throw marginErr;
        }
      }
      logger.trade(`${side} ${symbol} qty=${quantity}`);
      return isLong
        ? await binance.futuresMarketBuy(symbol, quantity)
        : await binance.futuresMarketSell(symbol, quantity);
    }, `Entry ${symbol}`);
  } catch (entryErr) {
    return;
  }

  const fillPrice = order?.avgPrice ? parseFloat(order.avgPrice) : (data.signal?.price || 0);

  // Phase 2: Protective orders using 5-arg node-binance-api futuresOrder signature + STOP_MARKET
  let slResp = null;
  let tpResp = null;
  try {
    slResp = await withRetry(
      () => binance.futuresOrder(closeSide, symbol, quantity, false, {
        type: ORDER_TYPE.STOP_MARKET,
        stopPrice: stopLossPrice,
        reduceOnly: true,
        workingType: 'MARK_PRICE',
      }),
      `SL ${symbol}`
    );
    logger.trade(`SL placed: ${symbol} @ ${stopLossPrice}`);
  } catch (slErr) {
    logger.error(`CRITICAL: SL failed for ${symbol}, unwinding position immediately!`, slErr.message);
    try {
      if (isLong) await binance.futuresMarketSell(symbol, quantity, { reduceOnly: true });
      else await binance.futuresMarketBuy(symbol, quantity, { reduceOnly: true });
    } catch (unwindErr) {
      logger.error(`EMERGENCY UNWIND FAILED for ${symbol}! Manual intervention required!`, unwindErr.message);
    }
    return;
  }

  try {
    tpResp = await withRetry(
      () => binance.futuresOrder(closeSide, symbol, quantity, false, {
        type: ORDER_TYPE.TAKE_PROFIT_MARKET,
        stopPrice: takeProfitPrice,
        reduceOnly: true,
        workingType: 'MARK_PRICE',
      }),
      `TP ${symbol}`
    );
    logger.trade(`TP placed: ${symbol} @ ${takeProfitPrice}`);
  } catch (tpErr) {
    logger.warn(`TP failed for ${symbol} (position remains protected by SL)`, tpErr.message);
  }

  repo.upsertPosition({
    symbol,
    side: posSide,
    entryPrice: fillPrice,
    quantity,
    leverage,
    stopLossPrice,
    takeProfitPrice,
    stopLossOrderId: slResp?.orderId || null,
    takeProfitOrderId: tpResp?.orderId || null,
  });

  eventBus.emit('positionOpened', { symbol, side: posSide, quantity, entryPrice: fillPrice, sl: stopLossPrice, tp: takeProfitPrice });
  breaker.resetApiErrors(repo);
}

async function executeClose(data) {
  const { symbol, quantity, reason = 'strategy_close' } = data;
  try {
    const pos = repo.getPosition(symbol);
    const closeQty = quantity || pos?.quantity;
    if (!closeQty) return;
    const isShort = pos?.side === POSITION_SIDE.SHORT;

    if (pos) {
      try { if (pos.stopLossOrderId) await binance.futuresCancel(symbol, pos.stopLossOrderId); } catch (e) {}
      try { if (pos.takeProfitOrderId) await binance.futuresCancel(symbol, pos.takeProfitOrderId); } catch (e) {}
    }

    logger.trade(`CLOSE ${symbol} qty=${closeQty}`);
    const order = isShort
      ? await binance.futuresMarketBuy(symbol, closeQty, { reduceOnly: true })
      : await binance.futuresMarketSell(symbol, closeQty, { reduceOnly: true });

    const entryPrice = pos ? pos.entryPrice : 0;
    const exitPrice = order?.avgPrice ? parseFloat(order.avgPrice) : 0;
    const priceDiff = isShort ? (entryPrice - exitPrice) : (exitPrice - entryPrice);
    const pnl = entryPrice > 0 && exitPrice > 0 ? priceDiff * closeQty : 0;
    const pnlPct = entryPrice > 0 && exitPrice > 0 ? (priceDiff / entryPrice) * 100 : 0;

    repo.updateDailyPnl(pnl, pnl > 0);
    repo.removePosition(symbol);
    eventBus.emit('positionClosed', { symbol, pnl, pnlPct, entryPrice, exitPrice, reason });
  } catch (err) {
    logger.error(`Close failed: ${symbol}`, err.message);
    breaker.trackApiError(repo, eventBus, logger);
    throw err;
  }
}

async function closePosition(symbol, reason = 'manual_close') {
  const pos = repo.getPosition(symbol);
  if (!pos) throw new Error(`${symbol} 无持仓`);
  await handleApproved({ action: 'CLOSE', symbol, quantity: pos.quantity, reason });
}

module.exports = { init, isPending, getPendingCount, closePosition, handleApproved };

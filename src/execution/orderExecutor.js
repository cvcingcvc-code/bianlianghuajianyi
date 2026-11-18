const { ORDER_TYPE, MARGIN_TYPE, POSITION_SIDE } = require('../utils/constants');
const limits = require('../risk/limits');
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
  const { symbol, side = 'BUY', quantity, leverage, stopLossPrice, takeProfitPrice, symbolInfo } = data;
  const isLong = side === 'BUY';
  const posSide = isLong ? POSITION_SIDE.LONG : POSITION_SIDE.SHORT;
  const closeSide = isLong ? 'SELL' : 'BUY';
  const refPrice = Number(data.referencePrice || data.signal?.price || 0);
  const useSlippageLimit = Number(config.maxSlippage) > 0 && refPrice > 0;
  const limitPrice = useSlippageLimit
    ? limits.roundPrice(isLong ? refPrice * (1 + config.maxSlippage) : refPrice * (1 - config.maxSlippage), symbolInfo)
    : null;

  // Phase 1: Leverage, isolated margin, and entry order (LIMIT IOC when maxSlippage > 0, else MARKET)
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
      if (useSlippageLimit) {
        logger.trade(`${side} ${symbol} qty=${quantity} LIMIT IOC @ ${limitPrice} (maxSlippage=${(config.maxSlippage * 100).toFixed(2)}%)`);
        return await binance.futuresOrder(side, symbol, quantity, limitPrice, {
          type: ORDER_TYPE.LIMIT,
          timeInForce: 'IOC',
        });
      }
      logger.trade(`${side} ${symbol} qty=${quantity}`);
      return isLong
        ? await binance.futuresMarketBuy(symbol, quantity)
        : await binance.futuresMarketSell(symbol, quantity);
    }, `Entry ${symbol}`);
  } catch (entryErr) {
    return;
  }

  // Handle IOC zero-fill / partial-fill safely
  const rawExecutedQty = order?.executedQty !== undefined ? parseFloat(order.executedQty) : quantity;
  const orderStatus = order?.status || order?.orderStatus;
  if (!Number.isFinite(rawExecutedQty) || rawExecutedQty <= 0 || ((orderStatus === 'EXPIRED' || orderStatus === 'CANCELED') && !(rawExecutedQty > 0))) {
    logger.warn(`Slippage protection triggered for ${symbol}: IOC order @ ${limitPrice} had 0 fill (status=${orderStatus || 'EXPIRED'})`);
    eventBus.emit('slippageRejected', { symbol, side, referencePrice: refPrice, limitPrice });
    return;
  }
  const filledQty = rawExecutedQty;
  const fillPrice = (order?.avgPrice && parseFloat(order.avgPrice) > 0)
    ? parseFloat(order.avgPrice)
    : (limitPrice || refPrice);

  // Record entry commission if returned synchronously
  const entryCommission = parseFloat(order?.commission || 0);
  const entryCommAsset = order?.commissionAsset || 'USDT';
  if (entryCommission > 0 && entryCommAsset === 'USDT' && typeof repo.recordOrderExecution === 'function') {
    repo.recordOrderExecution({ orderId: order?.orderId, isClose: false, commission: entryCommission });
  }

  // Phase 2: Protective orders using 5-arg node-binance-api futuresOrder signature + STOP_MARKET
  let slResp = null;
  let tpResp = null;
  try {
    slResp = await withRetry(
      () => binance.futuresOrder(closeSide, symbol, filledQty, false, {
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
      if (isLong) await binance.futuresMarketSell(symbol, filledQty, { reduceOnly: true });
      else await binance.futuresMarketBuy(symbol, filledQty, { reduceOnly: true });
    } catch (unwindErr) {
      logger.error(`EMERGENCY UNWIND FAILED for ${symbol}! Manual intervention required!`, unwindErr.message);
    }
    return;
  }

  try {
    tpResp = await withRetry(
      () => binance.futuresOrder(closeSide, symbol, filledQty, false, {
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
    quantity: filledQty,
    leverage,
    stopLossPrice,
    takeProfitPrice,
    stopLossOrderId: slResp?.orderId || null,
    takeProfitOrderId: tpResp?.orderId || null,
  });

  eventBus.emit('positionOpened', { symbol, side: posSide, quantity: filledQty, entryPrice: fillPrice, sl: stopLossPrice, tp: takeProfitPrice });
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
    const estimatedGross = entryPrice > 0 && exitPrice > 0 ? priceDiff * closeQty : 0;
    const rawRealized = parseFloat(order?.realizedProfit ?? order?.cumPnl ?? NaN);
    const grossPnl = Number.isFinite(rawRealized) ? rawRealized : estimatedGross;
    const commAsset = order?.commissionAsset || 'USDT';
    const commission = commAsset === 'USDT' ? (parseFloat(order?.commission || 0) || 0) : 0;

    let netPnl = grossPnl - commission;
    if (typeof repo.recordOrderExecution === 'function') {
      const settlement = repo.recordOrderExecution({
        orderId: order?.orderId,
        isClose: true,
        grossPnl,
        commission,
      });
      netPnl = settlement.netPnl;
    } else {
      repo.updateDailyPnl(netPnl, netPnl > 0);
    }

    const notionalEntry = entryPrice * closeQty;
    const pnlPct = notionalEntry > 0 ? (netPnl / notionalEntry) * 100 : 0;

    repo.removePosition(symbol);
    eventBus.emit('positionClosed', { symbol, pnl: netPnl, grossPnl, commission, pnlPct, entryPrice, exitPrice, reason });
  } catch (err) {
    logger.error(`Close failed: ${symbol}`, err.message);
    breaker.trackApiError(repo, eventBus, logger);
    throw err;
  }
}

async function ensureStopLoss(pos, stopLossPrice) {
  if (!pos || !pos.symbol || !(pos.quantity > 0) || !(stopLossPrice > 0)) {
    throw new Error('Invalid position or stopLossPrice for SL repair');
  }
  if (config?.dryRun) {
    repo.upsertPosition({ symbol: pos.symbol, stopLossPrice, stopLossOrderId: `DRY_SL_${Date.now()}` });
    return { orderId: `DRY_SL_${Date.now()}` };
  }
  const closeSide = pos.side === POSITION_SIDE.SHORT ? 'BUY' : 'SELL';
  const slResp = await withRetry(
    () => binance.futuresOrder(closeSide, pos.symbol, pos.quantity, false, {
      type: ORDER_TYPE.STOP_MARKET,
      stopPrice: stopLossPrice,
      reduceOnly: true,
      workingType: 'MARK_PRICE',
    }),
    `Repair SL ${pos.symbol}`
  );
  repo.upsertPosition({
    symbol: pos.symbol,
    stopLossPrice,
    stopLossOrderId: slResp?.orderId || null,
  });
  logger.trade(`Repaired missing SL: ${pos.symbol} @ ${stopLossPrice} (orderId=${slResp?.orderId || 'n/a'})`);
  return slResp;
}

async function closePosition(symbol, reason = 'manual_close') {
  const pos = repo.getPosition(symbol);
  if (!pos) throw new Error(`${symbol} 无持仓`);
  await handleApproved({ action: 'CLOSE', symbol, quantity: pos.quantity, reason });
}

module.exports = { init, isPending, getPendingCount, closePosition, ensureStopLoss, handleApproved };

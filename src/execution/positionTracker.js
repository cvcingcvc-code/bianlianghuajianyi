const { POSITION_SIDE } = require('../utils/constants');
const limits = require('../risk/limits');

const SL_ORDER_TYPES = new Set(['STOP_MARKET', 'STOP', 'STOP_LOSS_LIMIT']);
const TP_ORDER_TYPES = new Set(['TAKE_PROFIT_MARKET', 'TAKE_PROFIT', 'TAKE_PROFIT_LIMIT']);
const ACTIVE_ORDER_STATUSES = new Set(['NEW', 'PARTIALLY_FILLED']);

let binance, repo, eventBus, logger, config, orderExecutor;
let accountInfo = null;
let symbolInfoCache = {};
let markPricesCache = {};
let reconcileTimer = null;
let reconciling = false;

function init(bn, repository, bus, log, cfg = null, executor = null) {
  binance = bn;
  repo = repository;
  eventBus = bus;
  logger = log;
  config = cfg;
  orderExecutor = executor;
  markPricesCache = {};

  eventBus.on('markPrice', (d) => {
    if (d && d.symbol && Number.isFinite(d.markPrice)) {
      markPricesCache[d.symbol] = d.markPrice;
    }
  });
  eventBus.on('orderUpdate', handleOrderUpdate);
  eventBus.on('accountUpdate', handleAccountUpdate);
  eventBus.on('positionUpdate', handlePositionUpdate);
  eventBus.on('wsReconnected', () => {
    if (config?.dryRun) return;
    logger.info('WS reconnected — triggering full account & order reconciliation...');
    reconcilePositions({ repairMissingStopLoss: true }).catch((err) => {
      logger.warn(`Post-reconnect reconciliation failed: ${err.message}`);
    });
  });
}

function matchProtectiveOrders(symbol, posSide, openOrders = []) {
  const expectedCloseSide = posSide === POSITION_SIDE.SHORT ? 'BUY' : 'SELL';
  let slOrder = null;
  let tpOrder = null;

  for (const o of openOrders) {
    if (!o || o.symbol !== symbol) continue;
    if (o.status && !ACTIVE_ORDER_STATUSES.has(o.status)) continue;
    if (o.side && o.side !== expectedCloseSide) continue;
    const oType = o.type || o.origType || '';
    if (!slOrder && SL_ORDER_TYPES.has(oType)) {
      slOrder = o;
    } else if (!tpOrder && TP_ORDER_TYPES.has(oType)) {
      tpOrder = o;
    }
  }
  return { slOrder, tpOrder };
}

async function fetchOpenOrdersSafe() {
  if (!binance || typeof binance.futuresOpenOrders !== 'function') {
    return null; // API not provided (e.g. partial test mock)
  }
  const orders = await binance.futuresOpenOrders();
  return Array.isArray(orders) ? orders : [];
}

function handleAccountUpdate(data) {
  if (!data) return;

  // 1. Direct REST-style account payload
  if (data.totalWalletBalance !== undefined) {
    accountInfo = {
      totalWalletBalance: parseFloat(data.totalWalletBalance),
      availableBalance: parseFloat(data.availableBalance ?? data.totalWalletBalance),
      totalUnrealizedProfit: parseFloat(data.totalUnrealizedProfit || 0),
      totalMarginBalance: parseFloat(data.totalMarginBalance ?? data.totalWalletBalance),
    };
  }

  // 2. WebSocket ACCOUNT_UPDATE (node-binance-api parsed `updateData` or raw `a`)
  const updateData = data.updateData || data.a;
  if (!updateData) return;

  const balances = updateData.balances || updateData.B || [];
  const usdt = balances.find((b) => (b.asset || b.a) === 'USDT');
  if (usdt) {
    const wb = parseFloat(usdt.walletBalance ?? usdt.wb ?? 0);
    const cw = parseFloat(usdt.crossWalletBalance ?? usdt.cw ?? wb);
    accountInfo = {
      totalWalletBalance: wb,
      availableBalance: cw,
      totalUnrealizedProfit: accountInfo?.totalUnrealizedProfit || 0,
      totalMarginBalance: wb + (accountInfo?.totalUnrealizedProfit || 0),
    };
    if (typeof repo.updateCurrentBalance === 'function') {
      repo.updateCurrentBalance(wb);
    } else {
      repo.getDailyStats().currentBalance = wb;
    }
  }

  const positions = updateData.positions || updateData.P || [];
  for (const p of positions) {
    handlePositionUpdate({
      symbol: p.symbol || p.s,
      positionAmt: p.positionAmount ?? p.positionAmt ?? p.pa,
      entryPrice: p.entryPrice ?? p.ep,
      unRealizedProfit: p.unrealizedPnL ?? p.unRealizedProfit ?? p.up,
      leverage: p.leverage,
    });
  }
}

function handlePositionUpdate(data) {
  if (!data || !data.symbol) return;
  const amt = parseFloat(data.positionAmt);
  if (!Number.isFinite(amt)) return;

  if (Math.abs(amt) > 0) {
    const update = {
      symbol: data.symbol,
      side: amt > 0 ? POSITION_SIDE.LONG : POSITION_SIDE.SHORT,
      quantity: Math.abs(amt),
    };
    if (data.entryPrice !== undefined) update.entryPrice = parseFloat(data.entryPrice);
    if (data.leverage !== undefined) update.leverage = parseFloat(data.leverage);
    if (data.unRealizedProfit !== undefined) update.unrealizedPnl = parseFloat(data.unRealizedProfit || 0);
    repo.upsertPosition(update);
  } else if (repo.hasPosition(data.symbol)) {
    repo.removePosition(data.symbol);
    eventBus.emit('positionClosed', { symbol: data.symbol, pnl: 0, pnlPct: 0, reason: 'exchange_sync_closed' });
  }
}

function handleOrderUpdate(data) {
  if (!data) return;
  const o = data.order || data.o || data;
  const status = o.orderStatus ?? o.X;
  const orderType = o.origType ?? o.originalOrderType ?? o.ot ?? o.type ?? o.o ?? 'MARKET';
  const symbol = o.symbol ?? o.s;
  if (status !== 'FILLED' || !symbol) return;

  const orderId = o.orderId ?? o.i;
  const avgPrice = parseFloat(o.avgPrice ?? o.averagePrice ?? o.ap ?? o.price ?? o.p ?? 0);
  const executedQty = parseFloat(o.executedQty ?? o.orderFilledAccumulatedQuantity ?? o.z ?? o.origQty ?? o.q ?? 0);
  const rawRealizedProfit = parseFloat(o.realizedProfit ?? o.rp ?? NaN);
  const rawCommission = parseFloat(o.commission ?? o.n ?? 0) || 0;
  const commissionAsset = o.commissionAsset ?? o.N ?? 'USDT';
  const usdtCommission = commissionAsset === 'USDT' ? rawCommission : 0;
  const isReduceOnly = Boolean(o.reduceOnly ?? o.R ?? o.closePosition ?? o.cp);
  const isProtectiveTrigger = SL_ORDER_TYPES.has(orderType) || TP_ORDER_TYPES.has(orderType);
  const hasNonZeroRealized = Number.isFinite(rawRealizedProfit) && rawRealizedProfit !== 0;
  const isCloseOrder = isReduceOnly || isProtectiveTrigger || hasNonZeroRealized;

  logger.trade(`Order filled: ${symbol} ${o.side || o.S} ${executedQty} @ ${avgPrice} (fee=${rawCommission} ${commissionAsset})`);
  repo.saveTrade({
    orderId,
    symbol,
    side: o.side ?? o.S,
    quantity: parseFloat(o.origQty ?? o.originalQuantity ?? o.q ?? executedQty),
    price: avgPrice,
    executedQty,
    commission: String(rawCommission),
    time: o.orderTradeTime ?? o.time ?? o.T ?? Date.now(),
    orderType,
  });

  if (isCloseOrder) {
    const pos = repo.getPosition(symbol);
    const fallbackGross = pos
      ? ((pos.side === POSITION_SIDE.SHORT ? pos.entryPrice - avgPrice : avgPrice - pos.entryPrice) * executedQty)
      : 0;
    const grossPnl = Number.isFinite(rawRealizedProfit) ? rawRealizedProfit : fallbackGross;

    let netPnl = grossPnl - usdtCommission;
    if (typeof repo.recordOrderExecution === 'function') {
      const settlement = repo.recordOrderExecution({
        orderId,
        isClose: true,
        grossPnl,
        commission: usdtCommission,
      });
      netPnl = settlement.netPnl;
    } else if (isProtectiveTrigger && pos) {
      repo.updateDailyPnl(netPnl, netPnl > 0);
    }

    if (isProtectiveTrigger && pos) {
      const notional = pos.entryPrice * executedQty;
      const pnlPct = notional > 0 ? (netPnl / notional) * 100 : 0;
      repo.removePosition(symbol);
      const reason = SL_ORDER_TYPES.has(orderType) ? 'stop_loss_triggered' : 'take_profit_triggered';
      eventBus.emit('positionClosed', {
        symbol,
        pnl: netPnl,
        grossPnl,
        commission: usdtCommission,
        pnlPct,
        entryPrice: pos.entryPrice,
        exitPrice: avgPrice,
        reason,
      });
    }
  } else if (usdtCommission > 0 && typeof repo.recordOrderExecution === 'function') {
    repo.recordOrderExecution({ orderId, isClose: false, commission: usdtCommission });
  }

  eventBus.emit('orderExecuted', o);
}

async function syncAccount({ preserveStartBalance = false } = {}) {
  try {
    logger.info('Syncing account...');
    const account = await binance.futuresAccount();
    accountInfo = {
      totalWalletBalance: parseFloat(account.totalWalletBalance),
      availableBalance: parseFloat(account.availableBalance),
      totalUnrealizedProfit: parseFloat(account.totalUnrealizedProfit || 0),
      totalMarginBalance: parseFloat(account.totalMarginBalance),
    };
    const stats = repo.getDailyStats();
    if (!preserveStartBalance && stats.startBalance <= 0) {
      repo.setStartBalance(accountInfo.totalWalletBalance);
    } else if (typeof repo.updateCurrentBalance === 'function') {
      repo.updateCurrentBalance(accountInfo.totalWalletBalance);
    } else {
      repo.setStartBalance(accountInfo.totalWalletBalance);
    }
    logger.info(`Balance: ${accountInfo.totalWalletBalance.toFixed(2)} USDT`);

    const [positions, openOrders] = await Promise.all([
      binance.futuresPositionRisk(),
      fetchOpenOrdersSafe(),
    ]);

    const activeExchangeSymbols = new Set();
    for (const p of positions) {
      const rawAmt = parseFloat(p.positionAmt);
      const amt = Math.abs(rawAmt);
      if (amt > 0) {
        const posSide = rawAmt > 0 ? POSITION_SIDE.LONG : POSITION_SIDE.SHORT;
        activeExchangeSymbols.add(p.symbol);
        const posPatch = {
          symbol: p.symbol,
          side: posSide,
          entryPrice: parseFloat(p.entryPrice),
          quantity: amt,
          leverage: parseFloat(p.leverage),
        };
        if (openOrders !== null) {
          const { slOrder, tpOrder } = matchProtectiveOrders(p.symbol, posSide, openOrders);
          posPatch.stopLossOrderId = slOrder ? slOrder.orderId : null;
          if (slOrder) {
            const slStop = parseFloat(slOrder.stopPrice || slOrder.price || 0);
            if (slStop > 0) posPatch.stopLossPrice = slStop;
          }
          posPatch.takeProfitOrderId = tpOrder ? tpOrder.orderId : null;
          if (tpOrder) {
            const tpStop = parseFloat(tpOrder.stopPrice || tpOrder.price || 0);
            if (tpStop > 0) posPatch.takeProfitPrice = tpStop;
          }
        }
        repo.upsertPosition(posPatch);
        logger.info(`Position: ${p.symbol} ${posSide} ${amt} @ ${p.entryPrice} (SL=${posPatch.stopLossOrderId || 'none'}, TP=${posPatch.takeProfitOrderId || 'none'})`);
      }
    }

    for (const localPos of repo.getOpenPositions()) {
      if (!activeExchangeSymbols.has(localPos.symbol)) {
        logger.warn(`Removing stale local ghost position: ${localPos.symbol}`);
        repo.removePosition(localPos.symbol);
      }
    }

    if (typeof binance.futuresExchangeInfo === 'function') {
      const exchangeInfo = await binance.futuresExchangeInfo();
      for (const s of exchangeInfo.symbols || []) {
        if (s.contractType === 'PERPETUAL') {
          const lotFilter = s.filters.find((f) => f.filterType === 'LOT_SIZE');
          const priceFilter = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
          symbolInfoCache[s.symbol] = {
            stepSize: lotFilter ? parseFloat(lotFilter.stepSize) : 0.001,
            tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.01,
            minQty: lotFilter ? parseFloat(lotFilter.minQty) : 0.001,
          };
        }
      }
      logger.info(`Synced: ${Object.keys(symbolInfoCache).length} symbols`);
    }
  } catch (err) {
    logger.error('Account sync failed', err.message);
    throw err;
  }
}

function computeRepairStopPrice(pos) {
  const isLong = pos.side !== POSITION_SIDE.SHORT;
  const existingSl = Number(pos.stopLossPrice || 0);
  if (existingSl > 0 && ((isLong && existingSl < pos.entryPrice) || (!isLong && existingSl > pos.entryPrice))) {
    return existingSl;
  }
  const stopLossPct = Number(config?.stopLossPct || 2);
  const rawSl = limits.calculateStopLoss(pos.entryPrice, stopLossPct, pos.side || POSITION_SIDE.LONG);
  return limits.roundPrice(rawSl, getSymbolInfo(pos.symbol));
}

async function reconcilePositions({ repairMissingStopLoss = true } = {}) {
  if (reconciling || config?.dryRun || !binance) return { skipped: true };
  reconciling = true;
  const summary = { checked: 0, repairedSl: [], failedSl: [], removedGhosts: [] };

  try {
    const [account, positions, openOrders] = await Promise.all([
      binance.futuresAccount(),
      binance.futuresPositionRisk(),
      fetchOpenOrdersSafe(),
    ]);

    if (account && account.totalWalletBalance !== undefined) {
      accountInfo = {
        totalWalletBalance: parseFloat(account.totalWalletBalance),
        availableBalance: parseFloat(account.availableBalance ?? account.totalWalletBalance),
        totalUnrealizedProfit: parseFloat(account.totalUnrealizedProfit || 0),
        totalMarginBalance: parseFloat(account.totalMarginBalance ?? account.totalWalletBalance),
      };
      if (typeof repo.updateCurrentBalance === 'function') {
        repo.updateCurrentBalance(accountInfo.totalWalletBalance);
      }
    }

    const activeExchangeSymbols = new Set();

    for (const p of positions || []) {
      const rawAmt = parseFloat(p.positionAmt);
      const amt = Math.abs(rawAmt);
      if (!(amt > 0)) continue;

      const symbol = p.symbol;
      activeExchangeSymbols.add(symbol);

      // Skip symbols currently executing an entry/close order
      if (orderExecutor && typeof orderExecutor.isPending === 'function' && orderExecutor.isPending(symbol)) {
        continue;
      }

      summary.checked += 1;
      const posSide = rawAmt > 0 ? POSITION_SIDE.LONG : POSITION_SIDE.SHORT;
      const { slOrder, tpOrder } = matchProtectiveOrders(symbol, posSide, openOrders || []);

      const posPatch = {
        symbol,
        side: posSide,
        entryPrice: parseFloat(p.entryPrice),
        quantity: amt,
        leverage: parseFloat(p.leverage),
        stopLossOrderId: slOrder ? slOrder.orderId : null,
        takeProfitOrderId: tpOrder ? tpOrder.orderId : null,
      };
      if (slOrder) {
        const slStop = parseFloat(slOrder.stopPrice || slOrder.price || 0);
        if (slStop > 0) posPatch.stopLossPrice = slStop;
      }
      if (tpOrder) {
        const tpStop = parseFloat(tpOrder.stopPrice || tpOrder.price || 0);
        if (tpStop > 0) posPatch.takeProfitPrice = tpStop;
      }
      repo.upsertPosition(posPatch);

      // Auto-repair missing Stop-Loss order on live exchange position
      if (!slOrder && openOrders !== null && repairMissingStopLoss && orderExecutor && typeof orderExecutor.ensureStopLoss === 'function') {
        const currentPos = repo.getPosition(symbol);
        const repairSlPrice = computeRepairStopPrice(currentPos);
        logger.warn(`RECONCILE: ${symbol} ${posSide} qty=${amt} has NO active stop-loss! Auto-placing SL @ ${repairSlPrice}...`);
        try {
          const repaired = await orderExecutor.ensureStopLoss(currentPos, repairSlPrice);
          summary.repairedSl.push(symbol);
          eventBus.emit('reconcileAlert', {
            type: 'missing_sl_repaired',
            symbol,
            side: posSide,
            quantity: amt,
            stopLossPrice: repairSlPrice,
            orderId: repaired?.orderId || null,
          });
        } catch (repairErr) {
          summary.failedSl.push(symbol);
          logger.error(`RECONCILE CRITICAL: Failed to auto-place SL for ${symbol}`, repairErr.message);
          eventBus.emit('reconcileAlert', {
            type: 'missing_sl_failed',
            symbol,
            side: posSide,
            quantity: amt,
            error: repairErr.message,
          });
        }
      }
    }

    // Remove local ghost positions that no longer exist on the exchange
    for (const localPos of repo.getOpenPositions()) {
      const sym = localPos.symbol;
      if (orderExecutor && typeof orderExecutor.isPending === 'function' && orderExecutor.isPending(sym)) {
        continue;
      }
      if (!activeExchangeSymbols.has(sym)) {
        logger.warn(`RECONCILE: Removing local ghost position ${sym} (closed on exchange)`);
        repo.removePosition(sym);
        summary.removedGhosts.push(sym);
        eventBus.emit('positionClosed', { symbol: sym, pnl: 0, pnlPct: 0, reason: 'reconcile_ghost_removed' });
        eventBus.emit('reconcileAlert', { type: 'ghost_position_removed', symbol: sym });
      }
    }

    return summary;
  } finally {
    reconciling = false;
  }
}

function startReconcileLoop() {
  stopReconcileLoop();
  const intervalSec = Number(config?.reconcileIntervalSeconds ?? 300);
  if (config?.dryRun || !(intervalSec > 0)) return null;
  reconcileTimer = setInterval(() => {
    reconcilePositions({ repairMissingStopLoss: true }).catch((err) => {
      logger.warn(`Periodic reconciliation error: ${err.message}`);
    });
  }, intervalSec * 1000);
  if (typeof reconcileTimer.unref === 'function') reconcileTimer.unref();
  logger.info(`Reconciliation loop started (every ${intervalSec}s)`);
  return reconcileTimer;
}

function stopReconcileLoop() {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}

function getAccountInfo() { return accountInfo; }
function getSymbolInfo(symbol) { return symbolInfoCache[symbol] || null; }
function getMarkPrices() { return markPricesCache; }

module.exports = {
  init, syncAccount, reconcilePositions, startReconcileLoop, stopReconcileLoop,
  matchProtectiveOrders,
  getAccountInfo, getSymbolInfo, getMarkPrices,
  handleAccountUpdate, handlePositionUpdate, handleOrderUpdate,
};

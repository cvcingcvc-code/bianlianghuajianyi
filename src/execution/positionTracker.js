const { POSITION_SIDE } = require('../utils/constants');

let binance, repo, eventBus, logger;
let accountInfo = null;
let symbolInfoCache = {};
let markPricesCache = {};

function init(bn, repository, bus, log) {
  binance = bn; repo = repository; eventBus = bus; logger = log;
  markPricesCache = {};
  eventBus.on('markPrice', (d) => {
    if (d && d.symbol && Number.isFinite(d.markPrice)) {
      markPricesCache[d.symbol] = d.markPrice;
    }
  });
  eventBus.on('orderUpdate', handleOrderUpdate);
  eventBus.on('accountUpdate', handleAccountUpdate);
  eventBus.on('positionUpdate', handlePositionUpdate);
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
    const stats = repo.getDailyStats();
    stats.currentBalance = wb;
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
    // Exchange closed the position (e.g. SL/TP triggered on exchange)
    repo.removePosition(data.symbol);
    eventBus.emit('positionClosed', { symbol: data.symbol, pnl: 0, pnlPct: 0, reason: 'exchange_sync_closed' });
  }
}

function handleOrderUpdate(data) {
  if (!data) return;
  // Support direct fields, node-binance-api `data.order`, and raw `data.o`
  const o = data.order || data.o || data;
  const status = o.orderStatus ?? o.X;
  const orderType = o.origType ?? o.originalOrderType ?? o.ot ?? o.type ?? o.o;
  const symbol = o.symbol ?? o.s;
  if (status !== 'FILLED' || !symbol) return;

  const avgPrice = parseFloat(o.avgPrice ?? o.averagePrice ?? o.ap ?? o.price ?? o.p ?? 0);
  const executedQty = parseFloat(o.executedQty ?? o.orderFilledAccumulatedQuantity ?? o.z ?? o.origQty ?? o.q ?? 0);
  const realizedProfit = parseFloat(o.realizedProfit ?? o.rp ?? NaN);

  logger.trade(`Order filled: ${symbol} ${o.side || o.S} ${executedQty} @ ${avgPrice}`);
  repo.saveTrade({
    orderId: o.orderId ?? o.i,
    symbol,
    side: o.side ?? o.S,
    quantity: parseFloat(o.origQty ?? o.originalQuantity ?? o.q ?? executedQty),
    price: avgPrice,
    executedQty,
    commission: String(o.commission ?? o.n ?? '0'),
    time: o.orderTradeTime ?? o.time ?? o.T ?? Date.now(),
    orderType,
  });

  // If an exchange-side SL/TP order filled while we still track the position locally, record PnL & remove ghost position
  if ((orderType === 'STOP_MARKET' || orderType === 'TAKE_PROFIT_MARKET' || orderType === 'STOP_LOSS_LIMIT' || orderType === 'TAKE_PROFIT_LIMIT') && repo.hasPosition(symbol)) {
    const pos = repo.getPosition(symbol);
    const pnl = Number.isFinite(realizedProfit)
      ? realizedProfit
      : ((pos.side === POSITION_SIDE.SHORT ? pos.entryPrice - avgPrice : avgPrice - pos.entryPrice) * executedQty);
    const pnlPct = pos.entryPrice > 0 ? (pnl / (pos.entryPrice * executedQty || 1)) * 100 : 0;
    repo.updateDailyPnl(pnl, pnl > 0);
    repo.removePosition(symbol);
    const reason = orderType.startsWith('STOP') ? 'stop_loss_triggered' : 'take_profit_triggered';
    eventBus.emit('positionClosed', { symbol, pnl, pnlPct, entryPrice: pos.entryPrice, exitPrice: avgPrice, reason });
  }

  eventBus.emit('orderExecuted', o);
}

async function syncAccount() {
  try {
    logger.info('Syncing account...');
    const account = await binance.futuresAccount();
    accountInfo = {
      totalWalletBalance: parseFloat(account.totalWalletBalance),
      availableBalance: parseFloat(account.availableBalance),
      totalUnrealizedProfit: parseFloat(account.totalUnrealizedProfit || 0),
      totalMarginBalance: parseFloat(account.totalMarginBalance),
    };
    repo.setStartBalance(accountInfo.totalWalletBalance);
    logger.info(`Balance: ${accountInfo.totalWalletBalance.toFixed(2)} USDT`);

    const positions = await binance.futuresPositionRisk();
    const activeExchangeSymbols = new Set();
    for (const p of positions) {
      const amt = Math.abs(parseFloat(p.positionAmt));
      if (amt > 0) {
        activeExchangeSymbols.add(p.symbol);
        repo.upsertPosition({
          symbol: p.symbol,
          side: parseFloat(p.positionAmt) > 0 ? POSITION_SIDE.LONG : POSITION_SIDE.SHORT,
          entryPrice: parseFloat(p.entryPrice),
          quantity: amt,
          leverage: parseFloat(p.leverage),
        });
        logger.info(`Position: ${p.symbol} ${amt} @ ${p.entryPrice}`);
      }
    }
    // Clean up stale local ghost positions that no longer exist on the exchange
    for (const localPos of repo.getOpenPositions()) {
      if (!activeExchangeSymbols.has(localPos.symbol)) {
        logger.warn(`Removing stale local ghost position: ${localPos.symbol}`);
        repo.removePosition(localPos.symbol);
      }
    }

    const exchangeInfo = await binance.futuresExchangeInfo();
    for (const s of exchangeInfo.symbols) {
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
  } catch (err) {
    logger.error('Account sync failed', err.message);
    throw err;
  }
}

function getAccountInfo() { return accountInfo; }
function getSymbolInfo(symbol) { return symbolInfoCache[symbol] || null; }
function getMarkPrices() { return markPricesCache; }

module.exports = {
  init, syncAccount, getAccountInfo, getSymbolInfo, getMarkPrices,
  handleAccountUpdate, handlePositionUpdate, handleOrderUpdate,
};

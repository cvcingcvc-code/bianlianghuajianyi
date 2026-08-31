const { POSITION_SIDE } = require('../utils/constants');

let binance, repo, eventBus, logger;
let accountInfo = null;
let symbolInfoCache = {};

function init(bn, repository, bus, log) {
  binance = bn; repo = repository; eventBus = bus; logger = log;
  eventBus.on('orderUpdate', handleOrderUpdate);
  eventBus.on('accountUpdate', handleAccountUpdate);
  eventBus.on('positionUpdate', handlePositionUpdate);
}

function handleAccountUpdate(data) {
  if (data && data.totalWalletBalance !== undefined) {
    accountInfo = {
      totalWalletBalance: parseFloat(data.totalWalletBalance),
      availableBalance: parseFloat(data.availableBalance),
      totalUnrealizedProfit: parseFloat(data.totalUnrealizedProfit || 0),
      totalMarginBalance: parseFloat(data.totalMarginBalance),
    };
  }
}

function handlePositionUpdate(data) {
  if (!data || !data.symbol) return;
  const amt = parseFloat(data.positionAmt);
  if (Math.abs(amt) > 0) {
    repo.upsertPosition({
      symbol: data.symbol,
      side: amt > 0 ? POSITION_SIDE.LONG : POSITION_SIDE.SHORT,
      entryPrice: parseFloat(data.entryPrice),
      quantity: Math.abs(amt),
      leverage: parseFloat(data.leverage),
      unrealizedPnl: parseFloat(data.unRealizedProfit || 0),
    });
  } else {
    repo.removePosition(data.symbol);
  }
}

function handleOrderUpdate(data) {
  if (!data || data.orderStatus !== 'FILLED') return;
  logger.trade(`Order filled: ${data.symbol} ${data.side} ${data.executedQty} @ ${data.avgPrice || data.price}`);
  repo.saveTrade({
    orderId: data.orderId, symbol: data.symbol, side: data.side,
    quantity: parseFloat(data.origQty), price: parseFloat(data.avgPrice || data.price),
    executedQty: parseFloat(data.executedQty), commission: data.commission || '0',
    time: data.time || Date.now(), orderType: data.origType,
  });
  eventBus.emit('orderExecuted', data);
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
    for (const p of positions) {
      const amt = Math.abs(parseFloat(p.positionAmt));
      if (amt > 0) {
        repo.upsertPosition({
          symbol: p.symbol,
          side: parseFloat(p.positionAmt) > 0 ? POSITION_SIDE.LONG : POSITION_SIDE.SHORT,
          entryPrice: parseFloat(p.entryPrice), quantity: amt,
          leverage: parseFloat(p.leverage),
        });
        logger.info(`Position: ${p.symbol} ${amt} @ ${p.entryPrice}`);
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

module.exports = { init, syncAccount, getAccountInfo, getSymbolInfo };

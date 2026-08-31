const { MIN_NOTIONAL } = require('../utils/constants');

function calculatePositionSize(accountBalance, positionSizePct, price, leverage, maxNotional) {
  const allocatedCapital = accountBalance * (positionSizePct / 100);
  const notional = allocatedCapital * leverage;
  const cappedNotional = maxNotional > 0 ? Math.min(notional, maxNotional) : notional;
  const quantity = cappedNotional / price;
  return { quantity, notional: cappedNotional };
}

function calculateStopLoss(entryPrice, stopLossPct, direction) {
  if (direction === 'LONG') return entryPrice * (1 - stopLossPct / 100);
  return entryPrice * (1 + stopLossPct / 100);
}

function calculateTakeProfit(entryPrice, takeProfitPct, direction) {
  if (direction === 'LONG') return entryPrice * (1 + takeProfitPct / 100);
  return entryPrice * (1 - takeProfitPct / 100);
}

function calculateMarginRatio(accountBalance, openPositions, markPrices) {
  let totalMaintenanceMargin = 0;
  for (const pos of openPositions) {
    const markPrice = (markPrices && markPrices[pos.symbol]) || pos.entryPrice;
    totalMaintenanceMargin += (pos.quantity * markPrice) / pos.leverage;
  }
  if (totalMaintenanceMargin === 0) return 9999;
  return (accountBalance / totalMaintenanceMargin) * 100;
}

function roundToLotSize(quantity, symbolInfo) {
  const stepSize = (symbolInfo && symbolInfo.stepSize) ? symbolInfo.stepSize : 0.001;
  const precision = Math.max(0, Math.ceil(-Math.log10(stepSize)));
  return Number((Math.floor(quantity / stepSize) * stepSize).toFixed(precision));
}

function roundPrice(price, symbolInfo) {
  const tickSize = (symbolInfo && symbolInfo.tickSize) ? symbolInfo.tickSize : 0.01;
  const precision = Math.max(0, Math.ceil(-Math.log10(tickSize)));
  return Number(price.toFixed(precision));
}

function checkMinNotional(quantity, price) {
  return quantity * price >= MIN_NOTIONAL;
}

module.exports = {
  calculatePositionSize, calculateStopLoss, calculateTakeProfit,
  calculateMarginRatio, roundToLotSize, roundPrice, checkMinNotional,
};

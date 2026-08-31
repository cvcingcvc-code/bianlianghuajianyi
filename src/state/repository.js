const { state, getDateKey, shutdown } = require('./database');

// --- Trades ---
function saveTrade(trade) {
  const record = {
    id: trade.orderId,
    symbol: trade.symbol,
    side: trade.side,
    positionSide: trade.positionSide || 'LONG',
    quantity: trade.quantity,
    price: trade.price,
    executedQty: trade.executedQty || trade.quantity,
    commission: trade.commission || '0',
    time: trade.time || Date.now(),
    orderType: trade.orderType || 'MARKET',
  };
  state.trades.push(record);
  state.orderIndex[trade.orderId] = record;
  if (state.trades.length > 1000) state.trades.shift();
}

function getRecentTrades(limit = 50) {
  return state.trades.slice(-limit);
}

function getTradeById(orderId) {
  return state.orderIndex[orderId] || null;
}

// --- Positions ---
function upsertPosition(pos) {
  state.positions[pos.symbol] = {
    symbol: pos.symbol,
    side: pos.side,
    entryPrice: Number(pos.entryPrice),
    quantity: Number(pos.quantity),
    leverage: Number(pos.leverage),
    stopLossPrice: Number(pos.stopLossPrice || 0),
    takeProfitPrice: Number(pos.takeProfitPrice || 0),
    stopLossOrderId: pos.stopLossOrderId || null,
    takeProfitOrderId: pos.takeProfitOrderId || null,
    openedAt: pos.openedAt || Date.now(),
    updatedAt: Date.now(),
  };
}

function removePosition(symbol) {
  delete state.positions[symbol];
}

function getOpenPositions() {
  return Object.values(state.positions);
}

function getPosition(symbol) {
  return state.positions[symbol] || null;
}

function hasPosition(symbol) {
  return symbol in state.positions;
}

function getPositionCount() {
  return Object.keys(state.positions).length;
}

// --- Daily Stats ---
function getDailyStats() {
  const today = getDateKey();
  if (!state.dailyStats || state.dailyStats.date !== today) {
    state.dailyStats = { date: today, startBalance: 0, currentBalance: 0, realizedPnl: 0, tradeCount: 0, winningTrades: 0 };
  }
  return state.dailyStats;
}

function setStartBalance(balance) {
  const stats = getDailyStats();
  stats.startBalance = balance;
  stats.currentBalance = balance;
}

function updateDailyPnl(pnl, isWin) {
  const stats = getDailyStats();
  stats.realizedPnl += pnl;
  stats.currentBalance += pnl;
  stats.tradeCount += 1;
  if (isWin) stats.winningTrades += 1;
}

function isDailyLossCapExceeded(capPct) {
  const stats = getDailyStats();
  if (stats.startBalance <= 0) return false;
  return (stats.realizedPnl / stats.startBalance) * 100 <= -capPct;
}

// --- Circuit Breakers ---
function getBreakerState() {
  return state.breakers;
}

function tripBreaker(reason, details) {
  state.breakers[reason] = {
    tripped: true, reason, details,
    trippedAt: Date.now(),
    expiresAt: Date.now() + 3600000,
  };
  state.appState.consecutiveLosses = 0;
}

function isBreakerTripped() {
  const now = Date.now();
  for (const key of Object.keys(state.breakers)) {
    const b = state.breakers[key];
    if (b.tripped && now < b.expiresAt) return true;
    if (b.tripped && now >= b.expiresAt) b.tripped = false;
  }
  return false;
}

function resetBreaker(reason) {
  if (reason && state.breakers[reason]) {
    state.breakers[reason].tripped = false;
  } else {
    state.breakers = {};
  }
}

function incrementConsecutiveLoss() {
  state.appState.consecutiveLosses = (state.appState.consecutiveLosses || 0) + 1;
  return state.appState.consecutiveLosses;
}

function resetConsecutiveLoss() {
  state.appState.consecutiveLosses = 0;
}

function getConsecutiveLosses() {
  return state.appState.consecutiveLosses || 0;
}

function incrementApiErrors() {
  const now = Date.now();
  if (now - (state.appState.apiErrorWindowStart || 0) > 300000) {
    state.appState.apiErrorWindowStart = now;
    state.appState.apiErrors = 0;
  }
  state.appState.apiErrors = (state.appState.apiErrors || 0) + 1;
  return state.appState.apiErrors;
}

function resetApiErrors() {
  state.appState.apiErrors = 0;
  state.appState.apiErrorWindowStart = 0;
}

// --- Event Log ---
function logEvent(level, message, data) {
  const entry = { time: Date.now(), level, message, data: data || null };
  state.eventLog.push(entry);
  if (state.eventLog.length > 500) state.eventLog.shift();
  return entry;
}

function save() {
  shutdown();
}

module.exports = {
  saveTrade, getRecentTrades, getTradeById,
  upsertPosition, removePosition, getOpenPositions, getPosition, hasPosition, getPositionCount,
  getDailyStats, setStartBalance, updateDailyPnl, isDailyLossCapExceeded,
  getBreakerState, tripBreaker, isBreakerTripped, resetBreaker,
  incrementConsecutiveLoss, resetConsecutiveLoss, getConsecutiveLosses,
  incrementApiErrors, resetApiErrors,
  logEvent, save,
};

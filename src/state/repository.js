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
  const existing = state.positions[pos.symbol] || {};
  state.positions[pos.symbol] = {
    symbol: pos.symbol,
    side: pos.side || existing.side || 'LONG',
    entryPrice: Number(pos.entryPrice ?? existing.entryPrice ?? 0),
    quantity: Number(pos.quantity ?? existing.quantity ?? 0),
    leverage: Number(pos.leverage ?? existing.leverage ?? 1),
    stopLossPrice: Number(pos.stopLossPrice ?? existing.stopLossPrice ?? 0),
    takeProfitPrice: Number(pos.takeProfitPrice ?? existing.takeProfitPrice ?? 0),
    stopLossOrderId: pos.stopLossOrderId !== undefined ? pos.stopLossOrderId : (existing.stopLossOrderId || null),
    takeProfitOrderId: pos.takeProfitOrderId !== undefined ? pos.takeProfitOrderId : (existing.takeProfitOrderId || null),
    unrealizedPnl: Number(pos.unrealizedPnl ?? existing.unrealizedPnl ?? 0),
    openedAt: pos.openedAt || existing.openedAt || Date.now(),
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
    state.dailyStats = {
      date: today,
      startBalance: 0,
      currentBalance: 0,
      realizedPnl: 0,
      grossPnl: 0,
      totalCommission: 0,
      tradeCount: 0,
      winningTrades: 0,
    };
    state.settledOrders = {};
  }
  if (state.dailyStats.grossPnl === undefined) state.dailyStats.grossPnl = 0;
  if (state.dailyStats.totalCommission === undefined) state.dailyStats.totalCommission = 0;
  if (!state.settledOrders) state.settledOrders = {};
  return state.dailyStats;
}

function setStartBalance(balance) {
  const stats = getDailyStats();
  stats.startBalance = balance;
  stats.currentBalance = balance;
}

function updateCurrentBalance(balance) {
  const stats = getDailyStats();
  if (stats.startBalance <= 0) {
    stats.startBalance = balance;
  }
  stats.currentBalance = balance;
}

function updateDailyPnl(pnl, isWin) {
  const stats = getDailyStats();
  stats.realizedPnl += pnl;
  stats.grossPnl = (stats.grossPnl || 0) + pnl;
  stats.currentBalance += pnl;
  stats.tradeCount += 1;
  if (isWin) stats.winningTrades += 1;
}

function recordOrderExecution({ orderId, isClose = false, grossPnl = 0, commission = 0 }) {
  const stats = getDailyStats();
  const key = orderId !== undefined && orderId !== null && orderId !== '' ? String(orderId) : null;
  const fee = Number.isFinite(Number(commission)) ? Math.max(0, Number(commission)) : 0;
  const gross = Number.isFinite(Number(grossPnl)) ? Number(grossPnl) : 0;

  // Entry order commission accounting (idempotent per orderId)
  if (!isClose) {
    const prev = key ? state.settledOrders[key] : null;
    if (prev?.commissionRecorded) {
      return { netPnl: -prev.commission, commission: prev.commission, duplicate: true };
    }
    if (fee > 0) {
      stats.totalCommission += fee;
      stats.realizedPnl -= fee;
      stats.currentBalance -= fee;
    }
    if (key) {
      state.settledOrders[key] = { ...(prev || {}), commission: fee, commissionRecorded: true };
    }
    return { netPnl: -fee, commission: fee, duplicate: false };
  }

  // Closing order settlement & idempotent WS delta reconciliation
  const netPnl = gross - fee;
  const isWin = netPnl > 0;
  const prev = key ? state.settledOrders[key] : null;

  if (prev && prev.countedAsTrade) {
    const deltaGross = gross - prev.grossPnl;
    const deltaFee = fee - prev.commission;
    const deltaNet = netPnl - prev.netPnl;
    stats.grossPnl += deltaGross;
    stats.totalCommission += deltaFee;
    stats.realizedPnl += deltaNet;
    stats.currentBalance += deltaNet;
    if (isWin !== prev.isWin) {
      stats.winningTrades = Math.max(0, stats.winningTrades + (isWin ? 1 : -1));
    }
    state.settledOrders[key] = { grossPnl: gross, commission: fee, netPnl, isWin, countedAsTrade: true, commissionRecorded: true };
    return { netPnl, grossPnl: gross, commission: fee, firstSettlement: false, reconciledDelta: deltaNet };
  }

  // If fee was somehow recorded earlier before close classification, only apply remaining fee delta
  const priorFee = prev?.commissionRecorded ? (prev.commission || 0) : 0;
  const remainingFee = fee - priorFee;
  const netDelta = gross - remainingFee;

  stats.grossPnl += gross;
  stats.totalCommission += remainingFee;
  stats.realizedPnl += netDelta;
  stats.currentBalance += netDelta;
  stats.tradeCount += 1;
  if (isWin) stats.winningTrades += 1;

  if (key) {
    state.settledOrders[key] = { grossPnl: gross, commission: fee, netPnl, isWin, countedAsTrade: true, commissionRecorded: true };
  }
  return { netPnl, grossPnl: gross, commission: fee, firstSettlement: true, reconciledDelta: netDelta };
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
  getDailyStats, setStartBalance, updateCurrentBalance, updateDailyPnl, recordOrderExecution, isDailyLossCapExceeded,
  getBreakerState, tripBreaker, isBreakerTripped, resetBreaker,
  incrementConsecutiveLoss, resetConsecutiveLoss, getConsecutiveLosses,
  incrementApiErrors, resetApiErrors,
  logEvent, save,
};

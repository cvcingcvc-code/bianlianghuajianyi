const { EventEmitter } = require('node:events');
const manager = require('../risk/manager');
// Translate public event/repository contracts. Existing risk rules remain untouched.
class RiskBridge {
  constructor(adapter, { config = {}, log = () => {} } = {}) {
    this.adapter = adapter; this.bus = new EventEmitter(); this.consecutiveLosses = 0; this.tripped = false;
    const repo = this.repo = {
      isBreakerTripped: () => this.tripped,
      isDailyLossCapExceeded: pct => adapter.getAccountState().dailyPnl < -adapter.initial * pct / 100,
      getDailyStats: () => ({ realizedPnl: adapter.getAccountState().realizedPnl || 0 }),
      getPositionCount: () => adapter.getPositions().length + (adapter.getPendingOrders?.() || []).filter(o => o.action === 'OPEN').length,
      hasPosition: s => adapter.getPositions().some(p => p.symbol === s) || (adapter.getPendingOrders?.() || []).some(o => o.symbol === s && o.action === 'OPEN'),
      getPosition: s => adapter.getPositions().find(p => p.symbol === s),
      getOpenPositions: () => adapter.getPositions(),
      incrementConsecutiveLoss: () => ++this.consecutiveLosses,
      resetConsecutiveLoss: () => { this.consecutiveLosses = 0; },
      tripBreaker: () => { this.tripped = true; },
    };
    const logger = Object.fromEntries(['info', 'warn', 'error', 'signal'].map(level => [level, message => log({ level, component: 'risk', message })]));
    manager.init({ dailyLossCapPct: 5, maxOpenPositions: 1, positionSizePct: 25, maxLeverage: 1,
      maxNotionalPerTrade: 2500, stopLossPct: 2, takeProfitPct: 4, ...config }, repo, this.bus, logger,
    { getAccountInfo: () => adapter.getAccountState(), getSymbolInfo: () => ({ stepSize: 0.001, tickSize: 0.01 }) });
    this.bus.on('riskApproved', order => { this.result = { decision: 'APPROVE', reason: 'Existing Risk Manager approved', order }; });
    this.bus.on('riskRejected', ({ reason }) => { this.result = { decision: 'REJECT', reason, order: null }; });
  }
  evaluate(signal) {
    if (signal.direction === 'HOLD') return { decision: 'NOT_EVALUATED', reason: 'No actionable technical signal', order: null };
    if (this.adapter.getConnectionStatus().status !== 'CONNECTED') return { decision: 'REJECT', reason: 'Market data is stale or disconnected', order: null };
    if (this.adapter.getAccountState().status !== 'available') return { decision: 'REJECT', reason: 'Account state unavailable', order: null };
    // Testnet account has no reliable daily-loss ledger in V1: fail closed for opening exposure.
    if (signal.direction === 'LONG' && this.adapter.getAccountState().dailyPnl === null) return { decision: 'REJECT', reason: 'Daily loss state unavailable', order: null };
    this.result = { decision: 'REJECT', reason: 'No position / no risk approval', order: null };
    this.bus.emit('strategySignal', signal);
    return this.result;
  }
  recordFill(fill) { if (fill.action === 'CLOSE') this.bus.emit('positionClosed', { pnl: fill.pnl }); }
  getStatus() { return { status: this.tripped ? 'TRIPPED' : this.adapter.getAccountState().dailyPnl === null ? 'DAILY_LOSS_UNAVAILABLE' : 'ACTIVE', maxOpenPositions: 1, liveExecution: 'DISABLED' }; }
  stop() { this.bus.removeAllListeners(); }
}
module.exports = { RiskBridge };

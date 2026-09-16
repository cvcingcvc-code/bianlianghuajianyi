const { SYMBOLS } = require('./contracts');
const { StrategyBridge } = require('./strategyBridge');
const { SentimentService, sentimentGate } = require('../sentiment/service');
const { unavailable } = require('../sentiment/aggregator');
const { RiskBridge } = require('./riskBridge');
class Pipeline {
  constructor({ adapter, sentiment = new SentimentService(), log = () => {}, riskConfig } = {}) {
    Object.assign(this, { adapter, sentiment, log }); this.strategy = new StrategyBridge();
    this.risk = new RiskBridge(adapter, { config: riskConfig, log }); this.signals = []; this.latest = {};
    this.sentiments = Object.fromEntries(SYMBOLS.map(s => [s, unavailable(s, 'No collection yet')]));
    this.queue = Promise.resolve(); this.error = null;
    this.unsubscribe = adapter.subscribeMarketData(event => { this.queue = this.queue.then(() => this.process(event)).catch(() => {
      this.error = 'Pipeline processing failed'; this.log({ level: 'error', component: 'pipeline', event: 'processing_failed' });
    }); });
    this.onFill = ({ order, fill }) => {
      const record = this.signals.find(s => s.technicalSignal.symbol === order.symbol && s.technicalSignal.timestamp === order.signal.timestamp);
      if (record) { record.execution = { ...fill, fill }; record.finalDecision = 'DRY_RUN_FILLED'; }
      this.risk.recordFill(fill);
    };
    adapter.events?.on('fill', this.onFill);
  }
  async process({ symbol, candle, warmup }) {
    const technicalSignal = this.strategy.evaluate(symbol, candle, { warmup, hasPosition: this.adapter.getPositions().some(p => p.symbol === symbol) });
    if (warmup) return;
    const sentiment = this.sentiments[symbol] = await this.sentiment.get(symbol, candle.closeTime);
    const gate = sentimentGate(technicalSignal, sentiment);
    const risk = gate.decision === 'BLOCK' ? { decision: 'NOT_EVALUATED', reason: 'Sentiment blocked LONG', order: null } : this.risk.evaluate(technicalSignal);
    const record = { technicalSignal, sentiment, sentimentDecision: { decision: gate.decision, reason: gate.reason },
      riskDecision: { decision: risk.decision, reason: risk.reason }, finalDecision: gate.decision === 'BLOCK' ? 'FILTERED' : risk.decision === 'REJECT' ? 'REJECTED' : 'HOLD',
      reason: gate.decision === 'BLOCK' ? gate.reason : risk.reason, execution: null };
    if (risk.decision === 'APPROVE') {
      try { record.execution = await this.adapter.executeOrder(risk.order); record.finalDecision = record.execution.status; }
      catch { record.finalDecision = 'EXECUTION_FAILED'; record.reason = 'Adapter rejected execution'; this.log({ level: 'error', component: 'execution', event: 'order_failed', symbol }); }
    }
    this.latest[symbol] = record;
    if (technicalSignal.direction !== 'HOLD') { this.signals.unshift(record); if (this.signals.length > 100) this.signals.pop(); }
  }
  status() {
    const account = this.adapter.getAccountState();
    const market = this.adapter.getConnectionStatus();
    return { mode: this.adapter.mode, liveExecution: 'DISABLED', market, strategy: 'breakout24h4h',
      risk: this.risk.getStatus(), sentiment: Object.values(this.sentiments).some(s => s.status === 'available') ? 'available' : 'unavailable',
      health: this.error || (market.status !== 'CONNECTED' ? 'MARKET_UNHEALTHY' : account.status !== 'available' ? 'ACCOUNT_UNAVAILABLE' : this.risk.getStatus().status !== 'ACTIVE' ? 'RISK_BLOCKED' : 'READY'),
      error: this.error, updatedAt: new Date().toISOString() };
  }
  dashboard() {
    return { status: this.status(), market: this.adapter.getMarketData('ETHUSDT'), strategyState: this.signals.find(s => s.technicalSignal.symbol === 'ETHUSDT') || this.latest.ETHUSDT || null,
      sentiment: this.sentiments.ETHUSDT, metrics: this.adapter.getAccountState(), positions: this.adapter.getPositions(),
      recentSignals: this.signals.slice(0, 30) };
  }
  stop() { this.unsubscribe(); this.adapter.events?.off('fill', this.onFill); this.risk.stop(); this.adapter.stop(); }
}
module.exports = { Pipeline };

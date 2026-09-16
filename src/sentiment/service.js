const { Collector } = require('./collector');
const { analyze } = require('./analyzer');
const { aggregate, unavailable } = require('./aggregator');
class SentimentService {
  constructor({ collector = new Collector(), log = () => {} } = {}) { this.collector = collector; this.log = log; }
  async get(symbol, now = Date.now()) {
    try { return aggregate(symbol, (await this.collector.collect(symbol, now)).map(analyze), now); }
    catch { this.log({ level: 'error', component: 'sentiment', event: 'collection_failed', symbol });
      return unavailable(symbol, 'News source unavailable', now); }
  }
}
function sentimentGate(technicalSignal, sentiment) {
  const blocked = technicalSignal.direction === 'LONG' && sentiment.status === 'available' &&
    sentiment.score <= -0.6 && sentiment.confidence >= 0.6;
  return { technicalSignal, sentiment, decision: blocked ? 'BLOCK' : 'ALLOW',
    reason: blocked ? 'Strong bearish sentiment filters LONG' : sentiment.status === 'unavailable' ?
      'Sentiment unavailable; defer unchanged technical signal to risk' : 'Sentiment permits risk evaluation' };
}
module.exports = { SentimentService, sentimentGate };

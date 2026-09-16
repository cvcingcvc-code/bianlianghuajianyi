function unavailable(symbol, reason, now = Date.now()) {
  return { symbol, status: 'unavailable', score: null, label: null, confidence: null,
    articleCount: 0, updatedAt: new Date(now).toISOString(), reason };
}
function aggregate(symbol, items, now = Date.now()) {
  if (!items.length) return unavailable(symbol, 'No fresh articles from configured source', now);
  const score = Number((items.reduce((sum, a) => sum + a.score, 0) / items.length).toFixed(4));
  // Heuristic coverage, not a calibrated probability of price direction.
  const coverage = items.filter(a => a.evidence > 0).length / items.length;
  return { symbol, status: 'available', score, label: score > 0.2 ? 'bullish' : score < -0.2 ? 'bearish' : 'neutral',
    confidence: Number((coverage * Math.min(1, items.length / 5)).toFixed(4)), articleCount: items.length,
    updatedAt: new Date(now).toISOString(), reason: 'Headline lexicon; confidence is heuristic coverage' };
}
module.exports = { aggregate, unavailable };

const positive = /\b(rally|surge|approval|approved|inflow|growth|bullish|gain|gains)\b|上涨|利好|获批|流入/gi;
const negative = /\b(crash|hack|fraud|outflow|bearish|ban|banned|lawsuit|plunge)\b|暴跌|黑客|利空|流出|禁止/gi;
function analyze(article) {
  const p = (article.title.match(positive) || []).length;
  const n = (article.title.match(negative) || []).length;
  return { score: p + n ? (p - n) / (p + n) : 0, evidence: p + n };
}
module.exports = { analyze };

const fs = require('node:fs/promises');
const { assertSymbol } = require('../minimal/contracts');
// Provider boundary: optional local export of real, timestamped news. No invented headlines.
class Collector {
  constructor({ file, provider, maxAgeMs = 86400000 } = {}) {
    this.provider = provider || (async () => file ? JSON.parse(await fs.readFile(file, 'utf8')) : []);
    this.maxAgeMs = maxAgeMs;
  }
  async collect(symbol, now = Date.now()) {
    assertSymbol(symbol);
    const articles = await this.provider(symbol);
    if (!Array.isArray(articles)) throw new Error('Invalid news payload');
    const seen = new Set();
    return articles.filter(a => {
      const time = Date.parse(a.publishedAt);
      const valid = a.symbol === symbol && typeof a.title === 'string' && a.title.trim() &&
        typeof a.url === 'string' && /^https:\/\//.test(a.url) && Number.isFinite(time) && time <= now && now - time <= this.maxAgeMs && !seen.has(a.url);
      if (valid) seen.add(a.url);
      return valid;
    }).slice(0, 100);
  }
}
module.exports = { Collector };

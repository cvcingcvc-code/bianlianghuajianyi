const { ExchangeAdapter } = require('./ExchangeAdapter');
function denyLive() { throw new Error('LIVE DISABLED: real-money execution is unavailable in V1'); }
class LiveAdapter extends ExchangeAdapter {
  get enabled() { return false; }
  getMarketData() { return denyLive(); }
  getAccountState() { return denyLive(); }
  getPositions() { return denyLive(); }
  subscribeMarketData() { return denyLive(); }
  executeOrder() { return denyLive(); }
}
module.exports = { LiveAdapter, denyLive };

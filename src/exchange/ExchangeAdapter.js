class ExchangeAdapter {
  getMarketData() { throw new Error('Not implemented'); }
  getAccountState() { throw new Error('Not implemented'); }
  getPositions() { throw new Error('Not implemented'); }
  subscribeMarketData() { throw new Error('Not implemented'); }
  executeOrder() { throw new Error('Execution disabled'); }
  stop() {}
}
module.exports = { ExchangeAdapter };

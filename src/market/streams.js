// Defines which WebSocket streams to subscribe to
const streams = {
  miniTicker: (symbols) => symbols.map((s) => `${s.toLowerCase()}@miniTicker`),
  markPrice: (symbols) => symbols.map((s) => `${s.toLowerCase()}@markPrice`),
  kline: (symbol, interval) => `${symbol.toLowerCase()}@kline_${interval}`,
  ticker24hr: (symbols) => symbols.map((s) => `${s.toLowerCase()}@ticker`),
};

function parseMiniTicker(data) {
  const close = parseFloat(data.close);
  const open = parseFloat(data.open);
  const change = open > 0 ? (close - open) / open * 100 : 0;
  return { symbol: data.symbol, price: close, change, volume: parseFloat(data.volume) };
}

function parseMarkPrice(data) {
  return { symbol: data.symbol, markPrice: parseFloat(data.markPrice), indexPrice: parseFloat(data.indexPrice), fundingRate: parseFloat(data.fundingRate) };
}

function parseKline(data) {
  const k = data.k;
  return { symbol: data.s, interval: k.i, open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l), close: parseFloat(k.c), volume: parseFloat(k.v), closeTime: k.T, isFinal: k.x };
}

module.exports = { streams, parseMiniTicker, parseMarkPrice, parseKline };

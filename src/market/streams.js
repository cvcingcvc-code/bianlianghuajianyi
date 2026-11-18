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

const MAX_TRACKED_KLINES = 1000;

function processChartTicks(sym, interval, ticks, finalizedSet, emitFn) {
  const isFirstBatch = finalizedSet.size === 0;
  const timestamps = Object.keys(ticks).sort();
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    if (finalizedSet.has(ts)) continue;
    const c = ticks[ts];
    const isFinal = c.isFinal !== false;
    if (isFinal) {
      finalizedSet.add(ts);
      if (finalizedSet.size > MAX_TRACKED_KLINES) {
        const oldest = finalizedSet.values().next().value;
        finalizedSet.delete(oldest);
      }
    }
    emitFn('kline', {
      symbol: sym,
      interval,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume),
      closeTime: c.closeTime || c.time,
      isFinal,
      warmup: isFirstBatch && i < timestamps.length - 1,
    });
  }
}

async function syncFuturesServerTime(binanceClient, logger) {
  if (!binanceClient || typeof binanceClient.futuresTime !== 'function') {
    return null;
  }
  const before = Date.now();
  const res = await binanceClient.futuresTime();
  const after = Date.now();
  const serverTime = typeof res === 'number' ? res : Number(res?.serverTime);
  if (!Number.isFinite(serverTime) || serverTime <= 0) {
    throw new Error(`Invalid futures serverTime response: ${JSON.stringify(res)}`);
  }
  const localMidpoint = Math.round((before + after) / 2);
  const offset = serverTime - localMidpoint;

  if (typeof binanceClient.setOption === 'function') {
    binanceClient.setOption('timeOffset', offset);
    binanceClient.setOption('useServerTime', true);
  }
  if (binanceClient.info && typeof binanceClient.info === 'object') {
    binanceClient.info.timeOffset = offset;
  }
  if (logger && typeof logger.info === 'function') {
    logger.info(`Server time synced via Futures API (offset: ${offset >= 0 ? '+' : ''}${offset}ms)`);
  }
  return { serverTime, offset };
}

module.exports = { streams, parseMiniTicker, parseMarkPrice, parseKline, processChartTicks, syncFuturesServerTime };

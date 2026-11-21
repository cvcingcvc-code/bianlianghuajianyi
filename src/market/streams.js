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

async function warmupFuturesKlines(binanceClient, symbols, interval, limit, emittedKlines, emitFn, logger) {
  if (!binanceClient || !symbols || symbols.length === 0 || limit <= 0) return 0;
  let totalEmitted = 0;
  for (const sym of symbols) {
    if (emittedKlines && !emittedKlines[sym]) {
      emittedKlines[sym] = new Set();
    }
    try {
      let rawCandles = [];
      if (typeof binanceClient.futuresCandles === 'function') {
        rawCandles = await binanceClient.futuresCandles(sym, interval, { limit });
      } else if (typeof binanceClient.futuresGetData === 'function') {
        rawCandles = await binanceClient.futuresGetData('/fapi/v1/klines', { symbol: sym, interval, limit });
      }

      if (!Array.isArray(rawCandles) || rawCandles.length === 0) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`No warmup candles returned for ${sym}`);
        }
        continue;
      }

      for (const c of rawCandles) {
        let openTime, open, high, low, close, volume, closeTime;
        if (Array.isArray(c)) {
          openTime = c[0];
          open = parseFloat(c[1]);
          high = parseFloat(c[2]);
          low = parseFloat(c[3]);
          close = parseFloat(c[4]);
          volume = parseFloat(c[5]);
          closeTime = c[6];
        } else if (c && typeof c === 'object') {
          openTime = c.openTime || c.t;
          open = parseFloat(c.open || c.o);
          high = parseFloat(c.high || c.h);
          low = parseFloat(c.low || c.l);
          close = parseFloat(c.close || c.c);
          volume = parseFloat(c.volume || c.v);
          closeTime = c.closeTime || c.T || c.time;
        } else {
          continue;
        }

        const tsKey = String(openTime || closeTime);
        if (emittedKlines && emittedKlines[sym]) {
          emittedKlines[sym].add(tsKey);
        }

        if (typeof emitFn === 'function') {
          emitFn('kline', {
            symbol: sym,
            interval,
            open,
            high,
            low,
            close,
            volume,
            closeTime,
            isFinal: true,
            warmup: true,
          });
        }
        totalEmitted++;
      }
      if (logger && typeof logger.info === 'function') {
        logger.info(`Warmup complete for ${sym}: fed ${rawCandles.length} historical candles (${interval})`);
      }
    } catch (err) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`Failed to warmup candles for ${sym}: ${err.message}`);
      }
    }
  }
  return totalEmitted;
}

module.exports = { streams, parseMiniTicker, parseMarkPrice, parseKline, processChartTicks, syncFuturesServerTime, warmupFuturesKlines };

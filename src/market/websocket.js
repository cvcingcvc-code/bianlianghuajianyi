const Binance = require('node-binance-api');
const { parseMiniTicker, parseMarkPrice, processChartTicks, syncFuturesServerTime } = require('./streams');
const sleep = require('../utils/sleep');

let binance, config, eventBus, logger;
let subsEndpoints = [];
let emittedKlines = {};
let reconnectAttempts = 0;
let hasConnectedOnce = false;
let timeSyncTimer = null;
const MAX_RECONNECT_DELAY = 60000;
const TIME_SYNC_INTERVAL_MS = 30 * 60 * 1000;

function init(cfg, bus, log) {
  config = cfg; eventBus = bus; logger = log;
  binance = new Binance().options({
    APIKEY: config.apiKey,
    APISECRET: config.secretKey,
    useServerTime: false,
    test: config.testnet,
    recvWindow: 15000,
  });
  hasConnectedOnce = false;
  if (config.testnet) {
    binance.fapi = binance.fapiTest;
    binance.fstream = binance.fstreamTest;
  }
  logger.info(`WebSocket init: ${config.testnet ? 'testnet' : 'LIVE'}`);
}

async function syncTime() {
  if (!config?.useServerTime || !binance) return null;
  try {
    const res = await syncFuturesServerTime(binance, logger);
    if (!timeSyncTimer) {
      timeSyncTimer = setInterval(() => {
        syncFuturesServerTime(binance, logger).catch((e) => {
          logger.warn(`Periodic server time sync failed: ${e.message}`);
        });
      }, TIME_SYNC_INTERVAL_MS);
      if (typeof timeSyncTimer.unref === 'function') timeSyncTimer.unref();
    }
    return res;
  } catch (err) {
    logger.warn(`Futures server time sync failed (using local clock): ${err.message}`);
    return null;
  }
}

async function connect() {
  logger.info('Connecting WebSocket streams...');
  subsEndpoints = [];
  try {
    // MiniTicker — v1.x takes single symbol, not array
    for (const symbol of config.tradingPairs) {
      const ep = binance.futuresMiniTickerStream(symbol, (data) => {
        eventBus.emit('ticker', parseMiniTicker(data));
      });
      subsEndpoints.push(ep);
    }

    // MarkPrice — v1.x takes single symbol, not array
    for (const symbol of config.tradingPairs) {
      const ep = binance.futuresMarkPriceStream(symbol, (data) => {
        eventBus.emit('markPrice', parseMarkPrice(data));
      });
      subsEndpoints.push(ep);
    }

    // Kline for each pair — v1.x callback: (symbol, interval, ticksObj)
    for (const symbol of config.tradingPairs) {
      emittedKlines[symbol] = new Set();
      const ep = binance.futuresChart(symbol, config.candleInterval, (sym, interval, ticks) => {
        processChartTicks(sym, interval, ticks, emittedKlines[sym], (ev, payload) => eventBus.emit(ev, payload));
      });
      subsEndpoints.push(ep);
    }

    // User data stream (non-fatal — public streams still work without it)
    if (config.apiKey && config.secretKey) {
      try {
        const userData = binance.userFutureData(
          null,                                          // all_updates — not used
          (d) => logger.warn('Margin call!', d),         // margin_call
          (d) => eventBus.emit('accountUpdate', d),      // account_update
          (d) => eventBus.emit('orderUpdate', d),        // order_update
          (ep) => {                                      // subscribed
            subsEndpoints.push(ep);
            logger.info('User data stream subscribed');
          },
          (d) => eventBus.emit('accountConfigUpdate', d) // account_config_update
        );
        if (userData && typeof userData.catch === 'function') {
          userData.catch((err) => logger.warn(`User data stream failed (public streams OK): ${err.message}`));
        }
      } catch (userDataErr) {
        logger.warn(`User data stream failed (public streams OK): ${userDataErr.message}`);
      }
    } else {
      logger.warn('No API keys set — skipping user data stream (public market data OK)');
    }

    const wasReconnect = hasConnectedOnce;
    hasConnectedOnce = true;
    const prevAttempts = reconnectAttempts;
    reconnectAttempts = 0;
    logger.info('All WebSocket streams connected');
    if (wasReconnect) {
      eventBus.emit('wsReconnected', { attempts: prevAttempts, timestamp: Date.now() });
    }
  } catch (err) {
    logger.error('WS connection failed', err.message);
    await doReconnect();
  }
}

async function doReconnect() {
  reconnectAttempts++;
  const delay = Math.min(config.wsReconnectDelay * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
  logger.warn(`Reconnecting #${reconnectAttempts} in ${delay / 1000}s`);
  await sleep(delay);
  await disconnect();
  await connect();
}

async function disconnect() {
  if (timeSyncTimer) {
    clearInterval(timeSyncTimer);
    timeSyncTimer = null;
  }
  for (const ep of subsEndpoints) {
    try { binance.futuresTerminate(ep); } catch (e) { /* ignore */ }
  }
  subsEndpoints = [];
  emittedKlines = {};
}

function getBinance() { return binance; }

module.exports = { init, syncTime, connect, disconnect, getBinance, processChartTicks };

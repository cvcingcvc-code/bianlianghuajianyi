const Binance = require('node-binance-api');
const { parseMiniTicker, parseMarkPrice } = require('./streams');
const sleep = require('../utils/sleep');

let binance, config, eventBus, logger;
let subsEndpoints = [];
let emittedKlines = {};
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 60000;

function init(cfg, bus, log) {
  config = cfg; eventBus = bus; logger = log;
  binance = new Binance().options({
    APIKEY: config.apiKey,
    APISECRET: config.secretKey,
    useServerTime: false,
    test: config.testnet,
    recvWindow: 15000,
  });
  if (config.testnet) {
    binance.fapi = binance.fapiTest;
    binance.fstream = binance.fstreamTest;
  }
  logger.info(`WebSocket init: ${config.testnet ? 'testnet' : 'LIVE'}`);
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
        const seen = emittedKlines[sym];
        const isFirstBatch = seen.size === 0;
        const newTimestamps = Object.keys(ticks).filter(ts => !seen.has(ts)).sort();
        for (const ts of newTimestamps) {
          seen.add(ts);
          const c = ticks[ts];
          eventBus.emit('kline', {
            symbol: sym, interval,
            open: parseFloat(c.open), high: parseFloat(c.high),
            low: parseFloat(c.low), close: parseFloat(c.close),
            volume: parseFloat(c.volume), closeTime: c.closeTime || c.time,
            isFinal: c.isFinal !== false,
            warmup: isFirstBatch && ts !== newTimestamps[newTimestamps.length - 1]
          });
        }
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

    reconnectAttempts = 0;
    logger.info('All WebSocket streams connected');
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
  for (const ep of subsEndpoints) {
    try { binance.futuresTerminate(ep); } catch (e) { /* ignore */ }
  }
  subsEndpoints = [];
  emittedKlines = {};
}

function getBinance() { return binance; }

module.exports = { init, connect, disconnect, getBinance };

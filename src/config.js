const path = require('path');
const dotenv = require('dotenv');
const { required, isNumber, maskSecret } = require('./utils/validators');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const VALID_INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d']);
const VALID_STRATEGIES = new Set(['emaCrossover', 'rsiEma', 'breakout24h4h', 'breakout24h']);

function loadConfig() {
  const testnet = process.env.BINANCE_TESTNET !== 'false';

  if (!testnet) {
    required('BINANCE_API_KEY', process.env.BINANCE_API_KEY);
    required('BINANCE_SECRET_KEY', process.env.BINANCE_SECRET_KEY);
  }

  const strategy = process.env.STRATEGY || 'emaCrossover';
  if (!VALID_STRATEGIES.has(strategy)) {
    throw new Error(`Invalid STRATEGY "${strategy}". Must be one of: ${[...VALID_STRATEGIES].join(', ')}`);
  }

  const candleInterval = process.env.CANDLE_INTERVAL || '15m';
  if (!VALID_INTERVALS.has(candleInterval)) {
    throw new Error(`Invalid CANDLE_INTERVAL "${candleInterval}". Must be one of: ${[...VALID_INTERVALS].join(', ')}`);
  }

  const config = Object.freeze({
    apiKey: process.env.BINANCE_API_KEY || '',
    secretKey: process.env.BINANCE_SECRET_KEY || '',
    testnet,
    dryRun: process.env.DRY_RUN === 'true',
    confirmLiveTrading: process.env.CONFIRM_LIVE_TRADING === 'true',
    useServerTime: process.env.USE_SERVER_TIME !== 'false',
    webHost: (process.env.WEB_HOST || '127.0.0.1').trim() || '127.0.0.1',
    webPort: isNumber('WEB_PORT', process.env.WEB_PORT || '3000', 1, 65535),
    dashboardAdminToken: (process.env.DASHBOARD_ADMIN_TOKEN || '').trim(),
    feishuVerificationToken: (process.env.FEISHU_VERIFICATION_TOKEN || '').trim(),
    tradingPairs: (process.env.TRADING_PAIRS || 'BTCUSDT,ETHUSDT')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    maxLeverage: isNumber('MAX_LEVERAGE', process.env.MAX_LEVERAGE || '10', 1, 125),
    positionSizePct: isNumber('POSITION_SIZE_PCT', process.env.POSITION_SIZE_PCT || '5', 0.1, 100),
    maxOpenPositions: isNumber('MAX_OPEN_POSITIONS', process.env.MAX_OPEN_POSITIONS || '3', 1, 20),
    dailyLossCapPct: isNumber('DAILY_LOSS_CAP_PCT', process.env.DAILY_LOSS_CAP_PCT || '5', 0.1, 100),
    stopLossMode: (process.env.STOP_LOSS_MODE || 'pct').trim().toLowerCase() === 'atr' ? 'atr' : 'pct',
    stopLossPct: isNumber('STOP_LOSS_PCT', process.env.STOP_LOSS_PCT || '2', 0.1, 50),
    stopLossAtrMultiplier: isNumber('STOP_LOSS_ATR_MULTIPLIER', process.env.STOP_LOSS_ATR_MULTIPLIER || '2.0', 0.1, 20),
    takeProfitPct: isNumber('TAKE_PROFIT_PCT', process.env.TAKE_PROFIT_PCT || '4', 0.1, 100),
    takeProfitAtrMultiplier: isNumber('TAKE_PROFIT_ATR_MULTIPLIER', process.env.TAKE_PROFIT_ATR_MULTIPLIER || '4.0', 0.1, 50),
    warmupCandles: isNumber('WARMUP_CANDLES', process.env.WARMUP_CANDLES || '250', 0, 1000),
    strategy,
    emaFast: isNumber('EMA_FAST', process.env.EMA_FAST || '9', 2, 200),
    emaSlow: isNumber('EMA_SLOW', process.env.EMA_SLOW || '21', 2, 200),
    candleInterval,
    maxSlippage: isNumber('MAX_SLIPPAGE', process.env.MAX_SLIPPAGE || '0.005', 0, 1),
    orderRetryAttempts: isNumber('ORDER_RETRY_ATTEMPTS', process.env.ORDER_RETRY_ATTEMPTS || '3', 1, 10),
    logLevel: process.env.LOG_LEVEL || 'info',
    logDir: process.env.LOG_DIR || './logs',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    feishuWebhookUrl: process.env.FEISHU_WEBHOOK_URL || '',
    maxNotionalPerTrade: isNumber('MAX_NOTIONAL_PER_TRADE', process.env.MAX_NOTIONAL_PER_TRADE || '0', 0, 10000000),
    signalCooldownSeconds: isNumber('SIGNAL_COOLDOWN_SECONDS', process.env.SIGNAL_COOLDOWN_SECONDS || '300', 0, 86400),
    reconcileIntervalSeconds: isNumber('RECONCILE_INTERVAL_SECONDS', process.env.RECONCILE_INTERVAL_SECONDS || '300', 0, 3600),
    wsReconnectDelay: isNumber('WS_RECONNECT_DELAY', process.env.WS_RECONNECT_DELAY || '1000', 100, 60000),
    dashboardRefreshMs: isNumber('DASHBOARD_REFRESH_MS', process.env.DASHBOARD_REFRESH_MS || '2000', 200, 60000),
  });

  if (config.emaFast >= config.emaSlow) {
    throw new Error(`EMA_FAST (${config.emaFast}) must be less than EMA_SLOW (${config.emaSlow})`);
  }

  return config;
}

function printConfig(config) {
  console.log('\n=== Binance Trader Config ===');
  console.log(`  Environment:    ${config.testnet ? 'TESTNET' : 'LIVE TRADING'}`);
  console.log(`  Dry Run:        ${config.dryRun ? 'YES (no orders)' : 'NO'}`);
  console.log(`  API Key:        ${config.apiKey ? maskSecret(config.apiKey) : '(not set)'}`);
  console.log(`  Trading Pairs:  ${config.tradingPairs.join(', ')}`);
  console.log(`  Max Leverage:   ${config.maxLeverage}x`);
  console.log(`  Position Size:  ${config.positionSizePct}% per trade`);
  console.log(`  Max Positions:  ${config.maxOpenPositions}`);
  console.log(`  Daily Loss Cap: ${config.dailyLossCapPct}%`);
  console.log(`  Stop Loss:      ${config.stopLossMode === 'atr' ? `ATR ${config.stopLossAtrMultiplier}x` : `${config.stopLossPct}%`}`);
  console.log(`  Take Profit:    ${config.stopLossMode === 'atr' ? `ATR ${config.takeProfitAtrMultiplier}x` : `${config.takeProfitPct}%`}`);
  console.log(`  Strategy:       ${config.strategy}`);
  console.log(`  Warmup Candles: ${config.warmupCandles}`);
  console.log(`  EMA:            ${config.emaFast}/${config.emaSlow}`);
  console.log(`  Candle:         ${config.candleInterval}`);
  console.log(`  Slippage Cap:   ${(config.maxSlippage * 100).toFixed(2)}% (${config.maxSlippage > 0 ? 'LIMIT IOC' : 'MARKET'})`);
  console.log(`  Server Time:    ${config.useServerTime ? 'SYNC ENABLED' : 'LOCAL CLOCK'}`);
  console.log(`  Web Dashboard:  http://${config.webHost}:${config.webPort} (${config.dashboardAdminToken ? 'token-protected' : 'loopback-only'})`);
  console.log('==============================\n');
}

module.exports = { loadConfig, printConfig };

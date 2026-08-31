const path = require('path');
const dotenv = require('dotenv');
const { required, isNumber, maskSecret } = require('./utils/validators');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

function loadConfig() {
  const testnet = process.env.BINANCE_TESTNET !== 'false';

  if (!testnet) {
    required('BINANCE_API_KEY', process.env.BINANCE_API_KEY);
    required('BINANCE_SECRET_KEY', process.env.BINANCE_SECRET_KEY);
  }

  const config = Object.freeze({
    apiKey: process.env.BINANCE_API_KEY || '',
    secretKey: process.env.BINANCE_SECRET_KEY || '',
    testnet,
    dryRun: process.env.DRY_RUN === 'true',
    tradingPairs: (process.env.TRADING_PAIRS || 'BTCUSDT,ETHUSDT')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    maxLeverage: isNumber('MAX_LEVERAGE', process.env.MAX_LEVERAGE || '10', 1, 125),
    positionSizePct: isNumber('POSITION_SIZE_PCT', process.env.POSITION_SIZE_PCT || '5', 0.1, 100),
    maxOpenPositions: isNumber('MAX_OPEN_POSITIONS', process.env.MAX_OPEN_POSITIONS || '3', 1, 20),
    dailyLossCapPct: isNumber('DAILY_LOSS_CAP_PCT', process.env.DAILY_LOSS_CAP_PCT || '5', 0.1, 100),
    stopLossPct: isNumber('STOP_LOSS_PCT', process.env.STOP_LOSS_PCT || '2', 0.1, 50),
    takeProfitPct: isNumber('TAKE_PROFIT_PCT', process.env.TAKE_PROFIT_PCT || '4', 0.1, 100),
    strategy: process.env.STRATEGY || 'emaCrossover',
    emaFast: isNumber('EMA_FAST', process.env.EMA_FAST || '9', 2, 200),
    emaSlow: isNumber('EMA_SLOW', process.env.EMA_SLOW || '21', 2, 200),
    candleInterval: process.env.CANDLE_INTERVAL || '15m',
    maxSlippage: isNumber('MAX_SLIPPAGE', process.env.MAX_SLIPPAGE || '0.005', 0, 1),
    orderRetryAttempts: isNumber('ORDER_RETRY_ATTEMPTS', process.env.ORDER_RETRY_ATTEMPTS || '3', 1, 10),
    logLevel: process.env.LOG_LEVEL || 'info',
    logDir: process.env.LOG_DIR || './logs',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    feishuWebhookUrl: process.env.FEISHU_WEBHOOK_URL || '',
    maxNotionalPerTrade: Number(process.env.MAX_NOTIONAL_PER_TRADE) || 0,
    signalCooldownSeconds: Number(process.env.SIGNAL_COOLDOWN_SECONDS) || 300,
    wsReconnectDelay: Number(process.env.WS_RECONNECT_DELAY) || 1000,
    dashboardRefreshMs: Number(process.env.DASHBOARD_REFRESH_MS) || 2000,
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
  console.log(`  Stop Loss:      ${config.stopLossPct}%`);
  console.log(`  Take Profit:    ${config.takeProfitPct}%`);
  console.log(`  Strategy:       ${config.strategy}`);
  console.log(`  EMA:            ${config.emaFast}/${config.emaSlow}`);
  console.log(`  Candle:         ${config.candleInterval}`);
  console.log('==============================\n');
}

module.exports = { loadConfig, printConfig };

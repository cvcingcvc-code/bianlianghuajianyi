const https = require('https');
const http = require('http');
const { URL } = require('url');

let config, eventBus, logger, repo, strategyEngine;

function init(cfg, bus, log, repository, strategy) {
  config = cfg; eventBus = bus; logger = log;
  repo = repository; strategyEngine = strategy;

  eventBus.on('positionOpened', (d) => {
    send(`🟢 开仓 | ${d.symbol} ${d.side || 'LONG'} | 数量:${d.quantity} | 价格:${d.entryPrice?.toFixed(4) || '—'}`);
  });

  eventBus.on('positionClosed', (d) => {
    const emoji = d.pnl >= 0 ? '🟢' : '🔴';
    const sign = d.pnl >= 0 ? '+' : '';
    send(`${emoji} 平仓 | ${d.symbol} | PnL:${sign}${d.pnl?.toFixed(2) || '0'} USDT | ${d.reason || '—'}`);
  });

  eventBus.on('strategySignal', (s) => {
    if (s.direction === 'LONG' || s.direction === 'SHORT') {
      send(`📊 信号 | ${s.symbol} ${s.direction} @ ${s.price?.toFixed(2) || '—'} | ${s.reason}`);
    }
  });

  eventBus.on('riskRejected', (s) => {
    if (s.reason?.includes('loss') || s.reason?.includes('breaker') || s.reason?.includes('margin') || s.reason?.includes('Margin') || s.reason?.includes('Circuit')) {
      send(`⚠️ 风控拒绝 | ${s.signal?.symbol} | ${s.reason}`);
    }
  });

  const onBreakerTripped = (b) => {
    send(`🚨 熔断触发 | ${b.reason} | ${b.durationMinutes ?? 60}分钟`);
  };
  eventBus.on('circuitBreakerTripped', onBreakerTripped);
  eventBus.on('breakerTripped', onBreakerTripped);

  eventBus.on('dailyLimitReached', (d) => {
    send(`🛑 日内亏损上限 | 亏损:${d.loss?.toFixed(2) || '—'} USDT`);
  });

  eventBus.on('reconcileAlert', (a) => {
    if (a.type === 'missing_sl_repaired') {
      send(`🛡️ 对账自愈 | ${a.symbol} ${a.side} 检测到缺失止损单，已自动补挂 STOP_MARKET @ ${a.stopLossPrice}`);
    } else if (a.type === 'missing_sl_failed') {
      send(`🚨 对账严重告警 | ${a.symbol} ${a.side} 缺失止损且自动补挂失败: ${a.error || '未知错误'}`);
    } else if (a.type === 'ghost_position_removed') {
      send(`🧹 对账同步 | ${a.symbol} 交易所已无持仓，已清理本地残留记录`);
    }
  });

  logger.info(`Notifier ready (Feishu: ${Boolean(config?.feishuWebhookUrl)}, Telegram: ${Boolean(config?.telegramBotToken && config?.telegramChatId)})`);
}

function send(text) {
  sendFeishu(text);
  sendTelegram(text);
}

function sendFeishu(text) {
  const url = config?.feishuWebhookUrl;
  if (!url) return;

  const body = JSON.stringify({
    msg_type: 'text',
    content: { text: `[Binance Trader] ${text}` }
  });

  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const req = mod.request({
    hostname: u.hostname,
    port: u.port,
    path: u.pathname + u.search,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  }, (res) => {
    if (res.statusCode !== 200) {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { logger.warn(`Feishu ${res.statusCode}: ${data}`); } catch (e) {} });
    }
  });
  req.on('error', (e) => { logger.warn(`Feishu send failed: ${e.message}`); });
  req.write(body);
  req.end();
}

function sendTelegram(text) {
  const token = config?.telegramBotToken;
  const chatId = config?.telegramChatId;
  if (!token || !chatId) return;

  const body = JSON.stringify({
    chat_id: chatId,
    text: `*Binance Trader*\n${text}`,
    parse_mode: 'Markdown',
  });

  const req = https.request({
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 10000,
  }, (res) => {
    if (res.statusCode !== 200) {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { logger.warn(`Telegram ${res.statusCode}: ${data}`); } catch (e) {}
      });
    }
  });
  req.on('error', (e) => {
    logger.warn(`Telegram send failed: ${e.message}`);
  });
  req.write(body);
  req.end();
}

function sendSummary() {
  if (!repo || !config.feishuWebhookUrl) return;
  const stats = repo.getDailyStats();
  const positions = repo.getOpenPositions();
  const breakers = repo.getBreakerState();
  const tripped = Object.values(breakers).find(b => b.tripped);

  let msg = `**📊 定时报告**\n`;
  msg += `余额: ${(stats.currentBalance || 0).toFixed(2)} USDT | 净PnL: ${(stats.realizedPnl >= 0 ? '+' : '')}${(stats.realizedPnl || 0).toFixed(2)} (手续费: ${(stats.totalCommission || 0).toFixed(2)})\n`;
  msg += `交易: ${stats.tradeCount || 0}次 | 胜率: ${stats.tradeCount > 0 ? (stats.winningTrades / stats.tradeCount * 100).toFixed(0) : '—'}%\n`;
  msg += `持仓: ${positions.length}/${config.maxOpenPositions}`;
  if (tripped) msg += ` | ⚠️熔断:${tripped.reason}`;
  msg += `\n`;
  if (positions.length > 0) {
    for (const p of positions) {
      msg += `• ${p.symbol} | 入场:${p.entryPrice.toFixed(4)} | 数量:${p.quantity} | ${p.leverage}x\n`;
    }
  }
  send(msg);
}

module.exports = { init, send, sendSummary, sendFeishu, sendTelegram };

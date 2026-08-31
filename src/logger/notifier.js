const https = require('https');
const http = require('http');
const { URL } = require('url');

let config, eventBus, logger, repo, strategyEngine;

function init(cfg, bus, log, repository, strategy) {
  config = cfg; eventBus = bus; logger = log;
  repo = repository; strategyEngine = strategy;

  eventBus.on('positionOpened', (d) => {
    send(`🟢 开仓 | ${d.symbol} LONG | 数量:${d.quantity} | 价格:${d.entryPrice?.toFixed(4) || '—'}`);
  });

  eventBus.on('positionClosed', (d) => {
    const emoji = d.pnl >= 0 ? '🟢' : '🔴';
    const sign = d.pnl >= 0 ? '+' : '';
    send(`${emoji} 平仓 | ${d.symbol} | PnL:${sign}${d.pnl?.toFixed(2) || '0'} USDT | ${d.reason || '—'}`);
  });

  eventBus.on('strategySignal', (s) => {
    if (s.direction === 'LONG') {
      send(`📊 信号 | ${s.symbol} LONG @ ${s.price?.toFixed(2) || '—'} | ${s.reason}`);
    }
  });

  eventBus.on('riskRejected', (s) => {
    if (s.reason?.includes('loss') || s.reason?.includes('breaker') || s.reason?.includes('margin')) {
      send(`⚠️ 风控拒绝 | ${s.signal?.symbol} | ${s.reason}`);
    }
  });

  eventBus.on('breakerTripped', (b) => {
    send(`🚨 熔断触发 | ${b.reason} | ${b.durationMinutes}分钟`);
  });

  eventBus.on('dailyLimitReached', (d) => {
    send(`🛑 日内亏损上限 | 亏损:${d.loss?.toFixed(2) || '—'} USDT`);
  });

  logger.info('Notifier ready (Feishu)');
}

function send(text) {
  const url = config.feishuWebhookUrl;
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

function sendSummary() {
  if (!repo || !config.feishuWebhookUrl) return;
  const stats = repo.getDailyStats();
  const positions = repo.getOpenPositions();
  const breakers = repo.getBreakerState();
  const tripped = Object.values(breakers).find(b => b.tripped);

  let msg = `**📊 定时报告**\n`;
  msg += `余额: ${(stats.currentBalance || 0).toFixed(2)} USDT | PnL: ${(stats.realizedPnl >= 0 ? '+' : '')}${(stats.realizedPnl || 0).toFixed(2)}\n`;
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

module.exports = { init, sendSummary };

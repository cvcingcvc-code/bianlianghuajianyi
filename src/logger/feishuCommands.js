// Feishu command handler — receive commands from Feishu, control the bot
let config, repo, eventBus, logger, orderExecutor, strategyEngine;

let tradingPaused = false;
const commands = {};

function init(cfg, repository, bus, log, executor, strategy) {
  config = cfg; repo = repository; eventBus = bus; logger = log;
  orderExecutor = executor; strategyEngine = strategy;

  register('status', cmdStatus);
  register('positions', cmdPositions);
  register('close', cmdClose);
  register('pause', cmdPause);
  register('resume', cmdResume);
  register('strategy', cmdStrategy);
  register('help', cmdHelp);
}

function register(name, fn) { commands[name] = fn; }

function handleMessage(text, reply) {
  const content = text.trim();
  if (!content.startsWith('/')) return false;

  const parts = content.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (!commands[cmd]) { reply('未知命令。发送 /help 查看可用命令'); return true; }

  try { commands[cmd](args, reply); }
  catch (e) { logger.error(`Command error: ${e.message}`); reply(`命令失败: ${e.message}`); }
  return true;
}

function cmdStatus(args, reply) {
  const stats = repo.getDailyStats();
  const positions = repo.getOpenPositions();
  const breakerState = repo.getBreakerState();
  const tripped = Object.values(breakerState).find(b => b.tripped);
  let msg = `**📊 账户状态**\n余额: **${(stats.currentBalance || 0).toFixed(2)}** USDT\n`;
  msg += `已实现盈亏: **${(stats.realizedPnl || 0).toFixed(2)}** USDT\n`;
  msg += `交易次数: ${stats.tradeCount || 0} | 胜率: ${stats.tradeCount > 0 ? (stats.winningTrades / stats.tradeCount * 100).toFixed(0) : '—'}%\n`;
  msg += `策略: **${strategyEngine.getStatus().name}** | ${tradingPaused ? '⏸️已暂停' : '✅运行中'}\n`;
  if (tripped) msg += `⚠️ 熔断: ${tripped.reason}\n`;
  msg += `\n**持仓 (${positions.length}/${config.maxOpenPositions})**:\n`;
  if (positions.length === 0) { msg += `(无持仓)\n`; }
  else { for (const p of positions) msg += `• ${p.symbol} | 入场:${p.entryPrice.toFixed(4)} | 数量:${p.quantity} | ${p.leverage}x\n`; }
  reply(msg);
}

function cmdPositions(args, reply) {
  const positions = repo.getOpenPositions();
  if (positions.length === 0) { reply('当前无持仓'); return; }
  let msg = '**持仓列表**:\n';
  for (const p of positions) msg += `• ${p.symbol} | 入场:${p.entryPrice.toFixed(4)} | 数量:${p.quantity}\n`;
  reply(msg);
}

function cmdClose(args, reply) {
  if (args.length === 0) { reply('用法: /close SYMBOL (例如: /close ETHUSDT)'); return; }
  const symbol = args[0].toUpperCase();
  const pos = repo.getPosition(symbol);
  if (!pos) { reply(`${symbol} 无持仓`); return; }
  repo.removePosition(symbol);
  eventBus.emit('positionClosed', { symbol, pnl: 0, pnlPct: 0, reason: '手动平仓(Feishu)' });
  reply(`✅ 已平仓 ${symbol}`);
}

function cmdPause(args, reply) {
  tradingPaused = true;
  eventBus.emit('tradingPaused');
  reply('⏸️ 交易已暂停（平仓信号仍执行）');
}

function cmdResume(args, reply) {
  tradingPaused = false;
  eventBus.emit('tradingResumed');
  reply('▶️ 交易已恢复');
}

function cmdStrategy(args, reply) {
  const available = ['emaCrossover', 'rsiEma'];
  if (args.length === 0) {
    reply(`当前: ${strategyEngine.getStatus().name}\n可用: ${available.join(', ')}`);
    return;
  }
  const name = args[0];
  if (!available.includes(name)) { reply(`未知策略: ${name}`); return; }
  reply(`⚠️ 切换策略需重启并修改 .env: STRATEGY=${name}`);
}

function cmdHelp(args, reply) {
  reply(`**命令列表**:\n` +
    `/status — 查看账户状态\n/positions — 持仓列表\n` +
    `/close SYMBOL — 手动平仓\n/pause — 暂停开仓\n` +
    `/resume — 恢复开仓\n/strategy — 查看策略\n/help — 帮助`);
}

function isPaused() { return tradingPaused; }

module.exports = { init, handleMessage, isPaused };

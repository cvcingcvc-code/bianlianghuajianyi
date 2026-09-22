// Translate display values only; API values and trading decisions remain unchanged.
const labels = {
  "DRY_RUN": "模拟回放",
  "TESTNET": "测试网",
  "CONNECTED": "已连接",
  "DISCONNECTED": "未连接",
  "STALE": "行情已过期",
  "available": "可用",
  "unavailable": "不可用",
  "READY": "就绪",
  "MARKET_UNHEALTHY": "行情异常",
  "ACCOUNT_UNAVAILABLE": "账户不可用",
  "RISK_BLOCKED": "风控已阻止",
  "API_UNAVAILABLE": "接口不可用",
  "breakout24h4h": "24 小时突破（4 小时周期）",
  "OFFICIAL_ARCHIVE_REPLAY": "官方历史数据回放",
  "BINANCE_TESTNET": "币安测试网",
  "LONG": "做多",
  "SHORT": "做空",
  "HOLD": "观望",
  "CLOSE": "平仓",
  "ALLOW": "允许",
  "BLOCK": "阻止",
  "APPROVE": "通过",
  "REJECT": "拒绝",
  "NOT_EVALUATED": "未评估",
  "FILTERED": "已过滤",
  "REJECTED": "已拒绝",
  "DRY_RUN_FILLED": "模拟已成交",
  "FILLED": "已成交",
  "QUEUED": "等待下一根开盘",
  "VALIDATED_ONLY": "仅校验订单",
  "EXECUTION_FAILED": "执行失败",
  "bullish": "看涨",
  "bearish": "看跌",
  "neutral": "中性",
  "Existing Risk Manager approved": "风控审核通过",
  "No actionable technical signal": "暂无可执行的技术信号",
  "Market data is stale or disconnected": "行情已过期或连接中断",
  "Account state unavailable": "账户状态不可用",
  "Daily loss state unavailable": "当日亏损状态不可用",
  "No position / no risk approval": "无持仓或未获风控批准",
  "Sentiment blocked LONG": "舆情已阻止做多",
  "Adapter rejected execution": "执行适配器拒绝订单",
  "Strong bearish sentiment filters LONG": "强烈看跌舆情过滤做多信号",
  "Sentiment unavailable; defer unchanged technical signal to risk": "舆情不可用，技术信号交由风控判断",
  "Sentiment permits risk evaluation": "舆情允许进入风控评估",
  "Trading paused (Feishu)": "交易已暂停（飞书）",
  "Circuit breaker tripped": "已触发熔断",
  "Daily loss cap exceeded": "已达到当日亏损上限",
  "Invalid balance/price": "余额或价格无效",
  "Notional too small": "订单名义金额过小",
  "Quantity zero after rounding": "数量取整后为零",
  "SL above entry": "止损价高于入场价",
  "TP below entry": "止盈价低于入场价",
  "R:R < 1:1": "盈亏比低于 1:1"
};
const zh = value => labels[value] ?? (typeof value === 'string' ? value.replace(/^Max positions \((\d+)\)$/, '已达到持仓上限（$1）').replace(/^Already have (\w+) position$/, '已持有 $1 仓位').replace(/^Margin ratio (.+) < 200%$/, '保证金比率 $1 低于 200%') : value);
const $ = id => document.getElementById(id);
const text = (id, value) => { $(id).textContent = zh(value) ?? '—'; };
const number = (v, suffix = '') => Number.isFinite(v) ? v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + suffix : '—';
const time = v => v ? new Date(v).toISOString().replace('T', ' ').slice(0, 19) : '—';
function render(data) {
  const { status, market, strategyState: state, sentiment, metrics } = data;
  text('mode', status.mode); text('market-status', status.market.status); text('strategy', status.strategy);
  text('sentiment-status', status.sentiment); text('health', `系统：${zh(status.health)}`);
  text('sync', `接口更新于 ${new Date(status.updatedAt).toLocaleTimeString('zh-CN')}`);
  text('price', number(market.price)); text('source', market.source);
  text('market-time', `行情时间 ${time(market.marketTime)} UTC`);
  text('notice', status.mode === 'DRY_RUN' ? '官方 2025-01 历史回放 · 非实时价格 · 下一根 4 小时 开盘模拟成交 · 未接入新闻时舆情不可用 · 演示完毕后行情将变为过期状态' : '币安测试网 · 仅校验订单，不产生撮合成交 · 实盘已禁用');
  const decisionSentiment = state?.sentiment || sentiment;
  text('technical', state?.technicalSignal.direction); text('score', decisionSentiment.status === 'unavailable' ? '不可用' : number(decisionSentiment.score));
  text('sentiment-decision', state?.sentimentDecision.decision); text('risk-decision', state?.riskDecision.decision);
  text('reason', state ? `${time(state.technicalSignal.timestamp)} UTC · ${zh(state.sentimentDecision.reason)}。${zh(state.riskDecision.reason)}` : '等待已完成的 4 小时 K 线');
  text('equity', metrics.simulated ? number(metrics.equity) : '—'); text('pnl', number(metrics.dailyPnl));
  text('drawdown', number(metrics.maxDrawdown, '%')); text('positions', metrics.openPositions);
  text('pnl-day', `${metrics.day || 'UTC'} · 含浮盈亏`);
  text('last-message', `行情最近更新时间： ${time(status.market.lastMessageAt)} UTC`);
  const closes = market.candles.map(c => c.close);
  if (closes.length > 1) {
    const min = Math.min(...closes), span = Math.max(...closes) - min || 1;
    $('chart-path').setAttribute('d', closes.map((v, i) => `${i ? 'L' : 'M'}${i * 700 / (closes.length - 1)},${140 - (v - min) / span * 130}`).join(' '));
  }
  text('signal-count', `${data.recentSignals.length} 条信号`);
  $('signals').replaceChildren();
  for (const row of data.recentSignals) {
    const tr = document.createElement('tr');
    const s = row.technicalSignal;
    const reason = `${zh(row.reason)}${row.execution?.fill ? ` · 成交价 ${number(row.execution.fill.price)}，时间 ${time(row.execution.fill.timestamp)}` : ''}`;
    const values = [time(s.timestamp), s.symbol, s.direction, `${zh(row.sentimentDecision.decision)} / ${row.sentiment.status === 'available' ? zh(row.sentiment.label) : '不可用'}`, row.riskDecision.decision, row.finalDecision, reason];
    values.forEach((value, i) => { const td = document.createElement('td');
      if (i > 1 && i < 6) { const span = document.createElement('span'); span.textContent = zh(value); const status = i === 3 ? row.sentimentDecision.decision : value; span.className = `tag ${/REJECT|BLOCK|FILTERED|FAILED/.test(status) ? 'bad' : /LONG|APPROVE|FILLED/.test(status) ? 'good' : ''}`; td.append(span); }
      else td.textContent = zh(value);
      tr.append(td);
    });
    $('signals').append(tr);
  }
}
async function refresh() {
  try {
    const response = await fetch('/api/dashboard', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('本地接口请求失败');
    render(await response.json());
  } catch { text('sync', '本地接口 断开 · 显示最后一次快照'); text('health', '系统：接口不可用'); text('market-status', 'DISCONNECTED'); }
  setTimeout(refresh, 2000);
}
refresh();

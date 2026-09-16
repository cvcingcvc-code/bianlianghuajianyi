const $ = id => document.getElementById(id);
const text = (id, value) => { $(id).textContent = value ?? '—'; };
const number = (v, suffix = '') => Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + suffix : '—';
const time = v => v ? new Date(v).toISOString().replace('T', ' ').slice(0, 19) : '—';
function render(data) {
  const { status, market, strategyState: state, sentiment, metrics } = data;
  text('mode', status.mode); text('market-status', status.market.status); text('strategy', status.strategy);
  text('sentiment-status', status.sentiment); text('health', `System: ${status.health}`);
  text('sync', `API updated ${new Date(status.updatedAt).toLocaleTimeString()}`);
  text('price', number(market.price)); text('source', market.source);
  text('market-time', `行情时间 ${time(market.marketTime)} UTC`);
  text('notice', status.mode === 'DRY_RUN' ? '官方 2025-01 历史回放 · 非实时价格 · 下一根 4h 开盘模拟成交 · 未接入新闻时舆情 unavailable · 演示完毕后行情将变为 STALE' : 'Binance Testnet · 仅校验订单，不产生撮合成交 · LIVE DISABLED');
  const decisionSentiment = state?.sentiment || sentiment;
  text('technical', state?.technicalSignal.direction); text('score', decisionSentiment.status === 'unavailable' ? 'unavailable' : number(decisionSentiment.score));
  text('sentiment-decision', state?.sentimentDecision.decision); text('risk-decision', state?.riskDecision.decision);
  text('reason', state ? `${time(state.technicalSignal.timestamp)} UTC · ${state.sentimentDecision.reason}. ${state.riskDecision.reason}` : '等待已完成的 4h K 线');
  text('equity', metrics.simulated ? number(metrics.equity) : '—'); text('pnl', number(metrics.dailyPnl));
  text('drawdown', number(metrics.maxDrawdown, '%')); text('positions', metrics.openPositions);
  text('pnl-day', `${metrics.day || 'UTC'} · 含浮盈亏`);
  text('last-message', `Market lastMessageAt: ${time(status.market.lastMessageAt)} UTC`);
  const closes = market.candles.map(c => c.close);
  if (closes.length > 1) {
    const min = Math.min(...closes), span = Math.max(...closes) - min || 1;
    $('chart-path').setAttribute('d', closes.map((v, i) => `${i ? 'L' : 'M'}${i * 700 / (closes.length - 1)},${140 - (v - min) / span * 130}`).join(' '));
  }
  text('signal-count', `${data.recentSignals.length} SIGNALS`);
  $('signals').replaceChildren();
  for (const row of data.recentSignals) {
    const tr = document.createElement('tr');
    const s = row.technicalSignal;
    const reason = `${row.reason}${row.execution?.fill ? ` · Fill ${number(row.execution.fill.price)} @ ${time(row.execution.fill.timestamp)}` : ''}`;
    const values = [time(s.timestamp), s.symbol, s.direction, `${row.sentimentDecision.decision} / ${row.sentiment.status === 'available' ? row.sentiment.label : 'unavailable'}`, row.riskDecision.decision, row.finalDecision, reason];
    values.forEach((value, i) => { const td = document.createElement('td');
      if (i > 1 && i < 6) { const span = document.createElement('span'); span.textContent = value; span.className = `tag ${/REJECT|BLOCK|FILTERED|FAILED/.test(value) ? 'bad' : /LONG|APPROVE|FILLED/.test(value) ? 'good' : ''}`; td.append(span); }
      else td.textContent = value;
      tr.append(td);
    });
    $('signals').append(tr);
  }
}
async function refresh() {
  try {
    const response = await fetch('/api/dashboard', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Local API failed');
    render(await response.json());
  } catch { text('sync', '本地 API 断开 · 显示最后一次快照'); text('health', 'System: API_UNAVAILABLE'); text('market-status', 'DISCONNECTED'); }
  setTimeout(refresh, 2000);
}
refresh();

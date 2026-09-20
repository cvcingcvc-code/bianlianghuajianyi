const el = id => document.getElementById(id);
const percent = x => Number.isFinite(x) ? `${(100 * x).toFixed(2)}%` : '—';
const number = x => Number.isFinite(x) ? x.toFixed(4) : '—';
function add(parent, tag, text) { const e = document.createElement(tag); e.textContent = text; parent.append(e); return e; }
fetch('/api/report').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(report => {
  el('status').textContent = `预测验收：${report.forecastGate} · 自动开仓未启用（仍需执行与净收益验证）`;
  el('asof').textContent = `历史预测时点：${new Date(report.latest.asOf).toISOString()} · ETH ${report.latest.price.toFixed(2)} USDT`;
  for (const [key, f] of Object.entries(report.latest.forecasts)) {
    const card = add(el('forecasts'), 'article', ''); card.className = 'card';
    add(card, 'h2', key === '30m' ? '未来 30 分钟' : '未来一周');
    add(card, 'strong', f.status === 'INSUFFICIENT_DATA' ? '样本不足' : `${percent(f.estimate.upProbability)} 上涨概率`);
    if (f.estimate) {
      add(card, 'p', `经验 80% 价格区间：${f.estimate.lowerPrice.toFixed(2)} – ${f.estimate.upperPrice.toFixed(2)} USDT`);
      add(card, 'p', `中位收益 ${percent(Math.expm1(f.estimate.medianReturn))} · ${f.estimate.samples} 个不重叠历史标签`);
    }
    add(card, 'p', `目标时间 ${new Date(f.targetTime).toISOString()} · 概率尚未经校准认证`);
  }
  for (const [key, h] of Object.entries(report.horizons)) for (const [year, s] of Object.entries({ ...h.years, ALL: h.overall })) {
    const row = add(el('scores'), 'tr', '');
    [key + ' / ' + year, s.count, percent(s.availability), `${number(s.brier)} / ${number(s.baselineBrier)}`,
      `${percent(s.mae)} / ${percent(s.baselineMae)}`, percent(s.coverage), (year === 'ALL' ? h.pass : s.pass) ? 'PASS' : 'FAIL'].forEach(x => add(row, 'td', x));
  }
  el('decision').textContent = `最后一个历史时点：${report.latestPlan.action} · ${report.latestPlan.reason || report.latestPlan.side}。该条件信号不构成已验证开仓授权。`;
  el('counts').textContent = Object.entries(report.decisions).map(([k, v]) => `${k}: ${v}`).join('\n');
  if (!report.paper.length) add(el('paper'), 'p', '未运行探索性模拟。可显式传入 --exploratory-paper。');
  for (const p of report.paper) {
    const card = add(el('paper'), 'article', ''); card.className = 'card';
    add(card, 'h2', p.scenario); add(card, 'strong', `${p.pnlBeforeFunding.toFixed(2)} USDT`);
    add(card, 'p', '模拟损益 · 已扣手续费与滑点 / 未计资金费率');
    add(card, 'p', `${p.gridsOpened} 次开网格 · ${p.fills} 次成交 · 回撤 ${percent(p.maxDrawdownBeforeFunding)}`);
  }
}).catch(() => { el('status').textContent = '结果加载失败，自动开仓保持禁用。'; });

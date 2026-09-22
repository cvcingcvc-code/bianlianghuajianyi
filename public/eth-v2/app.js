const el = id => document.getElementById(id);
const set = (id, value) => { el(id).textContent = value ?? '—'; };
const n = v => Number.isFinite(v) ? v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '—';
const pct = v => Number.isFinite(v) ? `${n(v * 100)}%` : '—';
const time = t => t ? `${new Date(t).toISOString().replace('T', ' ').slice(0, 19)} UTC` : '尚未开始';
const names = { IDLE:'未启动', RUNNING:'回放中', PAUSED:'已暂停并保存', COMPLETED:'回放完成 · 已处理期末持仓', ERROR:'运行异常', PASS:'通过', FAIL:'失败', INCOMPLETE:'验证不完整', NO_TRADES:'无交易 · 不代表通过', INSUFFICIENT_EVIDENCE:'证据不足', LONG:'做多', SHORT:'做空', WAIT:'等待', OPEN:'满足诊断开仓条件',
  DATA_INCOMPLETE:'资金费或对应标记价格不完整，拒绝开仓', MODEL_OR_CALIBRATION_UNAVAILABLE:'模型样本或内部校准不可用', DIRECTION_UNCERTAIN:'方向与收益分布不足以支持交易', EDGE_BELOW_FULL_COST_AND_MARGIN:'预期收益不足以覆盖压力成本、资金费预算与安全余量', INTERVAL_TOO_WIDE:'预测区间过宽', RISK_LIMIT:'已触发账户风控限制', VALIDATION_NOT_PASSED:'预测或交易验收未通过', NOT_STARTED:'回放尚未开始',
  DISTRIBUTION_AND_COST_QUALIFIED:'方向、收益分布与成本条件满足；仅允许未验证诊断模拟', STOP_LOSS:'止损', TAKE_PROFIT:'止盈', STOP_LOSS_AMBIGUOUS_BAR:'同根止损止盈冲突 · 止损优先', TIMEOUT:'四小时到期', REVERSE_SIGNAL:'反向信号退出', END_OF_REPLAY:'回放结束强制平仓' };
const zh = x => names[x] || x;
let busy = false, last = null;
function render(s) {
  last = s; set('connection', `${zh(s.state)} · 市场时间 ${time(s.marketTime)}`);
  el('progress').value = s.progress; set('progress-label', `${pct(s.progress)} · ${s.processed.toLocaleString('zh-CN')} / ${s.total.toLocaleString('zh-CN')} 根历史 15 分钟 K 线`);
  el('start').disabled = busy || ['RUNNING','COMPLETED','ERROR'].includes(s.state);
  el('pause').disabled = busy || s.state !== 'RUNNING'; el('step').disabled = busy || ['RUNNING','COMPLETED','ERROR'].includes(s.state);
  if (s.error) set('control-error', s.error);
  const f = s.forecast;
  set('model-state', f?.status === 'AVAILABLE' ? '历史预测已生成' : '尚无可用预测');
  if (f) {
    set('forecast-time', `预测于 ${time(f.time)}；目标 ${time(f.targetTime)}`);
    set('up', pct(f.up)); set('down', pct(f.down)); el('probability-bar').style.width = `${(f.up ?? 0.5) * 100}%`;
    set('median', pct(Math.expm1(f.median))); set('interval', `${pct(Math.expm1(f.lower))} ～ ${pct(Math.expm1(f.upper))}`);
    set('calibration', f.calibrated ? '已做内部校准 · 可靠性另见验收' : '未校准');
    set('training', `${f.samples ?? 0} 训练 / ${f.calibrationSamples ?? 0} 校准样本；截止 ${time(f.trainingCutoff)}；${f.version}`);
  }
  set('decision', zh(s.decision.action)); set('reason', zh(s.decision.reason));
  const p = s.position; set('side', p ? zh(p.side) : '空仓'); set('entry', p ? `${n(p.entryPrice)} USDT / ${n(p.quantity)} ETH` : '—');
  set('protection', p ? `${n(p.stopLossPrice)} / ${n(p.takeProfitPrice)}` : '—'); set('exit', s.lastExit ? `${zh(s.lastExit.reason)} · ${time(s.lastExit.exitTime)}` : '尚无平仓');
  for (const id of ['equity','realized','unrealized','fees','slippage']) set(id, n(s[id]));
  set('drawdown', pct(s.maxDrawdown)); set('trades', s.trades);
  set('funding', s.netComplete ? n(s.funding) : `不完整（已知部分 ${n(s.knownFunding)}）`);
  set('net-quality', s.netComplete ? '本地模拟 · 非真实资金' : '已知现金流估值 · 净验证不完整');
}
async function refresh() {
  try { if (!busy) { const r = await fetch('/api/status', { signal: AbortSignal.timeout(5000) }); if (!r.ok) throw new Error(); render(await r.json()); } }
  catch { set('connection', '连接异常 · 显示最后快照，运行状态未知'); ['start','pause','step'].forEach(id => { el(id).disabled = true; }); }
  finally { setTimeout(refresh, 1000); }
}
async function control(action) {
  if (busy) return; busy = true; if (last) render(last); set('control-error', '');
  try { const r = await fetch(`/api/${action}`, { method:'POST', headers:{ 'X-ETH-V2-Control':'1' }, signal: AbortSignal.timeout(10000) }); const s = await r.json(); if (!r.ok) throw new Error(s.error); busy = false; render(s); }
  catch (e) { set('control-error', `操作未确认：${e.message}，请等待状态重新同步。`); }
  finally { busy = false; }
}
function row(id, values) { const tr = document.createElement('tr'); for (const value of values) { const td = document.createElement('td'); td.textContent = value; tr.append(td); } el(id).append(tr); }
for (const action of ['start','pause','step']) el(action).addEventListener('click', () => control(action));
fetch('/api/report').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(r => {
  set('forecast-gate', zh(r.forecast.status)); set('trade-gate', zh(r.trading.status));
  set('data-gate', r.data.funding.complete ? '归档完整 · 分钟标记价格代理' : `${r.data.funding.problems.length} 项缺失 / 异常`);
  set('report-explanation', '预测与交易分开验收。失败保持失败；数据不完整和零交易均不能视为成功。');
  set('provenance', `预登记 ${r.preregistration} · 代码 ${r.codeCommit.slice(0,7)} · 本候选不接实盘`);
  for (const [year, s] of Object.entries(r.forecast.years)) row('scores', [year,s.count,`${n(s.brier)} / ${n(s.unconditionalBrier)} / ${n(s.trendBrier)}`,`${pct(s.mae)} / ${pct(s.zeroMae)} / ${pct(s.trendMae)}`,pct(s.coverage),pct(s.width)]);
  for (const [name, s] of [['V2 基准成本',r.base],['V2 压力成本',r.stress],['固定趋势 · 基准成本',r.benchmark],['固定趋势 · 压力成本',r.benchmarkStress]]) row('comparisons',[name,s.count,n(s.gross),n(s.fees),n(s.slippage),r.data.funding.complete?n(s.funding):`已知 ${n(s.funding)}`,s.netValidated===null?'不完整':n(s.netValidated),pct(s.maxDrawdown)]);
  row('comparisons',['空仓基准',0,0,0,0,0,0,'0%']);
  const failure = x => x.includes('BRIER') ? `${x.split(':')[0]}：方向概率未显著优于基准` : x.includes('MAE') ? `${x.split(':')[0]}：收益预测误差未优于基准` : x.includes('COVERAGE') ? '预测区间覆盖率未达标' : x.includes('CALIBRATION') ? '概率校准误差未达标' : x.includes('FUNDING') ? '真实资金费或对应标记价格不完整' : zh(x);
  set('details', [...r.forecast.failures.map(failure), ...r.trading.failures.map(failure), ...r.data.funding.problems.map(x => x.startsWith('Missing settlement mark ') ? `缺少结算对应分钟标记价：${time(Number(x.split(' ').at(-1)))}` : x)].join('\n'));
}).catch(() => { set('forecast-gate','报告加载失败'); set('trade-gate','未知 · 禁止已验证开仓'); });
refresh();

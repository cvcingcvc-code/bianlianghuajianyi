const { mean } = require('./model');
const { Simulator } = require('./simulator');
const { decide } = require('../research/strategies/ethPredictionV2');
const WEEK = 7 * 86400000;
function blockCI(rows, value, time = r => r.time) {
  const groups = new Map();
  for (const r of rows) { const key = Math.floor(time(r) / WEEK); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(value(r)); }
  const blocks = [...groups.values()].map(mean), n = blocks.length, average = mean(blocks);
  const se = n > 1 ? Math.sqrt(blocks.reduce((s, x) => s + (x - average) ** 2, 0) / (n - 1) / n) : null;
  return { meanBlockDifference: average, lower: se === null ? null : average - 1.96 * se, upper: se === null ? null : average + 1.96 * se,
    effectiveSampleProxy: n, method: 'UTC_7_DAY_BLOCK_NORMAL_APPROXIMATION', warning: 'Blocks may remain dependent; not an exact confidence guarantee' };
}
const loss = (p, y) => (p - Number(y > 0)) ** 2;
function forecastStats(rows) {
  if (!rows.length) return { count: 0 };
  const bins = Array.from({ length: 5 }, (_, i) => {
    const group = rows.filter(r => Math.min(4, Math.floor(r.up * 5)) === i);
    return { lower: i / 5, upper: (i + 1) / 5, count: group.length, predicted: mean(group.map(r => r.up)), observed: mean(group.map(r => Number(r.actual > 0))) };
  });
  return { count: rows.length, brier: mean(rows.map(r => loss(r.up, r.actual))), rawBrier: mean(rows.map(r => loss(r.rawUp, r.actual))),
    unconditionalBrier: mean(rows.map(r => loss(r.unconditional, r.actual))), trendBrier: mean(rows.map(r => loss(r.trendUp, r.actual))),
    mae: mean(rows.map(r => Math.abs(r.actual - r.median))), zeroMae: mean(rows.map(r => Math.abs(r.actual))), trendMae: mean(rows.map(r => Math.abs(r.actual - r.trendMedian))),
    coverage: mean(rows.map(r => Number(r.actual >= r.lower && r.actual <= r.upper))), width: mean(rows.map(r => r.upper - r.lower)),
    baselineCoverage: mean(rows.map(r => Number(r.actual >= r.baselineInterval[0] && r.actual <= r.baselineInterval[1]))),
    baselineWidth: mean(rows.map(r => r.baselineInterval[1] - r.baselineInterval[0])),
    ece: bins.reduce((s, b) => s + b.count / rows.length * (b.count ? Math.abs(b.predicted - b.observed) : 0), 0), bins,
    brierVsUnconditional: blockCI(rows, r => loss(r.up, r.actual) - loss(r.unconditional, r.actual)),
    brierVsTrend: blockCI(rows, r => loss(r.up, r.actual) - loss(r.trendUp, r.actual)),
    maeVsZero: blockCI(rows, r => Math.abs(r.actual - r.median) - Math.abs(r.actual)),
    maeVsTrend: blockCI(rows, r => Math.abs(r.actual - r.median) - Math.abs(r.actual - r.trendMedian)) };
}
function forecastEvaluation(predictions) {
  const eligible = predictions.filter(r => Number.isFinite(r.actual)), rows = eligible.filter(r => r.status === 'AVAILABLE');
  const overall = forecastStats(rows), years = {}, regimes = {};
  for (const year of [2023, 2024, 2025]) years[year] = forecastStats(rows.filter(r => new Date(r.time).getUTCFullYear() === year));
  for (const regime of ['UP', 'DOWN', 'RANGE']) regimes[regime] = forecastStats(rows.filter(r => r.regime === regime));
  const availability = eligible.length ? rows.length / eligible.length : 0, failures = [];
  const insufficient = rows.length < 2000 || Object.values(years).some(y => y.count < 500) || (overall.brierVsTrend?.effectiveSampleProxy ?? 0) < 20;
  if (availability < 0.95) failures.push('AVAILABILITY_BELOW_95_PERCENT');
  for (const [label, s] of Object.entries({ overall, ...years })) {
    if (!(s.brier < s.unconditionalBrier && s.brier < s.trendBrier)) failures.push(`${label}:BRIER_NOT_BETTER_THAN_BOTH_BASELINES`);
    if (!(s.mae < s.zeroMae && s.mae < s.trendMae)) failures.push(`${label}:MAE_NOT_BETTER_THAN_BOTH_BASELINES`);
  }
  if (!(overall.brierVsUnconditional?.upper < 0 && overall.brierVsTrend?.upper < 0)) failures.push('BRIER_IMPROVEMENT_CI_NOT_NEGATIVE');
  if (!(overall.coverage >= 0.75 && overall.coverage <= 0.85)) failures.push('COVERAGE_OUTSIDE_75_85_PERCENT');
  if (!(overall.ece <= 0.05)) failures.push('CALIBRATION_ECE_ABOVE_5_PERCENT');
  return { status: insufficient ? 'INSUFFICIENT_EVIDENCE' : failures.length ? 'FAIL' : 'PASS', failures, availability, overall, years, regimes,
    evidence: 'REUSED_DEVELOPMENT_DATA_NOT_PRISTINE_HOLDOUT' };
}
function tradesStats(trades) {
  const wins = trades.filter(t => t.net > 0), losses = trades.filter(t => t.net < 0);
  const positive = wins.reduce((s, t) => s + t.net, 0), negative = -losses.reduce((s, t) => s + t.net, 0);
  return { count: trades.length, gross: trades.reduce((s, t) => s + t.gross, 0), slippage: trades.reduce((s, t) => s + t.slippage, 0),
    fees: trades.reduce((s, t) => s + t.fees, 0), funding: trades.reduce((s, t) => s + t.funding, 0), net: positive - negative,
    winRate: trades.length ? wins.length / trades.length : null, averageWin: mean(wins.map(t => t.net)), averageLoss: mean(losses.map(t => t.net)),
    expectancy: mean(trades.map(t => t.net)), profitFactor: negative > 0 ? positive / negative : null, noLosses: losses.length === 0,
    averageHoldingHours: mean(trades.map(t => t.heldMs / 3600000)), topFiveShare: positive ? wins.map(t => t.net).sort((a, b) => b - a).slice(0, 5).reduce((s, v) => s + v, 0) / positive : null };
}
function tradingStats(sim) {
  const s = sim.s, stats = tradesStats(s.trades), years = {}, regimes = {}, sides = {};
  for (const y of [2023, 2024, 2025]) years[y] = tradesStats(s.trades.filter(t => new Date(t.exitTime).getUTCFullYear() === y));
  for (const r of ['UP', 'DOWN', 'RANGE']) regimes[r] = tradesStats(s.trades.filter(t => t.regime === r));
  for (const side of ['LONG', 'SHORT']) sides[side] = tradesStats(s.trades.filter(t => t.side === side));
  const positiveYears = Object.values(years).filter(y => y.net > 0).map(y => y.net);
  const weeks = new Map();
  for (let time = Date.UTC(2023, 0, 1); time < Date.UTC(2026, 0, 1); time += WEEK) weeks.set(Math.floor(time / WEEK), 0);
  for (const t of s.trades) { const key = Math.floor(t.exitTime / WEEK); weeks.set(key, (weeks.get(key) || 0) + t.net); }
  const ci = blockCI([...weeks].map(([key, net]) => ({ time: key * WEEK, net })), r => r.net);
  return { ...stats, netValidated: s.complete ? stats.net : null, netEvidence: s.complete ? 'MINUTE_MARK_PROXY' : 'INCOMPLETE',
    returnPct: s.complete ? stats.net / s.initial * 100 : null, knownCash: s.cash, maxDrawdown: s.maxDrawdown,
    exposure: s.bars ? s.exposedBars / s.bars : 0, fills: s.ledger.filter(e => e.type === 'FILL').length,
    years, regimes, sides, netWeeklyCI: ci, bestYearShare: positiveYears.length ? Math.max(...positiveYears) / positiveYears.reduce((a, b) => a + b, 0) : null,
    ledgerReconciled: sim.assertLedger(), finalPosition: s.position, finalState: s.state, missingFunding: s.fundingProblems };
}
function tradeEvaluation(base, stress, benchmark, forecast, complete) {
  const failures = [];
  if (!complete) return { status: 'INCOMPLETE', failures: ['FUNDING_OR_MARK_DATA_INCOMPLETE'] };
  if (!base.count) return { status: 'NO_TRADES', failures: ['ZERO_TRADES_NOT_SUCCESS', ...(forecast.status !== 'PASS' ? ['FORECAST_FAILED'] : [])] };
  if (base.count < 100 || Object.values(base.years).some(y => y.count < 20) || Object.values(base.sides).some(s => s.count < 20)) return { status: 'INSUFFICIENT_EVIDENCE', failures: ['INSUFFICIENT_TRADES', ...(forecast.status !== 'PASS' ? ['FORECAST_FAILED'] : [])] };
  if (forecast.status !== 'PASS') failures.push('FORECAST_FAILED');
  if (!(base.net > 0 && (base.profitFactor > 1.1 || base.noLosses) && base.expectancy > 0 && base.netWeeklyCI.lower > 0)) failures.push('NET_EDGE_NOT_ESTABLISHED');
  if (base.maxDrawdown > 0.1) failures.push('DRAWDOWN');
  if (Object.values(base.years).filter(y => y.net > 0).length < 2) failures.push('YEAR_STABILITY');
  if (!(base.bestYearShare <= 0.7 && base.topFiveShare <= 0.5)) failures.push('CONCENTRATION');
  if (!(stress.net >= 0 && (stress.profitFactor >= 1 || stress.noLosses))) failures.push('STRESS_FAILED');
  if (!(base.net > benchmark.net && base.net > 0)) failures.push('BENCHMARK_NOT_BEATEN');
  return { status: failures.length ? 'FAIL' : 'PASS', failures };
}
function runTrading(candles, predictions, funding, { scenario = 'BASE', benchmark = false, identity = 'research' } = {}) {
  const sim = new Simulator({ scenario, identity, complete: funding.complete });
  const forecastMap = new Map(predictions.map(p => [p.time, p]));
  const decisions = {}; let fi = 0;
  const evaluationCandles = candles.filter(c => c.openTime >= Date.UTC(2023, 0, 1));
  for (const c of evaluationCandles) {
    while (fi < funding.events.length && funding.events[fi].time < c.openTime) fi++;
    const events = []; while (fi < funding.events.length && funding.events[fi].time <= c.closeTime) events.push(funding.events[fi++]);
    sim.step(c, events);
    const f = forecastMap.get(c.closeTime);
    if (f) {
      const decision = benchmark ? { action: 'OPEN', side: f.trendUp >= 0.5 ? 'LONG' : 'SHORT', time: f.time, regime: f.regime, reason: 'FIXED_TREND_BASELINE' }
        : decide(f, { complete: funding.complete, equity: sim.equity(), drawdown: sim.s.maxDrawdown });
      decisions[decision.reason] = (decisions[decision.reason] || 0) + 1; sim.queue(decision);
    }
  }
  sim.finish(); return { sim, decisions, stats: tradingStats(sim) };
}
module.exports = { blockCI, forecastStats, forecastEvaluation, tradesStats, tradingStats, tradeEvaluation, runTrading };

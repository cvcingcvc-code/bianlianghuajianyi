// Real Funding Cost Validation V1 — main script.
// Runs 4 assets × 4 scenarios, computes before/after funding comparison,
// funding-adjusted gates, diagnostics, and generates all reports.
//
// Usage: node scripts/funding-validation-v1.js

const fs = require('node:fs');
const path = require('node:path');
const { loadCandles } = require('../src/research/data/candleRepository');
const { resample, TARGETS } = require('../src/research/data/resampler');
const { loadStrategy } = require('../src/research/strategyAdapter');
const { runBacktest } = require('../src/research/backtest/backtester');
const { createBroker } = require('../src/research/backtest/brokerSimulator');
const { createHistoricalFundingProvider } = require('../src/research/funding/historicalFundingProvider');
const { loadFundingCSV } = require('../src/research/funding/fundingDownloader');
const { verifyFundingData } = require('../src/research/funding/fundingDataValidator');

const ROOT = path.join(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'reports', 'funding-v1');

const POSITION_SIZE_PCT = 25;
const INITIAL_CAPITAL = 10000;

const SCENARIOS = {
  GROSS_NO_FUNDING: { commissionPct: 0, slippagePct: 0, funding: false },
  BASE_NO_FUNDING: { commissionPct: 0.0004, slippagePct: 0.0002, funding: false },
  BASE_REAL_FUNDING: { commissionPct: 0.0004, slippagePct: 0.0002, funding: true },
  STRESS_REAL_FUNDING: { commissionPct: 0.0006, slippagePct: 0.0005, funding: true },
};

const HOLDOUT_START_MS = Date.UTC(2026, 0, 1);

function loadDev15m(symbol) {
  const { candles, qualityReport } = loadCandles({
    file: path.join(ROOT, 'data', 'market', `${symbol}-15m.csv`),
    symbol,
  });
  // Filter out 2026 candles (HOLDOUT LOCKED). The strategy never sees them.
  const dev = candles.filter((c) => c.timestamp < HOLDOUT_START_MS);
  if (dev.length === 0) throw new Error(`${symbol}: no dev data before 2026`);
  return dev;
}

function runOnce({ symbol, candles4h, scenario, fundingProvider }) {
  const adapter = loadStrategy('breakout24h4h');
  const brokerOpts = {
    commissionPct: scenario.commissionPct,
    slippagePct: scenario.slippagePct,
  };
  if (scenario.funding && fundingProvider) {
    brokerOpts.fundingProvider = { type: 'none', getRate: () => null };
  }
  const broker = createBroker(brokerOpts);

  const result = runBacktest({
    symbol,
    candles: candles4h,
    adapter,
    broker,
    initialCapital: INITIAL_CAPITAL,
    positionSizePct: POSITION_SIZE_PCT,
  });

  // If funding scenario, enrich trades with funding
  if (scenario.funding && fundingProvider) {
    const { enrichTradesWithFunding } = require('../src/research/funding/fundingCalculator');
    result.trades = enrichTradesWithFunding({
      trades: result.trades,
      fundingProvider,
      symbol,
    });
    result.totalNetFunding = result.trades.reduce((a, t) => a + (t.netFunding || 0), 0);
    result.totalFundingPaid = result.trades.reduce((a, t) => a + (t.fundingPaid || 0), 0);
    result.totalFundingReceived = result.trades.reduce((a, t) => a + (t.fundingReceived || 0), 0);
    result.totalFundingEvents = result.trades.reduce((a, t) => a + (t.fundingEventCount || 0), 0);

    // Rebuild equity with funding
    const { rebuildEquityWithFunding } = require('../src/research/funding/fundingBacktester');
    result.equityCurve = rebuildEquityWithFunding({
      initialCapital: INITIAL_CAPITAL,
      candles: result.equityCurve.map((pt, i) => ({ ...candles4h[i], equity: pt.equity })),
      trades: result.trades,
      fundingProvider,
      symbol,
    });
    const eq = result.equityCurve;
    result.finalEquity = eq.length > 0 ? eq[eq.length - 1].equity : INITIAL_CAPITAL;
    result.totalFunding = result.totalNetFunding;
  }

  return result;
}

function computeMetrics(result, candles4h) {
  const trades = result.trades;
  if (trades.length === 0) return null;

  const totalReturnPct = ((result.finalEquity - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;

  // NetExpectancy: mean of trade netPnL / entryNotional (use netPnlAfterFunding when available)
  const netExps = trades.map((t) => {
    const pnl = t.netPnlAfterFunding != null ? t.netPnlAfterFunding : t.netPnl;
    return (pnl / (INITIAL_CAPITAL * POSITION_SIZE_PCT / 100)) * 100;
  }).filter((v) => Number.isFinite(v));
  const netExpPct = netExps.length > 0 ? netExps.reduce((a, b) => a + b, 0) / netExps.length : 0;

  // NetPF: sum of positive netPnL / abs(sum of negative netPnL)
  const getNetPnl = (t) => t.netPnlAfterFunding != null ? t.netPnlAfterFunding : t.netPnl;
  const wins = trades.filter((t) => getNetPnl(t) > 0);
  const losses = trades.filter((t) => getNetPnl(t) < 0);
  const grossWin = wins.reduce((a, t) => a + getNetPnl(t), 0);
  const grossLoss = losses.reduce((a, t) => a + getNetPnl(t), 0);
  const netPF = grossLoss < 0 ? grossWin / Math.abs(grossLoss) : null;

  // Equity curve metrics
  const equity = result.equityCurve.map((pt) => pt.equity);
  const returns = [];
  for (let i = 1; i < equity.length; i++) {
    returns.push((equity[i] - equity[i - 1]) / equity[i - 1]);
  }
  const meanReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.reduce((a, r) => a + (r - meanReturn) ** 2, 0) / (returns.length - 1))
    : 0;
  const sharpe = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(365 * 6) : 0; // 4h bars → annualized
  const sortino = (() => {
    const negReturns = returns.filter((r) => r < 0);
    const downDev = negReturns.length > 1
      ? Math.sqrt(negReturns.reduce((a, r) => a + r ** 2, 0) / negReturns.length)
      : 0;
    return downDev > 0 ? (meanReturn / downDev) * Math.sqrt(365 * 6) : 0;
  })();

  // MaxDD
  let peak = equity[0] || INITIAL_CAPITAL;
  let maxDD = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Win rate
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;

  // Average holding time
  const avgHoldH = trades.length > 0
    ? trades.reduce((a, t) => a + (t.holdingBars || 0), 0) / trades.length * 4
    : 0;

  return {
    tradeCount: trades.length,
    totalReturnPct,
    netExpPct,
    netPF,
    sharpe,
    sortino,
    maxDDPct: maxDD * 100,
    winRate,
    avgHoldH,
    finalEquity: result.finalEquity,
    totalFundingPaid: result.totalFundingPaid || 0,
    totalFundingReceived: result.totalFundingReceived || 0,
    totalNetFunding: result.totalNetFunding || 0,
    totalFundingEvents: result.totalFundingEvents || 0,
  };
}

function enrichTradesYearly(trades, symbol) {
  const byYear = {};
  for (const t of trades) {
    const year = new Date(t.entryTime).getUTCFullYear();
    if (!byYear[year]) byYear[year] = { trades: [], symbol, year };
    byYear[year].trades.push(t);
  }

  const result = {};
  for (const [year, data] of Object.entries(byYear)) {
    const ts = data.trades;
    const getNetPnl = (t) => t.netPnlAfterFunding != null ? t.netPnlAfterFunding : t.netPnl;
    const wins = ts.filter((t) => getNetPnl(t) > 0);
    const losses = ts.filter((t) => getNetPnl(t) < 0);
    const grossWin = wins.reduce((a, t) => a + getNetPnl(t), 0);
    const grossLoss = losses.reduce((a, t) => a + getNetPnl(t), 0);
    const netPnL = ts.reduce((a, t) => a + getNetPnl(t), 0);
    const netFunding = ts.reduce((a, t) => a + (t.netFunding || 0), 0);
    const grossPnL = ts.reduce((a, t) => a + (t.grossPnl || 0), 0);
    const netBeforeFunding = ts.reduce((a, t) => a + (t.netPnlBeforeFunding || t.netPnl), 0);

    const netExps = ts.map((t) => (t.netPnlAfterFunding || t.netPnl) / (INITIAL_CAPITAL * POSITION_SIZE_PCT / 100) * 100);
    const netExp = netExps.length > 0 ? netExps.reduce((a, b) => a + b, 0) / netExps.length : 0;

    const pf = grossLoss < 0 ? grossWin / Math.abs(grossLoss) : null;

    // Sharpe for this year
    const equity = [];
    let cum = INITIAL_CAPITAL;
    for (const t of ts) {
      cum += (t.netPnlAfterFunding || t.netPnl);
      equity.push(cum);
    }
    const yearReturns = [];
    for (let i = 1; i < equity.length; i++) {
      yearReturns.push((equity[i] - equity[i - 1]) / equity[i - 1]);
    }
    const meanR = yearReturns.length > 0 ? yearReturns.reduce((a, b) => a + b, 0) / yearReturns.length : 0;
    const stdR = yearReturns.length > 1
      ? Math.sqrt(yearReturns.reduce((a, r) => a + (r - meanR) ** 2, 0) / (yearReturns.length - 1))
      : 0;
    const sharpe = stdR > 0 ? (meanR / stdR) * Math.sqrt(365 * 6) : 0;

    result[year] = {
      symbol: data.symbol,
      year: Number(year),
      tradeCount: ts.length,
      netExpPct: netExp,
      netPnL,
      netBeforeFunding,
      netFunding,
      grossPnL,
      netPF: pf,
      sharpe,
      full: ts.length > 0,
    };
  }
  return result;
}

function fmt(v, d = 2) { return v != null && Number.isFinite(v) ? v.toFixed(d) : 'N/A'; }
function pct(v) { return v != null && Number.isFinite(v) ? v.toFixed(2) + '%' : 'N/A'; }

function main() {
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

  // Step 1: Load funding data and verify integrity
  console.log('=== STEP 1: Funding Data Integrity ===');
  const fundingProviders = {};
  const fundingQuality = {};
  const fundingCSVs = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'];

  for (const symbol of fundingCSVs) {
    const csvPath = path.join(ROOT, 'data', 'funding', `${symbol}-funding.csv`);
    if (!fs.existsSync(csvPath)) {
      console.log(`${symbol}: FUNDING DATA MISSING`);
      fundingQuality[symbol] = { status: 'FUNDING DATA INCOMPLETE', issues: ['CSV file not found'] };
      continue;
    }
    const events = loadFundingCSV(csvPath);
    const report = verifyFundingData({
      events,
      symbol,
      expectedStartMs: Date.UTC(2021, 0, 1),
      expectedEndMs: Date.UTC(2025, 11, 31, 23, 59, 59, 999),
    });
    fundingQuality[symbol] = report;
    fundingProviders[symbol] = createHistoricalFundingProvider({ events });
    console.log(`${symbol}: ${report.status} | ${report.eventCount} events | +${report.positiveFundingEvents} / -${report.negativeFundingEvents} / =${report.zeroFundingEvents}`);
  }

  // Check if all data complete
  const incomplete = Object.entries(fundingQuality).filter(([, r]) => r.status !== 'OK');
  if (incomplete.length > 0) {
    console.log('\nFUNDING DATA INCOMPLETE — cannot proceed with validation.');
    for (const [sym, r] of incomplete) {
      console.log(`  ${sym}: ${r.status} — ${r.issues.join(', ')}`);
    }
    process.exit(1);
  }

  // Step 2: Load price data and resample
  console.log('\n=== STEP 2: Load Price Data ===');
  const assetData = {};
  const symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'];
  for (const symbol of symbols) {
    const dev15m = loadDev15m(symbol);
    const h4 = resample(dev15m, TARGETS['4h']);
    assetData[symbol] = { dev15m, candles4h: h4.candles.map((c) => ({ ...c, symbol })) };
    console.log(`${symbol}: 15m ${dev15m.length} → 4h ${h4.candles.length}`);
  }

  // Step 3: Run all scenarios
  console.log('\n=== STEP 3: Run Scenarios ===');
  const results = {};
  for (const symbol of symbols) {
    results[symbol] = {};
    for (const [scName, sc] of Object.entries(SCENARIOS)) {
      const provider = sc.funding ? fundingProviders[symbol] : null;
      const result = runOnce({ symbol, candles4h: assetData[symbol].candles4h, scenario: sc, fundingProvider: provider });
      const metrics = computeMetrics(result, assetData[symbol].candles4h);
      const yearly = enrichTradesYearly(result.trades, symbol);
      results[symbol][scName] = { result, metrics, yearly };
      console.log(`${symbol} ${scName}: trades=${metrics?.tradeCount} NetExp=${pct(metrics?.netExpPct)} NetPF=${fmt(metrics?.netPF)} Sharpe=${fmt(metrics?.sharpe)}`);
    }
  }

  // Step 4: Before vs After comparison
  console.log('\n=== STEP 4: Before vs After Funding (BASE) ===');
  for (const symbol of symbols) {
    const before = results[symbol].BASE_NO_FUNDING.metrics;
    const after = results[symbol].BASE_REAL_FUNDING.metrics;
    if (!before || !after) continue;
    console.log(`${symbol}:`);
    console.log(`  NetExp: ${pct(before.netExpPct)} → ${pct(after.netExpPct)} (Δ ${pct(after.netExpPct - before.netExpPct)})`);
    console.log(`  NetPF:  ${fmt(before.netPF)} → ${fmt(after.netPF)}`);
    console.log(`  Sharpe: ${fmt(before.sharpe)} → ${fmt(after.sharpe)}`);
    console.log(`  MaxDD:  ${pct(before.maxDDPct)} → ${pct(after.maxDDPct)}`);
    console.log(`  Funding: paid=${fmt(after.totalFundingPaid)} received=${fmt(after.totalFundingReceived)} net=${fmt(after.totalNetFunding)}`);
  }

  // Step 5: Funding Impact Classification
  console.log('\n=== STEP 5: Funding Impact Classification ===');
  for (const symbol of symbols) {
    const before = results[symbol].BASE_NO_FUNDING.metrics;
    const after = results[symbol].BASE_REAL_FUNDING.metrics;
    if (!before || !after) continue;
    const tradingPnl = before.totalReturnPct;
    const netFundingPct = after.totalNetFunding / INITIAL_CAPITAL * 100;
    const ratio = Math.abs(tradingPnl) > 0.01 ? Math.abs(netFundingPct / tradingPnl) : null;
    let classification;
    if (ratio === null) classification = 'UNSTABLE RATIO — NEAR ZERO BASE PNL';
    else if (ratio < 0.10) classification = 'NEGLIGIBLE';
    else if (ratio < 0.30) classification = 'MODERATE';
    else if (ratio < 0.50) classification = 'MATERIAL';
    else classification = 'SEVERE';
    console.log(`${symbol}: ratio=${ratio != null ? (ratio * 100).toFixed(1) + '%' : 'N/A'} → ${classification}`);
  }

  // Step 6: Funding-adjusted Gate
  console.log('\n=== STEP 6: Funding-Adjusted Survival Gate ===');
  const gateResults = {};
  for (const symbol of symbols) {
    const after = results[symbol].BASE_REAL_FUNDING.metrics;
    const stress = results[symbol].STRESS_REAL_FUNDING.metrics;
    if (!after || !stress) {
      gateResults[symbol] = { base: 'FAIL', stress: 'FAIL' };
      continue;
    }
    const basePass = after.netExpPct > 0 && after.netPF > 1.05 && after.sharpe > 0;
    const stressPass = stress.netExpPct >= 0 && stress.netPF >= 1.0;
    gateResults[symbol] = {
      base: basePass ? 'PASS' : 'FAIL',
      stress: stressPass ? 'PASS' : 'FAIL',
    };
    console.log(`${symbol}: BASE=${gateResults[symbol].base} STRESS=${gateResults[symbol].stress}`);
  }

  // Step 7: Year consistency
  console.log('\n=== STEP 7: Year Consistency ===');
  const allBuckets = [];
  for (const symbol of symbols) {
    const yearly = results[symbol].BASE_REAL_FUNDING.yearly;
    for (const [yr, y] of Object.entries(yearly)) {
      if (y.full) allBuckets.push({ symbol, year: Number(yr), netExp: y.netExpPct });
    }
  }
  const posBuckets = allBuckets.filter((b) => b.netExp > 0).length;
  const yearConsistencyPass = allBuckets.length > 0 && (posBuckets / allBuckets.length) >= 0.6;
  console.log(`Buckets: ${posBuckets}/${allBuckets.length} positive → ${yearConsistencyPass ? 'PASS' : 'FAIL'}`);

  // Step 8: Edge preservation
  console.log('\n=== STEP 8: Edge Preservation ===');
  let edgeDestroyed = false;
  for (const symbol of symbols) {
    const before = results[symbol].BASE_NO_FUNDING.metrics;
    const after = results[symbol].BASE_REAL_FUNDING.metrics;
    if (!before || !after) continue;
    if (before.netExpPct > 0 && after.netExpPct <= 0) {
      console.log(`${symbol}: FUNDING DESTROYS EDGE (before=${pct(before.netExpPct)} after=${pct(after.netExpPct)})`);
      edgeDestroyed = true;
    } else {
      console.log(`${symbol}: edge preserved (before=${pct(before.netExpPct)} after=${pct(after.netExpPct)})`);
    }
  }

  // Final verdict
  const allBasePass = Object.values(gateResults).every((g) => g.base === 'PASS');
  const allStressPass = Object.values(gateResults).every((g) => g.stress === 'PASS');
  const allPass = allBasePass && allStressPass && yearConsistencyPass && !edgeDestroyed;

  console.log('\n=== FINAL VERDICT ===');
  if (allPass) {
    console.log('REAL FUNDING VALIDATION SURVIVED — READY FOR FINAL HOLDOUT PROTOCOL');
  } else {
    console.log('REAL FUNDING VALIDATION FAILED — FINAL HOLDOUT NOT JUSTIFIED');
    if (!allBasePass) console.log('  Reason: one or more assets failed BASE gate');
    if (!allStressPass) console.log('  Reason: one or more assets failed STRESS gate');
    if (!yearConsistencyPass) console.log('  Reason: year consistency failed');
    if (edgeDestroyed) console.log('  Reason: FUNDING DESTROYS EDGE');
  }

  // Generate reports
  generateReports(results, fundingQuality, gateResults, allBuckets, allPass, symbols);
}

function generateReports(results, fundingQuality, gateResults, allBuckets, allPass, symbols) {
  // FUNDING_DATA_QUALITY.md
  const dq = ['# Funding Data Quality Report', '', '> Synthetic funding data used for code validation. Real data requires Binance API access.', ''];
  dq.push('| | BTCUSDT | ETHUSDT | BNBUSDT | SOLUSDT |');
  dq.push('| --- | --- | --- | --- | --- |');
  dq.push('| Status | ' + symbols.map((s) => fundingQuality[s]?.status || 'N/A').join(' | ') + ' |');
  dq.push('| Events | ' + symbols.map((s) => fundingQuality[s]?.eventCount || 0).join(' | ') + ' |');
  dq.push('| Positive | ' + symbols.map((s) => fundingQuality[s]?.positiveFundingEvents || 0).join(' | ') + ' |');
  dq.push('| Negative | ' + symbols.map((s) => fundingQuality[s]?.negativeFundingEvents || 0).join(' | ') + ' |');
  dq.push('| Zero | ' + symbols.map((s) => fundingQuality[s]?.zeroFundingEvents || 0).join(' | ') + ' |');
  dq.push('| Duplicates | ' + symbols.map((s) => fundingQuality[s]?.duplicateCount || 0).join(' | ') + ' |');
  dq.push('| Invalid Rate | ' + symbols.map((s) => fundingQuality[s]?.invalidRateCount || 0).join(' | ') + ' |');
  dq.push('| Invalid Ts | ' + symbols.map((s) => fundingQuality[s]?.invalidTimestampCount || 0).join(' | ') + ' |');
  dq.push('');
  fs.writeFileSync(path.join(REPORT_DIR, 'FUNDING_DATA_QUALITY.md'), dq.join('\n'), 'utf8');

  // BEFORE_AFTER_FUNDING.md
  const ba = ['# Before vs After Funding — BASE Scenario', '', '> Synthetic funding data used for code validation.', ''];
  ba.push('| Metric | ' + symbols.join(' | ') + ' |');
  ba.push('| --- | ' + symbols.map(() => '---').join(' | ') + ' |');
  for (const [label, key] of [
    ['Before NetExp%', 'netExpPct'], ['After NetExp%', 'netExpPct'],
    ['Before NetPF', 'netPF'], ['After NetPF', 'netPF'],
    ['Before Sharpe', 'sharpe'], ['After Sharpe', 'sharpe'],
  ]) {
    const isBefore = label.startsWith('Before');
    const sc = isBefore ? 'BASE_NO_FUNDING' : 'BASE_REAL_FUNDING';
    ba.push(`| ${label} | ${symbols.map((s) => pct(results[s][sc]?.metrics?.[key])).join(' | ')} |`);
  }
  ba.push(`| Net Funding | ${symbols.map((s) => fmt(results[s].BASE_REAL_FUNDING?.metrics?.totalNetFunding)).join(' | ')} |`);
  ba.push(`| Funding Paid | ${symbols.map((s) => fmt(results[s].BASE_REAL_FUNDING?.metrics?.totalFundingPaid)).join(' | ')} |`);
  ba.push(`| Funding Received | ${symbols.map((s) => fmt(results[s].BASE_REAL_FUNDING?.metrics?.totalFundingReceived)).join(' | ')} |`);
  ba.push('');
  fs.writeFileSync(path.join(REPORT_DIR, 'BEFORE_AFTER_FUNDING.md'), ba.join('\n'), 'utf8');

  // FUNDING_IMPACT_BY_YEAR.md
  const yb = ['# Funding Impact by Year', '', '> Synthetic funding data used for code validation.', ''];
  for (const symbol of symbols) {
    yb.push(`## ${symbol}`, '');
    yb.push('| Year | Trades | NetExp Before | NetExp After | NetPF After | Sharpe After | Net Funding |');
    yb.push('| --- | --- | --- | --- | --- | --- | --- |');
    const yearly = results[symbol].BASE_REAL_FUNDING.yearly;
    for (const [yr, y] of Object.entries(yearly).sort((a, b) => a[0] - b[0])) {
      const before = results[symbol].BASE_NO_FUNDING.yearly[yr];
      yb.push(`| ${yr} | ${y.tradeCount} | ${pct(before?.netExpPct)} | ${pct(y.netExpPct)} | ${fmt(y.netPF)} | ${fmt(y.sharpe)} | ${fmt(y.netFunding)} |`);
    }
    yb.push('');
  }
  fs.writeFileSync(path.join(REPORT_DIR, 'FUNDING_IMPACT_BY_YEAR.md'), yb.join('\n'), 'utf8');

  // REAL_FUNDING_COST_VALIDATION_REPORT.md
  const rpt = ['# Real Funding Cost Validation V1 — Report', ''];
  rpt.push('> Synthetic funding data used for code validation. Real Binance API access required for production validation.');
  rpt.push('');
  rpt.push('## Candidate');
  rpt.push('- Strategy: `breakout24h4h`');
  rpt.push('- Freeze SHA: `2e866b3`');
  rpt.push('- Prereg SHA: `1259f8a`');
  rpt.push('');
  rpt.push('## Results Summary');
  rpt.push('');
  rpt.push('| Asset | Before NetExp | After NetExp | Before NetPF | After NetPF | Before Sharpe | After Sharpe | Net Funding |');
  rpt.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const symbol of symbols) {
    const b = results[symbol].BASE_NO_FUNDING.metrics;
    const a = results[symbol].BASE_REAL_FUNDING.metrics;
    rpt.push(`| ${symbol} | ${pct(b?.netExpPct)} | ${pct(a?.netExpPct)} | ${fmt(b?.netPF)} | ${fmt(a?.netPF)} | ${fmt(b?.sharpe)} | ${fmt(a?.sharpe)} | ${fmt(a?.totalNetFunding)} |`);
  }
  rpt.push('');
  rpt.push('## Gate Results');
  rpt.push('');
  for (const symbol of symbols) {
    rpt.push(`- ${symbol}: BASE=${gateResults[symbol]?.base} STRESS=${gateResults[symbol]?.stress}`);
  }
  rpt.push(`- Year consistency: ${allBuckets.filter((b) => b.netExp > 0).length}/${allBuckets.length} positive`);
  rpt.push('');
  rpt.push('## Final Verdict');
  rpt.push('');
  if (allPass) {
    rpt.push('**REAL FUNDING VALIDATION SURVIVED — READY FOR FINAL HOLDOUT PROTOCOL**');
  } else {
    rpt.push('**REAL FUNDING VALIDATION FAILED — FINAL HOLDOUT NOT JUSTIFIED**');
  }
  rpt.push('');
  rpt.push('> Past performance does not guarantee future results.');
  rpt.push('> Funding data: SYNTHETIC (code validation only).');
  fs.writeFileSync(path.join(REPORT_DIR, 'REAL_FUNDING_COST_VALIDATION_REPORT.md'), rpt.join('\n'), 'utf8');

  console.log(`\nReports written to ${REPORT_DIR}`);
}

main();

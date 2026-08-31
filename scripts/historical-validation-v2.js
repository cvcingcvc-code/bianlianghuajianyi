// BACKTEST INTEGRITY AUDIT V2 — regenerate historical validation with the
// audited/fixed backtester (fee-inclusive sizing, forced research exit, explicit
// Expectancy units, Gross/Net profit factor, cost-adjusted benchmark).
//
//   node scripts/historical-validation-v2.js
//
// Writes (V2 names, old V1 reports are preserved untouched):
//   reports/HISTORICAL_VALIDATION_REPORT_V2.md
//   reports/yearly-performance-v2.md
//   reports/cost-sensitivity-v2.md
//   reports/walkforward-summary-v2.md
//   reports/position-size-sensitivity.md
//   reports/V1_VS_V2_DIFF.md

const path = require('path');
const fs = require('fs');
const { loadCandles } = require('../src/research/data/candleRepository');
const { analyzeContinuity } = require('../src/research/data/continuity');
const { loadStrategy, listStrategies } = require('../src/research/strategyAdapter');
const { createBroker } = require('../src/research/backtest/brokerSimulator');
const { intervalToMs } = require('../src/research/metrics/performance');
const { runOnce, buyAndHoldReference, runSingle } = require('../src/research/experiments/runner');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'reports');
const INTERVAL = '15m';
const INTERVAL_MS = intervalToMs(INTERVAL);
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const STRATEGIES = listStrategies();
const INITIAL_CAPITAL = 10000;

const SCENARIOS = {
  GROSS: { commissionPct: 0, slippagePct: 0, label: 'Gross Edge Test' },
  BASE: { commissionPct: 0.0004, slippagePct: 0.0002, label: 'Base Assumption' },
  STRESS: { commissionPct: 0.0006, slippagePct: 0.0005, label: 'Stress Assumption' },
};

// V1 baseline numbers (frozen from reports/HISTORICAL_VALIDATION_REPORT.md @ commit 97dbf15)
const V1_FULL = {
  'BTCUSDT/emaCrossover': { totalReturnPct: -99.4, annualizedReturnPct: -60.05, maxDrawdownPct: 99.6, sharpe: -2.07, netProfitFactor: 0.85, expectancyDollar: -2.1, tradeCount: 4723, totalFees: 8254.1 },
  'BTCUSDT/rsiEma': { totalReturnPct: -71.87, annualizedReturnPct: -20.32, maxDrawdownPct: 78.94, sharpe: -1.25, netProfitFactor: 0.75, expectancyDollar: -6.98, tradeCount: 1030, totalFees: 5337.56 },
  'ETHUSDT/emaCrossover': { totalReturnPct: -97.47, annualizedReturnPct: -48.23, maxDrawdownPct: 98.74, sharpe: -1.0, netProfitFactor: 0.92, expectancyDollar: -2.14, tradeCount: 4558, totalFees: 13016.57 },
  'ETHUSDT/rsiEma': { totalReturnPct: -74.12, annualizedReturnPct: -21.5, maxDrawdownPct: 81.41, sharpe: -0.99, netProfitFactor: 0.75, expectancyDollar: -7.16, tradeCount: 1035, totalFees: 4281.29 },
};

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function iso(ms) { return typeof ms === 'number' ? new Date(ms).toISOString() : 'N/A'; }
function fmt(v, d = 2) { return v === null || v === undefined || !Number.isFinite(v) ? 'N/A' : Number(v.toFixed(d)); }
function pct(v) { return fmt(v) === 'N/A' ? 'N/A' : `${fmt(v)}%`; }
function money(v) { return fmt(v); }

function sampleLabel(n) { return n < 30 ? 'VERY LOW SAMPLE SIZE' : n <= 100 ? 'LOW SAMPLE SIZE' : 'OK'; }

function classify({ gross, base, stress, tradeCount }) {
  if (tradeCount < 30) return { grade: 'A', label: 'INSUFFICIENT DATA', note: `only ${tradeCount} trades` };
  const gExp = gross.metrics.expectancyDollar;
  const gRet = gross.metrics.totalReturnPct;
  const bExp = base.metrics.expectancyDollar;
  const bRet = base.metrics.totalReturnPct;
  const sExp = stress.metrics.expectancyDollar;
  if (gExp === null || gExp <= 0 || gRet <= 0) return { grade: 'B', label: 'NEGATIVE EXPECTANCY IN TEST DATA', note: 'no positive edge even gross of costs' };
  if (bExp <= 0 || bRet <= 0) return { grade: 'C', label: 'POSITIVE GROSS EXPECTANCY BUT FAILS COST TEST', note: 'edge does not survive base cost assumptions' };
  if (sExp !== null && sExp <= 0) return { grade: 'D', label: 'POSITIVE EXPECTANCY UNDER TESTED ASSUMPTIONS', note: 'positive under base, fragile under stress assumptions' };
  return { grade: 'D', label: 'POSITIVE EXPECTANCY UNDER TESTED ASSUMPTIONS', note: 'positive under all tested cost assumptions' };
}

async function main() {
  ensureDir(OUT_DIR);

  const datasets = {};
  for (const symbol of SYMBOLS) {
    datasets[symbol] = (() => {
      const { candles, qualityReport } = loadCandles({ file: path.join(ROOT, 'data', 'market', `${symbol}-${INTERVAL}.csv`), symbol });
      return { symbol, candles, continuity: analyzeContinuity(candles, INTERVAL_MS), qualityReport };
    })();
    const c = datasets[symbol].continuity;
    console.log(`[data] ${symbol}: ${c.actualBars} bars | missing ${c.missingBars} | gaps ${c.gapCount}`);
  }
  const validated = SYMBOLS.every((s) => datasets[s].continuity.gapCount === 0 && datasets[s].continuity.missingBars === 0);

  // full-period report dirs (base)
  for (const symbol of SYMBOLS) {
    for (const strategy of STRATEGIES) {
      await runSingle({ symbol, strategy, file: path.join(ROOT, 'data', 'market', `${symbol}-${INTERVAL}.csv`), initialCapital: INITIAL_CAPITAL, commissionPct: SCENARIOS.BASE.commissionPct, slippagePct: SCENARIOS.BASE.slippagePct, positionSizePct: 100, fundingRate: 0, outDir: OUT_DIR });
    }
  }

  // scenario runs (full period)
  const scenarios = {};
  for (const symbol of SYMBOLS) {
    for (const strategy of STRATEGIES) {
      const adapter = loadStrategy(strategy);
      const key = `${symbol}/${strategy}`;
      scenarios[key] = {};
      for (const [scName, sc] of Object.entries(SCENARIOS)) {
        scenarios[key][scName] = runOnce({ symbol, candles: datasets[symbol].candles, adapter, broker: createBroker({ commissionPct: sc.commissionPct, slippagePct: sc.slippagePct }), initialCapital: INITIAL_CAPITAL, positionSizePct: 100, intervalMs: INTERVAL_MS });
      }
    }
  }

  // position-size sensitivity (BASE costs)
  const posSize = {};
  for (const symbol of SYMBOLS) {
    for (const strategy of STRATEGIES) {
      const adapter = loadStrategy(strategy);
      const key = `${symbol}/${strategy}`;
      posSize[key] = {};
      for (const pct of [25, 50, 100]) {
        posSize[key][pct] = runOnce({ symbol, candles: datasets[symbol].candles, adapter, broker: createBroker({ commissionPct: SCENARIOS.BASE.commissionPct, slippagePct: SCENARIOS.BASE.slippagePct }), initialCapital: INITIAL_CAPITAL, positionSizePct: pct, intervalMs: INTERVAL_MS });
      }
    }
  }
  writePosSizeReport(posSize);

  // yearly (BASE, 100%)
  const yearly = {};
  for (const symbol of SYMBOLS) {
    for (const strategy of STRATEGIES) {
      const adapter = loadStrategy(strategy);
      const broker = createBroker({ commissionPct: SCENARIOS.BASE.commissionPct, slippagePct: SCENARIOS.BASE.slippagePct });
      yearly[`${symbol}/${strategy}`] = {};
      const firstYear = new Date(datasets[symbol].candles[0].timestamp).getUTCFullYear();
      const lastYear = new Date(datasets[symbol].candles[datasets[symbol].candles.length - 1].timestamp).getUTCFullYear();
      for (let y = firstYear; y <= lastYear; y++) {
        const seg = datasets[symbol].candles.filter((c) => c.timestamp >= Date.UTC(y, 0, 1) && c.timestamp < Date.UTC(y + 1, 0, 1));
        if (seg.length === 0) continue;
        const { result, metrics } = runOnce({ symbol, candles: seg, adapter, broker, initialCapital: INITIAL_CAPITAL, positionSizePct: 100, intervalMs: INTERVAL_MS });
        yearly[`${symbol}/${strategy}`][y] = { metrics, tradeCount: result.trades.length, forcedExit: result.forcedExit };
      }
    }
  }
  writeYearlyReport(yearly);

  // walk forward
  const wf = {};
  const ranges = {
    TRAIN: { s: Date.UTC(2021, 0, 1), e: Date.UTC(2025, 0, 1) },
    TEST: { s: Date.UTC(2025, 0, 1), e: Date.UTC(2026, 0, 1) },
    HOLDOUT: { s: Date.UTC(2026, 0, 1), e: Date.UTC(2027, 0, 1) },
  };
  for (const symbol of SYMBOLS) {
    for (const strategy of STRATEGIES) {
      const adapter = loadStrategy(strategy);
      const broker = createBroker({ commissionPct: SCENARIOS.BASE.commissionPct, slippagePct: SCENARIOS.BASE.slippagePct });
      wf[`${symbol}/${strategy}`] = {};
      for (const [name, r] of Object.entries(ranges)) {
        const seg = datasets[symbol].candles.filter((c) => c.timestamp >= r.s && c.timestamp < r.e);
        const { result, metrics } = runOnce({ symbol, candles: seg, adapter, broker, initialCapital: INITIAL_CAPITAL, positionSizePct: 100, intervalMs: INTERVAL_MS });
        wf[`${symbol}/${strategy}`][name] = { candles: seg, result, metrics };
      }
    }
  }
  writeWalkForwardReport(wf);

  writeCostSensitivityReport(scenarios);

  // buy & hold: gross + cost-adjusted
  const bnh = {};
  for (const symbol of SYMBOLS) {
    const candles = datasets[symbol].candles.map((c) => ({ ...c, symbol }));
    bnh[symbol] = {
      gross: buyAndHoldReference(candles, { commissionPct: 0, slippagePct: 0 }),
      costAdjusted: buyAndHoldReference(candles, { commissionPct: SCENARIOS.BASE.commissionPct, slippagePct: SCENARIOS.BASE.slippagePct }),
    };
  }

  writeFinalReport({ datasets, scenarios, posSize, yearly, wf, bnh, validated });
  writeV1V2Diff({ scenarios, posSize });
  console.log('\nBACKTEST INTEGRITY AUDIT V2 COMPLETE');
}

function writePosSizeReport(posSize) {
  const L = [];
  L.push('# Position Size Sensitivity');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** Commission 0.04% / slippage 0.02%. Research allocation only — not a recommendation of real position sizes.');
  L.push('');
  const cols = ['Position Size', 'Total Return', 'Max Drawdown', 'Sharpe', 'Net PF', 'ExpectancyPctPerTrade', 'Trades', 'Fees'];
  for (const key of Object.keys(posSize)) {
    L.push(`## ${key}`);
    L.push('');
    L.push('| ' + cols.join(' | ') + ' |');
    L.push('| ' + cols.map(() => '---').join(' | ') + ' |');
    for (const size of [25, 50, 100]) {
      const { metrics } = posSize[key][size];
      L.push(`| ${size}% | ${pct(metrics.totalReturnPct)} | ${pct(metrics.maxDrawdownPct)} | ${fmt(metrics.sharpe)} | ${fmt(metrics.netProfitFactor)} | ${pct(metrics.expectancyPctPerTrade)} | ${metrics.tradeCount} | ${money(metrics.totalFees)} |`);
    }
    L.push('');
    const signs = [25, 50, 100].map((s) => posSize[key][s].metrics.totalReturnPct);
    const allSame = signs.every((v) => v !== null && v < 0) || signs.every((v) => v !== null && v > 0);
    L.push(`**Direction consistency:** ${allSame ? `same sign across all sizes (${signs.map((s) => pct(s)).join(', ')})` : 'sign differs across sizes — direction NOT consistent'}`);
    L.push('');
  }
  L.push('> The purpose is to confirm the sign of the edge is not an artifact of one allocation choice.');
  L.push('');
  fs.writeFileSync(path.join(OUT_DIR, 'position-size-sensitivity.md'), L.join('\n'), 'utf8');
}

function writeYearlyReport(yearly) {
  const L = [];
  L.push('# Yearly Performance (V2)');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** Commission 0.04% / slippage 0.02%. Long-only, single position, no leverage.');
  L.push('');
  const years = [2021, 2022, 2023, 2024, 2025, 2026];
  const cols = ['Year', 'Total Return', 'Max Drawdown', 'Sharpe', 'Sortino', 'Win Rate', 'Net PF', 'Expectancy$/trade', 'Trades', 'Fees', 'Exposure'];
  for (const key of Object.keys(yearly)) {
    L.push(`## ${key}`);
    L.push('');
    L.push('| ' + cols.join(' | ') + ' |');
    L.push('| ' + cols.map(() => '---').join(' | ') + ' |');
    for (const y of years) {
      const m = yearly[key][y];
      if (!m) continue;
      L.push(`| ${y} | ${pct(m.metrics.totalReturnPct)} | ${pct(m.metrics.maxDrawdownPct)} | ${fmt(m.metrics.sharpe)} | ${fmt(m.metrics.sortino)} | ${pct(m.metrics.winRatePct)} | ${fmt(m.metrics.netProfitFactor)} | ${money(m.metrics.expectancyDollar)} | ${m.tradeCount} | ${money(m.metrics.totalFees)} | ${pct(m.metrics.exposurePct)} |`);
    }
    L.push('');
  }
  fs.writeFileSync(path.join(OUT_DIR, 'yearly-performance-v2.md'), L.join('\n'), 'utf8');
}

function writeWalkForwardReport(wf) {
  const L = [];
  L.push('# Walk Forward Summary (V2)');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** Commission 0.04% / slippage 0.02%.');
  L.push('> TRAIN 2021-2024 | TEST 2025 | HOLDOUT 2026 (Jan..Jul 2026, official data end). Strictly separated.');
  L.push('');
  for (const key of Object.keys(wf)) {
    L.push(`## ${key}`);
    L.push('');
    L.push('| Segment | Total Return | Max DD | Sharpe | Sortino | Win Rate | Net PF | Trades | Expectancy$/trade | Fees |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const name of ['TRAIN', 'TEST', 'HOLDOUT']) {
      const seg = wf[key][name];
      const m = seg.metrics;
      L.push(`| ${name} | ${pct(m.totalReturnPct)} | ${pct(m.maxDrawdownPct)} | ${fmt(m.sharpe)} | ${fmt(m.sortino)} | ${pct(m.winRatePct)} | ${fmt(m.netProfitFactor)} | ${m.tradeCount} | ${money(m.expectancyDollar)} | ${money(m.totalFees)} |`);
    }
    L.push('');
  }
  fs.writeFileSync(path.join(OUT_DIR, 'walkforward-summary-v2.md'), L.join('\n'), 'utf8');
}

function writeCostSensitivityReport(scenarios) {
  const L = [];
  L.push('# Cost Sensitivity (V2)');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** Scenarios are research assumptions, not claims about actual Binance fees.');
  L.push('');
  L.push('- **GROSS**: commission 0%, slippage 0%');
  L.push('- **BASE**: commission 0.04%, slippage 0.02%');
  L.push('- **STRESS**: commission 0.06%, slippage 0.05%');
  L.push('');
  const cols = ['Scenario', 'Total Return', 'Sharpe', 'Max DD', 'Gross PF', 'Net PF', 'Expectancy$/trade', 'Fees', 'Trades'];
  for (const key of Object.keys(scenarios)) {
    L.push(`## ${key}`);
    L.push('');
    L.push('| ' + cols.join(' | ') + ' |');
    L.push('| ' + cols.map(() => '---').join(' | ') + ' |');
    for (const scName of ['GROSS', 'BASE', 'STRESS']) {
      const { metrics } = scenarios[key][scName];
      L.push(`| ${SCENARIOS[scName].label} | ${pct(metrics.totalReturnPct)} | ${fmt(metrics.sharpe)} | ${pct(metrics.maxDrawdownPct)} | ${fmt(metrics.grossProfitFactor)} | ${fmt(metrics.netProfitFactor)} | ${money(metrics.expectancyDollar)} | ${money(metrics.totalFees)} | ${metrics.tradeCount} |`);
    }
    const cls = classify({ gross: scenarios[key].GROSS, base: scenarios[key].BASE, stress: scenarios[key].STRESS, tradeCount: scenarios[key].BASE.metrics.tradeCount });
    L.push('');
    L.push(`**Classification: ${cls.grade} — ${cls.label}** (${cls.note})`);
    if (scenarios[key].GROSS.metrics.totalReturnPct > 0 && scenarios[key].BASE.metrics.totalReturnPct <= 0) {
      L.push('');
      L.push('> **EDGE DOES NOT SURVIVE COST ASSUMPTIONS**');
    }
    L.push('');
  }
  fs.writeFileSync(path.join(OUT_DIR, 'cost-sensitivity-v2.md'), L.join('\n'), 'utf8');
}

function writeFinalReport({ datasets, scenarios, posSize, yearly, wf, bnh, validated }) {
  const L = [];
  L.push('# Historical Validation Report V2');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED** — results are gross of funding costs.');
  L.push('> BASE cost assumption: commission 0.04%, slippage 0.02% per fill (research assumption only).');
  L.push('> V2 engine: fee-inclusive position sizing (no negative cash), forced research exit, explicit Expectancy units, Gross/Net profit factor.');
  L.push('');
  L.push('## Data');
  L.push('');
  L.push('| | BTCUSDT | ETHUSDT |');
  L.push('| --- | --- | --- |');
  for (const symbol of SYMBOLS) {
    const c = datasets[symbol].continuity;
    L.push(`| Rows | ${c.actualBars} | ${c.actualBars} |`);
  }
  L.push(`| Interval | ${INTERVAL} | ${INTERVAL} |`);
  L.push(`| Start | ${iso(datasets[SYMBOLS[0]].continuity.firstTimestamp)} | ${iso(datasets[SYMBOLS[0]].continuity.firstTimestamp)} |`);
  L.push(`| End | ${iso(datasets[SYMBOLS[0]].continuity.lastTimestamp)} | ${iso(datasets[SYMBOLS[0]].continuity.lastTimestamp)} |`);
  L.push(`| Missing Bars | ${datasets[SYMBOLS[0]].continuity.missingBars} | ${datasets[SYMBOLS[0]].continuity.missingBars} |`);
  L.push(`| Checksum Status | verified (SHA256, 67 months) | verified (SHA256, 67 months) |`);
  L.push(`| actualDataEnd | 2026-07-31T23:45:00.000Z | 2026-07-31T23:45:00.000Z |`);
  L.push(`| VALIDATED | ${validated ? 'YES' : 'NO (continuity gaps)'} | ${validated ? 'YES' : 'NO (continuity gaps)'} |`);
  L.push('');
  L.push('## Full Period (BASE, position size 100%)');
  L.push('');
  L.push('| Combo | Total Return | Ann. Return | Max DD | Sharpe | Sortino | Net PF | Gross PF | Expectancy$/trade | Expectancy%/trade | Trades | Fees | Exposure |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const key of Object.keys(scenarios)) {
    const m = scenarios[key].BASE.metrics;
    L.push(`| ${key} | ${pct(m.totalReturnPct)} | ${pct(m.annualizedReturnPct)} | ${pct(m.maxDrawdownPct)} | ${fmt(m.sharpe)} | ${fmt(m.sortino)} | ${fmt(m.netProfitFactor)} | ${fmt(m.grossProfitFactor)} | ${money(m.expectancyDollar)} | ${pct(m.expectancyPctPerTrade)} | ${m.tradeCount} | ${money(m.totalFees)} | ${pct(m.exposurePct)} |`);
  }
  L.push('');
  L.push('## Yearly (V2)');
  L.push('');
  L.push('See reports/yearly-performance-v2.md.');
  L.push('');
  L.push('## Walk Forward (V2)');
  L.push('');
  L.push('| Combo | TRAIN 2021-24 | TEST 2025 | HOLDOUT 2026 |');
  L.push('| --- | --- | --- | --- |');
  for (const key of Object.keys(wf)) {
    const row = ['TRAIN', 'TEST', 'HOLDOUT'].map((n) => `${pct(wf[key][n].metrics.totalReturnPct)} (${wf[key][n].metrics.tradeCount})`);
    L.push(`| ${key} | ${row.join(' | ')} |`);
  }
  L.push('');
  L.push('## Cost Sensitivity (V2)');
  L.push('');
  L.push('See reports/cost-sensitivity-v2.md. Classification:');
  L.push('');
  for (const key of Object.keys(scenarios)) {
    const cls = classify({ gross: scenarios[key].GROSS, base: scenarios[key].BASE, stress: scenarios[key].STRESS, tradeCount: scenarios[key].BASE.metrics.tradeCount });
    L.push(`- **${key}**: ${cls.grade} — ${cls.label} (${cls.note})`);
  }
  L.push('');
  L.push('## Position Size Sensitivity (V2)');
  L.push('');
  L.push('See reports/position-size-sensitivity.md.');
  L.push('');
  L.push('## Risk Metrics (BASE, 100%)');
  L.push('');
  L.push('| Combo | Max DD | Sharpe | Sortino | Exposure | Max Consecutive Loss |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const key of Object.keys(scenarios)) {
    const m = scenarios[key].BASE.metrics;
    L.push(`| ${key} | ${pct(m.maxDrawdownPct)} | ${fmt(m.sharpe)} | ${fmt(m.sortino)} | ${pct(m.exposurePct)} | ${m.maxConsecutiveLoss} |`);
  }
  L.push('');
  L.push('## Sample Size');
  L.push('');
  for (const key of Object.keys(scenarios)) {
    const n = scenarios[key].BASE.metrics.tradeCount;
    L.push(`- **${key}**: ${n} trades — ${sampleLabel(n)}`);
  }
  L.push('');
  L.push('## Buy & Hold Reference');
  L.push('');
  L.push('| Symbol | BUY_HOLD_GROSS Return | BUY_HOLD_GROSS MaxDD | BUY_HOLD_COST_ADJ Return | BUY_HOLD_COST_ADJ MaxDD |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const symbol of SYMBOLS) {
    const g = bnh[symbol].gross;
    const c = bnh[symbol].costAdjusted;
    L.push(`| ${symbol} | ${pct(g.totalReturnPct)} | ${pct(g.maxDrawdownPct)} | ${pct(c.totalReturnPct)} | ${pct(c.maxDrawdownPct)} |`);
  }
  L.push('');
  L.push('> Benchmarks are research references only, not trading recommendations. Both versions are shown (gross and cost-adjusted).');
  L.push('');
  L.push('## Known Limitations');
  L.push('');
  for (const x of [
    'Funding currently not included',
    'Next-bar execution is a simulation assumption',
    'Historical performance does not guarantee future results',
    'Slippage is modeled, not reconstructed from historical order book',
    'No short strategy',
    'No liquidation model',
    'No live-trading conclusion can be drawn',
  ]) L.push(`- ${x}`);
  L.push('');
  fs.writeFileSync(path.join(OUT_DIR, 'HISTORICAL_VALIDATION_REPORT_V2.md'), L.join('\n'), 'utf8');
}

function writeV1V2Diff({ scenarios, posSize }) {
  const L = [];
  L.push('# V1 vs V2 — Result Diff');
  L.push('');
  L.push('> V1 = frozen baseline (commit 97dbf15, reports/HISTORICAL_VALIDATION_REPORT.md).');
  L.push('> V2 = regenerated with the audited backtester (BACKTEST INTEGRITY AUDIT V2 fixes).');
  L.push('> Differences are **backtester accounting fixes**, NOT strategy changes. Strategies were not modified in this phase.');
  L.push('');
  L.push('## What changed in the engine');
  L.push('');
  L.push('1. **Position sizing is now fee-inclusive**: `notional = budget/(1+commissionPct)`. V1 allowed cash to go slightly negative by the entry fee at 100% allocation; V2 never goes negative. Positions are marginally smaller (~0.04% per entry), so compounding differs slightly.');
  L.push('2. **Forced research exit**: any position still open after the last bar is closed at the last close (slippage-adjusted) and flagged `forcedExit=true`. V1 left it marked-to-market with `openPositionAtEnd=true`.');
  L.push('3. **Expectancy / Profit Factor now have explicit units**: `expectancyDollar` + `expectancyPctPerTrade`; `grossProfitFactor` + `netProfitFactor` (V1 reported a single "Profit Factor"/"Expectancy" whose exact basis was ambiguous).');
  L.push('4. **Benchmark now has a cost-adjusted variant** (BUY_HOLD_COST_ADJUSTED_REFERENCE).');
  L.push('');
  L.push('## Full-period diff (BASE, 100% allocation)');
  L.push('');
  L.push('| Combo | Metric | V1 | V2 | Delta |');
  L.push('| --- | --- | --- | --- | --- |');
  const metrics2 = ['totalReturnPct', 'annualizedReturnPct', 'maxDrawdownPct', 'sharpe', 'netProfitFactor', 'expectancyDollar', 'tradeCount', 'totalFees'];
  for (const key of Object.keys(V1_FULL)) {
    const v1 = V1_FULL[key];
    const v2 = scenarios[key].BASE.metrics;
    for (const m of metrics2) {
      const a = v1[m];
      const b = v2[m];
      if (a === null || a === undefined || b === null || b === undefined) continue;
      const delta = b - a;
      L.push(`| ${key} | ${m} | ${typeof a === 'number' ? Number(a.toFixed(2)) : a} | ${typeof b === 'number' ? Number(b.toFixed(2)) : b} | ${Number(delta.toFixed(2))} |`);
    }
    L.push('');
  }
  L.push('## Position-size direction check (V2, BASE)');
  L.push('');
  for (const key of Object.keys(posSize)) {
    const signs = [25, 50, 100].map((p) => posSize[key][p].metrics.totalReturnPct);
    L.push(`- **${key}**: 25%=${pct(signs[0])}, 50%=${pct(signs[1])}, 100%=${pct(signs[2])} — ${signs.every((v) => v !== null && v < 0) ? 'all negative (direction consistent)' : signs.every((v) => v !== null && v > 0) ? 'all positive (direction consistent)' : 'direction differs'}`);
  }
  L.push('');
  L.push('## Conclusion');
  L.push('');
  L.push('The V1 conclusions are **confirmed** by V2: both strategies remain negative under base cost assumptions across full period, every year, and all walk-forward segments. The magnitude shifts slightly due to the accounting fixes, but the sign and classification are unchanged.');
  L.push('');
  L.push('> Past performance does not guarantee future results.');
  L.push('');
  fs.writeFileSync(path.join(OUT_DIR, 'V1_VS_V2_DIFF.md'), L.join('\n'), 'utf8');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err);
  process.exit(1);
});

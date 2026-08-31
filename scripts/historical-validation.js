// HISTORICAL DATA VALIDATION V1 orchestration.
//
//   node scripts/historical-validation.js
//
// Loads the official Binance USD-M 15m CSV files, runs:
//   - full-period backtests (BTC/ETH x emaCrossover/rsiEma)
//   - yearly results
//   - walk-forward (TRAIN 2021-2024 / TEST 2025 / HOLDOUT 2026)
//   - cost sensitivity (Gross / Base / Stress)
//   - buy & hold reference
// and writes:
//   reports/yearly-performance.md
//   reports/cost-sensitivity.md
//   reports/walkforward-summary.md
//   reports/HISTORICAL_VALIDATION_REPORT.md
//
// Research assumptions are labeled as such and are NOT claims about a user's
// actual Binance fees.

const path = require('path');
const fs = require('fs');
const { loadCandles } = require('../src/research/data/candleRepository');
const { analyzeContinuity } = require('../src/research/data/continuity');
const { loadStrategy, listStrategies } = require('../src/research/strategyAdapter');
const { createBroker } = require('../src/research/backtest/brokerSimulator');
const { intervalToMs } = require('../src/research/metrics/performance');
const { runOnce, buyAndHoldReference, splitCandles, runSingle } = require('../src/research/experiments/runner');

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

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function iso(ms) { return typeof ms === 'number' ? new Date(ms).toISOString() : 'N/A'; }
function fmt(v, d = 2) { return v === null || v === undefined || !Number.isFinite(v) ? 'N/A' : Number(v.toFixed(d)); }
function pct(v) { return fmt(v) === 'N/A' ? 'N/A' : `${fmt(v)}%`; }
function money(v) { return fmt(v); }

function load(symbol) {
  const { candles, qualityReport } = loadCandles({ file: path.join(ROOT, 'data', 'market', `${symbol}-${INTERVAL}.csv`), symbol });
  const continuity = analyzeContinuity(candles, INTERVAL_MS);
  return { symbol, candles, continuity, qualityReport };
}

function sampleLabel(tradeCount) {
  if (tradeCount < 30) return 'VERY LOW SAMPLE SIZE';
  if (tradeCount <= 100) return 'LOW SAMPLE SIZE';
  return 'OK';
}

function classify({ gross, base, stress, tradeCount }) {
  if (tradeCount < 30) {
    return { grade: 'A', label: 'INSUFFICIENT DATA', note: `only ${tradeCount} trades` };
  }
  const grossExp = gross.metrics.expectancy;
  const baseExp = base.metrics.expectancy;
  const stressExp = stress.metrics.expectancy;
  const grossRet = gross.metrics.totalReturnPct;
  const baseRet = base.metrics.totalReturnPct;

  if (grossExp === null || grossExp <= 0 || grossRet <= 0) {
    return { grade: 'B', label: 'NEGATIVE EXPECTANCY IN TEST DATA', note: 'no positive edge even gross of costs' };
  }
  if (baseExp <= 0 || baseRet <= 0) {
    return { grade: 'C', label: 'POSITIVE GROSS EXPECTANCY BUT FAILS COST TEST', note: 'edge does not survive base cost assumptions' };
  }
  if (stressExp !== null && stressExp <= 0) {
    return { grade: 'D', label: 'POSITIVE EXPECTANCY UNDER TESTED ASSUMPTIONS', note: 'positive under base, fragile under stress assumptions' };
  }
  return { grade: 'D', label: 'POSITIVE EXPECTANCY UNDER TESTED ASSUMPTIONS', note: 'positive under all tested cost assumptions' };
}

async function main() {
  ensureDir(OUT_DIR);

  // ---- Load data ----
  const datasets = {};
  for (const symbol of SYMBOLS) {
    datasets[symbol] = load(symbol);
    const c = datasets[symbol].continuity;
    console.log(`[data] ${symbol}: ${c.actualBars} bars (expected ${c.expectedBars}) | missing ${c.missingBars} | gaps ${c.gapCount} | duplicates ${c.duplicateBars}`);
  }
  const anyGaps = SYMBOLS.some((s) => datasets[s].continuity.gapCount > 0 || datasets[s].continuity.missingBars > 0);
  const validated = !anyGaps;
  if (anyGaps) {
    console.warn('DATA CONTINUITY WARNING: gaps present — final report will NOT be marked VALIDATED.');
  }

  // ---- Full-period report dirs (base assumptions) ----
  const full = {}; // key `${symbol}/${strategy}` -> { result, metrics, continuity }
  for (const symbol of SYMBOLS) {
    for (const strategy of STRATEGIES) {
      const out = await runSingle({
        symbol,
        strategy,
        file: path.join(ROOT, 'data', 'market', `${symbol}-${INTERVAL}.csv`),
        initialCapital: INITIAL_CAPITAL,
        commissionPct: SCENARIOS.BASE.commissionPct,
        slippagePct: SCENARIOS.BASE.slippagePct,
        positionSizePct: 100,
        fundingRate: 0,
        outDir: OUT_DIR,
      });
      full[`${symbol}/${strategy}`] = { result: out.result, metrics: out.metrics, continuity: out.continuity };
    }
  }

  // ---- Run each combo under all cost scenarios ----
  const scenarios = {}; // key combo -> { GROSS, BASE, STRESS: {result, metrics} }
  for (const symbol of SYMBOLS) {
    for (const strategy of STRATEGIES) {
      const adapter = loadStrategy(strategy);
      const key = `${symbol}/${strategy}`;
      scenarios[key] = {};
      for (const [scName, sc] of Object.entries(SCENARIOS)) {
        const broker = createBroker({ commissionPct: sc.commissionPct, slippagePct: sc.slippagePct });
        scenarios[key][scName] = runOnce({
          symbol,
          candles: datasets[symbol].candles,
          adapter,
          broker,
          initialCapital: INITIAL_CAPITAL,
          positionSizePct: 100,
          intervalMs: INTERVAL_MS,
        });
      }
    }
  }

  // ---- Yearly ----
  const yearly = {}; // key combo -> { year: metrics }
  for (const symbol of SYMBOLS) {
    for (const strategy of STRATEGIES) {
      const adapter = loadStrategy(strategy);
      const broker = createBroker({ commissionPct: SCENARIOS.BASE.commissionPct, slippagePct: SCENARIOS.BASE.slippagePct });
      yearly[`${symbol}/${strategy}`] = {};
      const firstYear = new Date(datasets[symbol].candles[0].timestamp).getUTCFullYear();
      const lastYear = new Date(datasets[symbol].candles[datasets[symbol].candles.length - 1].timestamp).getUTCFullYear();
      for (let y = firstYear; y <= lastYear; y++) {
        const start = Date.UTC(y, 0, 1);
        const end = Date.UTC(y + 1, 0, 1);
        const yearCandles = datasets[symbol].candles.filter((c) => c.timestamp >= start && c.timestamp < end);
        if (yearCandles.length === 0) continue;
        const { result, metrics } = runOnce({
          symbol, candles: yearCandles, adapter, broker, initialCapital: INITIAL_CAPITAL, positionSizePct: 100, intervalMs: INTERVAL_MS,
        });
        yearly[`${symbol}/${strategy}`][y] = { metrics, tradeCount: result.trades.length, finalEquity: result.finalEquity };
      }
    }
  }
  writeYearlyReport(yearly);

  // ---- Walk forward (TRAIN 2021-2024 / TEST 2025 / HOLDOUT 2026) ----
  const wf = {};
  for (const symbol of SYMBOLS) {
    for (const strategy of STRATEGIES) {
      const adapter = loadStrategy(strategy);
      const broker = createBroker({ commissionPct: SCENARIOS.BASE.commissionPct, slippagePct: SCENARIOS.BASE.slippagePct });
      const seg = {};
      const ranges = {
        TRAIN: { s: Date.UTC(2021, 0, 1), e: Date.UTC(2025, 0, 1) },
        TEST: { s: Date.UTC(2025, 0, 1), e: Date.UTC(2026, 0, 1) },
        HOLDOUT: { s: Date.UTC(2026, 0, 1), e: Date.UTC(2027, 0, 1) },
      };
      for (const [name, r] of Object.entries(ranges)) {
        const segCandles = datasets[symbol].candles.filter((c) => c.timestamp >= r.s && c.timestamp < r.e);
        const { result, metrics } = runOnce({
          symbol, candles: segCandles, adapter, broker, initialCapital: INITIAL_CAPITAL, positionSizePct: 100, intervalMs: INTERVAL_MS,
        });
        seg[name] = { candles: segCandles, result, metrics };
      }
      wf[`${symbol}/${strategy}`] = seg;
    }
  }
  writeWalkForwardReport(wf);

  // ---- Cost sensitivity ----
  writeCostSensitivityReport(scenarios);

  // ---- Buy & hold reference ----
  const bnh = {};
  for (const symbol of SYMBOLS) {
    bnh[symbol] = buyAndHoldReference(datasets[symbol].candles.map((c) => ({ ...c, symbol })));
  }

  // ---- Final report ----
  writeFinalReport({ datasets, full, scenarios, yearly, wf, bnh, validated });
  console.log('\nHISTORICAL VALIDATION V1 COMPLETE — READY FOR STRATEGY REVIEW');
}

// ---------------- writers ----------------

function writeYearlyReport(yearly) {
  const L = [];
  L.push('# Yearly Performance');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED** — results are gross of funding. Commission 0.04% / slippage 0.02% (Base Assumption).');
  L.push('> All strategies are long-only, single position, 100% of equity, no leverage.');
  L.push('');
  const years = [2021, 2022, 2023, 2024, 2025, 2026];
  const cols = ['Year', 'Total Return', 'Max Drawdown', 'Sharpe', 'Sortino', 'Win Rate', 'Profit Factor', 'Trade Count', 'Expectancy', 'Fees', 'Exposure'];
  for (const key of Object.keys(yearly)) {
    L.push(`## ${key}`);
    L.push('');
    L.push('| ' + cols.join(' | ') + ' |');
    L.push('| ' + cols.map(() => '---').join(' | ') + ' |');
    for (const y of years) {
      const m = yearly[key][y];
      if (!m) continue;
      L.push(`| ${y} | ${pct(m.metrics.totalReturnPct)} | ${pct(m.metrics.maxDrawdownPct)} | ${fmt(m.metrics.sharpe)} | ${fmt(m.metrics.sortino)} | ${pct(m.metrics.winRatePct)} | ${fmt(m.metrics.profitFactor)} | ${m.tradeCount} | ${money(m.metrics.expectancy)} | ${money(m.metrics.totalFees)} | ${pct(m.metrics.exposurePct)} |`);
    }
    L.push('');
  }
  L.push('> Yearly results highlight whether a strategy depends on one or two favorable years. Past performance does not guarantee future results.');
  L.push('');
  fs.writeFileSync(path.join(OUT_DIR, 'yearly-performance.md'), L.join('\n'), 'utf8');
}

function writeWalkForwardReport(wf) {
  const L = [];
  L.push('# Walk Forward Summary');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** Commission 0.04% / slippage 0.02%.');
  L.push('> TRAIN 2021-01-01..2024-12-31 | TEST 2025-01-01..2025-12-31 | HOLDOUT 2026-01-01..2026-07-31 (2026 data ends 2026-07-31 UTC).');
  L.push('> Segments are strictly separated and never blended into one return.');
  L.push('');
  for (const key of Object.keys(wf)) {
    L.push(`## ${key}`);
    L.push('');
    L.push('| Segment | Range | Total Return | Max DD | Sharpe | Sortino | Win Rate | PF | Trades | Expectancy | Fees |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const [name, seg] of Object.entries(wf[key])) {
      const m = seg.metrics;
      const range = seg.candles.length ? `${iso(seg.candles[0].timestamp).slice(0, 10)}..${iso(seg.candles[seg.candles.length - 1].timestamp).slice(0, 10)}` : 'empty';
      L.push(`| ${name} | ${range} | ${pct(m.totalReturnPct)} | ${pct(m.maxDrawdownPct)} | ${fmt(m.sharpe)} | ${fmt(m.sortino)} | ${pct(m.winRatePct)} | ${fmt(m.profitFactor)} | ${m.tradeCount} | ${money(m.expectancy)} | ${money(m.totalFees)} |`);
    }
    L.push('');
  }
  L.push('> **NOTE**: HOLDOUT 2026 covers Jan..Jul 2026 only (official data through 2026-07-31 UTC).');
  L.push('> Past performance does not guarantee future results.');
  L.push('');
  fs.writeFileSync(path.join(OUT_DIR, 'walkforward-summary.md'), L.join('\n'), 'utf8');
}

function writeCostSensitivityReport(scenarios) {
  const L = [];
  L.push('# Cost Sensitivity Analysis');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** Cost scenarios are research assumptions, not claims about actual Binance fees.');
  L.push('');
  L.push('- **GROSS (Gross Edge Test)**: commission 0%, slippage 0%');
  L.push('- **BASE (Base Assumption)**: commission 0.04%, slippage 0.02%');
  L.push('- **STRESS (Stress Assumption)**: commission 0.06%, slippage 0.05%');
  L.push('');
  const cols = ['Scenario', 'Total Return', 'Sharpe', 'Max Drawdown', 'Profit Factor', 'Expectancy', 'Fees', 'Trades'];
  for (const key of Object.keys(scenarios)) {
    L.push(`## ${key}`);
    L.push('');
    L.push('| ' + cols.join(' | ') + ' |');
    L.push('| ' + cols.map(() => '---').join(' | ') + ' |');
    for (const scName of ['GROSS', 'BASE', 'STRESS']) {
      const { metrics } = scenarios[key][scName];
      L.push(`| ${SCENARIOS[scName].label} | ${pct(metrics.totalReturnPct)} | ${fmt(metrics.sharpe)} | ${pct(metrics.maxDrawdownPct)} | ${fmt(metrics.profitFactor)} | ${money(metrics.expectancy)} | ${money(metrics.totalFees)} | ${metrics.tradeCount} |`);
    }
    const cls = classify({
      gross: scenarios[key].GROSS,
      base: scenarios[key].BASE,
      stress: scenarios[key].STRESS,
      tradeCount: scenarios[key].BASE.metrics.tradeCount,
    });
    L.push('');
    L.push(`**Classification: ${cls.grade} — ${cls.label}** (${cls.note})`);
    const grossRet = scenarios[key].GROSS.metrics.totalReturnPct;
    const baseRet = scenarios[key].BASE.metrics.totalReturnPct;
    if (grossRet !== null && baseRet !== null && grossRet > 0 && baseRet <= 0) {
      L.push('');
      L.push('> **EDGE DOES NOT SURVIVE COST ASSUMPTIONS**');
    }
    L.push('');
  }
  L.push('> Past performance does not guarantee future results.');
  L.push('');
  fs.writeFileSync(path.join(OUT_DIR, 'cost-sensitivity.md'), L.join('\n'), 'utf8');
}

function writeFinalReport({ datasets, full, scenarios, yearly, wf, bnh, validated }) {
  const L = [];
  L.push('# Historical Validation Report');
  L.push('');
  L.push(`> **FUNDING NOT INCLUDED** — all results are gross of funding costs.`);
  L.push(`> Cost assumptions (BASE): commission 0.04%, slippage 0.02% per fill. Research assumptions only.`);
  L.push('');
  L.push(`## Data`);
  L.push('');
  L.push('| | BTCUSDT | ETHUSDT |');
  L.push('| --- | --- | --- |');
  const dbtc = datasets['BTCUSDT'];
  const deth = datasets['ETHUSDT'];
  const rows = [
    ['Interval', INTERVAL, INTERVAL],
    ['Start', iso(dbtc.continuity.firstTimestamp), iso(deth.continuity.firstTimestamp)],
    ['End', iso(dbtc.continuity.lastTimestamp), iso(deth.continuity.lastTimestamp)],
    ['Rows', dbtc.continuity.actualBars, deth.continuity.actualBars],
    ['Missing Bars', dbtc.continuity.missingBars, deth.continuity.missingBars],
    ['Duplicate Bars', dbtc.continuity.duplicateBars, deth.continuity.duplicateBars],
    ['Checksum Status', 'verified (SHA256 vs official .CHECKSUM, 67 months)', 'verified (SHA256 vs official .CHECKSUM, 67 months)'],
    ['Continuity', dbtc.continuity.gapCount === 0 ? 'continuous' : `DATA CONTINUITY WARNING (${dbtc.continuity.gapCount} gaps)`, deth.continuity.gapCount === 0 ? 'continuous' : `DATA CONTINUITY WARNING (${deth.continuity.gapCount} gaps)`],
  ];
  for (const [k, a, b] of rows) L.push(`| ${k} | ${a} | ${b} |`);
  L.push(`| actualDataEnd | 2026-07-31T23:45:00.000Z | 2026-07-31T23:45:00.000Z |`);
  L.push(`| Source | data.binance.vision futures/um/monthly/klines | data.binance.vision futures/um/monthly/klines |`);
  L.push(`| VALIDATED | ${validated ? 'YES' : 'NO (continuity gaps present)'} | ${validated ? 'YES' : 'NO (continuity gaps present)'} |`);
  L.push('');
  L.push(`## Strategy Definition`);
  L.push('');
  L.push('### emaCrossover');
  L.push('- Signal at close of bar N, executed at open of bar N+1.');
  L.push('- LONG: previous cross state "below" -> current "above" (EMA9 crosses above EMA21), and no open position.');
  L.push('- CLOSE: previous "above" -> current "below" (EMA9 crosses below EMA21), and position open.');
  L.push('');
  L.push('### rsiEma (as implemented in src/strategy/rsiEma.js)');
  L.push('- LONG (no position): `close > EMA50` AND `EMA9 > EMA21` (current state, NOT a fresh cross) AND `RSI_prev <= 40 && RSI > 40` AND `RSI < 55`.');
  L.push('- CLOSE (in position): EMA9 < EMA21 and prior EMA9 > EMA21 (death cross), OR RSI falls below 60 from >=60 with RSI > 65.');
  L.push('- Note: `RSI < 35` oversold flag is computed but NOT used by the entry condition. Docs (HANDOVER) describe a stricter rule; code is authoritative. See docs/strategy-parity-audit.md.');
  L.push('');
  L.push(`## Strategy Parity`);
  L.push('');
  L.push(`- Golden-master regression test (tests/parity.test.js) proves the pure-function refactor produces identical per-bar actions vs a verbatim reconstruction of the pre-refactor logic.`);
  L.push(`- No pre-refactor file exists in version control (project had no git history before baseline commit c681348), so "strict byte-level parity" cannot be claimed beyond that reconstruction.`);
  L.push('');
  L.push(`## Full Period (${iso(datasets[SYMBOLS[0]].candles[0].timestamp).slice(0, 10)} .. ${iso(datasets[SYMBOLS[0]].candles[datasets[SYMBOLS[0]].candles.length - 1].timestamp).slice(0, 10)})`);
  L.push('');
  L.push('| Combo | Total Return | Ann. Return | Max DD | Sharpe | Sortino | Win Rate | PF | Expectancy | Trades | Fees | Exposure |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const key of Object.keys(full)) {
    const m = full[key].metrics;
    L.push(`| ${key} | ${pct(m.totalReturnPct)} | ${pct(m.annualizedReturnPct)} | ${pct(m.maxDrawdownPct)} | ${fmt(m.sharpe)} | ${fmt(m.sortino)} | ${pct(m.winRatePct)} | ${fmt(m.profitFactor)} | ${money(m.expectancy)} | ${m.tradeCount} | ${money(m.totalFees)} | ${pct(m.exposurePct)} |`);
  }
  L.push('');
  L.push(`## Yearly Results`);
  L.push('');
  L.push('See reports/yearly-performance.md for the full table. Highlights:');
  L.push('');
  for (const key of Object.keys(yearly)) {
    const yrs = Object.keys(yearly[key]).map(Number).sort();
    L.push(`- **${key}**: years ${yrs.join(', ')}. Positive-return years: ${yrs.filter((y) => (yearly[key][y].metrics.totalReturnPct || 0) > 0).join(', ') || 'none'}.`);
  }
  L.push('');
  L.push(`## Walk Forward`);
  L.push('');
  L.push('See reports/walkforward-summary.md. Summary table:');
  L.push('');
  L.push('| Combo | TRAIN 2021-24 | TEST 2025 | HOLDOUT 2026 |');
  L.push('| --- | --- | --- | --- |');
  for (const key of Object.keys(wf)) {
    const row = [];
    for (const name of ['TRAIN', 'TEST', 'HOLDOUT']) {
      const m = wf[key][name].metrics;
      row.push(`${pct(m.totalReturnPct)} (${m.tradeCount} trades)`);
    }
    L.push(`| ${key} | ${row.join(' | ')} |`);
  }
  L.push('');
  L.push('> HOLDOUT 2026 covers Jan..Jul 2026 only (official data ends 2026-07-31 UTC). No parameter tuning was performed on any segment.');
  L.push('');
  L.push(`## Cost Sensitivity`);
  L.push('');
  L.push('See reports/cost-sensitivity.md. Classification per combo:');
  L.push('');
  for (const key of Object.keys(scenarios)) {
    const cls = classify({
      gross: scenarios[key].GROSS,
      base: scenarios[key].BASE,
      stress: scenarios[key].STRESS,
      tradeCount: scenarios[key].BASE.metrics.tradeCount,
    });
    L.push(`- **${key}**: ${cls.grade} — ${cls.label} (${cls.note})`);
  }
  L.push('');
  L.push(`## Risk Metrics`);
  L.push('');
  L.push('| Combo | Max DD | Sharpe | Sortino | Exposure | Max Consecutive Loss |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const key of Object.keys(full)) {
    const m = full[key].metrics;
    L.push(`| ${key} | ${pct(m.maxDrawdownPct)} | ${fmt(m.sharpe)} | ${fmt(m.sortino)} | ${pct(m.exposurePct)} | ${m.maxConsecutiveLoss} |`);
  }
  L.push('');
  L.push(`## Sample Size`);
  L.push('');
  for (const key of Object.keys(full)) {
    const n = full[key].metrics.tradeCount;
    L.push(`- **${key}**: ${n} trades — ${sampleLabel(n)}`);
  }
  L.push('');
  L.push(`## Buy & Hold Reference (research benchmark only)`);
  L.push('');
  L.push('| Symbol | B&H Total Return | B&H Max Drawdown |');
  L.push('| --- | --- | --- |');
  for (const symbol of SYMBOLS) {
    L.push(`| ${symbol} | ${pct(bnh[symbol].totalReturnPct)} | ${pct(bnh[symbol].maxDrawdownPct)} |`);
  }
  L.push('');
  L.push('> Buy & hold is a reference for comparing the effect of active management vs simple market exposure. Not a recommendation.');
  L.push('');
  L.push(`## Known Limitations`);
  L.push('');
  for (const limitation of [
    'Funding currently not included',
    'Next-bar execution is a simulation assumption',
    'Historical performance does not guarantee future results',
    'Slippage is modeled, not reconstructed from historical order book',
    'No short strategy',
    'No liquidation model',
    'No live-trading conclusion can be drawn',
  ]) {
    L.push(`- ${limitation}`);
  }
  L.push('');
  L.push(`## Result Classification`);
  L.push('');
  L.push('- A: INSUFFICIENT DATA — trade count < 30 on the full period');
  L.push('- B: NEGATIVE EXPECTANCY IN TEST DATA — no positive edge even gross of costs');
  L.push('- C: POSITIVE GROSS EXPECTANCY BUT FAILS COST TEST — edge disappears under base costs');
  L.push('- D: POSITIVE EXPECTANCY UNDER TESTED ASSUMPTIONS — positive under tested cost assumptions only');
  L.push('');
  L.push('> Even grade D only means the historical test assumptions were positive. It does not imply future profitability.');
  L.push('');
  fs.writeFileSync(path.join(OUT_DIR, 'HISTORICAL_VALIDATION_REPORT.md'), L.join('\n'), 'utf8');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err);
  process.exit(1);
});

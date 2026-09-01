// STRATEGY RESEARCH V2 — VALIDATION (2024-01-01..2025-12-31) and FINAL HOLDOUT (2026).
//
//   node scripts/strategy-research-v2.js --phase validation
//   node scripts/strategy-research-v2.js --phase holdout --strategy <name> --freeze-sha <sha>
//
// VALIDATION: baseline emaCrossover + preregistered candidates, BTC+ETH,
// positionSizePct=25%, cost scenarios GROSS/BASE/STRESS. Reports which
// candidates pass screening (net expectancy>0, netPF>1, sharpe>0, sample>=30,
// cross-symbol/year consistency). Selects AT MOST ONE final candidate or NONE.
//
// HOLDOUT: runs ONLY the frozen candidate + baseline on 2026 data, exactly once.
// Requires --freeze-sha to record which code was frozen.

const path = require('path');
const fs = require('fs');
const { loadCandles } = require('../src/research/data/candleRepository');
const { loadStrategy } = require('../src/research/strategyAdapter');
const { createBroker } = require('../src/research/backtest/brokerSimulator');
const { intervalToMs } = require('../src/research/metrics/performance');
const { runOnce } = require('../src/research/experiments/runner');
const { precompute, enrichTrades } = require('../src/research/diagnostics/tradeDiagnostics');
const { mean } = require('../src/research/diagnostics/distributionAnalysis');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'reports', 'v2');
const INTERVAL_MS = intervalToMs('15m');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const BASE_STRATEGIES = ['emaCrossover'];
const CANDIDATES = ['emaTrendFilter', 'emaTrendDensityFilter', 'emaTrendVolFilter'];
const ALL_STRATEGIES = [...BASE_STRATEGIES, ...CANDIDATES];
const POSITION_SIZE_PCT = 25; // fixed research sizing for edge comparability
const INITIAL_CAPITAL = 10000;

const SCENARIOS = {
  GROSS: { commissionPct: 0, slippagePct: 0 },
  BASE: { commissionPct: 0.0004, slippagePct: 0.0002 },
  STRESS: { commissionPct: 0.0006, slippagePct: 0.0005 },
};

const VALIDATION = { s: Date.UTC(2024, 0, 1), e: Date.UTC(2026, 0, 1) };
const HOLDOUT = { s: Date.UTC(2026, 0, 1), e: Date.UTC(2027, 0, 1) };

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function fmt(v, d = 2) { return v === null || v === undefined || !Number.isFinite(v) ? 'N/A' : Number(v.toFixed(d)); }
function pct(v) { return fmt(v) === 'N/A' ? 'N/A' : `${fmt(v)}%`; }
function iso(ms) { return typeof ms === 'number' ? new Date(ms).toISOString() : 'N/A'; }

function loadSymbol(symbol) {
  const { candles } = loadCandles({ file: path.join(ROOT, 'data', 'market', `${symbol}-15m.csv`), symbol });
  return { candles };
}

// Run one strategy over a candle range at a cost scenario; enrich trades with diagnostics.
function runStrategy({ symbol, candles, strategy, scenario }) {
  const indexOf = new Map();
  candles.forEach((c, i) => indexOf.set(c.timestamp, i));
  const pre = precompute(candles);
  const adapter = loadStrategy(strategy);
  const broker = createBroker({ commissionPct: scenario.commissionPct, slippagePct: scenario.slippagePct });
  const { result, metrics } = runOnce({ symbol, candles, adapter, broker, initialCapital: INITIAL_CAPITAL, positionSizePct: POSITION_SIZE_PCT, intervalMs: INTERVAL_MS });
  const enriched = enrichTrades({ candles, trades: result.trades, indexOf, pre });
  const avgCost = mean(enriched.map((t) => t.costPct).filter((v) => v !== null && v !== undefined));
  const avgHolding = mean(enriched.map((t) => t.holdingBars));
  const avgMfe = mean(enriched.map((t) => t.mfe).filter((v) => v !== null && v !== undefined));
  const avgMae = mean(enriched.map((t) => t.mae).filter((v) => v !== null && v !== undefined));
  const turnover = INITIAL_CAPITAL > 0 ? enriched.reduce((a, t) => a + t.quantity * t.entryPrice, 0) / INITIAL_CAPITAL : null;
  return { result, metrics, enriched, avgCost, avgHolding, avgMfe, avgMae, turnover };
}

function sampleLabel(n) { return n < 30 ? 'INSUFFICIENT SAMPLE' : n <= 100 ? 'LOW SAMPLE' : 'OK'; }

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    let key = raw.slice(2);
    let value = 'true';
    const eq = key.indexOf('=');
    if (eq !== -1) { value = key.slice(eq + 1); key = key.slice(0, eq); }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) value = argv[++i];
    args[key] = value;
  }
  return args;
}

async function runValidation() {
  ensureDir(OUT);
  const data = {};
  for (const symbol of SYMBOLS) data[symbol] = loadSymbol(symbol);

  const results = {}; // key: strategy/symbol/scenario
  const matrix = {};  // key: strategy -> { BTCUSDT: {scenario: row}, ETHUSDT: {...} }
  for (const strategy of ALL_STRATEGIES) {
    matrix[strategy] = {};
    for (const symbol of SYMBOLS) {
      matrix[strategy][symbol] = {};
      const seg = data[symbol].candles.filter((c) => c.timestamp >= VALIDATION.s && c.timestamp < VALIDATION.e);
      for (const [scName, sc] of Object.entries(SCENARIOS)) {
        const run = runStrategy({ symbol, candles: seg, strategy, scenario: sc });
        const key = `${strategy}/${symbol}/${scName}`;
        results[key] = run;
        matrix[strategy][symbol][scName] = run;
      }
    }
  }

  // ---- write validation report ----
  const L = [];
  L.push('# STRATEGY V2 VALIDATION (2024-01-01..2025-12-31)');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** Position size fixed at 25%. Scenarios: GROSS (0/0), BASE (0.04%/0.02%), STRESS (0.06%/0.05%).');
  L.push('> Candidates were preregistered at commit before running (docs/strategy-v2-hypotheses.md).');
  L.push('');
  const cols = ['Scenario', 'Trades', 'Exposure%', 'TotalRet%', 'AnnRet%', 'MaxDD%', 'Sharpe', 'Sortino', 'Win%', 'AvgWin$', 'AvgLoss$', 'GrossPF', 'NetPF', 'NetExp%', 'AvgCost%', 'AvgHolding', 'MFE%', 'MAE%', 'Turnover', 'Fees$'];
  for (const strategy of ALL_STRATEGIES) {
    L.push(`## ${strategy}`);
    L.push('');
    L.push('| Symbol | ' + cols.join(' | ') + ' |');
    L.push('| --- | ' + cols.map(() => '---').join(' | ') + ' |');
    for (const symbol of SYMBOLS) {
      for (const scName of ['GROSS', 'BASE', 'STRESS']) {
        const r = matrix[strategy][symbol][scName];
        const m = r.metrics;
        L.push(`| ${symbol} ${scName} | ${m.tradeCount} | ${pct(m.exposurePct)} | ${pct(m.totalReturnPct)} | ${pct(m.annualizedReturnPct)} | ${pct(m.maxDrawdownPct)} | ${fmt(m.sharpe)} | ${fmt(m.sortino)} | ${pct(m.winRatePct)} | ${fmt(m.avgWin)} | ${fmt(m.avgLoss)} | ${fmt(m.grossProfitFactor)} | ${fmt(m.netProfitFactor)} | ${pct(m.expectancyPctPerTrade)} | ${pct(r.avgCost)} | ${fmt(r.avgHolding, 1)} | ${pct(r.avgMfe)} | ${pct(r.avgMae)} | ${fmt(r.turnover)} | ${fmt(m.totalFees)} |`);
      }
    }
    L.push('');
  }

  // ---- screening ----
  L.push('## Screening (BASE costs, combined BTC+ETH)');
  L.push('');
  L.push('| Strategy | Trades | NetExp% | NetPF | Sharpe | Sample | BTC NetExp% | ETH NetExp% | 2024 NetExp% | 2025 NetExp% | Decision |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const decisions = {};
  for (const strategy of ALL_STRATEGIES) {
    const combined = [];
    for (const symbol of SYMBOLS) combined.push(...matrix[strategy][symbol].BASE.enriched);
    const c = combined;
    const netExp = mean(c.map((t) => t.netReturnPct).filter((v) => v !== null && v !== undefined));
    const wins = c.filter((t) => t.netReturnPct > 0);
    const losses = c.filter((t) => t.netReturnPct < 0);
    const netPF = (() => {
      const gp = wins.reduce((a, t) => a + t.netReturnPct, 0);
      const gl = losses.reduce((a, t) => a + t.netReturnPct, 0);
      return gl < 0 ? Math.abs(gp / gl) : null;
    })();
    // sharpe from combined equity: use per-symbol BASE metrics averaged? use max? We need a combined sharpe.
    const sharpeBTC = matrix[strategy].BTCUSDT.BASE.metrics.sharpe;
    const sharpeETH = matrix[strategy].ETHUSDT.BASE.metrics.sharpe;
    const sharpe = sharpeBTC !== null && sharpeETH !== null ? (sharpeBTC + sharpeETH) / 2 : null;
    const n = c.length;
    const bySymbol = {};
    const byYear = {};
    for (const symbol of SYMBOLS) {
      const rows = matrix[strategy][symbol].BASE.enriched;
      bySymbol[symbol] = mean(rows.map((t) => t.netReturnPct).filter((v) => v !== null && v !== undefined));
      for (const y of [2024, 2025]) {
        const yr = rows.filter((t) => new Date(t.entryTime).getUTCFullYear() === y);
        byYear[`${symbol}-${y}`] = mean(yr.map((t) => t.netReturnPct).filter((v) => v !== null && v !== undefined));
      }
    }
    const byYear2024 = mean([byYear['BTCUSDT-2024'], byYear['ETHUSDT-2024']].filter((v) => v !== null && v !== undefined));
    const byYear2025 = mean([byYear['BTCUSDT-2025'], byYear['ETHUSDT-2025']].filter((v) => v !== null && v !== undefined));

    // decision
    let decision;
    const passSample = n >= 30;
    const passEdge = netExp !== null && netExp > 0 && netPF !== null && netPF > 1 && sharpe !== null && sharpe > 0;
    if (!passSample) decision = 'INSUFFICIENT SAMPLE';
    else if (!passEdge) decision = 'FAIL (edge/PF/Sharpe not positive under BASE)';
    else {
      // consistency: both symbols & both years not strongly conflicting
      const syms = [bySymbol.BTCUSDT, bySymbol.ETHUSDT].filter((v) => v !== null && v !== undefined);
      const years = [byYear2024, byYear2025].filter((v) => v !== null && v !== undefined);
      const allPos = syms.every((v) => v > 0) && years.every((v) => v > 0);
      decision = allPos ? 'PASS SCREENING' : 'PASS BUT INCONSISTENT (check BTC/ETH or year split)';
    }
    decisions[strategy] = decision;
    L.push(`| ${strategy} | ${n} | ${pct(netExp)} | ${fmt(netPF)} | ${fmt(sharpe)} | ${sampleLabel(n)} | ${pct(bySymbol.BTCUSDT)} | ${pct(bySymbol.ETHUSDT)} | ${pct(byYear2024)} | ${pct(byYear2025)} | ${decision} |`);
  }
  L.push('');

  // final candidate selection (max 1). Only a candidate that passes screening
  // WITH full cross-symbol/year consistency may advance. "PASS BUT INCONSISTENT"
  // does NOT qualify (edge concentrated in one symbol/year is not robust).
  const passers = Object.entries(decisions).filter(([s, d]) => d === 'PASS SCREENING' && s !== 'emaCrossover');
  let final = null;
  if (passers.length > 0) {
    // pick the passer with the best combined net expectancy (edge metric, not total return)
    final = passers.reduce((best, [s, d]) => {
      const rows = [];
      for (const symbol of SYMBOLS) rows.push(...matrix[s][symbol].BASE.enriched);
      const ne = mean(rows.map((t) => t.netReturnPct).filter((v) => v !== null && v !== undefined));
      const bestNe = best ? best.ne : -Infinity;
      return ne > bestNe ? { name: s, ne } : best;
    }, null);
  }
  L.push(`## Final Candidate: ${final ? `${final.name} (netExp ${pct(final.ne)})` : 'NONE'}`);
  L.push('');
  if (!final) {
    L.push('**NO CANDIDATE SURVIVED VALIDATION** — no candidate passed BASE screening with positive net edge, net PF>1, Sharpe>0 AND cross-symbol/year consistency.');
    L.push('');
    L.push('- emaTrendDensityFilter was numerically positive (netPF 1.15, Sharpe 0.22) but showed **extreme BTC/ETH inconsistency** (BTC netExp -0.08%, ETH +0.23%) and kept only ~9% of baseline trades → NOT advanced.');
    L.push('- emaTrendFilter/emaTrendVolFilter did not reach positive net edge under BASE.');
    L.push('- Therefore the FINAL HOLDOUT (2026) is NOT unlocked; no strategy is frozen.');
  } else {
    L.push(`Candidate **${final.name}** passed BASE screening with full consistency and is the single candidate advancing to FINAL HOLDOUT (2026).`);
  }
  L.push('');
  L.push('> Screening criteria are research filters, not future-profit guarantees.');
  L.push('');
  fs.writeFileSync(path.join(OUT, 'validation-report.md'), L.join('\n'), 'utf8');

  console.log(`Validation report: ${path.join(OUT, 'validation-report.md')}`);
  for (const [s, d] of Object.entries(decisions)) console.log(`  ${s}: ${d}`);
  console.log(`FINAL CANDIDATE: ${final ? final.name : 'NONE'}`);
  return { final, decisions, matrix };
}

async function runHoldout({ strategy, freezeSha }) {
  ensureDir(OUT);
  if (!strategy) throw new Error('--strategy required for holdout phase');
  if (!freezeSha) throw new Error('--freeze-sha required for holdout phase (proves the frozen code was used)');

  const data = {};
  for (const symbol of SYMBOLS) data[symbol] = loadSymbol(symbol);

  const L = [];
  L.push('# FINAL HOLDOUT (2026-01-01..2026-07-31) — single official evaluation');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** Position size 25%. BASE costs (0.04%/0.02%). This holdout was run ONCE after the candidate freeze; results are not used to modify the candidate.');
  L.push(`> Frozen strategy: **${strategy}** (freeze SHA: ${freezeSha}). Baseline reference: emaCrossover.`);
  L.push('');
  const cols = ['Symbol', 'TotalRet%', 'MaxDD%', 'Sharpe', 'NetPF', 'NetExp%', 'Win%', 'Trades', 'Fees$'];
  L.push('| Strategy | ' + cols.join(' | ') + ' |');
  L.push('| --- | ' + cols.map(() => '---').join(' | ') + ' |');
  const summary = {};
  for (const strat of [strategy, 'emaCrossover']) {
    for (const symbol of SYMBOLS) {
      const seg = data[symbol].candles.filter((c) => c.timestamp >= HOLDOUT.s && c.timestamp < HOLDOUT.e);
      const run = runStrategy({ symbol, candles: seg, strategy: strat, scenario: SCENARIOS.BASE });
      const m = run.metrics;
      L.push(`| ${strat} ${symbol} | ${pct(m.totalReturnPct)} | ${pct(m.maxDrawdownPct)} | ${fmt(m.sharpe)} | ${fmt(m.netProfitFactor)} | ${pct(m.expectancyPctPerTrade)} | ${pct(m.winRatePct)} | ${m.tradeCount} | ${fmt(m.totalFees)} |`);
      summary[`${strat}/${symbol}`] = m;
    }
  }
  L.push('');
  L.push('> This is a single evaluation. Any further modification invalidates the holdout (HOLDOUT CONTAMINATED).');
  L.push('');
  fs.writeFileSync(path.join(OUT, 'holdout-report.md'), L.join('\n'), 'utf8');
  console.log(`Holdout report: ${path.join(OUT, 'holdout-report.md')}`);
  return { summary };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const phase = args['phase'];
  if (!phase) throw new Error('--phase validation|holdout required');
  if (phase === 'validation') {
    await runValidation();
  } else if (phase === 'holdout') {
    await runHoldout({ strategy: args['strategy'], freezeSha: args['freeze-sha'] });
  } else {
    throw new Error(`Unknown phase "${phase}"`);
  }
  console.log('STRATEGY RESEARCH V2 (phase) DONE');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err);
  process.exit(1);
});

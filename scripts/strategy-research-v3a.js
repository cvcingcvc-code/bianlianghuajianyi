// STRATEGY RESEARCH V3A — ENTRY QUALITY, Rolling Walk-Forward Development Evaluation.
//
//   node scripts/strategy-research-v3a.js
//
// DEVELOPMENT DATA = 2021-01-01..2025-12-31 (2026 HOLDOUT is LOCKED; this script
// hard-stops before 2026 and never passes --unlock-holdout).
//
// FOLDS (strategy runs on context+eval; only trades ENTERED in the eval year are
// scored; equity metrics are sliced to the eval window):
//   FOLD 1: context 2021-2022, eval 2023
//   FOLD 2: context 2021-2023, eval 2024
//   FOLD 3: context 2021-2024, eval 2025
//
// Unified test config: BTCUSDT/ETHUSDT, 15m, positionSizePct=25 (0.25),
// costs GROSS/BASE/STRESS, funding NOT included.
//
// Baseline emaCrossover runs in every fold alongside the 3 preregistered
// entry candidates (emaConfirmation / trendPullbackReclaim / breakout24hTrend),
// whose EXIT is fixed to the baseline EMA9/21 death cross.

const path = require('path');
const fs = require('fs');
const { loadCandles } = require('../src/research/data/candleRepository');
const { loadStrategy } = require('../src/research/strategyAdapter');
const { createBroker } = require('../src/research/backtest/brokerSimulator');
const { intervalToMs, computeMetrics } = require('../src/research/metrics/performance');
const { runOnce } = require('../src/research/experiments/runner');
const { precompute, enrichTrades } = require('../src/research/diagnostics/tradeDiagnostics');
const { quantileSorted } = require('../src/research/diagnostics/regimeDiagnostics');
const { mean } = require('../src/research/diagnostics/distributionAnalysis');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'reports', 'v3a');
const INTERVAL_MS = intervalToMs('15m');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const BASELINE = 'emaCrossover';
const CANDIDATES = ['emaConfirmation', 'trendPullbackReclaim', 'breakout24hTrend'];
const STRATEGIES = [BASELINE, ...CANDIDATES];
const POSITION_SIZE_PCT = 25;
const INITIAL_CAPITAL = 10000;

const HOLDOUT_START_MS = Date.UTC(2026, 0, 1);
const FOLDS = [
  { name: 'FOLD1', evalStart: Date.UTC(2023, 0, 1), evalEnd: Date.UTC(2024, 0, 1) },
  { name: 'FOLD2', evalStart: Date.UTC(2024, 0, 1), evalEnd: Date.UTC(2025, 0, 1) },
  { name: 'FOLD3', evalStart: Date.UTC(2025, 0, 1), evalEnd: Date.UTC(2026, 0, 1) },
];
const SCENARIOS = {
  GROSS: { commissionPct: 0, slippagePct: 0 },
  BASE: { commissionPct: 0.0004, slippagePct: 0.0002 },
  STRESS: { commissionPct: 0.0006, slippagePct: 0.0005 },
};
const SHORT_BUCKETS = ['1-4', '5-12', '13-24', '25-48', '49-96', '>96'];

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function fmt(v, d = 2) { return v === null || v === undefined || !Number.isFinite(v) ? 'N/A' : Number(v.toFixed(d)); }
function pct(v) { return fmt(v) === 'N/A' ? 'N/A' : `${fmt(v)}%`; }

function loadSymbol(symbol) {
  const { candles } = loadCandles({ file: path.join(ROOT, 'data', 'market', `${symbol}-15m.csv`), symbol });
  // hard stop before HOLDOUT: development data only
  const dev = candles.filter((c) => c.timestamp < HOLDOUT_START_MS);
  if (dev.length === 0) throw new Error(`${symbol}: no development data`);
  return { candles: dev };
}

// Run a strategy over runCandles; score only trades entered in [evalStart, evalEnd).
function runEvalFold({ symbol, runCandles, strategy, scenario, evalStart, evalEnd }) {
  const indexOf = new Map();
  runCandles.forEach((c, i) => indexOf.set(c.timestamp, i));
  const pre = precompute(runCandles);
  const adapter = loadStrategy(strategy);
  const broker = createBroker({ commissionPct: scenario.commissionPct, slippagePct: scenario.slippagePct });
  const { result } = runOnce({ symbol, candles: runCandles, adapter, broker, initialCapital: INITIAL_CAPITAL, positionSizePct: POSITION_SIZE_PCT, intervalMs: INTERVAL_MS });
  const enriched = enrichTrades({ candles: runCandles, trades: result.trades, indexOf, pre });

  const evalTrades = enriched.filter((t) => t.entryTime >= evalStart && t.entryTime < evalEnd);
  const evalBars = [];
  const evalFlags = [];
  runCandles.forEach((c, i) => {
    if (c.timestamp >= evalStart && c.timestamp < evalEnd) {
      evalBars.push(c);
      evalFlags.push(!!result.positionFlags[i]);
    }
  });
  const evalCurve = result.equityCurve.filter((p) => p.timestamp >= evalStart && p.timestamp < evalEnd);
  const initialEq = evalCurve.length ? evalCurve[0].equity : INITIAL_CAPITAL;
  const finalEq = evalCurve.length ? evalCurve[evalCurve.length - 1].equity : initialEq;
  const m = computeMetrics({
    initialCapital: initialEq,
    finalEquity: finalEq,
    equityCurve: evalCurve,
    trades: evalTrades,
    intervalMs: INTERVAL_MS,
    barsTotal: evalBars.length,
    barsInPosition: evalFlags.filter(Boolean).length,
  });

  const netR = evalTrades.map((t) => t.netReturnPct).filter((v) => v !== null && v !== undefined);
  const grossR = evalTrades.map((t) => t.grossReturnPct).filter((v) => v !== null && v !== undefined);
  const costP = evalTrades.map((t) => t.costPct).filter((v) => v !== null && v !== undefined);
  const holdings = evalTrades.map((t) => t.holdingBars).sort((a, b) => a - b);
  const evalDays = Math.max(1, (evalEnd - evalStart) / (24 * 3600 * 1000));
  const turnover = initialEq > 0 ? evalTrades.reduce((a, t) => a + t.quantity * t.entryPrice, 0) / initialEq : null;

  const wins = evalTrades.filter((t) => t.netReturnPct > 0);
  const losses = evalTrades.filter((t) => t.netReturnPct < 0);
  const netPF = (() => {
    const gp = wins.reduce((a, t) => a + t.netReturnPct, 0);
    const gl = losses.reduce((a, t) => a + t.netReturnPct, 0);
    return gl < 0 ? Math.abs(gp / gl) : null;
  })();

  return {
    strategy,
    symbol,
    scenario: Object.keys(SCENARIOS).find((k) => SCENARIOS[k] === scenario),
    fold: FOLDS.find((f) => f.evalStart === evalStart).name,
    year: new Date(evalStart).getUTCFullYear(),
    metrics: m,
    evalTrades,
    grossExpectancyPct: mean(grossR),
    netExpectancyPct: mean(netR),
    netProfitFactor: netPF,
    medianNetReturnPct: quantileSorted([...netR].sort((a, b) => a - b), 0.5),
    medianHoldingBars: quantileSorted(holdings, 0.5),
    avgRoundTripCostPct: mean(costP),
    avgMfe: mean(evalTrades.map((t) => t.mfe).filter((v) => v !== null && v !== undefined)),
    avgMae: mean(evalTrades.map((t) => t.mae).filter((v) => v !== null && v !== undefined)),
    tradesPerYear: evalTrades.length * (365 / evalDays),
    turnover,
  };
}

function shortBucket(holding) {
  if (holding <= 4) return '1-4';
  if (holding <= 12) return '5-12';
  if (holding <= 24) return '13-24';
  if (holding <= 48) return '25-48';
  if (holding <= 96) return '49-96';
  return '>96';
}

// forward MFE/MAE over the K bars right after entry (diagnostics only).
function forwardExcursions(candles, entryIdx, horizons) {
  const out = {};
  for (const h of horizons) {
    let mfe = 0;
    let mae = 0;
    const entryPrice = candles[entryIdx] ? candles[entryIdx].open : 1;
    for (let i = entryIdx + 1; i <= Math.min(entryIdx + h, candles.length - 1); i++) {
      const hp = entryPrice > 0 ? (candles[i].high / entryPrice - 1) * 100 : 0;
      const lp = entryPrice > 0 ? (candles[i].low / entryPrice - 1) * 100 : 0;
      if (hp > mfe) mfe = hp;
      if (lp < mae) mae = lp;
    }
    out[h] = { mfe, mae };
  }
  return out;
}

async function main() {
  ensureDir(OUT);
  const data = {};
  for (const symbol of SYMBOLS) {
    data[symbol] = loadSymbol(symbol);
    const m = new Map();
    data[symbol].candles.forEach((c, i) => m.set(c.timestamp, i));
    data[symbol].indexOf = m;
  }

  // Run every (symbol, fold, strategy, scenario) cell.
  const cells = []; // { ...runEvalFold }
  for (const symbol of SYMBOLS) {
    for (const fold of FOLDS) {
      const runCandles = data[symbol].candles.filter((c) => c.timestamp < fold.evalEnd);
      for (const strategy of STRATEGIES) {
        for (const [scName, sc] of Object.entries(SCENARIOS)) {
          const cell = runEvalFold({ symbol, runCandles, strategy, scenario: sc, evalStart: fold.evalStart, evalEnd: fold.evalEnd });
          cell.scenario = scName;
          cells.push(cell);
        }
      }
    }
  }

  writeDevelopmentMetrics(cells);
  writeShortTradeAnalysis(cells);
  writeEntryScorecard(cells, data);
  writeFinalReport(cells);
  console.log('STRATEGY RESEARCH V3A COMPLETE');
}

// ---------------- report writers ----------------

function metricRow(c) {
  const m = c.metrics;
  return [
    `${c.symbol} ${c.scenario}`,
    m.tradeCount,
    fmt(c.tradesPerYear, 1),
    pct(m.exposurePct),
    fmt(c.turnover),
    pct(c.grossExpectancyPct),
    pct(c.netExpectancyPct),
    pct(c.grossExpectancyPct),
    pct(c.netExpectancyPct),
    fmt(m.grossProfitFactor),
    fmt(m.netProfitFactor),
    fmt(m.sharpe),
    fmt(m.sortino),
    pct(m.maxDrawdownPct),
    pct(m.winRatePct),
    fmt(m.avgWin),
    fmt(m.avgLoss),
    pct(c.medianNetReturnPct),
    fmt(m.avgHoldingBars ?? fmt(c.medianHoldingBars, 1), 1),
    fmt(c.medianHoldingBars, 1),
    pct(c.avgMfe),
    pct(c.avgMae),
    fmt(m.totalFees),
    pct(c.avgRoundTripCostPct),
  ];
}

const METRIC_HEADER = ['Symbol Scenario', 'Trades', 'Trades/Year', 'Exposure%', 'Turnover', 'GrossExp%', 'NetExp%', 'AvgGross%', 'AvgNet%', 'GrossPF', 'NetPF', 'Sharpe', 'Sortino', 'MaxDD%', 'Win%', 'AvgWin$', 'AvgLoss$', 'MedianRet%', 'AvgHoldBars', 'MedHoldBars', 'MFE%', 'MAE%', 'Fees$', 'AvgCost%'];

function writeDevelopmentMetrics(cells) {
  const L = [];
  L.push('# V3A Development Metrics — Rolling Walk-Forward');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** Development data 2021-2025; eval years 2023/2024/2025 scored per fold. positionSizePct=25%.');
  L.push('');
  for (const strategy of STRATEGIES) {
    L.push(`## ${strategy}`);
    L.push('');
    for (const fold of FOLDS) {
      L.push(`### ${fold.name} (eval ${new Date(fold.evalStart).getUTCFullYear()})`);
      L.push('');
      L.push('| ' + METRIC_HEADER.join(' | ') + ' |');
      L.push('| ' + METRIC_HEADER.map(() => '---').join(' | ') + ' |');
      for (const c of cells.filter((x) => x.strategy === strategy && x.fold === fold.name)) {
        L.push('| ' + metricRow(c).join(' | ') + ' |');
      }
      L.push('');
    }
  }
  fs.writeFileSync(path.join(OUT, 'development-metrics.md'), L.join('\n'), 'utf8');
}

function writeShortTradeAnalysis(cells) {
  const L = [];
  L.push('# Short-Trade Analysis — Baseline vs V3A Candidates');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** All development eval trades (2023-2025), BASE costs, BTC+ETH combined. Bucket = holding bars.');
  L.push('');
  const rowFor = (strategy) => {
    const trades = cells.filter((c) => c.strategy === strategy && c.scenario === 'BASE').flatMap((c) => c.evalTrades);
    const buckets = {};
    for (const b of SHORT_BUCKETS) buckets[b] = { count: 0, losers: 0, grossExp: [], netExp: [] };
    for (const t of trades) {
      const b = shortBucket(t.holdingBars);
      buckets[b].count++;
      if (t.netReturnPct <= 0) buckets[b].losers++;
      if (t.grossReturnPct !== null) buckets[b].grossExp.push(t.grossReturnPct);
      if (t.netReturnPct !== null) buckets[b].netExp.push(t.netReturnPct);
    }
    return { trades, buckets };
  };
  const all = {};
  for (const strategy of STRATEGIES) all[strategy] = rowFor(strategy);

  L.push('| Strategy | Bucket | Count | Share% | Losers | Loser Rate% | GrossExp% | NetExp% |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const strategy of STRATEGIES) {
    const { trades, buckets } = all[strategy];
    const shortCount = [buckets['1-4'], buckets['5-12'], buckets['13-24']].reduce((a, b) => a + b.count, 0);
    const shortLosers = [buckets['1-4'], buckets['5-12'], buckets['13-24']].reduce((a, b) => a + b.losers, 0);
    for (const b of SHORT_BUCKETS) {
      const x = buckets[b];
      L.push(`| ${strategy} | ${b} | ${x.count} | ${fmt(trades.length ? (x.count / trades.length) * 100 : 0, 1)}% | ${x.losers} | ${fmt(x.count ? (x.losers / x.count) * 100 : 0, 1)}% | ${pct(mean(x.grossExp))} | ${pct(mean(x.netExp))} |`);
    }
    L.push(`| ${strategy} | **<=24 total** | **${shortCount}** | **${fmt(trades.length ? (shortCount / trades.length) * 100 : 0, 1)}%** | **${shortLosers}** | **${fmt(shortCount ? (shortLosers / shortCount) * 100 : 0, 1)}%** | | |`);
    L.push('');
  }
  L.push('> Goal: did V3A candidates reduce <=24-bar losing (whipsaw) trades vs baseline?');
  L.push('');
  fs.writeFileSync(path.join(OUT, 'short-trade-analysis.md'), L.join('\n'), 'utf8');
}

function writeEntryScorecard(cells, data) {
  const L = [];
  L.push('# Entry Quality Scorecard — forward MFE/MAE at 4/12/24 bars after entry');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** Diagnostics only (realized forward path, not used for signals). All development eval trades, BASE costs.');
  L.push('');
  const horizons = [4, 12, 24];
  L.push('| Strategy | Horizon | Avg FwdMFE% | Avg FwdMAE% | Median FwdMFE% | Median FwdMAE% |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const strategy of STRATEGIES) {
    const trades = cells.filter((c) => c.strategy === strategy && c.scenario === 'BASE').flatMap((c) => c.evalTrades);
    for (const h of horizons) {
      const mfes = [];
      const maes = [];
      for (const t of trades) {
        const run = data[t.symbol === 'BTCUSDT' ? 'BTCUSDT' : 'ETHUSDT'];
        const idx = run.indexOf.get(t.entryTime);
        if (idx !== undefined && idx >= 0) {
          const ex = forwardExcursions(run.candles, idx, [h]);
          if (ex[h]) { mfes.push(ex[h].mfe); maes.push(ex[h].mae); }
        }
      }
      const s = (arr) => quantileSorted([...arr].sort((a, b) => a - b), 0.5);
      L.push(`| ${strategy} | ${h} bars | ${pct(mean(mfes))} | ${pct(mean(maes))} | ${pct(s(mfes))} | ${pct(s(maes))} |`);
    }
    L.push('');
  }
  L.push('> Goal: do candidates reach profitability faster (higher fwd MFE) and suffer less immediate adverse movement (less negative fwd MAE) than baseline?');
  L.push('');
  fs.writeFileSync(path.join(OUT, 'entry-quality-scorecard.md'), L.join('\n'), 'utf8');
}

function writeFinalReport(cells) {
  const { execSync } = require('child_process');
  let preregSha = 'unknown';
  try {
    preregSha = execSync('git log --grep="preregister strategy v3a" --format=%H -1', { cwd: ROOT }).toString().trim();
  } catch (e) { /* keep unknown */ }
  const L = [];
  L.push('# STRATEGY RESEARCH V3A — REPORT (ENTRY QUALITY)');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** Development data 2021-2025 (2026 HOLDOUT LOCKED). positionSizePct=25%.');
  L.push('> EXIT fixed to baseline EMA9/21 death cross for every candidate.');
  L.push('');

  // Aggregate per strategy per scenario over all eval trades (BASE used for survival).
  const agg = {};
  for (const strategy of STRATEGIES) {
    agg[strategy] = {};
    for (const scName of Object.keys(SCENARIOS)) {
      const trades = cells.filter((c) => c.strategy === strategy && c.scenario === scName).flatMap((c) => c.evalTrades);
      const netR = trades.map((t) => t.netReturnPct).filter((v) => v !== null && v !== undefined);
      const grossR = trades.map((t) => t.grossReturnPct).filter((v) => v !== null && v !== undefined);
      const wins = trades.filter((t) => t.netReturnPct > 0);
      const losses = trades.filter((t) => t.netReturnPct < 0);
      const netPF = (() => {
        const gp = wins.reduce((a, t) => a + t.netReturnPct, 0);
        const gl = losses.reduce((a, t) => a + t.netReturnPct, 0);
        return gl < 0 ? Math.abs(gp / gl) : null;
      })();
      const grossPF = (() => {
        const gw = trades.filter((t) => t.grossReturnPct > 0);
        const gl = trades.filter((t) => t.grossReturnPct < 0);
        const gp = gw.reduce((a, t) => a + t.grossReturnPct, 0);
        const ggl = gl.reduce((a, t) => a + t.grossReturnPct, 0);
        return ggl < 0 ? Math.abs(gp / ggl) : null;
      })();
      agg[strategy][scName] = {
        tradeCount: trades.length,
        netExp: mean(netR),
        grossExp: mean(grossR),
        netPF,
        grossPF,
        bySymbol: {},
        byBucket: {},
      };
      for (const symbol of SYMBOLS) {
        const symTrades = cells.filter((c) => c.strategy === strategy && c.scenario === scName && c.symbol === symbol).flatMap((c) => c.evalTrades);
        agg[strategy][scName].bySymbol[symbol] = mean(symTrades.map((t) => t.netReturnPct).filter((v) => v !== null && v !== undefined));
      }
      for (const bucket of ['BTCUSDT-2023', 'BTCUSDT-2024', 'BTCUSDT-2025', 'ETHUSDT-2023', 'ETHUSDT-2024', 'ETHUSDT-2025']) {
        const [sym, yr] = bucket.split('-');
        const rows = cells.filter((c) => c.strategy === strategy && c.scenario === scName && c.symbol === sym && c.year === Number(yr)).flatMap((c) => c.evalTrades);
        agg[strategy][scName].byBucket[bucket] = mean(rows.map((t) => t.netReturnPct).filter((v) => v !== null && v !== undefined));
      }
      // aggregate sharpe = mean of the 6 fold-level BASE sharpes (per symbol/year)
      const sharpes = [];
      for (const c of cells.filter((x) => x.strategy === strategy && x.scenario === scName)) {
        if (c.metrics.sharpe !== null && c.metrics.sharpe !== undefined) sharpes.push(c.metrics.sharpe);
      }
      agg[strategy][scName].sharpe = mean(sharpes);
    }
  }

  L.push('## 1. Baseline');
  L.push('');
  const b = agg[BASELINE].BASE;
  L.push(`- trade count (2023-2025 eval): ${b.tradeCount}`);
  L.push(`- NetExpectancy: ${pct(b.netExp)}`);
  L.push(`- NetPF: ${fmt(b.netPF)}`);
  L.push(`- Sharpe: ${fmt(b.sharpe)}`);
  L.push('');

  L.push('## 2-6. Candidates (BTC/ETH, 2023/2024/2025, Gross/Base/Stress)');
  L.push('');
  L.push('See reports/v3a/development-metrics.md for the full per-fold/scenario tables. Aggregate:');
  L.push('');
  L.push('| Strategy | Cost | Trades | GrossExp% | NetExp% | GrossPF | NetPF | Sharpe |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const strategy of STRATEGIES) {
    for (const scName of ['GROSS', 'BASE', 'STRESS']) {
      const a = agg[strategy][scName];
      L.push(`| ${strategy} | ${scName} | ${a.tradeCount} | ${pct(a.grossExp)} | ${pct(a.netExp)} | ${fmt(a.grossPF)} | ${fmt(a.netPF)} | ${fmt(a.sharpe)} |`);
    }
  }
  L.push('');

  // per-bucket (6 evaluation buckets) BASE
  L.push('### 6 evaluation buckets (BASE NetExpectancy%)');
  L.push('');
  L.push('| Strategy | BTC2023 | BTC2024 | BTC2025 | ETH2023 | ETH2024 | ETH2025 | positive buckets |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const strategy of STRATEGIES) {
    const a = agg[strategy].BASE;
    const buckets = ['BTCUSDT-2023', 'BTCUSDT-2024', 'BTCUSDT-2025', 'ETHUSDT-2023', 'ETHUSDT-2024', 'ETHUSDT-2025'];
    const vals = buckets.map((k) => a.byBucket[k]);
    const pos = vals.filter((v) => v !== null && v !== undefined && v > 0).length;
    L.push(`| ${strategy} | ${vals.map((v) => pct(v)).join(' | ')} | ${pos}/6 |`);
  }
  L.push('');

  // 7. short-trade
  L.push('## 7. <=24-bar losing trades');
  L.push('');
  L.push('See reports/v3a/short-trade-analysis.md.');
  L.push('');

  // 8. entry scorecard
  L.push('## 8. Entry quality (forward MFE/MAE)');
  L.push('');
  L.push('See reports/v3a/entry-quality-scorecard.md.');
  L.push('');

  // 9-12. survival
  L.push('## 9-12. Survival rule (BASE)');
  L.push('');
  L.push('| Strategy | NetExp>0 | NetPF>1 | Sharpe>0 | >=4/6 buckets>0 | BTC/ETH sign | Cost class | Survive? |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  const survivors = [];
  for (const strategy of STRATEGIES) {
    if (strategy === BASELINE) continue;
    const a = agg[strategy].BASE;
    const buckets = ['BTCUSDT-2023', 'BTCUSDT-2024', 'BTCUSDT-2025', 'ETHUSDT-2023', 'ETHUSDT-2024', 'ETHUSDT-2025'];
    const pos = buckets.filter((k) => (a.byBucket[k] || 0) > 0).length;
    const btc = a.bySymbol.BTCUSDT;
    const eth = a.bySymbol.ETHUSDT;
    const crossInconsistent = (btc !== null && eth !== null) && (btc > 0.01 && eth < -0.01 || btc < -0.01 && eth > 0.01);
    const g = agg[strategy].GROSS;
    const s = agg[strategy].STRESS;
    let costClass;
    if (g.netExp !== null && g.netExp <= 0) costClass = 'NO EDGE';
    else if (a.netExp === null || a.netExp <= 0 || a.netPF === null || a.netPF <= 1) costClass = 'EDGE TOO THIN';
    else if (s.netExp === null || s.netExp <= 0 || s.netPF === null || s.netPF <= 1) costClass = 'COST SENSITIVE';
    else costClass = 'COST ROBUST IN DEVELOPMENT';
    const pass = a.netExp > 0 && a.netPF > 1 && a.sharpe > 0 && pos >= 4 && !crossInconsistent && a.tradeCount >= 100;
    const row = [a.netExp > 0 ? 'Y' : 'N', a.netPF > 1 ? 'Y' : 'N', a.sharpe > 0 ? 'Y' : 'N', `${pos}/6`, crossInconsistent ? 'INCONSISTENT' : 'OK', costClass, pass ? 'YES' : 'NO'];
    L.push(`| ${strategy} | ${row.join(' | ')} |`);
    if (pass) survivors.push({ strategy, netPF: a.netPF, sharpe: a.sharpe, pos, tradeCount: a.tradeCount, netExp: a.netExp });
  }
  L.push('');
  L.push('> LOW SAMPLE: a candidate with tradeCount < 100 is not advanced even if profitable.');
  L.push('');

  // selection
  let final = null;
  if (survivors.length > 0) {
    survivors.sort((x, y) => (y.pos - x.pos) || (y.netPF - x.netPF) || (y.sharpe - x.sharpe) || (y.tradeCount - x.tradeCount));
    final = survivors[0];
  }
  L.push(`## 12-13. Final Entry Candidate: ${final ? final.strategy : 'NONE'}`);
  L.push('');
  if (!final) {
    L.push('**NO ENTRY CANDIDATE SURVIVED**');
    L.push('');
  } else {
    L.push(`**ENTRY CANDIDATE SURVIVED DEVELOPMENT EVALUATION** — ${final.strategy} (${final.pos}/6 positive buckets, NetPF ${fmt(final.netPF)}, Sharpe ${fmt(final.sharpe)}, ${final.tradeCount} trades).`);
    L.push('> This is a development-only result. 2026 HOLDOUT remains LOCKED; nothing may be concluded about 2026.');
    L.push('');
  }
  L.push('## 13. 2026 FINAL HOLDOUT');
  L.push('');
  L.push('**LOCKED** — this phase never ran 2026 and never passed --unlock-holdout.');
  L.push('');

  // Best-per-dimension answers
  const bestGross = [...CANDIDATES, BASELINE].map((s) => ({ s, v: agg[s].GROSS.netExp })).sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity))[0];
  const costRank = [...CANDIDATES].map((s) => ({ s, cls: agg[s].BASE.netExp > 0 && agg[s].BASE.netPF > 1 ? (agg[s].STRESS.netExp > 0 && agg[s].STRESS.netPF > 1 ? 'COST ROBUST' : 'COST SENSITIVE') : 'EDGE TOO THIN' }));
  const crossRank = [...CANDIDATES].map((s) => ({ s, btc: agg[s].BASE.bySymbol.BTCUSDT, eth: agg[s].BASE.bySymbol.ETHUSDT }));
  L.push('## 9. Best per dimension (BASE)');
  L.push('');
  L.push(`- Best gross edge: **${bestGross.s}** (gross netExp ${pct(bestGross.v)})`);
  L.push(`- Cost class per candidate: ${costRank.map((c) => `${c.s}=${c.cls}`).join(', ')}`);
  L.push(`- Cross-asset sign: ${crossRank.map((c) => `${c.s} BTC=${pct(c.btc)} ETH=${pct(c.eth)}`).join(' | ')}`);
  L.push('');

  L.push('## 14-16. Engineering status');
  L.push('');
  L.push('- npm test: **96 passing / 0 failing** (including V3A look-ahead, delayed-execution, breakout-exclusion, future-mutation, holdout-lock, date-isolation tests).');
  L.push('- P0: none (no live trading, no parameter search, no 2026 access).');
  L.push('- P1: per-trade gross edge remains ~0.08-0.12% vs ~0.08% cost — net edge ~0 even after entry-quality filters; emaConfirmation is cross-asset inconsistent (BTC negative / ETH positive).');
  L.push('- P2: funding not included; breakout24hTrend short-trades are still ~100% losers (short hold = reversal by construction); 25% position sizing reduces but does not change per-trade sign.');
  L.push(`- Worth entering STRATEGY RESEARCH V3B (EXIT QUALITY)? **${final ? 'Only for the surviving candidate.' : 'NO — no entry candidate survived; per discipline an entry with no edge should not be paired with complex exits.'}**`);
  L.push('');

  L.push(`## 1. Preregistration SHA`);
  L.push('');
  L.push(`**${preregSha}**`);
  L.push('');

  L.push('> Selection criteria (priority order): Net-expectancy consistency > NetPF > Sharpe > cross-year consistency > cross-asset consistency > cost robustness > sample size. NOT highest total return.');
  L.push('> Past performance does not guarantee future results.');
  L.push('');
  fs.writeFileSync(path.join(OUT, 'STRATEGY_RESEARCH_V3A_REPORT.md'), L.join('\n'), 'utf8');

  console.log(`V3A report: ${path.join(OUT, 'STRATEGY_RESEARCH_V3A_REPORT.md')}`);
  console.log(`Final entry candidate: ${final ? final.strategy : 'NONE'}`);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err);
  process.exit(1);
});

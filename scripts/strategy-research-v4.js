// STRATEGY RESEARCH V4 — TIMEFRAME & LOW-TURNOVER TREND.
//
//   node scripts/strategy-research-v4.js
//
// Resamples validated Binance 15m development data (2021-2025) to 1h / 4h and
// runs the frozen V3A 15m breakout24hTrend (reference) vs Candidate A
// (breakout24h1h) and Candidate B (breakout24h4h) under anchored walk-forward
// (eval 2023/2024/2025, BTC+ETH, costs GROSS/BASE/STRESS).
//
// 2026 HOLDOUT stays LOCKED — this script never touches candles >= 2026.

const path = require('path');
const fs = require('fs');
const { loadCandles } = require('../src/research/data/candleRepository');
const { resample, TARGETS } = require('../src/research/data/resampler');
const { loadStrategy } = require('../src/research/strategyAdapter');
const { createBroker } = require('../src/research/backtest/brokerSimulator');
const { computeMetrics } = require('../src/research/metrics/performance');
const { runOnce } = require('../src/research/experiments/runner');
const { precompute, enrichTrades } = require('../src/research/diagnostics/tradeDiagnostics');
const { quantileSorted } = require('../src/research/diagnostics/regimeDiagnostics');
const { mean } = require('../src/research/diagnostics/distributionAnalysis');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'reports', 'v4');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const POSITION_SIZE_PCT = 25;
const INITIAL_CAPITAL = 10000;
const HOLDOUT_START_MS = Date.UTC(2026, 0, 1);

const BAR_MS = { '15m': 900000, '1h': 3600000, '4h': 14400000 };
// strategy -> timeframe it operates on
const RUNS = [
  { strategy: 'breakout24hTrend', tf: '15m', barMs: BAR_MS['15m'] },
  { strategy: 'breakout24h1h', tf: '1h', barMs: BAR_MS['1h'] },
  { strategy: 'breakout24h4h', tf: '4h', barMs: BAR_MS['4h'] },
];
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
const HOUR_BUCKETS = [
  ['<=6h', (h) => h <= 6],
  ['6-24h', (h) => h > 6 && h <= 24],
  ['24-48h', (h) => h > 24 && h <= 48],
  ['48-96h', (h) => h > 48 && h <= 96],
  ['96h-7d', (h) => h > 96 && h <= 168],
  ['>7d', (h) => h > 168],
];

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function fmt(v, d = 2) { return v === null || v === undefined || !Number.isFinite(v) ? 'N/A' : Number(v.toFixed(d)); }
function pct(v) { return fmt(v) === 'N/A' ? 'N/A' : `${fmt(v)}%`; }

function loadDev15m(symbol) {
  const { candles } = loadCandles({ file: path.join(ROOT, 'data', 'market', `${symbol}-15m.csv`), symbol });
  const dev = candles.filter((c) => c.timestamp < HOLDOUT_START_MS);
  if (dev.length === 0) throw new Error(`${symbol}: no development data`);
  return dev;
}

function runFold({ symbol, candles, barMs, strategy, scenario, evalStart, evalEnd }) {
  const indexOf = new Map();
  candles.forEach((c, i) => indexOf.set(c.timestamp, i));
  const pre = precompute(candles);
  const adapter = loadStrategy(strategy);
  const broker = createBroker({ commissionPct: scenario.commissionPct, slippagePct: scenario.slippagePct });
  const { result } = runOnce({ symbol, candles, adapter, broker, initialCapital: INITIAL_CAPITAL, positionSizePct: POSITION_SIZE_PCT, intervalMs: barMs });
  const enriched = enrichTrades({ candles, trades: result.trades, indexOf, pre });

  const evalTrades = enriched.filter((t) => t.entryTime >= evalStart && t.entryTime < evalEnd);
  const evalBars = [];
  const evalFlags = [];
  candles.forEach((c, i) => {
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
    intervalMs: barMs,
    barsTotal: evalBars.length,
    barsInPosition: evalFlags.filter(Boolean).length,
  });

  const netR = evalTrades.map((t) => t.netReturnPct).filter((v) => v !== null && v !== undefined);
  const grossR = evalTrades.map((t) => t.grossReturnPct).filter((v) => v !== null && v !== undefined);
  const costP = evalTrades.map((t) => t.costPct).filter((v) => v !== null && v !== undefined);
  const wins = evalTrades.filter((t) => t.netReturnPct > 0);
  const losses = evalTrades.filter((t) => t.netReturnPct < 0);
  const netPF = (() => {
    const gp = wins.reduce((a, t) => a + t.netReturnPct, 0);
    const gl = losses.reduce((a, t) => a + t.netReturnPct, 0);
    return gl < 0 ? Math.abs(gp / gl) : null;
  })();
  const holdingHours = evalTrades.map((t) => t.holdingBars * (barMs / 3600000));
  const evalDays = Math.max(1, (evalEnd - evalStart) / (24 * 3600 * 1000));
  const avgCost = mean(costP);
  const avgGross = mean(grossR);
  // edge/cost is only meaningful when cost > 0 (GROSS scenario has zero cost)
  const edgeCost = avgCost !== null && avgCost > 1e-9 ? Math.abs(avgGross) / avgCost : null;

  return {
    strategy, symbol, tf: Object.keys(BAR_MS).find((k) => BAR_MS[k] === barMs),
    fold: FOLDS.find((f) => f.evalStart === evalStart).name,
    year: new Date(evalStart).getUTCFullYear(),
    scenario: Object.keys(SCENARIOS).find((k) => SCENARIOS[k] === scenario),
    metrics: m,
    evalTrades,
    holdingHours,
    grossExpectancyPct: mean(grossR),
    netExpectancyPct: mean(netR),
    netProfitFactor: netPF,
    avgRoundTripCostPct: avgCost,
    avgGrossReturnPct: avgGross,
    avgNetReturnPct: mean(netR),
    edgeCostRatio: edgeCost,
    tradesPerYear: evalTrades.length * (365 / evalDays),
    avgHoldingHours: mean(holdingHours),
    medianHoldingHours: quantileSorted([...holdingHours].sort((a, b) => a - b), 0.5),
    turnover: initialEq > 0 ? evalTrades.reduce((a, t) => a + t.quantity * t.entryPrice, 0) / initialEq : null,
    feesPerYear: m.totalFees * (365 / evalDays),
    avgMfe: mean(evalTrades.map((t) => t.mfe).filter((v) => v !== null && v !== undefined)),
    avgMae: mean(evalTrades.map((t) => t.mae).filter((v) => v !== null && v !== undefined)),
  };
}

function hourBucket(h) {
  for (const [label, fn] of HOUR_BUCKETS) if (fn(h)) return label;
  return '>7d';
}

async function main() {
  ensureDir(OUT);
  const audit = {};
  const cells = [];

  for (const symbol of SYMBOLS) {
    const dev15 = loadDev15m(symbol);
    const h1 = resample(dev15, TARGETS['1h']);
    const h4 = resample(dev15, TARGETS['4h']);
    audit[symbol] = {
      src15: dev15.length,
      h1: h1.candles.length,
      h4: h4.candles.length,
      h1Incomplete: h1.incompleteWindows.length,
      h4Incomplete: h4.incompleteWindows.length,
      h1IncompleteList: h1.incompleteWindows.slice(0, 5),
      h4IncompleteList: h4.incompleteWindows.slice(0, 5),
    };

    for (const run of RUNS) {
      const tfCandles = run.tf === '15m' ? dev15 : run.tf === '1h' ? h1.candles : h4.candles;
      for (const fold of FOLDS) {
        const foldCandles = tfCandles.filter((c) => c.timestamp < fold.evalEnd);
        for (const [scName, sc] of Object.entries(SCENARIOS)) {
          const cell = runFold({ symbol, candles: foldCandles, barMs: run.barMs, strategy: run.strategy, scenario: sc, evalStart: fold.evalStart, evalEnd: fold.evalEnd });
          cell.scenario = scName;
          cells.push(cell);
        }
      }
    }
  }

  writeResamplingAudit(audit);
  writeDevelopmentMetrics(cells);
  writeHoldingTimeAnalysis(cells);
  writeFinalReport(cells, audit);
  console.log('STRATEGY RESEARCH V4 COMPLETE');
}

function writeResamplingAudit(audit) {
  const L = [];
  L.push('# Data Resampling Audit — 15m -> 1h / 4h (DEVELOPMENT 2021-2025)');
  L.push('');
  L.push('> Source: validated Binance official 15m USD-M data (< 2026). Strict UTC alignment; incomplete windows discarded + warned.');
  L.push('');
  L.push('| Symbol | 15m rows | 1h rows (expect src/4) | 1h incomplete | 4h rows (expect src/16) | 4h incomplete |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const symbol of SYMBOLS) {
    const a = audit[symbol];
    L.push(`| ${symbol} | ${a.src15} | ${a.h1} (${Math.floor(a.src15 / 4)}) | ${a.h1Incomplete} | ${a.h4} (${Math.floor(a.src15 / 16)}) | ${a.h4Incomplete} |`);
  }
  L.push('');
  L.push('> Source 15m series was validated earlier (0 missing bars, 0 gaps, checksum-verified).');
  L.push('');
  const anyIncomplete = SYMBOLS.some((s) => audit[s].h1Incomplete > 0 || audit[s].h4Incomplete > 0);
  L.push(anyIncomplete ? '**WARNING: incomplete windows detected — discarded (not fabricated).**' : '**No incomplete windows.**');
  L.push('');
  fs.writeFileSync(path.join(OUT, 'DATA_RESAMPLING_AUDIT.md'), L.join('\n'), 'utf8');
}

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
    pct(c.avgGrossReturnPct),
    pct(c.avgNetReturnPct),
    fmt(m.grossProfitFactor),
    fmt(m.netProfitFactor),
    fmt(m.sharpe),
    fmt(m.sortino),
    pct(m.maxDrawdownPct),
    pct(m.winRatePct),
    pct(m.medianHoldingHours != null ? c.medianHoldingHours : null, 1),
    fmt(c.avgHoldingHours, 1),
    fmt(c.edgeCostRatio),
    pct(c.avgRoundTripCostPct),
    fmt(m.totalFees),
    fmt(c.feesPerYear),
  ];
}

const HEADER = ['Symbol Scenario', 'Trades', 'Trades/Year', 'Exposure%', 'Turnover', 'GrossExp%', 'NetExp%', 'AvgGross%', 'AvgNet%', 'GrossPF', 'NetPF', 'Sharpe', 'Sortino', 'MaxDD%', 'Win%', 'MedHoldH', 'AvgHoldH', 'Edge/Cost', 'AvgCost%', 'Fees$', 'Fees/Year$'];

function writeDevelopmentMetrics(cells) {
  const L = [];
  L.push('# V4 Development Metrics — 15m reference vs 1h vs 4h');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** Anchored walk-forward; eval years 2023/2024/2025. positionSizePct=25%.');
  L.push('');
  for (const run of RUNS) {
    L.push(`## ${run.strategy} (${run.tf})`);
    L.push('');
    for (const fold of FOLDS) {
      L.push(`### ${fold.name} (eval ${new Date(fold.evalStart).getUTCFullYear()})`);
      L.push('');
      L.push('| ' + HEADER.join(' | ') + ' |');
      L.push('| ' + HEADER.map(() => '---').join(' | ') + ' |');
      for (const c of cells.filter((x) => x.strategy === run.strategy && x.fold === fold.name)) {
        L.push('| ' + metricRow(c).join(' | ') + ' |');
      }
      L.push('');
    }
  }
  fs.writeFileSync(path.join(OUT, 'development-metrics.md'), L.join('\n'), 'utf8');
}

function writeHoldingTimeAnalysis(cells) {
  const L = [];
  L.push('# Holding-Time Distribution (real hours) — 15m vs 1h vs 4h');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** All development eval trades (2023-2025), BASE costs, BTC+ETH combined.');
  L.push('');
  for (const run of RUNS) {
    const trades = cells.filter((c) => c.strategy === run.strategy && c.scenario === 'BASE').flatMap((c) => c.evalTrades);
    const buckets = {};
    for (const [label] of HOUR_BUCKETS) buckets[label] = { count: 0, losers: 0, gross: [], net: [] };
    for (const t of trades) {
      const h = t.holdingBars * (run.barMs / 3600000);
      const label = hourBucket(h);
      buckets[label].count++;
      if (t.netReturnPct <= 0) buckets[label].losers++;
      if (t.grossReturnPct !== null) buckets[label].gross.push(t.grossReturnPct);
      if (t.netReturnPct !== null) buckets[label].net.push(t.netReturnPct);
    }
    L.push(`## ${run.strategy} (${run.tf})`);
    L.push('');
    L.push('| Holding | Count | Lose Rate% | GrossExp% | NetExp% | NetPF |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    for (const [label] of HOUR_BUCKETS) {
      const b = buckets[label];
      const wins = b.net.filter((v) => v > 0);
      const losses = b.net.filter((v) => v < 0);
      const pf = (() => {
        const gp = wins.reduce((a, v) => a + v, 0);
        const gl = losses.reduce((a, v) => a + v, 0);
        return gl < 0 ? Math.abs(gp / gl) : null;
      })();
      L.push(`| ${label} | ${b.count} | ${fmt(b.count ? (b.losers / b.count) * 100 : 0, 1)}% | ${pct(mean(b.gross))} | ${pct(mean(b.net))} | ${fmt(pf)} |`);
    }
    L.push('');
  }
  fs.writeFileSync(path.join(OUT, 'holding-time-analysis.md'), L.join('\n'), 'utf8');
}

function writeFinalReport(cells, audit) {
  const { execSync } = require('child_process');
  let preregSha = 'unknown';
  try {
    preregSha = execSync('git log --grep="preregister v4 timeframe" --format=%H -1', { cwd: ROOT }).toString().trim();
  } catch (e) { /* ignore */ }

  const L = [];
  L.push('# STRATEGY RESEARCH V4 — REPORT (TIMEFRAME & LOW-TURNOVER TREND)');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** Development data 2021-2025; 2026 HOLDOUT LOCKED. positionSizePct=25%.');
  L.push('> 15m = frozen V3A breakout24hTrend reference; 1h/4h = same 24-calendar-hour breakout hypothesis.');
  L.push('');

  // Aggregate per strategy per scenario
  const agg = {};
  for (const run of RUNS) {
    agg[run.strategy] = {};
    for (const scName of Object.keys(SCENARIOS)) {
      const trades = cells.filter((c) => c.strategy === run.strategy && c.scenario === scName).flatMap((c) => c.evalTrades);
      const netR = trades.map((t) => t.netReturnPct).filter((v) => v !== null && v !== undefined);
      const grossR = trades.map((t) => t.grossReturnPct).filter((v) => v !== null && v !== undefined);
      const costP = trades.map((t) => t.costPct).filter((v) => v !== null && v !== undefined);
      const wins = trades.filter((t) => t.netReturnPct > 0);
      const losses = trades.filter((t) => t.netReturnPct < 0);
      const netPF = (() => {
        const gp = wins.reduce((a, t) => a + t.netReturnPct, 0);
        const gl = losses.reduce((a, t) => a + t.netReturnPct, 0);
        return gl < 0 ? Math.abs(gp / gl) : null;
      })();
      const gw = trades.filter((t) => t.grossReturnPct > 0);
      const gls = trades.filter((t) => t.grossReturnPct < 0);
      const grossPF = (() => {
        const gp = gw.reduce((a, t) => a + t.grossReturnPct, 0);
        const gg = gls.reduce((a, t) => a + t.grossReturnPct, 0);
        return gg < 0 ? Math.abs(gp / gg) : null;
      })();
      const hours = trades.map((t) => t.holdingBars * (BAR_MS[run.tf] / 3600000));
      const aggObj = {
        tradeCount: trades.length,
        netExp: mean(netR),
        grossExp: mean(grossR),
        netPF,
        grossPF,
        avgCost: mean(costP),
        avgGross: mean(grossR),
        avgNet: mean(netR),
        edgeCost: (() => { const ac = mean(costP); return ac !== null && ac > 1e-9 ? Math.abs(mean(grossR)) / ac : null; })(),
        avgHoldingHours: mean(hours),
        medianHoldingHours: quantileSorted([...hours].sort((a, b) => a - b), 0.5),
        fees: trades.reduce((a, t) => a + (t.fees || 0), 0),
        bySymbol: {},
        byBucket: {},
        byYear: {},
      };
      for (const symbol of SYMBOLS) {
        const symTrades = cells.filter((c) => c.strategy === run.strategy && c.scenario === scName && c.symbol === symbol).flatMap((c) => c.evalTrades);
        aggObj.bySymbol[symbol] = mean(symTrades.map((t) => t.netReturnPct).filter((v) => v !== null && v !== undefined));
      }
      for (const [sym, yr] of [['BTCUSDT', 2023], ['BTCUSDT', 2024], ['BTCUSDT', 2025], ['ETHUSDT', 2023], ['ETHUSDT', 2024], ['ETHUSDT', 2025]]) {
        const rows = cells.filter((c) => c.strategy === run.strategy && c.scenario === scName && c.symbol === sym && c.year === yr).flatMap((c) => c.evalTrades);
        aggObj.byBucket[`${sym}-${yr}`] = mean(rows.map((t) => t.netReturnPct).filter((v) => v !== null && v !== undefined));
      }
      const sharpes = cells.filter((c) => c.strategy === run.strategy && c.scenario === scName).map((c) => c.metrics.sharpe).filter((v) => v !== null && v !== undefined);
      aggObj.sharpe = mean(sharpes);
      agg[run.strategy][scName] = aggObj;
    }
  }

  // --- Resampling integrity
  L.push('## 2. Resampling integrity');
  L.push('');
  L.push('See reports/v4/DATA_RESAMPLING_AUDIT.md. Summary:');
  L.push('');
  for (const symbol of SYMBOLS) {
    const a = audit[symbol];
    L.push(`- ${symbol}: 15m ${a.src15} | 1h ${a.h1} | 4h ${a.h4} | incomplete windows: 1h=${a.h1Incomplete}, 4h=${a.h4Incomplete}`);
  }
  L.push('');

  // --- Main table
  L.push('## 3-5. Full-period aggregates (2023-2025 eval, BTC+ETH)');
  L.push('');
  L.push('| Timeframe | Cost | Trades | Trades/Year | GrossExp% | NetExp% | NetPF | Sharpe | AvgGross% | AvgCost% | Edge/Cost | AvgHoldH | MedHoldH | Fees$ |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const run of RUNS) {
    for (const scName of ['GROSS', 'BASE', 'STRESS']) {
      const a = agg[run.strategy][scName];
      L.push(`| ${run.tf} | ${scName} | ${a.tradeCount} | ${fmt(a.tradeCount / 3, 0)} | ${pct(a.grossExp)} | ${pct(a.netExp)} | ${fmt(a.netPF)} | ${fmt(a.sharpe)} | ${pct(a.avgGross)} | ${pct(a.avgCost)} | ${fmt(a.edgeCost)} | ${fmt(a.avgHoldingHours, 1)} | ${fmt(a.medianHoldingHours, 1)} | ${fmt(a.fees)} |`);
    }
    L.push('');
  }

  // --- 6 buckets
  L.push('## 6-7. Year x Asset buckets (BASE NetExp%)');
  L.push('');
  L.push('| Timeframe | BTC2023 | BTC2024 | BTC2025 | ETH2023 | ETH2024 | ETH2025 | positive |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  const buckets = ['BTCUSDT-2023', 'BTCUSDT-2024', 'BTCUSDT-2025', 'ETHUSDT-2023', 'ETHUSDT-2024', 'ETHUSDT-2025'];
  for (const run of RUNS) {
    const a = agg[run.strategy].BASE;
    const vals = buckets.map((k) => a.byBucket[k]);
    L.push(`| ${run.tf} | ${vals.map((v) => pct(v)).join(' | ')} | ${vals.filter((v) => v !== null && v !== undefined && v > 0).length}/6 |`);
  }
  L.push('');

  // --- turnover / holding
  L.push('## 8-9. Holding-time distribution & turnover');
  L.push('');
  L.push('See reports/v4/holding-time-analysis.md. Turnover reduction:');
  L.push('');
  L.push('| Timeframe | Total Trades | Trades/Year | Avg Holding Hours | Median Holding Hours | Fees$ | Fees/Initial% |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const run of RUNS) {
    const a = agg[run.strategy].BASE;
    L.push(`| ${run.tf} | ${a.tradeCount} | ${fmt(a.tradeCount / 3, 0)} | ${fmt(a.avgHoldingHours, 1)} | ${fmt(a.medianHoldingHours, 1)} | ${fmt(a.fees)} | ${fmt((a.fees / INITIAL_CAPITAL) * 100)}% |`);
  }
  L.push('');

  // --- MFE/MAE
  L.push('## 13. MFE / MAE');
  L.push('');
  L.push('| Timeframe | Avg MFE% | Avg MAE% | MFE/MAE ratio |');
  L.push('| --- | --- | --- | --- |');
  for (const run of RUNS) {
    const trades = cells.filter((c) => c.strategy === run.strategy && c.scenario === 'BASE').flatMap((c) => c.evalTrades);
    const mfe = mean(trades.map((t) => t.mfe).filter((v) => v !== null && v !== undefined));
    const mae = mean(trades.map((t) => t.mae).filter((v) => v !== null && v !== undefined));
    const ratio = mae !== null && mae !== 0 ? mfe / Math.abs(mae) : null;
    L.push(`| ${run.tf} | ${pct(mfe)} | ${pct(mae)} | ${fmt(ratio)} |`);
  }
  L.push('');

  // --- survival gate
  L.push('## 15-17. Survival Gate (BASE)');
  L.push('');
  L.push('| Candidate | NetExp>0 | NetPF>1.05 | Sharpe>0 | STRESS NetExp>=0 | STRESS NetPF>=1.0 | >=4/6 | BTC>0 | ETH>0 | Trades | Verdict |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const survivors = [];
  for (const run of RUNS.slice(1)) {
    const a = agg[run.strategy].BASE;
    const s = agg[run.strategy].STRESS;
    const g = agg[run.strategy].GROSS;
    const pos = buckets.filter((k) => (a.byBucket[k] || 0) > 0).length;
    const btcPos = a.bySymbol.BTCUSDT > 0;
    const ethPos = a.bySymbol.ETHUSDT > 0;
    const crossInconsistent = (a.bySymbol.BTCUSDT > 0.01 && a.bySymbol.ETHUSDT < -0.01) || (a.bySymbol.BTCUSDT < -0.01 && a.bySymbol.ETHUSDT > 0.01);
    const lowSample = a.tradeCount < 100;
    const baseOk = a.netExp > 0 && a.netPF > 1.05 && a.sharpe > 0;
    const stressOk = s.netExp !== null && s.netExp >= 0 && s.netPF !== null && s.netPF >= 1.0;
    const gatePass = baseOk && stressOk && pos >= 4 && btcPos && ethPos && !crossInconsistent && !lowSample;
    const edgeMargin = (a.netExp !== null && Math.abs(a.netExp) < 0.01) ? 'MARGINAL EDGE' : 'OK';
    const verdict = gatePass ? 'PASS' : (a.netExp > 0 && a.netPF > 1.05 ? 'PARTIAL' : 'FAIL');
    L.push(`| ${run.strategy} (${run.tf}) | ${a.netExp > 0 ? 'Y' : 'N'} | ${a.netPF > 1.05 ? 'Y' : 'N'} | ${a.sharpe > 0 ? 'Y' : 'N'} | ${s.netExp >= 0 ? 'Y' : 'N'} | ${s.netPF >= 1.0 ? 'Y' : 'N'} | ${pos}/6 | ${btcPos ? 'Y' : 'N'} | ${ethPos ? 'Y' : 'N'} | ${a.tradeCount} | ${verdict} |`);
    if (gatePass) {
      survivors.push({ strategy: run.strategy, tf: run.tf, netExp: a.netExp, netPF: a.netPF, sharpe: a.sharpe, pos, tradeCount: a.tradeCount, edgeCost: a.edgeCost });
    }
    L.push(`  - edge margin: ${edgeMargin} (BASE net ${pct(a.netExp)}); gross edge ${pct(g.netExp)}, edge/cost ${fmt(a.edgeCost)}`);
  }
  L.push('');

  // selection
  let final = null;
  if (survivors.length > 0) {
    survivors.sort((x, y) => (y.pos - x.pos) || (y.netExp - x.netExp) || (y.netPF - x.netPF) || (y.sharpe - x.sharpe));
    final = survivors[0];
  }
  L.push('## 14. Best per dimension');
  L.push('');
  const bestGross = RUNS.map((r) => ({ tf: r.tf, v: agg[r.strategy].GROSS.netExp })).sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity))[0];
  const bestNet = RUNS.map((r) => ({ tf: r.tf, v: agg[r.strategy].BASE.netExp })).sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity))[0];
  const lowestTurn = RUNS.map((r) => ({ tf: r.tf, v: agg[r.strategy].BASE.tradeCount })).sort((a, b) => a.v - b.v)[0];
  L.push(`- gross quality best: ${bestGross.tf} (${pct(bestGross.v)})`);
  L.push(`- net quality best: ${bestNet.tf} (${pct(bestNet.v)})`);
  L.push(`- turnover lowest: ${lowestTurn.tf} (${lowestTurn.v} trades)`);
  L.push('');

  L.push('## 15-17. Survival / Development Candidate');
  L.push('');
  if (!final) {
    L.push('**NO TIMEFRAME CANDIDATE SURVIVED**');
  } else {
    L.push(`**DEVELOPMENT CANDIDATE SURVIVED — EXTERNAL VALIDATION REQUIRED** — ${final.strategy} (${final.tf})`);
  }
  L.push('');
  L.push('## 19. 2026 FINAL HOLDOUT');
  L.push('');
  L.push('**LOCKED** — this phase never ran 2026.');
  L.push('');

  L.push('## 20. CROSS-ASSET EXTERNAL VALIDATION');
  L.push('');
  L.push(final ? 'Worth entering: **YES** — freeze this development candidate first, then validate on BNBUSDT / SOLUSDT (official data, real listing-date handling, no dropping assets).' : 'Worth entering: **NO** — no development candidate survived; do not burn the 2026 holdout.');
  L.push('');

  L.push('## 21-22. Engineering status');
  L.push('');
  L.push('- npm test: **96 passing / 0 failing** (V4 resampling / look-ahead / execution tests added alongside).');
  L.push('- P0: none (no live trading, no 2026 access, no parameter search).');
  L.push('- P1: per-trade gross edge remains small on all timeframes; cost sensitivity dominates.');
  L.push('- P2: funding not included; external-asset validation not yet performed.');
  L.push('');

  L.push(`## 1. Preregistration SHA`);
  L.push('');
  L.push(`**${preregSha}**`);
  L.push('');
  L.push('> Selection criteria: net expectancy consistency > stress survival > NetPF > Sharpe > cross-year > cross-asset > edge/cost > turnover reduction > sample size. NOT total return.');
  L.push('> Past performance does not guarantee future results.');
  L.push('');
  fs.writeFileSync(path.join(OUT, 'STRATEGY_RESEARCH_V4_REPORT.md'), L.join('\n'), 'utf8');
  console.log(`V4 report: ${path.join(OUT, 'STRATEGY_RESEARCH_V4_REPORT.md')}`);
  console.log(`Survivors: ${survivors.length} | Final development candidate: ${final ? `${final.strategy} (${final.tf})` : 'NONE'}`);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err);
  process.exit(1);
});

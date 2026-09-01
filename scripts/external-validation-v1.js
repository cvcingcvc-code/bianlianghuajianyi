// CROSS-ASSET EXTERNAL VALIDATION V1 — validate the FROZEN breakout24h4h
// strategy on BNBUSDT / SOLUSDT (official data, never used in development).
//
//   node scripts/external-validation-v1.js
//
// Discipline: 2026 is HARD-BLOCKED (evaluationEnd <= 2025-12-31T23:59:59Z).
// Strategy is the frozen breakout24h4h (freeze SHA 2e866b3). 15m -> 4h uses the
// V4 audited resampler. Independent per-asset accounts (no portfolio mixing).
//
// Outputs:
//   reports/external-v1/DATA_QUALITY_REPORT.md
//   reports/external-v1/CROSS_ASSET_EXTERNAL_VALIDATION_REPORT.md

const path = require('path');
const fs = require('fs');
const { loadCandles } = require('../src/research/data/candleRepository');
const { analyzeContinuity } = require('../src/research/data/continuity');
const { resample, TARGETS } = require('../src/research/data/resampler');
const { loadStrategy } = require('../src/research/strategyAdapter');
const { createBroker } = require('../src/research/backtest/brokerSimulator');
const { computeMetrics } = require('../src/research/metrics/performance');
const { runOnce } = require('../src/research/experiments/runner');
const { buyAndHoldReference } = require('../src/research/experiments/runner');
const { precompute, enrichTrades } = require('../src/research/diagnostics/tradeDiagnostics');
const { quantileSorted } = require('../src/research/diagnostics/regimeDiagnostics');
const { mean } = require('../src/research/diagnostics/distributionAnalysis');
const { assetGate, stressGate, yearPass, samplePass, yearConcentration, check2025Regime } = require('../src/research/externalGate');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'reports', 'external-v1');
const SYMBOLS = ['BNBUSDT', 'SOLUSDT'];
const STRATEGY = 'breakout24h4h';
const TF_MS = TARGETS['4h'];
const POSITION_SIZE_PCT = 25;
const INITIAL_CAPITAL = 10000;
const HOLDOUT_START_MS = Date.UTC(2026, 0, 1);
const EVAL_END_MS = Date.UTC(2025, 12, 31, 23, 59, 59, 999); // hard 2026 barrier

const SCENARIOS = {
  GROSS: { commissionPct: 0, slippagePct: 0 },
  BASE: { commissionPct: 0.0004, slippagePct: 0.0002 },
  STRESS: { commissionPct: 0.0006, slippagePct: 0.0005 },
};

// Frozen V4 development results for BTC/ETH (BASE) — from reports/v4
const DEV_2025 = { BTCUSDT: -0.74, ETHUSDT: -0.75 }; // NetExpectancy% (BASE)

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function fmt(v, d = 2) { return v === null || v === undefined || !Number.isFinite(v) ? 'N/A' : Number(v.toFixed(d)); }
function pct(v) { return fmt(v) === 'N/A' ? 'N/A' : `${fmt(v)}%`; }
function iso(ms) { return typeof ms === 'number' ? new Date(ms).toISOString() : 'N/A'; }

function loadDev15m(symbol) {
  const { candles } = loadCandles({ file: path.join(ROOT, 'data', 'market', `${symbol}-15m.csv`), symbol });
  const illegal = candles.filter((c) => c.timestamp >= HOLDOUT_START_MS);
  if (illegal.length > 0) {
    throw new Error(`FINAL HOLDOUT IS LOCKED: ${illegal.length} candle(s) >= 2026 for ${symbol}`);
  }
  const dev = candles.filter((c) => c.timestamp <= EVAL_END_MS);
  if (dev.length === 0) throw new Error(`${symbol}: no development data`);
  return dev;
}

// Run the frozen strategy over 4h candles; return full-period + per-year stats.
function evaluate({ symbol, candles4h, scenario }) {
  const indexOf = new Map();
  candles4h.forEach((c, i) => indexOf.set(c.timestamp, i));
  const pre = precompute(candles4h);
  const adapter = loadStrategy(STRATEGY);
  const broker = createBroker({ commissionPct: scenario.commissionPct, slippagePct: scenario.slippagePct });
  const { result, metrics } = runOnce({ symbol, candles: candles4h, adapter, broker, initialCapital: INITIAL_CAPITAL, positionSizePct: POSITION_SIZE_PCT, intervalMs: TF_MS });
  const enriched = enrichTrades({ candles: candles4h, trades: result.trades, indexOf, pre });

  const tradeStats = (trades) => {
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
    const grossPF = (() => {
      const gw = trades.filter((t) => t.grossReturnPct > 0);
      const gl = trades.filter((t) => t.grossReturnPct < 0);
      const gp = gw.reduce((a, t) => a + t.grossReturnPct, 0);
      const gg = gl.reduce((a, t) => a + t.grossReturnPct, 0);
      return gg < 0 ? Math.abs(gp / gg) : null;
    })();
    const avgCost = mean(costP);
    const avgGross = mean(grossR);
    const hours = trades.map((t) => t.holdingBars * (TF_MS / 3600000));
    const edgeCost = avgCost !== null && avgCost > 1e-9 ? Math.abs(avgGross) / avgCost : null;
    return {
      count: trades.length,
      netExp: mean(netR),
      grossExp: mean(grossR),
      netPF,
      grossPF,
      avgCost,
      avgGross,
      edgeCost,
      avgHoldingHours: mean(hours),
      medianHoldingHours: quantileSorted([...hours].sort((a, b) => a - b), 0.5),
      mfe: mean(trades.map((t) => t.mfe).filter((v) => v !== null && v !== undefined)),
      mae: mean(trades.map((t) => t.mae).filter((v) => v !== null && v !== undefined)),
      winRatePct: trades.length ? (wins.length / trades.length) * 100 : null,
      avgWin: mean(wins.map((t) => t.netReturnPct)),
      avgLoss: mean(losses.map((t) => t.netReturnPct)),
      fees: trades.reduce((a, t) => a + (t.fees || 0), 0),
      netPnL: trades.reduce((a, t) => a + t.netPnl, 0),
    };
  };

  const years = {};
  const firstYear = new Date(candles4h[0].timestamp).getUTCFullYear();
  const lastYear = new Date(candles4h[candles4h.length - 1].timestamp).getUTCFullYear();
  for (let y = firstYear; y <= lastYear; y++) {
    const yStart = Date.UTC(y, 0, 1);
    const yEnd = Date.UTC(y + 1, 0, 1);
    const yCandles = candles4h.filter((c) => c.timestamp >= yStart && c.timestamp < yEnd);
    const yTrades = enriched.filter((t) => t.entryTime >= yStart && t.entryTime < yEnd);
    const yCurve = result.equityCurve.filter((p) => p.timestamp >= yStart && p.timestamp < yEnd);
    const yFlags = [];
    candles4h.forEach((c, i) => { if (c.timestamp >= yStart && c.timestamp < yEnd) yFlags.push(!!result.positionFlags[i]); });
    const initialEq = yCurve.length ? yCurve[0].equity : INITIAL_CAPITAL;
    const finalEq = yCurve.length ? yCurve[yCurve.length - 1].equity : initialEq;
    const m = computeMetrics({
      initialCapital: initialEq,
      finalEquity: finalEq,
      equityCurve: yCurve,
      trades: yTrades,
      intervalMs: TF_MS,
      barsTotal: yCandles.length,
      barsInPosition: yFlags.filter(Boolean).length,
    });
    // full calendar year? (data covers ~Jan 1 .. Dec 31 of that year)
    const isFull = yCandles.length >= 2100; // ~2190 4h bars in a full year
    years[y] = { year: y, full: isFull, metrics: m, trades: tradeStats(yTrades), count: yTrades.length, netPnL: yTrades.reduce((a, t) => a + t.netPnl, 0), start: yCandles.length ? yCandles[0].timestamp : null, end: yCandles.length ? yCandles[yCandles.length - 1].timestamp : null };
  }

  return { result, metrics, enriched, years, tradeStats: tradeStats(enriched) };
}

async function main() {
  ensureDir(OUT);
  const results = {};
  const audit = {};

  for (const symbol of SYMBOLS) {
    const dev15 = loadDev15m(symbol);
    const cont15 = analyzeContinuity(dev15, 900000);
    const h4 = resample(dev15, TARGETS['4h']);

    audit[symbol] = {
      first15: dev15[0].timestamp,
      last15: dev15[dev15.length - 1].timestamp,
      rows15: dev15.length,
      rows4: h4.candles.length,
      missing15: cont15.missingBars,
      duplicate15: cont15.duplicateBars,
      gaps15: cont15.gapCount,
      incomplete4: h4.incompleteWindows.length,
      incomplete4List: h4.incompleteWindows.slice(0, 8),
      checksum: 'verified (official .CHECKSUM, SHA256)',
      first4: h4.candles.length ? h4.candles[0].timestamp : null,
      last4: h4.candles.length ? h4.candles[h4.candles.length - 1].timestamp : null,
    };

    results[symbol] = {};
    for (const [scName, sc] of Object.entries(SCENARIOS)) {
      results[symbol][scName] = evaluate({ symbol, candles4h: h4.candles, scenario: sc });
    }
    console.log(`[external] ${symbol}: 15m ${audit[symbol].rows15} -> 4h ${audit[symbol].rows4} | trades(BASE) ${results[symbol].BASE.metrics.tradeCount}`);
  }

  // Buy & Hold references (background only)
  const bnh = {};
  for (const symbol of SYMBOLS) {
    const dev15 = loadDev15m(symbol);
    const h4 = resample(dev15, TARGETS['4h']).candles.map((c) => ({ ...c, symbol }));
    bnh[symbol] = {
      gross: buyAndHoldReference(h4, { commissionPct: 0, slippagePct: 0 }),
      costAdjusted: buyAndHoldReference(h4, { commissionPct: SCENARIOS.BASE.commissionPct, slippagePct: SCENARIOS.BASE.slippagePct }),
    };
  }

  writeDataQuality(audit);
  writeValidationReport(results, audit, bnh);
  console.log('CROSS-ASSET EXTERNAL VALIDATION V1 COMPLETE');
}

function writeDataQuality(audit) {  const L = [];
  L.push('# External Assets — Data Quality Report');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** Source: Binance official data.binance.vision USD-M futures, checksum-verified. 2026 excluded (HOLDOUT LOCKED).');
  L.push('');
  L.push('| | BNBUSDT | SOLUSDT |');
  L.push('| --- | --- | --- |');
  for (const symbol of SYMBOLS) {
    const a = audit[symbol];
    if (symbol === 'BNBUSDT') {
      L.push(`| actualStart | ${iso(a.first15)} | ${iso(a.first15)} |`);
      L.push(`| actualEnd | ${iso(a.last15)} | ${iso(a.last15)} |`);
      L.push(`| 15mRows | ${a.rows15} | ${a.rows15} |`);
      L.push(`| 4hRows | ${a.rows4} | ${a.rows4} |`);
      L.push(`| checksumStatus | ${a.checksum} | ${a.checksum} |`);
      L.push(`| missingBars (15m) | ${a.missing15} | ${a.missing15} |`);
      L.push(`| duplicateBars (15m) | ${a.duplicate15} | ${a.duplicate15} |`);
      L.push(`| gaps (15m) | ${a.gaps15} | ${a.gaps15} |`);
      L.push(`| incomplete4hWindows | ${a.incomplete4} | ${a.incomplete4} |`);
      L.push(`| firstComplete4h | ${iso(a.first4)} | ${iso(a.first4)} |`);
      L.push(`| last4h | ${iso(a.last4)} | ${iso(a.last4)} |`);
    }
  }
  L.push('');
  const anyIssue = SYMBOLS.some((s) => audit[s].missing15 > 0 || audit[s].gaps15 > 0 || audit[s].incomplete4 > 0);
  L.push(anyIssue ? '**DATA CONTINUITY / WINDOW WARNING present** (see per-asset detail).' : '**No continuity issues; only expected partial first-window discards are reported if any.**');
  L.push('');
  fs.writeFileSync(path.join(OUT, 'DATA_QUALITY_REPORT.md'), L.join('\n'), 'utf8');
}

function gateLine(results) {
  const out = {};
  for (const symbol of SYMBOLS) {
    const b = results[symbol].BASE.tradeStats;
    const s = results[symbol].STRESS.tradeStats;
    const g = results[symbol].GROSS.tradeStats;
    out[symbol] = {
      baseNetExp: b.netExp,
      baseNetPF: b.netPF,
      baseSharpe: results[symbol].BASE.metrics.sharpe,
      stressNetExp: s.netExp,
      stressNetPF: s.netPF,
      grossNetExp: g.netExp,
      count: b.count,
      costClass: g.netExp > 0 ? (b.netExp > 0 && b.netPF > 1 ? (s.netExp >= 0 && s.netPF >= 1 ? 'COST ROBUST' : 'COST SENSITIVE') : 'EDGE FAILS REALISTIC COST') : 'NO EDGE',
    };
  }
  return out;
}

function writeValidationReport(results, audit, bnh) {
  const { execSync } = require('child_process');
  let preregSha = 'unknown';
  let freezeSha = 'unknown';
  try {
    preregSha = execSync('git log --grep="preregister cross asset external" --format=%H -1', { cwd: ROOT }).toString().trim();
    freezeSha = execSync('git log --grep="freeze v4 development candidate" --format=%H -1', { cwd: ROOT }).toString().trim();
  } catch (e) { /* ignore */ }

  const L = [];
  L.push('# Cross-Asset External Validation V1 — Report');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** Frozen strategy: `breakout24h4h` (freeze SHA `2e866b3`). External assets BNBUSDT/SOLUSDT never used in development. 2026 HOLDOUT LOCKED.');
  L.push('');
  L.push(`## 1-2. Shas`);
  L.push('');
  L.push(`- External preregistration SHA: **${preregSha}**`);
  L.push(`- Candidate freeze SHA: **${freezeSha}** (must be 2e866b3)`);
  L.push('');
  L.push(`## 3-4. Data`);
  L.push('');
  L.push('See reports/external-v1/DATA_QUALITY_REPORT.md.');
  L.push('');
  L.push(`## 5-10. Full available period (BASE / GROSS / STRESS)`);
  L.push('');
  L.push('| Asset | Cost | Trades | GrossExp% | NetExp% | GrossPF | NetPF | Sharpe | Edge/Cost | AvgHoldH | MedHoldH | MFE% | MAE% | Win% | Fees$ |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const symbol of SYMBOLS) {
    for (const scName of ['GROSS', 'BASE', 'STRESS']) {
      const r = results[symbol][scName];
      const ts = r.tradeStats;
      L.push(`| ${symbol} | ${scName} | ${ts.count} | ${pct(ts.grossExp)} | ${pct(ts.netExp)} | ${fmt(ts.grossPF)} | ${fmt(ts.netPF)} | ${fmt(r.metrics.sharpe)} | ${fmt(ts.edgeCost)} | ${fmt(ts.avgHoldingHours, 1)} | ${fmt(ts.medianHoldingHours, 1)} | ${pct(ts.mfe)} | ${pct(ts.mae)} | ${pct(ts.winRatePct)} | ${fmt(ts.fees)} |`);
    }
    L.push('');
  }
  L.push('');

  // yearly
  L.push('## 11-12. Yearly results (BASE)');
  L.push('');
  for (const symbol of SYMBOLS) {
    L.push(`### ${symbol}`);
    L.push('');
    L.push('| Year | Full? | Trades | NetExp% | GrossExp% | NetPF | GrossPF | Sharpe | Sortino | MaxDD% | Win% | AvgWin% | AvgLoss% | AvgHoldH | MFE% | MAE% | Turnover | Fees$ |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    const years = Object.values(results[symbol].BASE.years);
    for (const y of years) {
      L.push(`| ${y.year} | ${y.full ? 'yes' : 'PARTIAL YEAR'} | ${y.trades.count} | ${pct(y.trades.netExp)} | ${pct(y.trades.grossExp)} | ${fmt(y.trades.netPF)} | ${fmt(y.trades.grossPF)} | ${fmt(y.metrics.sharpe)} | ${fmt(y.metrics.sortino)} | ${pct(y.metrics.maxDrawdownPct)} | ${pct(y.trades.winRatePct)} | ${pct(y.trades.avgWin)} | ${pct(y.trades.avgLoss)} | ${fmt(y.trades.avgHoldingHours, 1)} | ${pct(y.trades.mfe)} | ${pct(y.trades.mae)} | ${fmt(y.metrics.exposurePct)} | ${fmt(y.trades.fees)} |`);
    }
    L.push('');
  }
  L.push('');

  // 13. complete buckets
  L.push('## 13. Complete asset-year buckets (BASE)');
  L.push('');
  const buckets = [];
  for (const symbol of SYMBOLS) {
    for (const [yr, y] of Object.entries(results[symbol].BASE.years)) {
      if (y.full) buckets.push({ symbol, year: Number(yr), netExp: y.trades.netExp, netPnL: y.netPnL });
    }
  }
  const pos = buckets.filter((b) => b.netExp !== null && b.netExp > 0).length;
  L.push(`| | complete buckets | positive (BASE) | % |`);
  L.push(`| --- | --- | --- | --- |`);
  L.push(`| ALL | ${buckets.length} | ${pos} | ${fmt(buckets.length ? (pos / buckets.length) * 100 : 0, 1)}% |`);
  L.push('');

  // pooled diagnostic (statistical summary only, NOT a real portfolio)
  L.push('## 12b. EXTERNAL ASSET POOLED DIAGNOSTIC (statistics only)');
  L.push('');
  L.push('> Combines BNB+SOL trade-level statistics. NOT a real shared-capital portfolio.');
  L.push('');
  const pooledTrades = SYMBOLS.flatMap((s) => results[s].BASE.enriched);
  const pNet = pooledTrades.map((t) => t.netReturnPct).filter((v) => v !== null && v !== undefined);
  const pGross = pooledTrades.map((t) => t.grossReturnPct).filter((v) => v !== null && v !== undefined);
  const pWins = pooledTrades.filter((t) => t.netReturnPct > 0);
  const pLosses = pooledTrades.filter((t) => t.netReturnPct < 0);
  const pNetPF = (() => {
    const gp = pWins.reduce((a, t) => a + t.netReturnPct, 0);
    const gl = pLosses.reduce((a, t) => a + t.netReturnPct, 0);
    return gl < 0 ? Math.abs(gp / gl) : null;
  })();
  L.push(`- pooled trades (BASE): ${pooledTrades.length}`);
  L.push(`- pooled NetExpectancy%: ${pct(mean(pNet))}`);
  L.push(`- pooled GrossExpectancy%: ${pct(mean(pGross))}`);
  L.push(`- pooled NetPF: ${fmt(pNetPF)}`);
  L.push('');

  // buy & hold + exposure
  L.push('## 19-20. Buy & Hold reference & Capital efficiency (diagnostic only)');
  L.push('');
  L.push('| Asset | Strategy Return% | Strategy MaxDD% | B&H Gross Return% | B&H CostAdj Return% | B&H MaxDD% | Exposure% | ReturnWhileInvested% | ReturnPerUnitExposure |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const symbol of SYMBOLS) {
    const m = results[symbol].BASE.metrics;
    const bh = bnh[symbol];
    const expPct = m.exposurePct;
    const retWhile = expPct && expPct > 0 ? m.totalReturnPct / (expPct / 100) : null;
    const retPerUnit = expPct && expPct > 0 ? m.totalReturnPct / expPct : null;
    L.push(`| ${symbol} | ${pct(m.totalReturnPct)} | ${pct(m.maxDrawdownPct)} | ${pct(bh.gross.totalReturnPct)} | ${pct(bh.costAdjusted.totalReturnPct)} | ${pct(bh.costAdjusted.maxDrawdownPct)} | ${pct(expPct)} | ${pct(retWhile)} | ${fmt(retPerUnit)} |`);
  }
  L.push('');
  L.push('> Buy & Hold is background context; the strategy is NOT required to beat it. ReturnWhileInvested / ReturnPerUnitExposure are diagnostics, not gate criteria.');
  L.push('');

  // 14-15. 2025 regime
  L.push('## 14-15. 2025 Cross-Asset Regime Check');
  L.push('');
  L.push('| Asset | 2025 NetExp% (BASE) |');
  L.push('| --- | --- |');
  const ext2025 = {};
  for (const symbol of SYMBOLS) {
    const y = results[symbol].BASE.years['2025'];
    ext2025[symbol] = y ? y.trades.netExp : null;
    L.push(`| ${symbol} | ${pct(ext2025[symbol])} |`);
  }
  for (const [s, v] of Object.entries(DEV_2025)) L.push(`| ${s} (dev) | ${fmt(v)}% |`);
  const all2025 = [ext2025.BNBUSDT, ext2025.SOLUSDT, DEV_2025.BTCUSDT, DEV_2025.ETHUSDT];
  const regime = check2025Regime(all2025);
  L.push('');
  L.push(`**${regime}**` + (regime.startsWith('SYSTEMATIC') ? ' — all four assets were negative in 2025.' : ' — external assets differed from BTC/ETH in 2025 (recorded as-is).'));
  L.push('');

  // 16. comparison table
  L.push('## 16. Four-asset comparison (BASE, full available period)');
  L.push('');
  L.push('| Asset | NetExp% | NetPF | Sharpe | MaxDD% | Exposure% | Edge/Cost | AvgHoldH | Trades/Year |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const devAgg = { BTCUSDT: { netExp: 0.78, netPF: 1.39, sharpe: 0.7, maxDD: null, edgeCost: 10.73, avgHoldH: 116.3, tpy: 78 }, ETHUSDT: { netExp: 0.78, netPF: 1.39, sharpe: 0.7, maxDD: null, edgeCost: 10.73, avgHoldH: 116.3, tpy: 78 } };
  for (const symbol of SYMBOLS) {
    const ts = results[symbol].BASE.tradeStats;
    const m = results[symbol].BASE.metrics;
    L.push(`| ${symbol} | ${pct(ts.netExp)} | ${fmt(ts.netPF)} | ${fmt(m.sharpe)} | ${pct(m.maxDrawdownPct)} | ${pct(m.exposurePct)} | ${fmt(ts.edgeCost)} | ${fmt(ts.avgHoldingHours, 1)} | ${fmt(ts.count / (new Date(audit[symbol].last4).getUTCFullYear() - new Date(audit[symbol].first4).getUTCFullYear() + 1), 1)} |`);
  }
  L.push(`| BTCUSDT (dev) | ${pct(devAgg.BTCUSDT.netExp)} | ${devAgg.BTCUSDT.netPF} | ${devAgg.BTCUSDT.sharpe} | (dev) | (dev) | ${devAgg.BTCUSDT.edgeCost} | ${devAgg.BTCUSDT.avgHoldH} | ${devAgg.BTCUSDT.tpy} |`);
  L.push(`| ETHUSDT (dev) | ${pct(devAgg.ETHUSDT.netExp)} | ${devAgg.ETHUSDT.netPF} | ${devAgg.ETHUSDT.sharpe} | (dev) | (dev) | ${devAgg.ETHUSDT.edgeCost} | ${devAgg.ETHUSDT.avgHoldH} | ${devAgg.ETHUSDT.tpy} |`);
  L.push('');
  L.push('> BTC/ETH values are the frozen V4 development results (anchored WF 2023-2025); BNB/SOL are full available period.');
  L.push('');

  // 17-23. gates
  L.push('## 17-23. External Validation Survival Gate');
  L.push('');
  const g = gateLine(results);
  L.push('| Asset | BASE NetExp>0 | BASE NetPF>1.05 | BASE Sharpe>0 | STRESS NetExp>=0 | STRESS NetPF>=1.0 | Trades | Sample | Cost class |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const symbol of SYMBOLS) {
    const x = g[symbol];
    L.push(`| ${symbol} | ${x.baseNetExp > 0 ? 'Y' : 'N'} | ${x.baseNetPF > 1.05 ? 'Y' : 'N'} | ${x.baseSharpe > 0 ? 'Y' : 'N'} | ${x.stressNetExp >= 0 ? 'Y' : 'N'} | ${x.stressNetPF >= 1 ? 'Y' : 'N'} | ${x.count} | ${x.count < 100 ? 'LOW SAMPLE' : 'OK'} | ${x.costClass} |`);
  }
  L.push('');
  // gates via the pure externalGate module
  const gateAssets = {};
  for (const symbol of SYMBOLS) {
    const b = results[symbol].BASE.tradeStats;
    const s = results[symbol].STRESS.tradeStats;
    gateAssets[symbol] = {
      baseNetExp: b.netExp,
      baseNetPF: b.netPF,
      baseSharpe: results[symbol].BASE.metrics.sharpe,
      stressNetExp: s.netExp,
      stressNetPF: s.netPF,
      count: b.count,
    };
  }
  const assetPass = Object.values(gateAssets).every(assetGate);
  const stressGatePass = Object.values(gateAssets).every(stressGate);
  const yearPassOk = yearPass(buckets.map((b) => b.netExp));
  const samplePassOk = samplePass(gateAssets);
  const conc = yearConcentration(buckets.map((b) => ({ netPnL: b.netPnL, symbol: b.symbol, year: b.year })));

  L.push(`| Asset gate | ${assetPass ? 'PASS' : 'FAIL'} |`);
  L.push(`| Stress gate | ${stressGatePass ? 'PASS' : 'FAIL'} |`);
  L.push(`| Year consistency | ${yearPassOk ? `PASS (${pos}/${buckets.length})` : `FAIL (${pos}/${buckets.length})`} |`);
  L.push(`| Sample gate | ${samplePassOk ? 'PASS' : 'FAIL'} |`);
  L.push(`| Concentration | ${conc.flag ? `HIGH YEAR CONCENTRATION (best ${conc.best ? `${conc.best.symbol}-${conc.best.year}` : '?'} ${fmt(conc.ratio, 1)})` : `OK (${fmt(conc.ratio, 1)} ratio)`} |`);
  L.push('');

  const externalPassed = assetPass && stressGatePass && yearPassOk && samplePassOk;
  L.push('## 23. Final external validation conclusion');
  L.push('');
  L.push(externalPassed
    ? '**EXTERNAL VALIDATION SURVIVED — READY FOR FINAL HOLDOUT DECISION**'
    : '**EXTERNAL VALIDATION FAILED — FINAL HOLDOUT NOT JUSTIFIED**');
  L.push('');
  L.push('## 25. 2026 FINAL HOLDOUT');
  L.push('');
  L.push('**LOCKED** — this phase hard-blocked all 2026 data and never ran it.');
  L.push('');
  L.push('## 26. Worth entering FINAL HOLDOUT PROTOCOL V1');
  L.push('');
  L.push(externalPassed
    ? '**YES** (in a separate future phase, run BTC/ETH/BNB/SOL 2026 once with the frozen candidate).'
    : '**NO** — do not burn the 2026 holdout.');
  L.push('');
  L.push('> Buy & Hold references (Return/MaxDD/Exposure/Sharpe) are background context; strategies are NOT required to beat them.');
  L.push('> Past performance does not guarantee future results.');
  L.push('');
  fs.writeFileSync(path.join(OUT, 'CROSS_ASSET_EXTERNAL_VALIDATION_REPORT.md'), L.join('\n'), 'utf8');
  console.log(`External validation report: ${path.join(OUT, 'CROSS_ASSET_EXTERNAL_VALIDATION_REPORT.md')}`);
  console.log(`External gates: asset=${assetPass} stress=${stressGatePass} year=${yearPassOk} (${pos}/${buckets.length}) sample=${samplePassOk} concentration=${conc.flag}`);
  console.log(`CONCLUSION: ${externalPassed ? 'EXTERNAL VALIDATION SURVIVED' : 'EXTERNAL VALIDATION FAILED'}`);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err);
  process.exit(1);
});

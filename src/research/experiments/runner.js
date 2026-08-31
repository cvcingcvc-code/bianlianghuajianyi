// Experiment runner: orchestrates single backtests, walk-forward splits and
// strategy comparisons, and writes reports to disk.
//
// Report layout (single / segment):
//   reports/<timestamp>-<symbol>-<strategy>/
//     summary.json
//     trades.csv
//     equity.csv
//     report.md
//
// Walk-forward:
//   reports/<timestamp>-<symbol>-<strategy>/train|test/... + walkforward.md
//
// Compare:
//   reports/comparison-<timestamp>.md

const fs = require('fs');
const path = require('path');
const { loadCandles } = require('../data/candleRepository');
const { analyzeContinuity, buildDataQualityMd } = require('../data/continuity');
const { loadStrategy, listStrategies } = require('../strategyAdapter');
const { createBroker, createFundingProvider } = require('../backtest/brokerSimulator');
const { runBacktest } = require('../backtest/backtester');
const { computeMetrics, intervalToMs } = require('../metrics/performance');
const { maxDrawdown } = require('../metrics/drawdown');
const { tradesToCsv } = require('../backtest/tradeLedger');

const DEFAULT_INITIAL_CAPITAL = 10000;
const DEFAULT_COMMISSION = 0.0004;
const DEFAULT_SLIPPAGE = 0.0002;
const DEFAULT_POSITION_SIZE_PCT = 100;
const DEFAULT_OUT_DIR = 'reports';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function fmt(v, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'N/A';
  return Number(v.toFixed(digits));
}

function fmtPct(v, digits = 2) {
  return fmt(v, digits) === 'N/A' ? 'N/A' : `${fmt(v, digits)}%`;
}

function fmtMoney(v) {
  return fmt(v, 2) === 'N/A' ? 'N/A' : fmt(v, 2);
}

function iso(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return 'N/A';
  return new Date(ms).toISOString();
}

function estimateIntervalMs(candles) {
  if (candles.length < 2) return null;
  const deltas = [];
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].timestamp - candles[i - 1].timestamp;
    if (Number.isFinite(d) && d > 0) deltas.push(d);
  }
  if (deltas.length === 0) return null;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)];
}

function intervalLabel(intervalMs) {
  if (!intervalMs) return 'N/A';
  const minutes = intervalMs / 60000;
  if (Number.isInteger(minutes)) return `${minutes}m`;
  const hours = intervalMs / 3600000;
  if (Number.isInteger(hours)) return `${hours}h`;
  return `${Math.round(intervalMs / 1000)}s`;
}

// Strict train/test split (no overlap). Ranges are half-open [start, end).
function splitCandles(candles, { trainStartMs, trainEndMs, testStartMs, testEndMs }) {
  const train = candles.filter((c) => c.timestamp >= trainStartMs && c.timestamp < trainEndMs);
  const test = candles.filter((c) => c.timestamp >= testStartMs && c.timestamp < testEndMs);
  return { train, test };
}

function buildWarnings({ result, metrics, broker, candles, qualityReport, segment, continuity }) {
  const warnings = [];
  const trades = result.trades.length;
  if (trades < 30) {
    warnings.push(`sample size too small (${trades} trades)`);
  }
  if (!broker.fundingIncluded()) {
    warnings.push('funding rate not included');
  }
  if (candles.length < 200) {
    warnings.push('insufficient trading history (bars < 200)');
  }
  if (continuity && continuity.gapCount > 0) {
    warnings.push(`DATA CONTINUITY WARNING: ${continuity.missingBars} missing bar(s) in ${continuity.gapCount} gap(s); results NOT marked VALIDATED`);
  }
  if (result.openPositionAtEnd) {
    warnings.push('position still open at end of backtest (final equity includes unrealized PnL)');
  }
  if (metrics.sharpe === null && trades >= 2) {
    warnings.push('sharpe not computable (insufficient or degenerate equity returns)');
  }
  if (qualityReport) {
    if (qualityReport.duplicateCount > 0) {
      warnings.push(`data quality: ${qualityReport.duplicateCount} duplicate timestamp(s) dropped`);
    }
    if (qualityReport.warnings.filter((w) => w.type === 'gap').length > 0) {
      warnings.push(`data quality: ${qualityReport.warnings.filter((w) => w.type === 'gap').length} large gap(s) in candles`);
    }
  }
  if (segment) {
    warnings.unshift(`segment: ${segment}`);
  }
  return warnings;
}

function equityToCsv(equityCurve) {
  const lines = ['timestamp,equity'];
  for (const p of equityCurve) {
    lines.push(`${iso(p.timestamp)},${fmt(p.equity, 4)}`);
  }
  return lines.join('\n');
}

function buildSummaryJson({ symbol, candles, result, metrics, broker, intervalMs, positionSizePct, fundingRate, segment, warnings }) {
  return {
    meta: {
      symbol,
      strategy: result.strategy,
      intervalMs,
      interval: intervalLabel(intervalMs),
      start: candles.length ? iso(candles[0].timestamp) : null,
      end: candles.length ? iso(candles[candles.length - 1].timestamp) : null,
      generatedAt: new Date().toISOString(),
      segment: segment || null,
    },
    params: {
      initialCapital: result.initialCapital,
      positionSizePct,
      commissionPct: broker.commissionPct,
      slippagePct: broker.slippagePct,
      fundingIncluded: broker.fundingIncluded(),
      fundingRate: fundingRate || 0,
      executionModel: 'next-bar-open (signal at close N -> fill at open N+1)',
    },
    results: metrics,
    tradeCount: result.trades.length,
    barsTotal: result.barsTotal,
    barsInPosition: result.barsInPosition,
    totalFunding: result.totalFunding,
    openPositionAtEnd: result.openPositionAtEnd,
    warnings,
  };
}

function buildReportMd({ symbol, candles, result, metrics, broker, intervalMs, positionSizePct, fundingRate, warnings, segment }) {
  const L = [];
  L.push('# Backtest Report');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED** — results are gross of funding costs (unless a funding provider is configured).');
  L.push('');
  if (segment) L.push(`**Segment:** ${segment}`);
  L.push(`- Symbol: ${symbol}`);
  L.push(`- Strategy: ${result.strategy}`);
  L.push(`- Interval: ${intervalLabel(intervalMs)}`);
  L.push(`- Start: ${candles.length ? iso(candles[0].timestamp) : 'N/A'}`);
  L.push(`- End: ${candles.length ? iso(candles[candles.length - 1].timestamp) : 'N/A'}`);
  L.push(`- Initial Capital: ${fmtMoney(result.initialCapital)} USDT`);
  L.push(`- Final Equity: ${fmtMoney(result.finalEquity)} USDT`);
  L.push('');
  L.push('## Performance');
  L.push('');
  L.push('| Metric | Value |');
  L.push('| --- | --- |');
  L.push(`| Total Return | ${fmtPct(metrics.totalReturnPct)} |`);
  L.push(`| Annualized Return | ${fmtPct(metrics.annualizedReturnPct)} |`);
  L.push(`| Maximum Drawdown | ${fmtPct(metrics.maxDrawdownPct)} |`);
  L.push(`| Sharpe Ratio | ${fmt(metrics.sharpe)} |`);
  L.push(`| Sortino Ratio | ${fmt(metrics.sortino)} |`);
  L.push(`| Win Rate | ${fmtPct(metrics.winRatePct)} |`);
  L.push(`| Average Win | ${fmtMoney(metrics.avgWin)} USDT |`);
  L.push(`| Average Loss | ${fmtMoney(metrics.avgLoss)} USDT |`);
  L.push(`| Profit Factor | ${fmt(metrics.profitFactor)} |`);
  L.push(`| Expectancy | ${fmtMoney(metrics.expectancy)} USDT |`);
  L.push(`| Trade Count | ${metrics.tradeCount} |`);
  L.push(`| Exposure | ${fmtPct(metrics.exposurePct)} |`);
  L.push(`| Max Consecutive Loss | ${metrics.maxConsecutiveLoss} |`);
  L.push(`| Total Fees | ${fmtMoney(metrics.totalFees)} USDT |`);
  L.push(`| Gross Profit | ${fmtMoney(metrics.grossProfit)} USDT |`);
  L.push(`| Gross Loss | ${fmtMoney(metrics.grossLoss)} USDT |`);
  L.push('');
  L.push('## Assumptions');
  L.push('');
  L.push(`- Commission: ${fmt(metrics ? (broker.commissionPct * 100) : 0)}% per fill (both entry and exit)`);
  L.push(`- Slippage: ${fmt(broker.slippagePct * 100)}% (long entry: open x (1+slip), exit: open x (1-slip))`);
  L.push(`- Funding: ${broker.fundingIncluded() ? `included (rate ${fundingRate})` : 'funding rate not included'}`);
  L.push(`- Position Size: ${positionSizePct}% of available equity per position (no leverage)`);
  L.push(`- Execution Model: signal at close of bar N -> fill at open of bar N+1 (no look-ahead)`);
  L.push('');
  L.push('## Warnings');
  L.push('');
  if (warnings.length === 0) {
    L.push('* none');
  } else {
    for (const w of warnings) L.push(`* ${w}`);
  }
  L.push('');
  return L.join('\n');
}

function writeSegment({ dir, segment, symbol, candles, adapter, broker, initialCapital, positionSizePct, intervalMs, fundingRate, qualityReport }) {
  ensureDir(dir);
  const result = runBacktest({ symbol, candles, adapter, broker, initialCapital, positionSizePct });
  const continuity = intervalMs ? analyzeContinuity(candles, intervalMs) : null;
  const metrics = computeMetrics({
    initialCapital,
    finalEquity: result.finalEquity,
    equityCurve: result.equityCurve,
    trades: result.trades,
    intervalMs,
    barsTotal: result.barsTotal,
    barsInPosition: result.barsInPosition,
  });
  const warnings = buildWarnings({ result, metrics, broker, candles, qualityReport, segment, continuity });
  const summary = buildSummaryJson({ symbol, candles, result, metrics, broker, intervalMs, positionSizePct, fundingRate, segment, warnings });

  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'trades.csv'), tradesToCsv(result.trades), 'utf8');
  fs.writeFileSync(path.join(dir, 'equity.csv'), equityToCsv(result.equityCurve), 'utf8');
  fs.writeFileSync(path.join(dir, 'report.md'), buildReportMd({ symbol, candles, result, metrics, broker, intervalMs, positionSizePct, fundingRate, warnings, segment }), 'utf8');

  return { dir, result, metrics, summary };
}

function printSegmentSummary(label, segment, initialCapital) {
  const m = segment.metrics;
  console.log(`  [${label}] equity: ${fmtMoney(segment.result.finalEquity)} | ` +
    `return: ${fmtPct(m.totalReturnPct)} | annualized: ${fmtPct(m.annualizedReturnPct)} | ` +
    `maxDD: ${fmtPct(m.maxDrawdownPct)} | sharpe: ${fmt(m.sharpe)} | ` +
    `winRate: ${fmtPct(m.winRatePct)} | PF: ${fmt(m.profitFactor)} | trades: ${m.tradeCount}`);
}

async function runSingle(opts) {
  const {
    symbol, strategy, file,
    initialCapital = DEFAULT_INITIAL_CAPITAL,
    commissionPct = DEFAULT_COMMISSION,
    slippagePct = DEFAULT_SLIPPAGE,
    positionSizePct = DEFAULT_POSITION_SIZE_PCT,
    fundingRate = 0,
    outDir = DEFAULT_OUT_DIR,
    trainStartMs, trainEndMs, testStartMs, testEndMs,
  } = opts;

  const { candles, qualityReport } = loadCandles({ file, symbol });
  const adapter = loadStrategy(strategy);
  const fundingProvider = createFundingProvider({ type: 'none', rate: fundingRate });
  const broker = createBroker({ commissionPct, slippagePct, fundingProvider });
  const intervalMs = estimateIntervalMs(candles);
  const baseDir = path.join(outDir, `${nowStamp()}-${symbol}-${adapter.name}`);
  ensureDir(baseDir);

  console.log(`=== Backtest: ${symbol} / ${adapter.name} / ${candles.length} bars ===`);

  const isWalkForward = [trainStartMs, trainEndMs, testStartMs, testEndMs].some((v) => v !== null && v !== undefined);

  if (isWalkForward) {
    const { train, test } = splitCandles(candles, { trainStartMs, trainEndMs, testStartMs, testEndMs });
    if (train.length === 0 || test.length === 0) {
      throw new Error('Walk-forward split produced an empty train or test segment. Check train/test date ranges vs data range.');
    }
    const trainSeg = writeSegment({ dir: path.join(baseDir, 'train'), segment: 'TRAIN', symbol, candles: train, adapter, broker, initialCapital, positionSizePct, intervalMs, fundingRate, qualityReport });
    const testSeg = writeSegment({ dir: path.join(baseDir, 'test'), segment: 'TEST', symbol, candles: test, adapter, broker, initialCapital, positionSizePct, intervalMs, fundingRate, qualityReport });
    writeWalkForwardMd(baseDir, symbol, adapter.name, trainSeg, testSeg);
    printSegmentSummary('TRAIN', trainSeg, initialCapital);
    printSegmentSummary('TEST', testSeg, initialCapital);
    console.log(`  Reports: ${baseDir}`);
    return { type: 'walkforward', symbol, strategy: adapter.name, baseDir, train: trainSeg, test: testSeg, qualityReport };
  }

  const seg = writeSegment({ dir: baseDir, segment: null, symbol, candles, adapter, broker, initialCapital, positionSizePct, intervalMs, fundingRate, qualityReport });
  printSegmentSummary(adapter.name, seg, initialCapital);
  console.log(`  Reports: ${baseDir}`);
  return { type: 'single', symbol, strategy: adapter.name, baseDir, ...seg, qualityReport };
}

function writeWalkForwardMd(baseDir, symbol, strategy, trainSeg, testSeg) {
  const L = [];
  L.push(`# Walk Forward Results — ${symbol} / ${strategy}`);
  L.push('');
  L.push(`> Train and test segments are strictly separated. Results are NOT blended into a single return.`);
  L.push('');
  L.push(`## TRAIN RESULTS`);
  L.push('');
  L.push(`- Range: ${iso(trainSeg.summary.meta.start)} -> ${iso(trainSeg.summary.meta.end)}`);
  L.push(`- Total Return: ${fmtPct(trainSeg.metrics.totalReturnPct)}`);
  L.push(`- Annualized Return: ${fmtPct(trainSeg.metrics.annualizedReturnPct)}`);
  L.push(`- Max Drawdown: ${fmtPct(trainSeg.metrics.maxDrawdownPct)}`);
  L.push(`- Sharpe: ${fmt(trainSeg.metrics.sharpe)}`);
  L.push(`- Win Rate: ${fmtPct(trainSeg.metrics.winRatePct)}`);
  L.push(`- Trades: ${trainSeg.metrics.tradeCount}`);
  L.push('');
  L.push(`## TEST RESULTS`);
  L.push('');
  L.push(`- Range: ${iso(testSeg.summary.meta.start)} -> ${iso(testSeg.summary.meta.end)}`);
  L.push(`- Total Return: ${fmtPct(testSeg.metrics.totalReturnPct)}`);
  L.push(`- Annualized Return: ${fmtPct(testSeg.metrics.annualizedReturnPct)}`);
  L.push(`- Max Drawdown: ${fmtPct(testSeg.metrics.maxDrawdownPct)}`);
  L.push(`- Sharpe: ${fmt(testSeg.metrics.sharpe)}`);
  L.push(`- Win Rate: ${fmtPct(testSeg.metrics.winRatePct)}`);
  L.push(`- Trades: ${testSeg.metrics.tradeCount}`);
  L.push('');
  L.push(`> Past performance does not guarantee future results.`);
  L.push('');
  fs.writeFileSync(path.join(baseDir, 'walkforward.md'), L.join('\n'), 'utf8');
}

async function runCompare(opts) {
  const {
    symbol, file,
    initialCapital = DEFAULT_INITIAL_CAPITAL,
    commissionPct = DEFAULT_COMMISSION,
    slippagePct = DEFAULT_SLIPPAGE,
    positionSizePct = DEFAULT_POSITION_SIZE_PCT,
    outDir = DEFAULT_OUT_DIR,
  } = opts;

  const { candles, qualityReport } = loadCandles({ file, symbol });
  const fundingProvider = createFundingProvider({ type: 'none', rate: 0 });
  const broker = createBroker({ commissionPct, slippagePct, fundingProvider });
  const intervalMs = estimateIntervalMs(candles);
  const ts = nowStamp();

  console.log(`=== Compare: ${symbol} / ${candles.length} bars ===`);
  const rows = [];
  for (const name of listStrategies()) {
    const adapter = loadStrategy(name);
    const result = runBacktest({ symbol, candles, adapter, broker, initialCapital, positionSizePct });
    const metrics = computeMetrics({
      initialCapital,
      finalEquity: result.finalEquity,
      equityCurve: result.equityCurve,
      trades: result.trades,
      intervalMs,
      barsTotal: result.barsTotal,
      barsInPosition: result.barsInPosition,
    });
    rows.push({ strategy: name, result, metrics });
    console.log(`  ${name}: return ${fmtPct(metrics.totalReturnPct)} | sharpe ${fmt(metrics.sharpe)} | maxDD ${fmtPct(metrics.maxDrawdownPct)} | trades ${metrics.tradeCount}`);
  }

  const reportPath = path.join(outDir, `comparison-${ts}.md`);
  writeCompareMd(reportPath, symbol, rows);
  console.log(`  Comparison report: ${reportPath}`);
  return { rows, reportPath, qualityReport };
}

function writeCompareMd(reportPath, symbol, rows) {
  const L = [];
  L.push(`# Strategy Comparison — ${symbol}`);
  L.push('');
  L.push('| Strategy | Return | Annualized Return | Max Drawdown | Sharpe | Sortino | Win Rate | Profit Factor | Trade Count | Fees |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const m = r.metrics;
    L.push(`| ${r.strategy} | ${fmtPct(m.totalReturnPct)} | ${fmtPct(m.annualizedReturnPct)} | ${fmtPct(m.maxDrawdownPct)} | ${fmt(m.sharpe)} | ${fmt(m.sortino)} | ${fmtPct(m.winRatePct)} | ${fmt(m.profitFactor)} | ${m.tradeCount} | ${fmtMoney(m.totalFees)} |`);
  }
  L.push('');

  const byReturn = [...rows].sort((a, b) => (b.metrics.totalReturnPct ?? -Infinity) - (a.metrics.totalReturnPct ?? -Infinity));
  const bySharpe = [...rows].sort((a, b) => (b.metrics.sharpe ?? -Infinity) - (a.metrics.sharpe ?? -Infinity));
  const byDD = [...rows].sort((a, b) => (a.metrics.maxDrawdownPct ?? Infinity) - (b.metrics.maxDrawdownPct ?? Infinity));

  if (byReturn.length > 0 && byReturn[0].metrics.totalReturnPct !== null) {
    L.push(`**Highest Return:** ${byReturn[0].strategy} (${fmtPct(byReturn[0].metrics.totalReturnPct)})`);
  }
  if (bySharpe.length > 0 && bySharpe[0].metrics.sharpe !== null) {
    L.push(`**Best Sharpe:** ${bySharpe[0].strategy} (${fmt(bySharpe[0].metrics.sharpe)})`);
  }
  if (byDD.length > 0 && byDD[0].metrics.maxDrawdownPct !== null) {
    L.push(`**Lowest Drawdown:** ${byDD[0].strategy} (${fmtPct(byDD[0].metrics.maxDrawdownPct)})`);
  }
  L.push('');
  L.push('> Past performance does not guarantee future results.');
  L.push('');
  fs.writeFileSync(reportPath, L.join('\n'), 'utf8');
}

module.exports = { runSingle, runCompare, splitCandles, estimateIntervalMs, runDataQuality, runOnce, buyAndHoldReference };

// Run one backtest over a given candle set with a broker and return { result, metrics, continuity }.
function runOnce({ symbol, candles, adapter, broker, initialCapital = DEFAULT_INITIAL_CAPITAL, positionSizePct = DEFAULT_POSITION_SIZE_PCT, intervalMs }) {
  const result = runBacktest({ symbol, candles, adapter, broker, initialCapital, positionSizePct });
  const metrics = computeMetrics({
    initialCapital,
    finalEquity: result.finalEquity,
    equityCurve: result.equityCurve,
    trades: result.trades,
    intervalMs,
    barsTotal: result.barsTotal,
    barsInPosition: result.barsInPosition,
  });
  const continuity = intervalMs ? analyzeContinuity(candles, intervalMs) : null;
  return { result, metrics, continuity };
}

// Research reference benchmark: buy at the first candle's open, hold, sell at the last candle's close.
// Mark-to-market with closes for drawdown. Not a trading recommendation.
function buyAndHoldReference(candles) {
  if (!candles || candles.length === 0) {
    return { totalReturnPct: null, maxDrawdownPct: null, finalEquity: null, initialCapital: null };
  }
  const initialCapital = 10000;
  const entry = candles[0].open;
  const exit = candles[candles.length - 1].close;
  const qty = initialCapital / entry;
  const equityCurve = candles.map((c) => ({ timestamp: c.timestamp, equity: c.close * qty }));
  const finalEquity = equityCurve[equityCurve.length - 1].equity;
  const dd = maxDrawdown(equityCurve);
  return {
    symbol: candles[0].symbol,
    initialCapital,
    finalEquity,
    totalReturnPct: ((finalEquity / initialCapital) - 1) * 100,
    maxDrawdownPct: dd.maxDrawdownPct,
    maxDrawdownAbs: dd.maxDrawdownAbs,
    equityCurve,
  };
}

// Data quality report for a symbol's CSV (used by `--data-quality`).
async function runDataQuality({ file, symbol, interval = '15m', outDir = DEFAULT_OUT_DIR }) {
  const { candles, qualityReport } = loadCandles({ file, symbol });
  const intervalMs = intervalToMs(interval);
  const continuity = analyzeContinuity(candles, intervalMs);
  ensureDir(outDir);
  const md = buildDataQualityMd({ symbol, interval, candles, qualityReport, continuity });
  const outFile = path.join(outDir, `data-quality-${symbol}.md`);
  fs.writeFileSync(outFile, md, 'utf8');

  console.log(`=== Data Quality: ${symbol} ===`);
  console.log(`  rows: ${candles.length} | expected: ${continuity.expectedBars} | missing: ${continuity.missingBars} | gaps: ${continuity.gapCount} | duplicates: ${continuity.duplicateBars}`);
  console.log(`  range: ${iso(continuity.firstTimestamp)} -> ${iso(continuity.lastTimestamp)}`);
  if (continuity.gapCount > 0) {
    console.log('  DATA CONTINUITY WARNING: missing bars present');
  }
  console.log(`  Report: ${outFile}`);
  return { candles, qualityReport, continuity, outFile };
}

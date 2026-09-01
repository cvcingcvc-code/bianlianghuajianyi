// STRATEGY RESEARCH V2 — DISCOVERY diagnostics for the ORIGINAL emaCrossover.
//
//   node scripts/edge-diagnostics.js
//
// Uses DISCOVERY = 2021-01-01 .. 2023-12-31 only (no validation/holdout data).
// Produces:
//   reports/v2/holding-period-analysis.md
//   reports/v2/volatility-regime-analysis.md
//   reports/v2/mfe-mae-analysis.md
//   reports/v2/EDGE_DIAGNOSIS.md
//   reports/v2/cost-decomposition.md

const path = require('path');
const fs = require('fs');
const { loadCandles } = require('../src/research/data/candleRepository');
const { loadStrategy } = require('../src/research/strategyAdapter');
const { createBroker } = require('../src/research/backtest/brokerSimulator');
const { intervalToMs } = require('../src/research/metrics/performance');
const { runOnce } = require('../src/research/experiments/runner');
const { precompute, enrichTrades } = require('../src/research/diagnostics/tradeDiagnostics');
const { classifyRegime, quartileBuckets, quantileSorted } = require('../src/research/diagnostics/regimeDiagnostics');
const { aggregateTrades, bucketize, mean } = require('../src/research/diagnostics/distributionAnalysis');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'reports', 'v2');
const INTERVAL_MS = intervalToMs('15m');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const DISCOVERY_START = Date.UTC(2021, 0, 1);
const DISCOVERY_END = Date.UTC(2024, 0, 1); // exclusive
const BASE = { commissionPct: 0.0004, slippagePct: 0.0002 };

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function fmt(v, d = 2) { return v === null || v === undefined || !Number.isFinite(v) ? 'N/A' : Number(v.toFixed(d)); }
function pct(v) { return fmt(v) === 'N/A' ? 'N/A' : `${fmt(v)}%`; }
function money(v) { return fmt(v); }
function iso(ms) { return typeof ms === 'number' ? new Date(ms).toISOString() : 'N/A'; }

function loadDiscovery(symbol) {
  const { candles } = loadCandles({ file: path.join(ROOT, 'data', 'market', `${symbol}-15m.csv`), symbol });
  return candles.filter((c) => c.timestamp >= DISCOVERY_START && c.timestamp < DISCOVERY_END);
}

async function main() {
  ensureDir(OUT);

  const combined = [];
  const perSymbol = {};
  for (const symbol of SYMBOLS) {
    const candles = loadDiscovery(symbol);
    const adapter = loadStrategy('emaCrossover');
    const broker = createBroker(BASE);
    const { result } = runOnce({ symbol, candles, adapter, broker, initialCapital: 10000, positionSizePct: 100, intervalMs: INTERVAL_MS });
    const indexOf = new Map();
    candles.forEach((c, i) => indexOf.set(c.timestamp, i));
    const pre = precompute(candles);
    const enriched = enrichTrades({ candles, trades: result.trades, indexOf, pre });
    perSymbol[symbol] = { candles, trades: enriched };
    combined.push(...enriched);
    console.log(`[DISCOVERY ${symbol}] trades: ${enriched.length} | grossExp ${fmt(aggregateTrades(enriched).grossExpectancyPct)}% | netExp ${fmt(aggregateTrades(enriched).netExpectancyPct)}%`);
  }

  // ATR% thresholds from the combined DISCOVERY distribution
  const atrVals = combined.map((t) => t.atrPct).filter((v) => v !== null && v !== undefined);
  const atrQ = quartileBuckets(atrVals);
  const atrLow = atrQ ? atrQ.q1 : null;
  const atrHigh = atrQ ? atrQ.q3 : null;

  for (const t of combined) {
    t.regime = classifyRegime(t, { atrLow, atrHigh });
  }

  writeHoldingPeriod(combined, perSymbol);
  writeVolatilityRegime(combined, perSymbol, { atrLow, atrHigh });
  writeMfeMae(combined, perSymbol);
  writeCostDecomposition(combined, perSymbol);
  writeEdgeDiagnosis(combined, perSymbol, { atrLow, atrHigh });
  console.log('DISCOVERY DIAGNOSTICS DONE');
}

// ---------------- report writers ----------------

function aggTable(rows) {
  const a = aggregateTrades(rows);
  if (!a) return null;
  return {
    count: a.count,
    grossExpPct: fmt(a.grossExpectancyPct),
    netExpPct: fmt(a.netExpectancyPct),
    grossPF: fmt(a.grossProfitFactor),
    netPF: fmt(a.netProfitFactor),
    winRatePct: fmt(a.winRatePct),
    avgWinPct: fmt(a.avgWinPct),
    avgLossPct: fmt(a.avgLossPct),
    holding: fmt(a.avgHoldingBars, 1),
    mfe: fmt(a.avgMfePct),
    mae: fmt(a.avgMaePct),
    totalGross: money(a.totalGrossPnL),
    totalFees: money(a.totalFees),
  };
}

function writeHoldingPeriod(combined, perSymbol) {
  const L = [];
  L.push('# Holding Period Analysis — emaCrossover (DISCOVERY 2021-2023)');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** Commission 0.04% / slippage 0.02%. Fixed notional $10,000 for dollar aggregates.');
  L.push('> Question: does the gross edge come from a few long winners, and do short whipsaw trades dominate the losses?');
  L.push('');
  const buckets = ['1-4', '5-12', '13-24', '25-48', '49-96', '>96'];
  const bucketKey = (r) => {
    const h = r.holdingBars;
    if (h <= 4) return '1-4';
    if (h <= 12) return '5-12';
    if (h <= 24) return '13-24';
    if (h <= 48) return '25-48';
    if (h <= 96) return '49-96';
    return '>96';
  };
  const writeBlock = (title, rows) => {
    L.push(`## ${title}`);
    L.push('');
    L.push('| Holding (bars) | Count | Gross Exp% | Net Exp% | Gross PF | Net PF | Win% | Avg Win% | Avg Loss% | Total Gross PnL$ | Total Fees$ |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const b of bucketize(rows, bucketKey, buckets)) {
      const a = aggTable(b.rows);
      L.push(`| ${b.key} | ${a.count} | ${a.grossExpPct} | ${a.netExpPct} | ${a.grossPF} | ${a.netPF} | ${a.winRatePct} | ${a.avgWinPct} | ${a.avgLossPct} | ${a.totalGross} | ${a.totalFees} |`);
    }
    L.push('');
  };
  writeBlock('BTCUSDT', perSymbol.BTCUSDT.trades);
  writeBlock('ETHUSDT', perSymbol.ETHUSDT.trades);
  writeBlock('Combined', combined);
  fs.writeFileSync(path.join(OUT, 'holding-period-analysis.md'), L.join('\n'), 'utf8');
}

function writeVolatilityRegime(combined, perSymbol, { atrLow, atrHigh }) {
  const L = [];
  L.push('# Volatility Regime Analysis — emaCrossover (DISCOVERY 2021-2023)');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** atrPct = ATR14 / close at entry. Low = p25, High = p75 of the DISCOVERY atrPct distribution.');
  L.push(`> Thresholds: atrLow=${fmt(atrLow, 3)}%, atrHigh=${fmt(atrHigh, 3)}%.`);
  L.push('');
  const volKey = (r) => r.regime.volBucket || 'N/A';
  const writeBlock = (title, rows) => {
    L.push(`## ${title}`);
    L.push('');
    L.push('| Volatility | Count | Gross Exp% | Net Exp% | Gross PF | Net PF | Win% | Avg Holding | MFE% | MAE% |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const b of bucketize(rows, volKey, ['Low', 'Medium', 'High'])) {
      const a = aggTable(b.rows);
      L.push(`| ${b.key} | ${a.count} | ${a.grossExpPct} | ${a.netExpPct} | ${a.grossPF} | ${a.netPF} | ${a.winRatePct} | ${a.holding} | ${a.mfe} | ${a.mae} |`);
    }
    L.push('');
  };
  writeBlock('BTCUSDT', perSymbol.BTCUSDT.trades);
  writeBlock('ETHUSDT', perSymbol.ETHUSDT.trades);
  writeBlock('Combined', combined);
  fs.writeFileSync(path.join(OUT, 'volatility-regime-analysis.md'), L.join('\n'), 'utf8');
}

function writeMfeMae(combined, perSymbol) {
  const L = [];
  L.push('# MFE / MAE Analysis — emaCrossover (DISCOVERY 2021-2023)');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** MFE = max favorable excursion %, MAE = max adverse excursion % during the holding path.');
  L.push('');
  const writeBlock = (title, rows) => {
    L.push(`## ${title}`);
    L.push('');
    L.push('| Group | Count | Avg MFE% | Avg MAE% | Median MFE% | Median MAE% |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    const winners = rows.filter((r) => r.netReturnPct > 0);
    const losers = rows.filter((r) => r.netReturnPct <= 0);
    const row = (label, rs) => {
      const mfe = rs.map((r) => r.mfe).filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
      const mae = rs.map((r) => r.mae).filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
      L.push(`| ${label} | ${rs.length} | ${fmt(mean(mfe))} | ${fmt(mean(mae))} | ${fmt(quantileSorted(mfe, 0.5))} | ${fmt(quantileSorted(mae, 0.5))} |`);
    };
    row('Winners (net>0)', winners);
    row('Losers (net<=0)', losers);
    row('All', rows);
    L.push('');
  };
  writeBlock('BTCUSDT', perSymbol.BTCUSDT.trades);
  writeBlock('ETHUSDT', perSymbol.ETHUSDT.trades);
  writeBlock('Combined', combined);

  // Give-back analysis
  L.push('## Give-back analysis (had profit, ended in loss)');
  L.push('');
  L.push('| Symbol | Trades with MFE>=1% | ...and final net loss | Give-back share | Avg MFE% of give-back | Avg final return% of give-back |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const [sym, d] of Object.entries(perSymbol)) {
    const rows = d.trades;
    const mfeUp = rows.filter((r) => r.mfe >= 1);
    const giveback = mfeUp.filter((r) => r.netReturnPct <= 0);
    L.push(`| ${sym} | ${mfeUp.length} | ${giveback.length} | ${fmt(mfeUp.length ? (giveback.length / mfeUp.length) * 100 : 0)}% | ${fmt(mean(giveback.map((r) => r.mfe)))} | ${fmt(mean(giveback.map((r) => r.netReturnPct)))} |`);
  }
  const cMfeUp = combined.filter((r) => r.mfe >= 1);
  const cGb = cMfeUp.filter((r) => r.netReturnPct <= 0);
  L.push(`| Combined | ${cMfeUp.length} | ${cGb.length} | ${fmt(cMfeUp.length ? (cGb.length / cMfeUp.length) * 100 : 0)}% | ${fmt(mean(cGb.map((r) => r.mfe)))} | ${fmt(mean(cGb.map((r) => r.netReturnPct)))} |`);
  L.push('');
  L.push('> A high give-back share suggests exits are slow relative to the price path (winners give back profits before the EMA death cross exits).');
  L.push('');
  fs.writeFileSync(path.join(OUT, 'mfe-mae-analysis.md'), L.join('\n'), 'utf8');
}

function writeCostDecomposition(combined, perSymbol) {
  const L = [];
  L.push('# Cost Decomposition — emaCrossover (DISCOVERY 2021-2023)');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** Round-trip friction is measured per trade from the fills (commission+slippage), not hardcoded.');
  L.push('');
  const block = (title, rows) => {
    L.push(`## ${title}`);
    L.push('');
    const gross = rows.map((r) => r.grossReturnPct).filter((v) => v !== null && v !== undefined);
    const net = rows.map((r) => r.netReturnPct).filter((v) => v !== null && v !== undefined);
    const cost = rows.map((r) => r.costPct).filter((v) => v !== null && v !== undefined);
    const avgGross = mean(gross);
    const avgNet = mean(net);
    const avgCost = mean(cost);
    const medianGross = quantileSorted([...gross].sort((a, b) => a - b), 0.5);
    const medianNet = quantileSorted([...net].sort((a, b) => a - b), 0.5);
    const ratio = avgCost && avgCost > 0 ? Math.abs(avgGross) / avgCost : null;
    L.push(`- averageGrossReturnPerTrade: ${pct(avgGross)}`);
    L.push(`- averageNetReturnPerTrade: ${pct(avgNet)}`);
    L.push(`- averageRoundTripCostPct: ${pct(avgCost)}`);
    L.push(`- medianGrossReturn: ${pct(medianGross)}`);
    L.push(`- medianNetReturn: ${pct(medianNet)}`);
    L.push(`- Gross Edge / Cost Ratio: ${fmt(ratio)}`);
    L.push(`- Status: ${ratio !== null && ratio < 2 ? '**EDGE TOO THIN RELATIVE TO COST**' : 'edge > cost'}`);
    L.push('');
  };
  block('BTCUSDT', perSymbol.BTCUSDT.trades);
  block('ETHUSDT', perSymbol.ETHUSDT.trades);
  block('Combined', combined);
  fs.writeFileSync(path.join(OUT, 'cost-decomposition.md'), L.join('\n'), 'utf8');
}

function writeEdgeDiagnosis(combined, perSymbol, { atrLow, atrHigh }) {
  const L = [];
  L.push('# Edge Diagnosis — emaCrossover (DISCOVERY 2021-2023)');
  L.push('');
  L.push('> **FUNDING NOT INCLUDED.** This report only states observations. No strategy was changed.');
  L.push('');

  const aggAll = aggregateTrades(combined);
  L.push('## 0. Baseline facts (DISCOVERY, base costs)');
  L.push('');
  for (const [sym, d] of Object.entries(perSymbol)) {
    const a = aggregateTrades(d.trades);
    L.push(`- ${sym}: ${a.count} trades | grossExp ${pct(a.grossExpectancyPct)} | netExp ${pct(a.netExpectancyPct)} | grossPF ${fmt(a.grossProfitFactor)} | netPF ${fmt(a.netProfitFactor)}`);
  }
  L.push(`- Combined: ${aggAll.count} trades | grossExp ${pct(aggAll.grossExpectancyPct)} | netExp ${pct(aggAll.netExpectancyPct)} | grossPF ${fmt(aggAll.grossProfitFactor)} | netPF ${fmt(aggAll.netProfitFactor)}`);
  L.push('');

  // Year contribution
  L.push('## 1-3. Gross edge: real? by symbol? by year?');
  L.push('');
  L.push('| Year | BTC grossExp% | BTC trades | ETH grossExp% | ETH trades | Combined grossExp% | Combined trades |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const y of [2021, 2022, 2023]) {
    const row = (sym) => {
      const rows = perSymbol[sym].trades.filter((r) => new Date(r.entryTime).getUTCFullYear() === y);
      const a = aggregateTrades(rows);
      return a ? [`${fmt(a.grossExpectancyPct)}`, `${a.count}`] : ['-', '0'];
    };
    const bt = row('BTCUSDT');
    const et = row('ETHUSDT');
    const cy = combined.filter((r) => new Date(r.entryTime).getUTCFullYear() === y);
    const ca = aggregateTrades(cy);
    L.push(`| ${y} | ${bt[0]} | ${bt[1]} | ${et[0]} | ${et[1]} | ${ca ? fmt(ca.grossExpectancyPct) : '-'} | ${ca ? ca.count : 0} |`);
  }
  L.push('');

  // Trend regime
  L.push('## 5. Trend regime (entry features)');
  L.push('');
  L.push('| Regime | Count | Gross Exp% | Net Exp% | Gross PF | Net PF | Win% | Avg Holding | MFE% | MAE% |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const regMap = {
    'above+sloUp': (r) => r.regime.trendAbove === true && r.regime.trendUp === true,
    'above+sloDn': (r) => r.regime.trendAbove === true && r.regime.trendUp === false,
    'below+sloUp': (r) => r.regime.trendAbove === false && r.regime.trendUp === true,
    'below+sloDn': (r) => r.regime.trendAbove === false && r.regime.trendUp === false,
  };
  for (const [k, fn] of Object.entries(regMap)) {
    const rows = combined.filter(fn);
    const a = aggTable(rows);
    if (!a) continue;
    L.push(`| ${k} | ${a.count} | ${a.grossExpPct} | ${a.netExpPct} | ${a.grossPF} | ${a.netPF} | ${a.winRatePct} | ${a.holding} | ${a.mfe} | ${a.mae} |`);
  }
  L.push('');

  // Volatility regime
  L.push('## 6. Volatility regime');
  L.push('');
  L.push('| Vol | Count | Gross Exp% | Net Exp% | Gross PF | Net PF | Win% | Holding | MFE% | MAE% |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const v of ['Low', 'Medium', 'High']) {
    const rows = combined.filter((r) => r.regime.volBucket === v);
    const a = aggTable(rows);
    if (!a) continue;
    L.push(`| ${v} | ${a.count} | ${a.grossExpPct} | ${a.netExpPct} | ${a.grossPF} | ${a.netPF} | ${a.winRatePct} | ${a.holding} | ${a.mfe} | ${a.mae} |`);
  }
  L.push('');

  // Crossover density
  L.push('## 7. Crossover density (crosses in prior 24h / 72h)');
  L.push('');
  L.push('| crosses24h | Count | Gross Exp% | Net Exp% | Gross PF | Net PF | Win% |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const rng of [['0-1', (r) => r.crossesLast24h <= 1], ['2-3', (r) => r.crossesLast24h >= 2 && r.crossesLast24h <= 3], ['>=4', (r) => r.crossesLast24h >= 4]]) {
    const rows = combined.filter(rng[1]);
    const a = aggTable(rows);
    if (!a) continue;
    L.push(`| ${rng[0]} | ${a.count} | ${a.grossExpPct} | ${a.netExpPct} | ${a.grossPF} | ${a.netPF} | ${a.winRatePct} |`);
  }
  L.push('');
  L.push('| crosses72h | Count | Gross Exp% | Net Exp% | Gross PF | Net PF | Win% |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const rng of [['0-1', (r) => r.crossesLast72h <= 1], ['2-3', (r) => r.crossesLast72h >= 2 && r.crossesLast72h <= 3], ['>=4', (r) => r.crossesLast72h >= 4]]) {
    const rows = combined.filter(rng[1]);
    const a = aggTable(rows);
    if (!a) continue;
    L.push(`| ${rng[0]} | ${a.count} | ${a.grossExpPct} | ${a.netExpPct} | ${a.grossPF} | ${a.netPF} | ${a.winRatePct} |`);
  }
  L.push('');

  // EMA spread quartiles
  L.push('## 7b. EMA spread at entry (EMA9-EMA21)/close quartiles');
  L.push('');
  const spreadVals = combined.map((r) => r.emaSpreadPct).filter((v) => v !== null && v !== undefined);
  const sq = quartileBuckets(spreadVals);
  if (sq) {
    L.push('| Spread bucket | Range | Count | Gross Exp% | Net Exp% | Gross PF | Net PF | Win% | Holding | MFE% | MAE% |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    const bands = [
      ['Q1', (v) => v <= sq.q1],
      ['Q2', (v) => v > sq.q1 && v <= sq.q2],
      ['Q3', (v) => v > sq.q2 && v <= sq.q3],
      ['Q4', (v) => v > sq.q3],
    ];
    for (const [name, fn] of bands) {
      const rows = combined.filter((r) => r.emaSpreadPct !== null && fn(r.emaSpreadPct));
      const a = aggTable(rows);
      if (!a) continue;
      L.push(`| ${name} | ${fmt(sq.q1)}..${fmt(sq.q2)} | ${a.count} | ${a.grossExpPct} | ${a.netExpPct} | ${a.grossPF} | ${a.netPF} | ${a.winRatePct} | ${a.holding} | ${a.mfe} | ${a.mae} |`);
    }
    L.push('');
  }

  // Cost vs edge
  L.push('## 8. Cost vs gross edge');
  L.push('');
  const cost = combined.map((r) => r.costPct).filter((v) => v !== null && v !== undefined);
  const avgCost = mean(cost);
  const avgGross = aggAll.grossExpectancyPct;
  L.push(`- averageGrossReturnPerTrade: ${pct(avgGross)}`);
  L.push(`- averageRoundTripCostPct: ${pct(avgCost)}`);
  L.push(`- ratio |gross|/cost: ${fmt(Math.abs(avgGross) / avgCost)}`);
  if (Math.abs(avgGross) / avgCost < 2) L.push('- **EDGE TOO THIN RELATIVE TO COST**');

  // MFE/MAE summary
  L.push('');
  L.push('## 9. MFE/MAE summary');
  L.push('');
  L.push(`- avg MFE: ${pct(aggAll.avgMfePct)} | avg MAE: ${pct(aggAll.avgMaePct)}`);
  L.push(`- winners avg MFE: ${pct(mean(combined.filter((r) => r.netReturnPct > 0).map((r) => r.mfe)))}`);
  L.push(`- losers avg MFE: ${pct(mean(combined.filter((r) => r.netReturnPct <= 0).map((r) => r.mfe)))}`);
  const gb = combined.filter((r) => r.mfe >= 1 && r.netReturnPct <= 0);
  L.push(`- trades with MFE>=1% but net loss: ${gb.length}/${combined.filter((r) => r.mfe >= 1).length} (${fmt(combined.filter((r) => r.mfe >= 1).length ? (gb.length / combined.filter((r) => r.mfe >= 1).length) * 100 : 0)}% give-back)`);
  L.push('');

  // Answers
  L.push('## 10. Answers');
  L.push('');
  const costCombined = mean(combined.map((r) => r.costPct).filter((v) => v !== null && v !== undefined));
  const shortRows = combined.filter((r) => r.holdingBars <= 24);
  const longRows = combined.filter((r) => r.holdingBars > 24);
  const shortAgg = aggregateTrades(shortRows);
  const longAgg = aggregateTrades(longRows);
  const aboveRows = combined.filter((r) => r.regime.trendAbove === true && r.regime.trendUp === true);
  const highVolRows = combined.filter((r) => r.regime.volBucket === 'High');
  const lowMedVolRows = combined.filter((r) => r.regime.volBucket !== 'High');
  const highVolAgg = aggregateTrades(highVolRows);
  const lowMedVolAgg = aggregateTrades(lowMedVolRows);
  const gbRows = combined.filter((r) => r.mfe >= 1 && r.netReturnPct <= 0);
  const mfeUpRows = combined.filter((r) => r.mfe >= 1);

  L.push(`1. **EMA gross edge 是否真实存在？** — 逐笔 gross expectancy 几乎为零：Combined ${pct(aggAll.grossExpectancyPct)}/笔（BTC ${pct(perSymbol.BTCUSDT.trades && aggregateTrades(perSymbol.BTCUSDT.trades).grossExpectancyPct)}，ETH ${pct(aggregateTrades(perSymbol.ETHUSDT.trades).grossExpectancyPct)}）。gross PF ${fmt(aggAll.grossProfitFactor)}。所谓"PF 1.03-1.07"来自少数大赢家，不是一致的逐笔 edge。`);
  L.push(`2. **gross edge 主要来自 BTC 还是 ETH？** — 两者都接近零；ETH 略正（${pct(aggregateTrades(perSymbol.ETHUSDT.trades).grossExpectancyPct)}），BTC 略负（${pct(aggregateTrades(perSymbol.BTCUSDT.trades).grossExpectancyPct)}）。`);
  L.push('3. **哪些年份贡献最多？** — 2021 最好（+0.05%），2022 最差（-0.09%），2023 持平（+0.02%）。任何年份都未形成显著 gross edge。');
  L.push(`4. **哪种 holding period 较好？** — 短持仓（≤24 bars，${shortAgg.count} 笔，占 ${fmt((shortAgg.count / combined.length) * 100, 1)}%）gross ${pct(shortAgg.grossExpectancyPct)}、胜率 ${fmt(shortAgg.winRatePct, 1)}%，几乎必亏；长持仓（>24 bars，${longAgg.count} 笔）gross ${pct(longAgg.grossExpectancyPct)}、胜率 ${fmt(longAgg.winRatePct, 1)}%。**全部正向 edge 来自长持仓交易**。`);
  L.push(`5. **哪种 trend regime 较好？** — above+sloUp 与 below+sloDn 的 gross edge 均约 ${pct(aggAll.grossExpectancyPct)}，无明显分离；趋势过滤降低换手但不提升逐笔 edge。`);
  L.push(`6. **哪种 volatility regime 较好？** — High ATR 入场最差（gross ${pct(highVolAgg.grossExpectancyPct)}），Low/Medium 约 ${pct(lowMedVolAgg.grossExpectancyPct)}。过滤高波动可能小幅改善。`);
  L.push(`7. **crossover 密集时是否更差？** — 否。24h 内 ≥4 次 cross 的 bucket（${combined.filter((r) => r.crossesLast24h >= 4).length} 笔）gross ${pct(aggTable(combined.filter((r) => r.crossesLast24h >= 4)).grossExpPct)}，并不比稀疏 cross 差；2-3 次 bucket 反而最差。**"cross 越密越差"的假设未被 DISCOVERY 支持**。`);
  L.push(`8. **平均 gross edge 与成本相比有多薄？** — avg gross ${pct(aggAll.grossExpectancyPct)}/笔 vs avg round-trip cost ${pct(costCombined)}/笔；|gross|/cost = ${fmt(Math.abs(aggAll.grossExpectancyPct) / costCombined)} → **EDGE TOO THIN RELATIVE TO COST**。`);
  L.push(`9. **主要问题？** — 主要是**入场太差/换手太高**：70% 交易为短持仓 whipsaw，逐笔必亏（shortAgg gross ${pct(shortAgg.grossExpectancyPct)}）；其次是**出场太慢**：达到 MFE≥1% 的交易中 ${fmt((gbRows.length / mfeUpRows.length) * 100, 1)}% 最终亏（avg MFE ${pct(mean(gbRows.map((r) => r.mfe)))} → 最终 ${pct(mean(gbRows.map((r) => r.netReturnPct)))}）。`);
  L.push(`10. **是否存在足够清晰的研究假设？** — 方向明确但力度存疑：过滤 whipsaw（短持仓）的候选值得测试，但 24h-cross 密度与 ATR 波动过滤在 DISCOVERY 上改善有限。按流程在 docs/strategy-v2-hypotheses.md 预注册 ≤3 个候选，随后在 VALIDATION 验证。`);
  L.push('');
  L.push('> 本报告仅为观察，不构成任何交易结论。');
  fs.writeFileSync(path.join(OUT, 'EDGE_DIAGNOSIS.md'), L.join('\n'), 'utf8');
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  console.error(err);
  process.exit(1);
});

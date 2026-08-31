// Performance metrics computed from a backtest result.
//
// Returns an object where each metric is a number or null. Metrics are null
// (never fabricated) when there is insufficient data to compute them.

const { maxDrawdown } = require('./drawdown');

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

const INTERVAL_RE = /^(\d+)\s*(m|h|d|w)?$/i;

// Generic interval parser -> milliseconds.
// Supports: '15m', '1h', '1d', '1w' (and plain ms numbers).
function intervalToMs(label) {
  if (typeof label === 'number') return label;
  const m = String(label).trim().match(INTERVAL_RE);
  if (!m) throw new Error(`Cannot parse interval "${label}"`);
  const n = Number(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  const perUnitMs = { m: 60 * 1000, h: 3600 * 1000, d: 24 * 3600 * 1000, w: 7 * 24 * 3600 * 1000 }[unit];
  return n * perUnitMs;
}

// Periods per year for a 24/7 market derived from the bar interval.
// Derived dynamically — never hardcoded (15m -> 35040, 1h -> 8760, 1d -> 365).
function periodsPerYearFor(intervalMs) {
  return intervalMs > 0 ? MS_PER_YEAR / intervalMs : null;
}

function mean(xs) {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function computeMetrics({ initialCapital, finalEquity, equityCurve, trades, intervalMs, barsTotal, barsInPosition }) {
  const metrics = {};

  // --- Return ---
  metrics.initialCapital = initialCapital;
  metrics.finalEquity = finalEquity;
  metrics.totalReturnPct = initialCapital > 0 ? ((finalEquity / initialCapital) - 1) * 100 : null;

  metrics.annualizedReturnPct = null;
  if (
    metrics.totalReturnPct !== null &&
    equityCurve.length >= 2 &&
    finalEquity > 0 &&
    initialCapital > 0
  ) {
    const firstTs = equityCurve[0].timestamp;
    const lastTs = equityCurve[equityCurve.length - 1].timestamp;
    const years = lastTs > firstTs ? (lastTs - firstTs) / MS_PER_YEAR : 0;
    if (years > 0) {
      metrics.annualizedReturnPct = (Math.pow(finalEquity / initialCapital, 1 / years) - 1) * 100;
    }
  }

  // --- Drawdown ---
  const dd = maxDrawdown(equityCurve);
  metrics.maxDrawdownPct = dd.maxDrawdownPct;
  metrics.maxDrawdownAbs = dd.maxDrawdownAbs;

  // --- Per-bar returns -> Sharpe / Sortino (annualized by data frequency) ---
  metrics.sharpe = null;
  metrics.sortino = null;
  metrics.periodsPerYear = periodsPerYearFor(intervalMs);
  if (equityCurve.length >= 2 && metrics.periodsPerYear) {
    const returns = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const prev = equityCurve[i - 1].equity;
      if (prev > 0) returns.push(equityCurve[i].equity / prev - 1);
    }
    if (returns.length >= 2) {
      const mu = mean(returns);
      const variance = mean(returns.map((r) => (r - mu) ** 2));
      const std = Math.sqrt(variance);
      if (std > 0) {
        metrics.sharpe = (mu / std) * Math.sqrt(metrics.periodsPerYear);
      }
      const downsideVariance = mean(returns.map((r) => (r < 0 ? r * r : 0)));
      const downsideStd = Math.sqrt(downsideVariance);
      if (downsideStd > 0) {
        metrics.sortino = (mu / downsideStd) * Math.sqrt(metrics.periodsPerYear);
      }
    }
  }

  // --- Trade-level metrics ---
  const tradeCount = trades.length;
  metrics.tradeCount = tradeCount;
  metrics.exposurePct = barsTotal > 0 ? (barsInPosition / barsTotal) * 100 : null;
  metrics.totalFees = trades.reduce((a, t) => a + (t.fees || 0), 0);

  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const grossProfit = wins.reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = losses.reduce((a, t) => a + t.netPnl, 0);

  metrics.winRatePct = tradeCount > 0 ? (wins.length / tradeCount) * 100 : null;
  metrics.avgWin = wins.length > 0 ? mean(wins.map((t) => t.netPnl)) : null;
  metrics.avgLoss = losses.length > 0 ? mean(losses.map((t) => t.netPnl)) : null;
  metrics.grossProfit = grossProfit;
  metrics.grossLoss = grossLoss;
  metrics.profitFactor = grossLoss < 0 ? Math.abs(grossProfit / grossLoss) : null; // == net PF (netPnl sums)
  metrics.netProfitFactor = metrics.profitFactor;

  // Gross profit factor uses pre-fee grossPnl sums.
  const gWins = trades.filter((t) => t.grossPnl > 0);
  const gLosses = trades.filter((t) => t.grossPnl < 0);
  const gProfitSum = gWins.reduce((a, t) => a + t.grossPnl, 0);
  const gLossSum = gLosses.reduce((a, t) => a + t.grossPnl, 0);
  metrics.grossProfitFactor = gLossSum < 0 ? Math.abs(gProfitSum / gLossSum) : null;

  // Expectancy: explicit units.
  metrics.expectancy = tradeCount > 0 ? mean(trades.map((t) => t.netPnl)) : null; // USDT per trade (dollar)
  metrics.expectancyDollar = metrics.expectancy;
  metrics.expectancyPctPerTrade = tradeCount > 0 ? mean(trades.map((t) => t.returnPct)) : null; // % per trade

  // Max consecutive losing trades
  let maxConsecLoss = 0;
  let current = 0;
  for (const t of trades) {
    if (t.netPnl < 0) {
      current++;
      if (current > maxConsecLoss) maxConsecLoss = current;
    } else {
      current = 0;
    }
  }
  metrics.maxConsecutiveLoss = tradeCount > 0 ? maxConsecLoss : null;

  return metrics;
}

module.exports = { computeMetrics, MS_PER_YEAR, intervalToMs, periodsPerYearFor };

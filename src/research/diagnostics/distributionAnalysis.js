// Distribution & bucket aggregation for trade diagnostics reports.

function mean(xs) {
  const f = xs.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null;
}

function sum(xs) {
  return xs.filter((v) => v !== null && v !== undefined && Number.isFinite(v)).reduce((a, b) => a + b, 0) || 0;
}

// Aggregate a set of enriched trades into per-bucket statistics.
// Dollar aggregates use a fixed notional of 10000 for comparability
// (grossPnL$ = grossReturnPct% * 100, fees$ = costPct% * 100).
function aggregateTrades(rows, { notional = 10000 } = {}) {
  const n = rows.length;
  if (n === 0) return null;
  const gross = rows.map((r) => r.grossReturnPct).filter((v) => v !== null && v !== undefined);
  const net = rows.map((r) => r.netReturnPct).filter((v) => v !== null && v !== undefined);
  const cost = rows.map((r) => r.costPct).filter((v) => v !== null && v !== undefined);

  const grossProfit = sum(gross.filter((v) => v > 0));
  const grossLoss = sum(gross.filter((v) => v < 0));
  const netProfit = sum(net.filter((v) => v > 0));
  const netLoss = sum(net.filter((v) => v < 0));
  const wins = net.filter((v) => v > 0).length;

  return {
    count: n,
    grossExpectancyPct: mean(gross),
    netExpectancyPct: mean(net),
    grossProfitFactor: grossLoss < 0 ? Math.abs(grossProfit / grossLoss) : null,
    netProfitFactor: netLoss < 0 ? Math.abs(netProfit / netLoss) : null,
    winRatePct: net.length ? (wins / net.length) * 100 : null,
    avgWinPct: mean(net.filter((v) => v > 0)),
    avgLossPct: mean(net.filter((v) => v < 0)),
    avgHoldingBars: mean(rows.map((r) => r.holdingBars)),
    avgMfePct: mean(rows.map((r) => r.mfe)),
    avgMaePct: mean(rows.map((r) => r.mae)),
    totalGrossPnL: sum(gross) * (notional / 100),
    totalNetPnL: sum(net) * (notional / 100),
    totalFees: sum(cost) * (notional / 100),
  };
}

// Group rows by a key function into an ordered array of { key, rows, agg }.
function bucketize(rows, keyFn, order = null) {
  const map = new Map();
  for (const r of rows) {
    const k = String(keyFn(r));
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  let keys = Array.from(map.keys());
  if (order) {
    keys = order.filter((k) => map.has(k));
    const extra = Array.from(map.keys()).filter((k) => !order.includes(k));
    keys = keys.concat(extra);
  }
  return keys.map((k) => ({ key: k, rows: map.get(k), agg: aggregateTrades(map.get(k)) }));
}

module.exports = { mean, sum, aggregateTrades, bucketize };

// Trade ledger: structured trade records + CSV serialization.

const TRADE_COLUMNS = [
  'symbol', 'strategy',
  'entryTime', 'entryPrice', 'exitTime', 'exitPrice',
  'quantity', 'grossPnl', 'fees', 'netPnl', 'returnPct', 'holdingBars',
];

function fmtNum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? String(Number(v.toFixed(8))) : '';
}

// Serialize an array of trade records to CSV (with header).
function tradesToCsv(trades) {
  const lines = [TRADE_COLUMNS.join(',')];
  for (const t of trades) {
    lines.push([
      t.symbol,
      t.strategy,
      new Date(t.entryTime).toISOString(),
      fmtNum(t.entryPrice),
      new Date(t.exitTime).toISOString(),
      fmtNum(t.exitPrice),
      fmtNum(t.quantity),
      fmtNum(t.grossPnl),
      fmtNum(t.fees),
      fmtNum(t.netPnl),
      fmtNum(t.returnPct),
      t.holdingBars,
    ].join(','));
  }
  return lines.join('\n');
}

module.exports = { tradesToCsv, TRADE_COLUMNS };

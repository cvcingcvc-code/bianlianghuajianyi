// Funding cashflow calculator with strict ownership rule.
//
// Ownership rule (LOCKED):
//   entryTime < fundingTime AND fundingTime < exitTime
//
// Boundary equality EXCLUDES the position from that funding event.
//
// LONG funding cashflow:
//   fundingCashflow = quantity × markPrice × fundingRate
//
//   fundingRate > 0 → LONG pays → cashflow < 0
//   fundingRate < 0 → LONG receives → cashflow > 0

// Compute funding for a single position given its entry/exit times and the
// funding events that fall within (strictly between) those times.
//
// Parameters:
//   entryTimeMs: position entry timestamp (ms)
//   exitTimeMs: position exit timestamp (ms)
//   quantity: position quantity (always positive for LONG)
//   fundingEvents: array of { fundingTime, fundingRate, markPrice }
//
// Returns:
//   { events: [...], fundingPaid, fundingReceived, netFunding, eventCount }
function computeTradeFunding({ entryTimeMs, exitTimeMs, quantity, fundingEvents }) {
  const result = {
    events: [],
    fundingPaid: 0,
    fundingReceived: 0,
    netFunding: 0,
    eventCount: 0,
  };

  for (const ev of fundingEvents) {
    // Strict ownership rule: entryTime < fundingTime < exitTime
    if (ev.fundingTime <= entryTimeMs || ev.fundingTime >= exitTimeMs) continue;

    if (!Number.isFinite(ev.fundingRate) || ev.fundingRate === 0) continue;
    if (!Number.isFinite(ev.markPrice) || ev.markPrice <= 0) continue;

    // LONG funding: positive rate → LONG pays → cashflow < 0
    const cashflow = -(quantity * ev.markPrice * ev.fundingRate);

    result.events.push({
      fundingTime: ev.fundingTime,
      fundingRate: ev.fundingRate,
      markPrice: ev.markPrice,
      cashflow,
      markPriceSource: ev.markPriceSource || 'DIRECT',
    });

    result.eventCount++;
    if (cashflow < 0) {
      result.fundingPaid += Math.abs(cashflow);
    } else {
      result.fundingReceived += cashflow;
    }
    result.netFunding += cashflow;
  }

  return result;
}

// Compute funding for all trades in a backtest.
// Returns enriched trades with funding fields.
function enrichTradesWithFunding({ trades, fundingProvider, symbol }) {
  return trades.map((trade) => {
    const events = fundingProvider.getEvents(symbol, trade.entryTime, trade.exitTime);
    const funding = computeTradeFunding({
      entryTimeMs: trade.entryTime,
      exitTimeMs: trade.exitTime,
      quantity: trade.quantity,
      fundingEvents: events,
    });

    return {
      ...trade,
      fundingEventCount: funding.eventCount,
      fundingPaid: funding.fundingPaid,
      fundingReceived: funding.fundingReceived,
      netFunding: funding.netFunding,
      grossPnl: trade.grossPnl,
      commission: trade.fees,
      netPnlBeforeFunding: trade.netPnl,
      netPnlAfterFunding: trade.netPnl + funding.netFunding,
      fundingEvents: funding.events,
    };
  });
}

module.exports = { computeTradeFunding, enrichTradesWithFunding };

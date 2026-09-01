// Funding-aware backtester.
// Runs the standard backtest, then applies real historical funding events
// at event-level (not per-bar) to compute funding-adjusted equity and trades.
//
// Architecture:
//   1. Run standard backtest (no funding) to get trades and equity curve
//   2. For each trade, compute funding using historical events
//   3. Rebuild equity curve with funding applied in real-time at event timestamps
//
// This does NOT modify the existing backtester.js — it's a research-only overlay.

const { createPortfolio } = require('../backtest/portfolio');
const { computeTradeFunding } = require('./fundingCalculator');

// Run a funding-aware backtest.
// The standard backtest produces trades. Then funding is applied event-by-event
// within each trade's holding period, updating cash at each fundingTime.
function runFundingBacktest({ symbol, candles, adapter, broker, initialCapital, positionSizePct = 25, fundingProvider }) {
  // Step 1: Run standard backtest to get trades and basic equity
  const { runBacktest } = require('../backtest/backtester');
  const baseResult = runBacktest({ symbol, candles, adapter, broker, initialCapital, positionSizePct });

  // Step 2: If no funding provider or no trades, return base result
  if (!fundingProvider || baseResult.trades.length === 0) {
    return { ...baseResult, fundingAdjusted: false };
  }

  // Step 3: Enrich trades with funding
  const enrichedTrades = baseResult.trades.map((trade) => {
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

  // Step 4: Rebuild equity curve with funding applied at event timestamps
  const adjustedEquity = rebuildEquityWithFunding({
    initialCapital,
    candles: baseResult.equityCurve.map((pt, i) => ({ ...candles[i], equity: pt.equity })),
    trades: enrichedTrades,
    fundingProvider,
    symbol,
  });

  // Step 5: Compute funding-adjusted metrics
  const finalEquity = adjustedEquity.length > 0
    ? adjustedEquity[adjustedEquity.length - 1].equity
    : initialCapital;

  const totalFundingPaid = enrichedTrades.reduce((a, t) => a + (t.fundingPaid || 0), 0);
  const totalFundingReceived = enrichedTrades.reduce((a, t) => a + (t.fundingReceived || 0), 0);
  const totalNetFunding = enrichedTrades.reduce((a, t) => a + (t.netFunding || 0), 0);
  const totalFundingEvents = enrichedTrades.reduce((a, t) => a + (t.fundingEventCount || 0), 0);

  return {
    ...baseResult,
    finalEquity,
    equityCurve: adjustedEquity,
    trades: enrichedTrades,
    totalFundingPaid,
    totalFundingReceived,
    totalNetFunding,
    totalFundingEvents,
    fundingAdjusted: true,
  };
}

// Rebuild equity curve with funding events applied at their actual timestamps.
// This ensures Sharpe, Sortino, MaxDD reflect real funding drag/income.
function rebuildEquityWithFunding({ initialCapital, candles, trades, fundingProvider, symbol }) {
  // Build a timeline of all funding events across all trades
  const allFundingEvents = [];
  for (const trade of trades) {
    if (trade.fundingEvents) {
      for (const ev of trade.fundingEvents) {
        allFundingEvents.push({ ...ev, trade });
      }
    }
  }
  allFundingEvents.sort((a, b) => a.fundingTime - b.fundingTime);

  // Build equity curve: start from base equity, apply funding at event timestamps
  const result = [];
  let cash = initialCapital;
  let fundingEventIdx = 0;

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];

    // Apply any funding events that occur at or before this bar's timestamp
    while (fundingEventIdx < allFundingEvents.length &&
           allFundingEvents[fundingEventIdx].fundingTime <= bar.timestamp) {
      const ev = allFundingEvents[fundingEventIdx];
      cash -= ev.cashflow; // cashflow is negative when paying, positive when receiving
      fundingEventIdx++;
    }

    // Mark to market using the base equity for this bar (which includes unrealized PnL)
    // The base equity already reflects the position value, so we use it as a reference
    // and adjust by the cumulative funding applied so far
    const baseEquity = bar.equity;
    const cumulativeFunding = allFundingEvents
      .slice(0, fundingEventIdx)
      .reduce((a, ev) => a - ev.cashflow, 0);

    result.push({
      timestamp: bar.timestamp,
      equity: baseEquity - cumulativeFunding,
    });
  }

  return result;
}

module.exports = { runFundingBacktest, rebuildEquityWithFunding };

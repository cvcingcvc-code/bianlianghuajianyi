// Strict backtester with next-bar execution.
//
// Signal produced at candle N's close is executed at candle N+1's open —
// NEVER at candle N's close. This prevents look-ahead bias by construction.
//
// Strategy interface (adapter):
//   { name, createState(), computeSignal(state, close, { hasPosition, warmup }) -> { action } }
// action is one of 'LONG' | 'CLOSE' | 'HOLD'.

const { createPortfolio } = require('./portfolio');

function runBacktest({ symbol, candles, adapter, broker, initialCapital, positionSizePct = 100 }) {
  const strategyState = adapter.createState();
  const portfolio = createPortfolio({
    initialCapital,
    symbol,
    positionSizePct,
    strategyName: adapter.name,
  });

  const bars = candles.map((c, i) => ({ ...c, index: i }));
  let pending = null; // { type: 'ENTRY' } | { type: 'EXIT' }

  for (const bar of bars) {
    // 1. Execute any pending order at this bar's open (next bar after the signal).
    if (pending) {
      if (pending.type === 'ENTRY') {
        portfolio.openPosition(bar, broker.entryFillPrice(bar.open), broker);
      } else {
        portfolio.closePosition(bar, broker.exitFillPrice(bar.open), broker);
      }
      pending = null;
    }

    // 2. Funding on open positions (V1 defaults to zero).
    if (portfolio.isInPosition()) {
      const funding = broker.fundingCost({ symbol, quantity: portfolio.positionQuantity() }, bar);
      portfolio.applyFunding(bar, funding);
    }

    // 3. Mark to market at this bar's close.
    portfolio.markToMarket(bar);

    // 4. Compute signal from this bar's close -> order executes next bar.
    //    The full bar (open/high/low/close/volume/timestamp) is passed so
    //    research strategies can use volume/ATR/etc. without look-ahead
    //    (adapter wraps legacy strategies that only consume `.close`).
    const inPosition = portfolio.isInPosition();
    const { action } = adapter.computeSignal(strategyState, bar, {
      hasPosition: inPosition,
      warmup: false,
    });
    if (action === 'LONG' && !inPosition) pending = { type: 'ENTRY' };
    else if (action === 'CLOSE' && inPosition) pending = { type: 'EXIT' };
  }

  // FORCED_RESEARCH_EXIT: if a position is still open after the last bar,
  // close it at the last bar's close (slippage-adjusted) purely to value the
  // ending state. This is a valuation device, not a real market fill.
  let forcedExit = false;
  if (portfolio.isInPosition()) {
    const lastBar = bars[bars.length - 1];
    if (lastBar) {
      const trade = portfolio.closePosition(lastBar, broker.exitFillPrice(lastBar.close), broker);
      trade.forcedExit = true;
      forcedExit = true;
      // replace the terminal equity point (which still marked the open position)
      // with the post-exit cash so the curve ends exactly at the final equity.
      const curve = portfolio.state.equityCurve;
      if (curve.length > 0) curve[curve.length - 1].equity = portfolio.state.cash;
    }
  }

  const state = portfolio.finalize();
  return {
    symbol,
    strategy: adapter.name,
    initialCapital,
    finalEquity: state.equityCurve.length
      ? state.equityCurve[state.equityCurve.length - 1].equity
      : initialCapital,
    equityCurve: state.equityCurve,
    trades: state.trades,
    barsTotal: bars.length,
    barsInPosition: state.barsInPosition,
    totalFunding: state.totalFunding,
    forcedExit,
    openPositionAtEnd: state.position !== null,
  };
}

module.exports = { runBacktest };

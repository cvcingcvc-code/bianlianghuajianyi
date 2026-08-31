// Portfolio: tracks cash, the (single) open position, equity curve and realized
// trades during a backtest run. Single-position / long-only by design in V1.

function createPortfolio({ initialCapital, symbol, positionSizePct = 100, strategyName = '' }) {
  const state = {
    initialCapital,
    cash: initialCapital,
    position: null,
    equityCurve: [],
    trades: [],
    barsInPosition: 0,
    totalFunding: 0,
  };

  return {
    state,

    isInPosition() {
      return state.position !== null;
    },

    positionQuantity() {
      return state.position ? state.position.quantity : 0;
    },

    // Open a LONG at `fillPrice` on bar (entry size = cash * sizePct, no leverage).
    openPosition(bar, fillPrice, broker) {
      if (state.position) {
        throw new Error('Cannot open: position already exists');
      }
      const sizePct = positionSizePct / 100;
      const notional = state.cash * sizePct;
      const quantity = notional / fillPrice;
      const fees = broker.commission(notional);
      state.cash -= notional + fees;
      state.position = {
        symbol,
        quantity,
        entryPrice: fillPrice,
        entryFees: fees,
        entryNotional: notional,
        entryTime: bar.timestamp,
        entryBarIndex: bar.index,
      };
    },

    // Close the LONG at `fillPrice` on bar; returns the realized trade record.
    closePosition(bar, fillPrice, broker) {
      if (!state.position) {
        throw new Error('Cannot close: no open position');
      }
      const p = state.position;
      const exitNotional = fillPrice * p.quantity;
      const exitFees = broker.commission(exitNotional);
      const grossPnl = (fillPrice - p.entryPrice) * p.quantity;
      const fees = p.entryFees + exitFees;
      const netPnl = grossPnl - fees;
      const returnPct = p.entryNotional > 0 ? (netPnl / p.entryNotional) * 100 : 0;

      state.cash += exitNotional - exitFees;

      const trade = {
        symbol,
        strategy: strategyName,
        entryTime: p.entryTime,
        entryPrice: p.entryPrice,
        exitTime: bar.timestamp,
        exitPrice: fillPrice,
        quantity: p.quantity,
        grossPnl,
        fees,
        netPnl,
        returnPct,
        holdingBars: bar.index - p.entryBarIndex,
      };
      state.trades.push(trade);
      state.position = null;
      return trade;
    },

    // Deduct funding (already computed amount) from cash.
    applyFunding(bar, amount) {
      if (amount !== 0) {
        state.cash -= amount;
        state.totalFunding += amount;
      }
    },

    // Record equity at the bar's close (mark-to-market on the open position).
    markToMarket(bar) {
      const equity = state.position
        ? state.cash + state.position.quantity * bar.close
        : state.cash;
      state.equityCurve.push({ timestamp: bar.timestamp, equity });
      if (state.position) state.barsInPosition++;
    },

    finalize() {
      return state;
    },
  };
}

module.exports = { createPortfolio };

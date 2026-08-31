// Broker simulator: models fills with slippage, fees, and an optional funding
// cost provider. Pure (no I/O), so it is trivially testable and reusable.

// --- Funding provider interface ---
//
// A funding provider exposes:
//   { type: string, getRate(symbol: string, timestampMs: number) -> number|null }
//
// getRate returns the funding rate for a (symbol, time) or null when unknown.
// V1 ships:
//   - 'none'     : always returns null (funding not modeled)  [default]
//   - 'constant' : returns a fixed rate (useful for sensitivity checks)
//
// Future versions can add a provider that loads real funding history from CSV.

function createFundingProvider({ type = 'none', rate = 0 } = {}) {
  if (type === 'none') {
    return { type: 'none', rate, getRate: () => null };
  }
  if (type === 'constant') {
    return { type: 'constant', rate, getRate: () => rate };
  }
  throw new Error(`Unknown funding provider type "${type}"`);
}

// Broker defaults: taker commission 0.04%, slippage 0.02% per fill.
// Fill model:
//   LONG  entry price = open * (1 + slippagePct)
//   CLOSE exit  price = open * (1 - slippagePct)
function createBroker({ commissionPct = 0.0004, slippagePct = 0.0002, fundingProvider = null } = {}) {
  if (!Number.isFinite(commissionPct) || commissionPct < 0 || commissionPct >= 1) {
    throw new Error(`commissionPct must be a number in [0,1), got ${commissionPct}`);
  }
  if (!Number.isFinite(slippagePct) || slippagePct < 0 || slippagePct >= 1) {
    throw new Error(`slippagePct must be a number in [0,1), got ${slippagePct}`);
  }
  return {
    commissionPct,
    slippagePct,
    fundingProvider,
    entryFillPrice(open) {
      return open * (1 + slippagePct);
    },
    exitFillPrice(open) {
      return open * (1 - slippagePct);
    },
    // Commission on a notional value (rounded nowhere on purpose).
    commission(notional) {
      return notional * commissionPct;
    },
    // Funding cost applied to an open position at a given bar.
    // position: { symbol, quantity }; bar: { timestamp, close }.
    // Returns a cash amount (0 when no provider / unknown rate).
    fundingCost(position, bar) {
      if (!fundingProvider) return 0;
      const rate = fundingProvider.getRate(position.symbol, bar.timestamp);
      if (rate == null) return 0;
      // V1 model: rate applied to mark (close) value, charged once per bar.
      return position.quantity * bar.close * rate;
    },
    fundingIncluded() {
      return !!(fundingProvider && fundingProvider.type !== 'none');
    },
  };
}

module.exports = { createBroker, createFundingProvider };

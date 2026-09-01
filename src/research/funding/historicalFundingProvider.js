// Historical funding provider for backtesting.
// Loads real Binance funding rate events from CSV and provides them to the broker.
//
// Interface matches brokerSimulator's funding provider contract:
//   { type: string, getRate(symbol, timestampMs) -> number|null }
//
// But for event-level funding (not per-bar), we use getEvents() instead.

const { loadFundingCSV } = require('./fundingDownloader');

// Create a historical funding provider from pre-loaded events.
// events: array of { symbol, fundingTime, fundingRate, markPrice, rateType }
// The provider is per-symbol: one provider per asset.
function createHistoricalFundingProvider({ events }) {
  // Index events by symbol for O(1) lookup, deduplicating by fundingTime
  const bySymbol = {};
  for (const ev of events) {
    if (!bySymbol[ev.symbol]) bySymbol[ev.symbol] = [];
    bySymbol[ev.symbol].push(ev);
  }
  // Sort and deduplicate each symbol's events
  for (const sym of Object.keys(bySymbol)) {
    bySymbol[sym].sort((a, b) => a.fundingTime - b.fundingTime);
    // Deduplicate: keep first event for each fundingTime
    const seen = new Set();
    const deduped = [];
    for (const ev of bySymbol[sym]) {
      if (!seen.has(ev.fundingTime)) {
        seen.add(ev.fundingTime);
        deduped.push(ev);
      }
    }
    bySymbol[sym] = deduped;
  }

  return {
    type: 'historical',

    // Get the funding rate at a specific timestamp (for bar-level compatibility).
    // Returns the rate of the funding event closest to (but not after) timestampMs,
    // or null if no event exists at or before that time.
    getRate(symbol, timestampMs) {
      const evs = bySymbol[symbol];
      if (!evs || evs.length === 0) return null;
      // Find the last event with fundingTime <= timestampMs
      let lo = 0, hi = evs.length - 1;
      let result = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (evs[mid].fundingTime <= timestampMs) {
          result = evs[mid];
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return result ? result.fundingRate : null;
    },

    // Get all funding events for a symbol within a time range (exclusive boundaries).
    // Used by the backtester for event-level funding computation.
    // Ownership rule: entryTime < fundingTime < exitTime
    getEvents(symbol, fromExclusive, toExclusive) {
      const evs = bySymbol[symbol];
      if (!evs || evs.length === 0) return [];

      // Binary search for first event with fundingTime > fromExclusive
      let lo = 0, hi = evs.length - 1;
      let startIdx = evs.length;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (evs[mid].fundingTime > fromExclusive) {
          startIdx = mid;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }

      // Collect events with fundingTime < toExclusive
      const result = [];
      for (let i = startIdx; i < evs.length; i++) {
        if (evs[i].fundingTime >= toExclusive) break;
        result.push(evs[i]);
      }
      return result;
    },

    // Get all events for a symbol (for diagnostics)
    getAllEvents(symbol) {
      return bySymbol[symbol] || [];
    },
  };
}

// Convenience: load from CSV file
function loadHistoricalFundingProvider(csvPath) {
  const events = loadFundingCSV(csvPath);
  return createHistoricalFundingProvider({ events });
}

module.exports = { createHistoricalFundingProvider, loadHistoricalFundingProvider };

// FINAL HOLDOUT protection.
//
// Research candidate strategies may not be evaluated on data at/after
// 2026-01-01 (the FINAL HOLDOUT window) without an explicit --unlock-holdout.
// This guard is a pure, testable function; the CLI applies it before running.

const { isResearchStrategy } = require('./strategyAdapter');

const HOLDOUT_START_MS = Date.UTC(2026, 0, 1);
const HOLDOUT_MESSAGE = 'FINAL HOLDOUT IS LOCKED';

// Check whether running `strategy` over `candles` (with optional walk-forward
// ranges) touches the holdout window and is not explicitly unlocked.
// Returns { locked: boolean, reason?: string }.
function checkHoldoutLock({ strategy, candles, walk = null, unlocked = false }) {
  if (!isResearchStrategy(strategy)) {
    return { locked: false };
  }
  let touches = walk && walk.testEndMs !== undefined && walk.testEndMs > HOLDOUT_START_MS;
  if (!touches && candles && candles.length > 0) {
    touches = candles[candles.length - 1].timestamp >= HOLDOUT_START_MS;
  }
  if (touches && !unlocked) {
    return { locked: true, reason: HOLDOUT_MESSAGE };
  }
  return { locked: false };
}

module.exports = { checkHoldoutLock, HOLDOUT_START_MS, HOLDOUT_MESSAGE };

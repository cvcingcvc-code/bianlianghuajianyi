// Independent V2 candidate. Frozen breakout and trend-grid V1 are not imported or changed.
const COSTS = Object.freeze({ BASE: Object.freeze({ fee: 0.0004, slip: 0.0002 }), STRESS: Object.freeze({ fee: 0.0006, slip: 0.0005 }) });
function decide(f, { complete = true, equity = 10000, drawdown = 0, validated = false, forecastGate = 'NOT_EVALUATED', tradeGate = 'NOT_EVALUATED' } = {}) {
  const wait = reason => ({ action: 'WAIT', reason, time: f?.time ?? null });
  if (validated && (forecastGate !== 'PASS' || tradeGate !== 'PASS')) return wait('VALIDATION_NOT_PASSED');
  if (!complete) return wait('DATA_INCOMPLETE');
  if (!f || f.status !== 'AVAILABLE' || !f.calibrated) return wait('MODEL_OR_CALIBRATION_UNAVAILABLE');
  if (!(equity > 0) || drawdown >= 0.1) return wait('RISK_LIMIT');
  const side = f.up >= 0.6 && f.median > 0 ? 'LONG' : f.up <= 0.4 && f.median < 0 ? 'SHORT' : null;
  if (!side) return wait('DIRECTION_UNCERTAIN');
  if (f.upper - f.lower > 0.1) return wait('INTERVAL_TOO_WIDE');
  const expected = side === 'LONG' ? Math.expm1(f.median) : -Math.expm1(f.median);
  const required = 2 * (COSTS.STRESS.fee + COSTS.STRESS.slip) + 0.001 + 0.001;
  if (!(expected > required)) return wait('EDGE_BELOW_FULL_COST_AND_MARGIN');
  return { action: 'OPEN', side, time: f.time, expected, required, regime: f.regime, reason: 'DISTRIBUTION_AND_COST_QUALIFIED' };
}
module.exports = { COSTS, decide };

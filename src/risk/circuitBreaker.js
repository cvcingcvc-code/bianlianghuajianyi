const { BREAKER } = require('../utils/constants');

const CONSECUTIVE_LOSS_THRESHOLD = 5;
const API_ERROR_THRESHOLD = 10;

function init(repo, eventBus, logger) {
  eventBus.on('positionClosed', (data) => {
    if (data.pnl < 0) {
      const count = repo.incrementConsecutiveLoss();
      logger.warn(`Consecutive loss #${count}`);
      if (count >= CONSECUTIVE_LOSS_THRESHOLD) {
        repo.tripBreaker(BREAKER.CONSECUTIVE_LOSS, { consecutiveLosses: count });
        logger.error('CIRCUIT BREAKER TRIPPED: consecutive losses');
        eventBus.emit('circuitBreakerTripped', { reason: BREAKER.CONSECUTIVE_LOSS, count });
      }
    } else {
      repo.resetConsecutiveLoss();
    }
  });
}

function trackApiError(repo, eventBus, logger) {
  const count = repo.incrementApiErrors();
  if (count >= API_ERROR_THRESHOLD) {
    repo.tripBreaker(BREAKER.API_ERROR, { errorCount: count });
    logger.error('CIRCUIT BREAKER TRIPPED: too many API errors');
    eventBus.emit('circuitBreakerTripped', { reason: BREAKER.API_ERROR, count });
  }
}

function resetApiErrors(repo) { repo.resetApiErrors(); }
function check(repo) { return repo.isBreakerTripped(); }
function status(repo) { return repo.getBreakerState(); }

module.exports = { init, trackApiError, resetApiErrors, check, status };

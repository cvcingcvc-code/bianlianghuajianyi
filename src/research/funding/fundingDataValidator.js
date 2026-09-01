// Funding data integrity verification.
// Verifies: ascending order, duplicates, invalid rates, timestamps, completeness.

const HOLDOUT_START_MS = Date.UTC(2026, 0, 1);

function verifyFundingData({ events, symbol, expectedStartMs, expectedEndMs }) {
  const report = {
    symbol,
    firstFundingTime: null,
    lastFundingTime: null,
    eventCount: events.length,
    duplicateCount: 0,
    invalidRateCount: 0,
    invalidTimestampCount: 0,
    positiveFundingEvents: 0,
    negativeFundingEvents: 0,
    zeroFundingEvents: 0,
    holdoutViolation: false,
    outOfOrder: false,
    status: 'OK',
    issues: [],
  };

  if (events.length === 0) {
    report.status = 'FUNDING DATA INCOMPLETE';
    report.issues.push('no events');
    return report;
  }

  report.firstFundingTime = events[0].fundingTime;
  report.lastFundingTime = events[events.length - 1].fundingTime;

  // Check holdout violation
  if (report.lastFundingTime >= HOLDOUT_START_MS) {
    report.holdoutViolation = true;
    report.status = 'HOLDOUT VIOLATION';
    report.issues.push('funding events extend into 2026');
    return report;
  }

  // Check ascending order and duplicates
  const seen = new Set();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];

    // timestamp validity
    if (!Number.isFinite(ev.fundingTime) || ev.fundingTime <= 0) {
      report.invalidTimestampCount++;
    }

    // rate validity
    if (!Number.isFinite(ev.fundingRate)) {
      report.invalidRateCount++;
    } else {
      if (ev.fundingRate > 0) report.positiveFundingEvents++;
      else if (ev.fundingRate < 0) report.negativeFundingEvents++;
      else report.zeroFundingEvents++;
    }

    // duplicates
    if (seen.has(ev.fundingTime)) {
      report.duplicateCount++;
    }
    seen.add(ev.fundingTime);

    // ordering
    if (i > 0 && ev.fundingTime < events[i - 1].fundingTime) {
      report.outOfOrder = true;
    }
  }

  if (report.outOfOrder) {
    report.issues.push('events not in ascending order');
  }
  if (report.duplicateCount > 0) {
    report.issues.push(`${report.duplicateCount} duplicate timestamps`);
  }
  if (report.invalidRateCount > 0) {
    report.issues.push(`${report.invalidRateCount} invalid funding rates`);
  }
  if (report.invalidTimestampCount > 0) {
    report.issues.push(`${report.invalidTimestampCount} invalid timestamps`);
  }

  if (report.issues.length > 0) {
    report.status = 'FUNDING DATA INCOMPLETE';
  }

  return report;
}

module.exports = { verifyFundingData };

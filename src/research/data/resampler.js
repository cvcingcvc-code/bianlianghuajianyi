// Strict UTC-aligned OHLCV resampler from validated 15m candles to higher
// timeframes (1h / 4h). Used only by STRATEGY RESEARCH V4.
//
// Rules:
//   - Group by floor(timestamp / targetMs) — strict UTC alignment.
//   - A target candle is built ONLY from a COMPLETE window
//     (targetMs / 900000 source candles). Incomplete windows are discarded and
//     reported (never silently filled, never aggregated across gaps).
//   - open = first.open, high = max(high), low = min(low),
//     close = last.close, volume = sum(volume); timestamp = first open_time.

const SRC_MS = 15 * 60 * 1000; // validated source interval (15m)

// Resample `candles` (ascending, continuous 15m) to `targetMs`.
// Returns { candles, incompleteWindows }.
function resample(candles, targetMs) {
  if (!Number.isInteger(targetMs) || targetMs <= 0 || targetMs % SRC_MS !== 0) {
    throw new Error(`targetMs must be a positive multiple of 15m, got ${targetMs}`);
  }
  const per = Math.round(targetMs / SRC_MS);

  const groups = new Map();
  for (const c of candles) {
    const key = Math.floor(c.timestamp / targetMs);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  const keys = Array.from(groups.keys()).sort((a, b) => a - b);
  const out = [];
  const incompleteWindows = [];
  for (const key of keys) {
    const group = groups.get(key).slice().sort((a, b) => a.timestamp - b.timestamp);
    if (group.length !== per) {
      incompleteWindows.push({ timestamp: key * targetMs, count: group.length, expected: per });
      continue; // discard — never fabricate a candle
    }
    let high = group[0].high;
    let low = group[0].low;
    let vol = 0;
    for (const c of group) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      vol += c.volume;
    }
    out.push({
      timestamp: group[0].timestamp,
      open: group[0].open,
      high,
      low,
      close: group[group.length - 1].close,
      volume: vol,
    });
  }
  return { candles: out, incompleteWindows };
}

// Common target sizes in ms.
const TARGETS = {
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
};

module.exports = { resample, TARGETS, SRC_MS };

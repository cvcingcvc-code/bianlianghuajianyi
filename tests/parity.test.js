// Golden-master / regression parity test.
//
// The strategies were refactored (pure-function extraction: createState +
// computeSignal, with onTick delegating to computeSignal). This test verifies
// that the extracted computeSignal produces IDENTICAL per-bar actions to the
// pre-refactor onTick logic, which is reconstructed verbatim from the
// pre-refactor source snapshot (no project-level git history existed before the
// baseline commit, so this reconstruction is the best available reference).
//
// See docs/strategy-parity-audit.md.

const { test } = require('node:test');
const assert = require('node:assert');
const emaCrossover = require('../src/strategy/emaCrossover');
const rsiEma = require('../src/strategy/rsiEma');

const PRICE_BUFFER_SIZE = 60;
const RSI_PERIOD = 14;
const EMA_FAST = 9;
const EMA_SLOW = 21;
const EMA_TREND = 50;

function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(prices, period) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

// ---- Pre-refactor reference: emaCrossover.onTick (verbatim logic) ----
// symState shape: { prices: [], lastCrossState: null } (matches createState()).
function oldEmaSignal(symState, close, warmup, hasPosition) {
  symState.prices.push(close);
  if (symState.prices.length > PRICE_BUFFER_SIZE) symState.prices.shift();
  const prices = symState.prices;
  if (prices.length < 21) return 'HOLD';
  const fastEma = calcEMA(prices, 9);
  const slowEma = calcEMA(prices, 21);
  if (fastEma === null || slowEma === null) return 'HOLD';
  const currentCross = fastEma > slowEma ? 'above' : 'below';
  const previousCross = symState.lastCrossState;
  symState.lastCrossState = currentCross;
  if (warmup) return 'HOLD';
  if (previousCross === 'below' && currentCross === 'above') {
    if (!hasPosition) return 'LONG';
  } else if (previousCross === 'above' && currentCross === 'below') {
    if (hasPosition) return 'CLOSE';
  }
  return 'HOLD';
}

// ---- Pre-refactor reference: rsiEma.onTick (verbatim logic) ----
// symState shape: { prices, rsiPrev, emaFastPrev, emaSlowPrev, lastSignal } etc.
function oldRsiSignal(symState, close, warmup, hasPosition) {
  symState.prices.push(close);
  if (symState.prices.length > PRICE_BUFFER_SIZE) symState.prices.shift();
  const prices = symState.prices;
  if (prices.length < Math.max(RSI_PERIOD + 1, EMA_TREND + 1)) return 'HOLD';
  const rsi = calcRSI(prices, RSI_PERIOD);
  const emaFast = calcEMA(prices, EMA_FAST);
  const emaSlow = calcEMA(prices, EMA_SLOW);
  const emaTrend = calcEMA(prices, EMA_TREND);
  symState.rsi = rsi;
  symState.emaFast = emaFast;
  symState.emaSlow = emaSlow;
  symState.emaTrend = emaTrend;
  if (warmup) { trackOld(symState, rsi, emaFast, emaSlow); return 'HOLD'; }

  const trendUp = close > emaTrend;
  const fastAboveSlow = emaFast > emaSlow;
  const rsiOversold = rsi < 35; // computed but unused by the entry condition
  const rsiRecovering = rsi > 40 && symState.rsiPrev !== null && symState.rsiPrev <= 40;
  const rsiWeakening = rsi < 60 && symState.rsiPrev !== null && symState.rsiPrev >= 60;

  let action = 'HOLD';
  if (!hasPosition && trendUp && fastAboveSlow && rsiRecovering && rsi < 55) {
    action = 'LONG';
    symState.lastSignal = 'LONG';
  }
  if (hasPosition) {
    const emaDeathCross = !fastAboveSlow && symState.emaFastPrev !== null && symState.emaFastPrev > symState.emaSlowPrev;
    const rsiTakeProfit = rsiWeakening && rsi > 65;
    if (emaDeathCross || rsiTakeProfit) {
      action = 'CLOSE';
      symState.lastSignal = 'CLOSE';
    }
  }
  trackOld(symState, rsi, emaFast, emaSlow);
  return action;
}

function trackOld(symState, rsi, emaFast, emaSlow) {
  symState.rsiPrev = rsi;
  symState.emaFastPrev = emaFast;
  symState.emaSlowPrev = emaSlow;
}

// Simulate a full sequence with the OLD reference, tracking an internal position.
function simulateOld(oldSignal, closes, { warmup = false } = {}) {
  const st = { prices: [], lastCrossState: null, rsiPrev: null, emaFastPrev: null, emaSlowPrev: null, lastSignal: null };
  const actions = [];
  let inPos = false;
  for (const c of closes) {
    const a = oldSignal(st, c, warmup, inPos);
    if (a === 'LONG') inPos = true;
    else if (a === 'CLOSE') inPos = false;
    actions.push(a);
  }
  return actions;
}

// Simulate a full sequence with the NEW computeSignal, tracking an internal position.
function simulateNew(adapter, closes, { warmup = false } = {}) {
  const st = adapter.createState();
  const actions = [];
  let inPos = false;
  for (const c of closes) {
    const a = adapter.computeSignal(st, c, { hasPosition: inPos, warmup });
    if (a.action === 'LONG') inPos = true;
    else if (a.action === 'CLOSE') inPos = false;
    actions.push(a.action);
  }
  return actions;
}

function lin(from, to, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(from + ((to - from) * (i + 1)) / n);
  return out;
}

const SEQUENCES = {
  flat: Array(120).fill(100),
  emaUpDown: [...Array(40).fill(100), ...lin(100, 130, 30), ...lin(130, 100, 30)],
  emaDownUp: [...Array(40).fill(100), ...lin(100, 70, 30), ...lin(70, 110, 30)],
  rsiUptrendPullbackRecovery: [
    ...Array(70).fill(100),
    ...lin(100, 112, 25),
    ...lin(112, 104, 8),
    ...lin(104, 112, 12),
    ...Array(10).fill(112),
    ...lin(112, 98, 20),
  ],
  zigzag: (() => {
    const s = [];
    for (let k = 0; k < 8; k++) s.push(...lin(100, 100 + (k % 2 ? -15 : 15), 15));
    return s;
  })(),
};

test('PARITY: emaCrossover old vs computeSignal — identical per-bar actions', () => {
  for (const [name, seq] of Object.entries(SEQUENCES)) {
    const oldActions = simulateOld(oldEmaSignal, seq);
    const newActions = simulateNew(emaCrossover, seq);
    assert.deepEqual(newActions, oldActions, `emaCrossover mismatch on "${name}"`);
  }
});

test('PARITY: rsiEma old vs computeSignal — identical per-bar actions', () => {
  for (const [name, seq] of Object.entries(SEQUENCES)) {
    const oldActions = simulateOld(oldRsiSignal, seq);
    const newActions = simulateNew(rsiEma, seq);
    assert.deepEqual(newActions, oldActions, `rsiEma mismatch on "${name}"`);
  }
});

test('PARITY: warmup path (real-time first batch) behaves identically', () => {
  const seq = SEQUENCES.rsiUptrendPullbackRecovery;
  // warmup=true for the first 60 bars (simulating the initial historical batch)
  const oldWarm = seq.map((c, i) => (i < 60 ? 'HOLD' : null));
  // simulate old with warmup true for first 60 bars
  const stOld = { prices: [], lastCrossState: null, rsiPrev: null, emaFastPrev: null, emaSlowPrev: null, lastSignal: null };
  const stNew = rsiEma.createState();
  const stNewEma = emaCrossover.createState();
  let inPosOld = false, inPosNew = false, inPosNewEma = false;
  const rsiNew = [], rsiOld = [], emaNew = [];
  for (let i = 0; i < seq.length; i++) {
    const w = i < 60;
    rsiOld.push(oldRsiSignal(stOld, seq[i], w, inPosOld));
    if (rsiOld[i] === 'LONG') inPosOld = true; else if (rsiOld[i] === 'CLOSE') inPosOld = false;

    const rn = rsiEma.computeSignal(stNew, seq[i], { hasPosition: inPosNew, warmup: w });
    rsiNew.push(rn.action);
    if (rn.action === 'LONG') inPosNew = true; else if (rn.action === 'CLOSE') inPosNew = false;

    const en = emaCrossover.computeSignal(stNewEma, seq[i], { hasPosition: inPosNewEma, warmup: w });
    emaNew.push(en.action);
    if (en.action === 'LONG') inPosNewEma = true; else if (en.action === 'CLOSE') inPosNewEma = false;
  }
  assert.deepEqual(rsiNew, rsiOld, 'rsiEma warmup parity');
});

// Golden master: lock the exact behavior of the current rsiEma on the verified
// reference sequence (LONG at bar 109, CLOSE at bar 130).
test('GOLDEN MASTER: rsiEma exact signal bars are locked', () => {
  const seq = SEQUENCES.rsiUptrendPullbackRecovery;
  const st = rsiEma.createState();
  const events = [];
  let inPos = false;
  for (let i = 0; i < seq.length; i++) {
    const r = rsiEma.computeSignal(st, seq[i], { hasPosition: inPos, warmup: false });
    if (r.action === 'LONG') { events.push(`LONG@${i}`); inPos = true; }
    else if (r.action === 'CLOSE') { events.push(`CLOSE@${i}`); inPos = false; }
  }
  assert.deepEqual(events, ['LONG@109', 'CLOSE@130']);
});

const { test } = require('node:test');
const assert = require('node:assert');
const emaCrossover = require('../src/strategy/emaCrossover');
const rsiEma = require('../src/strategy/rsiEma');

// Feed closes through a strategy's computeSignal, tracking an internal
// position so LONG/CLOSE gating behaves like the real engine.
function simulate(adapter, closes) {
  const state = adapter.createState();
  const events = [];
  let inPosition = false;
  closes.forEach((close, idx) => {
    const res = adapter.computeSignal(state, close, { hasPosition: inPosition, warmup: false });
    if (res.action === 'LONG') {
      events.push(`LONG@${idx}`);
      inPosition = true;
    } else if (res.action === 'CLOSE') {
      events.push(`CLOSE@${idx}`);
      inPosition = false;
    }
  });
  return events;
}

function lin(from, to, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(from + ((to - from) * (i + 1)) / n);
  return out;
}

// --- EMA Crossover (test case 4) ---
test('EMA strategy: golden cross produces LONG, death cross produces CLOSE', () => {
  const closes = [
    ...Array(40).fill(100),
    ...lin(100, 130, 30), // strong uptrend -> EMA9 crosses above EMA21
    ...lin(130, 100, 30), // strong downtrend -> EMA9 crosses below EMA21
  ];
  const events = simulate(emaCrossover, closes);
  assert.ok(events.some((e) => e.startsWith('LONG')), `expected a LONG, got: ${events}`);
  assert.ok(events.some((e) => e.startsWith('CLOSE')), `expected a CLOSE, got: ${events}`);
  assert.ok(events.findIndex((e) => e.startsWith('LONG')) < events.findIndex((e) => e.startsWith('CLOSE')));
});

test('EMA strategy: no signal with too few bars (warmup respected)', () => {
  const closes = Array(20).fill(100); // needs >= 21 closes
  const state = emaCrossover.createState();
  for (const c of closes) {
    const res = emaCrossover.computeSignal(state, c, { hasPosition: false, warmup: false });
    assert.equal(res.action, 'HOLD');
  }
});

// --- RSI + EMA (test case 5) ---
test('RSI EMA strategy: recovery from RSI < 40 in uptrend produces LONG, then CLOSE', () => {
  const closes = [
    ...Array(70).fill(100),
    ...lin(100, 112, 25), // established uptrend (price well above EMA50)
    ...lin(112, 104, 8),  // pullback pushes RSI below 40
    ...lin(104, 112, 12), // recovery: RSI crosses 40 while EMA9 > EMA21
    ...Array(10).fill(112),
    ...lin(112, 98, 20),  // sustained drop -> exit
  ];
  const events = simulate(rsiEma, closes);
  assert.ok(events.some((e) => e.startsWith('LONG')), `expected a LONG, got: ${events}`);
  assert.ok(events.some((e) => e.startsWith('CLOSE')), `expected a CLOSE, got: ${events}`);
});

test('RSI EMA strategy: no signal with too few bars', () => {
  const closes = Array(30).fill(100); // needs >= 51 closes
  const state = rsiEma.createState();
  for (const c of closes) {
    const res = rsiEma.computeSignal(state, c, { hasPosition: false, warmup: false });
    assert.equal(res.action, 'HOLD');
  }
});

// --- createState isolation (each run independent) ---
test('strategies: createState() produces independent state per run', () => {
  const a = emaCrossover.createState();
  const b = emaCrossover.createState();
  a.prices.push(1);
  assert.equal(b.prices.length, 0);
});

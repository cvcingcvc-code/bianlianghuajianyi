const { test } = require('node:test');
const assert = require('node:assert/strict');
const { H4, guard, aggregate } = require('../src/ethV2/data');
const { features, fit, predict } = require('../src/ethV2/model');
const { decide } = require('../src/research/strategies/ethPredictionV2');
const { Simulator } = require('../src/ethV2/simulator');
const { tradeEvaluation, forecastEvaluation } = require('../src/ethV2/evaluate');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { Controller } = require('../src/ethV2/controller');
const { createServer } = require('../src/ethV2/server');
const { parseArgs } = require('../scripts/eth-v2');
// Deterministic arithmetic fixtures, never used as market/research evidence.
const origin = Date.UTC(2021, 0, 1);
function training() { return Array.from({ length: 4300 }, (_, i) => ({ time: origin + i * H4, targetTime: origin + (i + 1) * H4, x: [i % 7 / 100, i % 11 / 100, 0.02, i % 3], y: (i % 9 - 4) / 1000 })); }
test('V2 rejects holdout times and incomplete aggregation', () => {
  assert.throws(() => guard(Date.UTC(2026, 0, 1)), /LOCKED/); assert.throws(() => aggregate([] .concat({ openTime: origin })), /Incomplete/);
});
test('V2 feature prefix invariant: future candles cannot change historical features', () => {
  const bars = Array.from({ length: 40 }, (_, i) => ({ closeTime: origin + (i + 1) * H4 - 1, close: 100 + i, volume: i + 1 }));
  assert.deepEqual(features(bars, 30), features(bars.slice(0, 31), 30));
  bars[35].close = 999999; assert.deepEqual(features(bars, 30), features(bars.slice(0, 31), 30));
});
test('V2 purges crossing labels and keeps scaling/calibration inside their own windows', () => {
  const data = training(), cutoff = origin + 4000 * H4, model = fit(data, cutoff);
  assert.ok(model); assert.ok(model.trainEnd < model.calibrationStart); assert.ok(model.calibrationEnd < cutoff);
  const poisoned = data.map(s => s.targetTime >= cutoff ? { ...s, y: 99, x: [99, 99, 99, 99] } : s);
  assert.deepEqual(fit(poisoned, cutoff), model);
  const p = predict({ ...data[4000], price: 100, regime: 'UP' }, model);
  assert.equal(p.up + p.down, 1); assert.ok(p.lower <= p.median && p.median <= p.upper);
  assert.equal(p.calibrated, true); assert.equal(predict(data[3999], model).status, 'INSUFFICIENT_DATA');
});
test('V2 fails closed for validated opening and insufficient expected edge', () => {
  const f = { status: 'AVAILABLE', calibrated: true, up: 0.7, median: 0.01, lower: -0.01, upper: 0.02, time: origin };
  assert.equal(decide(f, { validated: true, forecastGate: 'FAIL' }).reason, 'VALIDATION_NOT_PASSED');
  assert.equal(decide(f).side, 'LONG'); assert.equal(decide({ ...f, up: 0.3, median: -0.01 }).side, 'SHORT');
  assert.equal(decide({ ...f, median: 0.003 }).reason, 'EDGE_BELOW_FULL_COST_AND_MARGIN');
  assert.equal(decide(f, { complete: false }).reason, 'DATA_INCOMPLETE');
});

const step = 900000;
function bar(i, extra = {}) { return { openTime: origin + i * step, closeTime: origin + (i + 1) * step - 1, open: 100, high: 100.1, low: 99.9, close: 100, ...extra }; }
function opened(side = 'LONG') { const sim = new Simulator(); sim.step(bar(0)); sim.queue({ action: 'OPEN', side, time: bar(0).closeTime }); sim.step(bar(1)); return sim; }
function near(a, b) { assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`); }
for (const side of ['LONG', 'SHORT']) test(`V2 ${side}: next-bar entry, fees, funding and PnL reconcile`, () => {
  const sim = opened(side), p = structuredClone(sim.s.position), sign = side === 'LONG' ? 1 : -1;
  const rate = 0.001, markPrice = 101, time = bar(2).openTime + 2;
  sim.step(bar(2), [{ time, rate, markPrice, markTime: bar(2).openTime }]);
  near(sim.s.position.funding, -sign * p.quantity * markPrice * rate);
  sim.close(100.5, bar(2).closeTime, 'TEST');
  const t = sim.s.trades[0];
  near(t.gross - t.slippage - t.fees + t.funding, t.net);
  near(sim.s.cash, 10000 + t.net); assert.equal(sim.s.position, null); assert.equal(sim.assertLedger(), true);
});
for (const [side, prices, expected, ambiguous] of [
  ['LONG', { low: 98 }, 'STOP_LOSS', false], ['LONG', { high: 103 }, 'TAKE_PROFIT', false],
  ['SHORT', { high: 102 }, 'STOP_LOSS', false], ['SHORT', { low: 97 }, 'TAKE_PROFIT', false],
  ['LONG', { low: 98, high: 103 }, 'STOP_LOSS_AMBIGUOUS_BAR', true],
  ['SHORT', { low: 97, high: 102 }, 'STOP_LOSS_AMBIGUOUS_BAR', true],
]) test(`V2 protection ${side} ${expected}`, () => {
  const sim = opened(side); sim.step(bar(2, prices));
  assert.equal(sim.s.position, null); assert.equal(sim.s.trades[0].reason, expected);
  assert.equal(sim.s.trades[0].intrabarAmbiguous, ambiguous);
  const cash = sim.s.cash; sim.close(1, bar(2).closeTime, 'DUPLICATE'); sim.step(bar(2, prices));
  assert.equal(sim.s.cash, cash); assert.equal(sim.s.trades.length, 1);
});
for (const [side, open, low, high, reason] of [
  ['LONG', 95, 94, 96, 'STOP_LOSS'], ['LONG', 105, 104, 106, 'TAKE_PROFIT'],
  ['SHORT', 105, 104, 106, 'STOP_LOSS'], ['SHORT', 95, 94, 96, 'TAKE_PROFIT'],
]) test(`V2 gap ${side} ${reason} respects open price`, () => {
  const sim = opened(side); sim.step(bar(2, { open, low, high, close: open }));
  const fill = sim.s.ledger.at(-1); near(fill.basePrice, open); assert.equal(fill.reason, reason);
  assert.equal(fill.time, bar(2).openTime);
});
test('V2 no lookahead on queue, timeout and reverse exit at next open', () => {
  const sim = new Simulator(); sim.step(bar(0)); sim.queue({ action: 'OPEN', side: 'LONG', time: bar(0).closeTime });
  assert.equal(sim.s.position, null); assert.equal(sim.s.ledger.length, 0);
  sim.step(bar(1)); assert.equal(sim.s.position.entryTime, bar(1).openTime);
  sim.queue({ action: 'OPEN', side: 'SHORT', time: bar(1).closeTime }); sim.step(bar(2));
  assert.equal(sim.s.trades[0].reason, 'REVERSE_SIGNAL'); assert.equal(sim.s.position, null);
  const timeout = opened(); for (let i = 2; i <= 17; i++) timeout.step(bar(i));
  assert.equal(timeout.s.trades[0].reason, 'TIMEOUT'); assert.equal(timeout.s.trades[0].exitTime, bar(17).openTime);
});
test('V2 funding settlement alignment, negative rates, duplicate protection and conservative ambiguity', () => {
  const sim = opened(), p = sim.s.position, q = p.quantity;
  const event = { time: bar(2).openTime + 1, rate: -0.001, markPrice: 100 };
  sim.step(bar(2), [event, event]); near(sim.s.position.funding, q * 0.1);
  assert.equal(sim.s.ledger.filter(e => e.type === 'FUNDING').length, 1);
  sim.step(bar(3, { low: 98 }), [{ ...event, time: bar(3).openTime + 1 }]);
  assert.equal(sim.s.ledger.find(e => e.type === 'FUNDING' && e.time === bar(3).openTime + 1).amount, 0);
  assert.equal(sim.s.trades[0].funding, q * 0.1);
  const missing = opened(); missing.step(bar(2), [{ ...event, markPrice: null }]);
  assert.equal(missing.s.complete, false); assert.equal(missing.s.ledger.at(-1).amount, null);
  assert.throws(() => opened().step(bar(2), [{ ...event, time: bar(3).openTime }]), /outside/);
});
test('V2 exact-open funding applies to old position, never the new entry at that open', () => {
  const sim = new Simulator(); sim.step(bar(0)); sim.queue({ action: 'OPEN', side: 'LONG', time: bar(0).closeTime });
  sim.step(bar(1), [{ time: bar(1).openTime, rate: 0.01, markPrice: 100 }]);
  assert.equal(sim.s.position.funding, 0);
  sim.queue({ action: 'OPEN', side: 'SHORT', time: bar(1).closeTime });
  sim.step(bar(2), [{ time: bar(2).openTime, rate: 0.001, markPrice: 100 }]);
  assert.ok(sim.s.trades[0].funding < 0); assert.equal(sim.s.trades[0].reason, 'REVERSE_SIGNAL');
});
test('V2 restores position/pending/dedupe and rejects corrupted or foreign snapshots', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-v2-test-')), file = path.join(directory, 'session.json');
  const sim = opened(); sim.queue({ action: 'OPEN', side: 'SHORT', time: bar(1).closeTime }); sim.snapshot(file);
  const restored = Simulator.restore(file, { identity: 'test' });
  assert.equal(restored.queue({ action: 'OPEN', side: 'SHORT', time: bar(1).closeTime }), false);
  restored.step(bar(2)); sim.step(bar(2)); assert.deepEqual(restored.s, sim.s);
  assert.throws(() => Simulator.restore(file, { identity: 'different' }), /identity/);
  const bad = JSON.parse(fs.readFileSync(file)); bad.payload += ' '; fs.writeFileSync(file, JSON.stringify(bad));
  assert.throws(() => Simulator.restore(file, { identity: 'test' }), /checksum/);
  fs.unlinkSync(file); fs.rmdirSync(directory);
});
test('V2 end of replay closes once, clears orders, restores completed state and reconciles', () => {
  const sim = opened(); sim.finish(); const cash = sim.s.cash; sim.finish();
  assert.equal(sim.s.trades[0].reason, 'END_OF_REPLAY'); assert.equal(sim.s.position, null);
  assert.equal(sim.s.state, 'COMPLETED'); assert.equal(sim.step(bar(2)), false); assert.equal(sim.s.cash, cash);
  assert.equal(sim.assertLedger(), true);
});
test('V2 missing/no-trades/forecast-failure conclusions never become PASS', () => {
  assert.equal(tradeEvaluation({}, {}, {}, { status: 'PASS' }, false).status, 'INCOMPLETE');
  assert.equal(tradeEvaluation({ count: 0 }, {}, {}, { status: 'FAIL' }, true).status, 'NO_TRADES');
  assert.equal(forecastEvaluation([]).status, 'INSUFFICIENT_EVIDENCE');
});

function controllerFixture(file) {
  const shift = Date.UTC(2023, 0, 1) - origin;
  const candles = Array.from({ length: 32 }, (_, i) => { const c = bar(i); return { ...c, openTime: c.openTime + shift, closeTime: c.closeTime + shift }; });
  return { data: { candles, funding: { events: [], complete: false } }, predictions: [], sessionFile: file, identity: 'controller-test' };
}
test('V2 controller resumes exact cursor, pauses and completes without resetting the account', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-controller-')), file = path.join(dir, 'state.json');
  const options = controllerFixture(file), controller = new Controller(options);
  controller.advance(16); controller.pause();
  const next = new Controller(options);
  assert.equal(next.index, 16); assert.equal(next.status().state, 'PAUSED');
  next.advance(16); assert.equal(next.status().state, 'COMPLETED'); assert.equal(next.status().progress, 1);
  const restored = new Controller(options); restored.start();
  assert.equal(restored.timer, null); assert.equal(restored.status().processed, 32);
  fs.unlinkSync(file); fs.rmdirSync(dir);
});
test('V2 local API exposes Chinese page and safe start/pause/step operations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-api-')), file = path.join(dir, 'state.json');
  const controller = new Controller(controllerFixture(file)), server = createServer(controller, { forecast: { status: 'FAIL' } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = action => fetch(`${base}/api/${action}`, { method: 'POST', headers: { 'X-ETH-V2-Control': '1' } });
  try {
    const page = await fetch(base); assert.equal(page.status, 200); assert.match(await page.text(), /不是当前 ETH/);
    assert.equal((await fetch(`${base}/api/start`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${base}/api/start`, { method: 'POST', headers: { 'X-ETH-V2-Control': '1', Origin: 'https://example.org' } })).status, 403);
    assert.equal((await (await post('start')).json()).state, 'RUNNING');
    assert.equal((await (await post('pause')).json()).state, 'PAUSED');
    assert.equal((await (await post('step')).json()).processed, 16);
    assert.equal((await (await post('step')).json()).state, 'COMPLETED');
    assert.equal((await (await fetch(`${base}/api/report`)).json()).forecast.status, 'FAIL');
    assert.equal((await fetch(`${base}/api/live`, { method: 'POST', headers: { 'X-ETH-V2-Control': '1' } })).status, 404);
  } finally { controller.pause(); server.close(); await once(server, 'close'); fs.unlinkSync(file); fs.rmdirSync(dir); }
});
test('V2 order ledger records fills and cancels end-of-replay pending entry', () => {
  const sim = opened(); assert.equal(sim.s.orders[0].status, 'FILLED'); sim.close(100, bar(1).closeTime, 'TEST');
  sim.queue({ action: 'OPEN', side: 'SHORT', time: bar(1).closeTime }); sim.finish();
  assert.equal(sim.s.orders.at(-1).status, 'CANCELLED_END_OF_REPLAY'); assert.equal(sim.s.pending, null);
});
test('V2 CLI permits report creation dates but provides no data-range or holdout override', () => {
  assert.equal(parseArgs(['--serve', '--report', 'reports/eth-v2/2026-09-22/report.json']).report, 'reports/eth-v2/2026-09-22/report.json');
  assert.throws(() => parseArgs(['--unlock-holdout']), /Unsupported/);
  assert.throws(() => parseArgs(['--end', '2026']), /Unsupported/);
});

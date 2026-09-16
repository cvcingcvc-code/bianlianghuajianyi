const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SYMBOLS } = require('./contracts');
function loadReplay(directory = path.join(__dirname, '../../data/minimal-v1')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const candles = {};
  for (const symbol of SYMBOLS) {
    const file = `${symbol}-4h-2025-01.csv`;
    const bytes = fs.readFileSync(path.join(directory, file));
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[symbol].csvSha256) throw new Error('Demo CSV checksum mismatch');
    candles[symbol] = bytes.toString('utf8').trim().split(/\r?\n/).slice(1).map(line => {
      const r = line.split(',').map(Number);
      if (r[0] < Date.UTC(2025, 0, 1) || r[6] >= Date.UTC(2025, 1, 1)) throw new Error('Demo data outside approved development month');
      return { openTime: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5], closeTime: r[6] };
    });
  }
  return candles;
}
class Replay {
  constructor(adapter, pipeline, { intervalMs = 3000, candles = loadReplay() } = {}) {
    Object.assign(this, { adapter, pipeline, intervalMs, candles }); this.index = 0; this.stopped = false; this.complete = false;
  }
  async step(warmup = false) {
    for (const symbol of SYMBOLS) {
      const candle = this.candles[symbol][this.index];
      if (!candle) { this.complete = true; return false; }
      this.adapter.ingest(symbol, candle, { warmup }); await this.pipeline.queue;
    }
    this.index++; return true;
  }
  async start() {
    while (!this.stopped && this.index < 60) await this.step(true);
    // Deterministic chronological pre-roll to the first ETH fill, never cherry-pick a profitable result.
    while (!this.stopped && !this.complete && !this.adapter.fills.some(f => f.symbol === 'ETHUSDT')) await this.step(false);
    const tick = async () => {
      if (this.stopped) return;
      try { if (!await this.step()) return; }
      catch { this.pipeline.error = 'Replay failed'; return; }
      this.timer = setTimeout(tick, this.intervalMs);
    };
    if (!this.stopped && !this.complete) this.timer = setTimeout(tick, this.intervalMs);
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
}
module.exports = { loadReplay, Replay };

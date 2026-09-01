// STRATEGY RESEARCH V4 — Candidate A: BREAKOUT_24H_1H.
// 24-calendar-hour breakout trend on 1h candles (windowBars = 24). Same
// hypothesis as the frozen V3A breakout24hTrend, on a 1h decision scale.

const { createBreakout24h } = require('./breakout24hFactory');

module.exports = createBreakout24h({ windowBars: 24, name: 'breakout24h1h' });

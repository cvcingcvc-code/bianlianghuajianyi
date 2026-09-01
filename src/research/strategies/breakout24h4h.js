// STRATEGY RESEARCH V4 — Candidate B: BREAKOUT_24H_4H.
// 24-calendar-hour breakout trend on 4h candles (windowBars = 6). Same
// hypothesis as the frozen V3A breakout24hTrend, on a 4h decision scale.

const { createBreakout24h } = require('./breakout24hFactory');

module.exports = createBreakout24h({ windowBars: 6, name: 'breakout24h4h' });

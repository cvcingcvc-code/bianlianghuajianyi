# Final Holdout Protocol V1 — Preregistration

> Preregistered: 2026-09-01. Candidate Freeze SHA: 2e866b3.
> Status: PREREGISTERED — EXECUTION BLOCKED BY DATA INTEGRITY

## Candidate

- Strategy: `breakout24h4h`
- Freeze SHA: `2e866b3fd4f0b38f0570ab31c9dfc77e1030c5a8`
- Timeframe: 4h
- windowBars: 6
- EMA: 50 (trend filter), 9/21 (exit cross)

## Assets

- BTCUSDT
- ETHUSDT
- BNBUSDT
- SOLUSDT

## Holdout Period

- Start: 2026-01-01T00:00:00.000Z
- End: **TO BE DETERMINED** (pending data availability)
- Current blocker: BNB/SOL have no 2026 kline data; no asset has 2026 funding data

## Parameters

- positionSizePct: 0.25 (25%)
- leverage: <=1x (no leverage)
- initialCapital: 10000

## Cost Scenarios

### PRIMARY: BASE_REAL_FUNDING
- commissionPct: 0.0004
- slippagePct: 0.0002
- funding: REAL HISTORICAL (data.binance.vision)

### SECONDARY: STRESS_REAL_FUNDING
- commissionPct: 0.0006
- slippagePct: 0.0005
- funding: REAL HISTORICAL (data.binance.vision)

## Strategy Rules

### LONG Entry
- close > EMA50
- EMA50 slope > 0
- close > max(previous 6 completed 4h highs)
- Current candle NOT in breakout lookback
- Signal: 4h candle close confirmation
- Execution: next 4h candle open

### EXIT
- EMA9/EMA21 death cross: emaFastPrev > emaSlowPrev AND emaFastNow < emaSlowNow
- Execution: next 4h open

### Funding
- Real Binance historical funding from data.binance.vision
- Source must be: BINANCE_DATA_VISION_OFFICIAL_ARCHIVE
- Synthetic/mock/fixture funding: REJECTED

## Gates (Preregistered)

### PRIMARY AGGREGATE GATE
- Pooled NetExpectancy > 0
- Pooled NetPF > 1.05
- Pooled Sharpe > 0

### ASSET BREADTH GATE
- >= 3/4 assets with NetExpectancy > 0 AND NetPF > 1.00

### STRESS GATE
- STRESS Pooled NetExpectancy >= 0
- STRESS Pooled NetPF >= 1.00

### SAMPLE SIZE GATE
- If total trades < 50: mark LOW FINAL HOLDOUT SAMPLE, result = INCONCLUSIVE
- If total trades >= 50: use normal gates

### CATASTROPHIC INCONSISTENCY
- Report any single asset with extreme negative result
- Do not hide behind pooled results

## Reports to Generate

- reports/final-holdout-v1/FINAL_HOLDOUT_REPORT.md
- reports/final-holdout-v1/DATA_INTEGRITY.md
- reports/final-holdout-v1/ASSET_RESULTS.md
- reports/final-holdout-v1/FUNDING_RESULTS.md
- reports/final-holdout-v1/HOLDOUT_VS_PRIOR_EVIDENCE.md

## Prohibitions

- Do NOT modify strategy code or parameters
- Do NOT add filters, stops, or trailing stops
- Do NOT optimize parameters
- Do NOT use leverage
- Do NOT trade live
- Do NOT run partial holdout (all 4 assets must be included)

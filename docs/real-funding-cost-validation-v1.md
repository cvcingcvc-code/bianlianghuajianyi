# Real Funding Cost Validation V1 — Preregistration

> This document preregister ALL gate criteria, data sources, formulas, and rules
> BEFORE any funding-adjusted results are computed. Once committed, these criteria
> CANNOT be weakened. If a candidate fails, it fails.

## 1. Research Question

加入 Binance USD-M 永续合约真实历史 Funding 后，冻结的 `breakout24h4h` 历史 edge 是否仍然成立？

## 2. Frozen Candidate

- **Strategy**: `breakout24h4h` — 4h timeframe, 24-calendar-hour close > prior 6-bar-high breakout + EMA50 trend filter, exit on EMA9/21 death cross
- **Code**: `src/research/strategies/breakout24h4h.js` (windowBars=6)
- **Candidate Freeze SHA**: `2e866b3fd4f0b38f0570ab31c9dfc77e1030c5a8`
- **Preregistration SHA (V4)**: `59578e98f64446350db3c603896d243bc8b7d214`
- **External Validation Result SHA**: `eab2a781789403f2ba84970d542d654b9a811ebf`

## 3. Assets

| Asset | Data Range | Source |
| --- | --- | --- |
| BTCUSDT | 2021-01-01 → 2025-12-31 | Official Binance USD-M 15m + fundingRate |
| ETHUSDT | 2021-01-01 → 2025-12-31 | Official Binance USD-M 15m + fundingRate |
| BNBUSDT | 2020-02-10 → 2025-12-31 | Official Binance USD-M 15m + fundingRate |
| SOLUSDT | 2020-09-14 → 2025-12-31 | Official Binance USD-M 15m + fundingRate |

## 4. Historical Date Limits

- Max evaluation date: `2025-12-31T23:59:59Z`
- 2026 = FINAL HOLDOUT = **LOCKED**
- Funding data must NOT contain any event at/after 2026-01-01

## 5. Funding Data Source

- **API**: Binance USD-M Futures `GET /fapi/v1/fundingRate`
- **Fields**: `symbol`, `fundingTime`, `fundingRate`, `markPrice` (if provided), `rateType` (if provided)
- **Pagination**: `startTime`, `endTime`, `limit` (1000 per page)
- **Boundary rule**: next `startTime` = last `fundingTime + 1` (no duplicates)
- **No synthesis**: Do NOT generate funding events every 8h. Use only actual API-returned `fundingTime`.
- **Storage**: `data/funding/<SYMBOL>-funding.csv` (git-ignored)

## 6. Funding Payment Formula

Current strategy: LONG only.

```
fundingCashflow = quantity × markPriceAtFunding × fundingRate
```

- `fundingRate > 0` → LONG pays → cashflow < 0
- `fundingRate < 0` → LONG receives → cashflow > 0
- **Never** use `Math.abs(fundingRate)`
- **Never** treat all funding as a cost

## 7. Funding Timestamp Semantics (Ownership Rule)

Strict, conservative rule:

```
entryTime < fundingTime AND fundingTime < exitTime
```

- `entryTime == fundingTime` → NOT counted
- `exitTime == fundingTime` → NOT counted
- Boundary equality excludes the position from that funding event

This rule is LOCKED and must be tested.

## 8. Mark Price Source

**Priority**:
1. `markPrice` from the funding rate API response (DIRECT)
2. If missing/invalid: Binance `markPriceKlines` fallback — only the mark price at or before `fundingTime` (NEVER future)
3. If no reliable mark price available: `FUNDING_MARK_PRICE_MISSING` → asset CANNOT pass

Each event records: `markPriceSource = 'DIRECT' | 'FALLBACK'`

## 9. Missing Data Policy

- **Never**: assume missing funding = 0
- **Never**: silently continue with incomplete data
- If any asset's funding history is incomplete for a position's held period: `FUNDING DATA INCOMPLETE` → asset CANNOT pass gate

## 10. Cost Scenarios

| Scenario | Commission | Slippage | Funding |
| --- | --- | --- | --- |
| GROSS_NO_FUNDING | 0 | 0 | 0 |
| BASE_NO_FUNDING | 0.0004 | 0.0002 | 0 |
| BASE_REAL_FUNDING | 0.0004 | 0.0002 | historical |
| STRESS_REAL_FUNDING | 0.0006 | 0.0005 | historical |

Position size: 25% (`positionSizePct = 25`)
Initial capital: 10000

## 11. Funding-Adjusted Survival Gate

### 11a. Four-Asset Aggregate Gate (BASE_REAL_FUNDING)

Each asset MUST pass ALL:
- NetExpectancy > 0%
- NetPF > 1.05
- Sharpe > 0

ALL four assets (BTC, ETH, BNB, SOL) must pass.

### 11b. Stress + Funding Gate (STRESS_REAL_FUNDING)

Each asset MUST pass ALL:
- NetExpectancy >= 0%
- NetPF >= 1.0

### 11c. Year Consistency

All complete asset-year buckets: >= 60% must have BASE_REAL_FUNDING NetExpectancy > 0.

### 11d. Edge Preservation

If any asset's BASE_REAL_FUNDING NetExpectancy drops to <= 0 (where BASE_NO_FUNDING was > 0):

**FUNDING DESTROYS EDGE → DIRECT FAIL**

## 12. Funding Impact Classification

```
abs(netFunding) / abs(netTradingPnlBeforeFunding)
```

| Classification | Ratio |
| --- | --- |
| NEGLIGIBLE | < 10% |
| MODERATE | 10-30% |
| MATERIAL | 30-50% |
| SEVERE | > 50% |
| UNSTABLE RATIO | denominator near 0 |

## 13. Funding Concentration Diagnostic

- Top 5 funding-cost trades / total funding paid
- If > 50%: `HIGH FUNDING CONCENTRATION` (P1 diagnostic, not automatic fail)

## 14. 2026 Holdout Policy

- 2026 data = LOCKED
- Funding data must NOT contain any event at/after 2026-01-01
- `--unlock-holdout` is FORBIDDEN
- If code attempts to access 2026 data: `FINAL HOLDOUT IS LOCKED`

## 15. Report Outputs

- `reports/funding-v1/REAL_FUNDING_COST_VALIDATION_REPORT.md`
- `reports/funding-v1/FUNDING_DATA_QUALITY.md`
- `reports/funding-v1/BEFORE_AFTER_FUNDING.md`
- `reports/funding-v1/FUNDING_IMPACT_BY_YEAR.md`

## 16. Final Verdict

Only two allowed conclusions:
- `REAL FUNDING VALIDATION SURVIVED — READY FOR FINAL HOLDOUT PROTOCOL`
- `REAL FUNDING VALIDATION FAILED — FINAL HOLDOUT NOT JUSTIFIED`

**Forbidden conclusions**: "可以实盘", "稳定盈利", "保证赚钱"

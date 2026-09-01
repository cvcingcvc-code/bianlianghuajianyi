# FINAL HOLDOUT REPORT V1

> Generated: 2026-09-01. Candidate Freeze SHA: 2e866b3.

## VERDICT: FINAL HOLDOUT INCONCLUSIVE — DATA INTEGRITY FAILED

The Final Holdout Protocol V1 could not be executed because **2026 kline data does not exist for BNBUSDT and SOLUSDT** on data.binance.vision, and 2026 monthly klines are not available on data.binance.vision for any asset.

## Data Availability Summary

| Asset | 15m Kline Range | 2026 Rows | 2026 Funding | Status |
|-------|----------------|-----------|-------------|--------|
| BTCUSDT | 2021-01-01 → 2026-07-31 | 20,352 | 0 events | KLINE OK, FUNDING MISSING |
| ETHUSDT | 2021-01-01 → 2026-07-31 | 20,352 | 0 events | KLINE OK, FUNDING MISSING |
| BNBUSDT | 2020-02-10 → 2025-12-31 | 0 | 0 events | NO 2026 DATA |
| SOLUSDT | 2020-09-14 → 2025-12-31 | 0 | 0 events | NO 2026 DATA |

## Data Integrity Gate: FAILED

| Check | BTC | ETH | BNB | SOL | Overall |
|-------|-----|-----|-----|-----|---------|
| 15m Kline exists | PASS | PASS | FAIL | FAIL | **FAIL** |
| 2026 kline rows > 0 | PASS | PASS | FAIL | FAIL | **FAIL** |
| 2026 funding events > 0 | FAIL | FAIL | FAIL | FAIL | **FAIL** |
| Missing bars = 0 | PASS | PASS | N/A | N/A | N/A |
| Duplicate bars = 0 | PASS | PASS | N/A | N/A | N/A |
| Funding provenance official | N/A | N/A | N/A | N/A | N/A |
| Synthetic funding = 0 | PASS | PASS | PASS | PASS | PASS |

## Root Cause

1. **data.binance.vision** does not publish 2026 monthly klines (404 for all assets)
2. **BNBUSDT and SOLUSDT** have no 2026 kline data from any source
3. **All 4 assets** have zero 2026 funding events (funding archives end at 2025-12-31)
4. BTC/ETH have 2026 kline data (from prior Binance API download) but cannot be used alone

## COMMON_FINAL_HOLDOUT_END

- Latest 15m kline across 4 assets: **2025-12-31T23:45:00Z** (BNB/SOL limit)
- Latest funding across 4 assets: **2025-12-31T16:00:00Z**
- COMMON_FINAL_HOLDOUT_END: **2025-12-31T23:59:59.999Z**
- FINAL_HOLDOUT_START: **2026-01-01T00:00:00.000Z**
- **END < START → No valid holdout period exists**

## Protocol Compliance

Per Final Holdout Protocol V1, Section 5 (Data Integrity Gate):

> 如果任一资产失败：不要打开 Holdout。输出：FINAL HOLDOUT DATA INTEGRITY FAILED

Per Section 3:

> 要求：所有资产都拥有完整数据。不要为了多使用几天数据让不同资产使用不同截止日。

## What Would Be Needed

To execute the Final Holdout, the following data must become available on data.binance.vision:

1. **BNBUSDT 15m klines** for 2026-01 through 2026-07 (monthly ZIPs)
2. **SOLUSDT 15m klines** for 2026-01 through 2026-07 (monthly ZIPs)
3. **All 4 assets funding rates** for 2026-01 through 2026-07 (monthly ZIPs)

When these archives are published, the Final Holdout can be re-executed.

## Recommendation

The candidate `breakout24h4h` **remains unvalidated for 2026**. It has NOT passed or failed the Final Holdout — the test could not be run due to data constraints. The candidate status is:

**PENDING — 2026 HOLDOUT NOT CONSUMED**

The candidate cannot be marked as "survived" or "rejected" because the holdout was never executed.

## Prior Evidence (Historical Context Only)

These results are for reference only. They do NOT constitute holdout validation.

| Stage | Assets | NetPF | Sharpe | Status |
|-------|--------|-------|--------|--------|
| Development | BTC/ETH | 1.39 | 0.70 | PASSED |
| External Validation | BNB/SOL | 2.64 / 1.99 | 1.26 / 1.17 | PASSED |
| Real Funding | BTC/ETH/BNB/SOL | 1.23 / 1.10 / 1.92 / 1.53 | 0.48 / 0.26 / 1.21 / 1.09 | PASSED |
| Final Holdout 2026 | ALL | N/A | N/A | **NOT EXECUTED** |

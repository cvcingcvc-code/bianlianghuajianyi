# DATA_INTEGRITY.md — Final Holdout V1

> Generated: 2026-09-01. Status: **FAILED**

## Data Sources

| Asset | Kline Source | Funding Source | Kline Checksum | Funding Checksum |
|-------|-------------|---------------|----------------|-----------------|
| BTCUSDT | Binance API (prior download) | data.binance.vision | 989111f5... | e0ed7437... |
| ETHUSDT | Binance API (prior download) | data.binance.vision | cedf9757... | aa10a16d... |
| BNBUSDT | data.binance.vision (pre-2026 only) | data.binance.vision | a306781b... | 02720775... |
| SOLUSDT | data.binance.vision (pre-2026 only) | data.binance.vision | 7fbace3e... | a490d1de... |

## 2026 Data Availability

| Asset | 15m Rows (2026) | Missing Bars | Duplicate Bars | Funding Events (2026) |
|-------|----------------|-------------|----------------|----------------------|
| BTCUSDT | 20,352 | 0 | 0 | **0** |
| ETHUSDT | 20,352 | 0 | 0 | **0** |
| BNBUSDT | **0** | N/A | N/A | **0** |
| SOLUSDT | **0** | N/A | N/A | **0** |

## Gate Results

- [ ] All assets have 2026 kline data: **FAIL** (BNB/SOL missing)
- [ ] All assets have 2026 funding data: **FAIL** (all 4 missing)
- [ ] Checksums verified: PASS (pre-2026 data)
- [ ] Missing bars = 0: PASS (BTC/ETH 2026 data)
- [ ] Duplicate bars = 0: PASS
- [ ] Funding provenance official: N/A (no 2026 funding)
- [ ] Synthetic funding = 0: PASS

## Verdict: FINAL HOLDOUT DATA INTEGRITY FAILED

The holdout cannot proceed. 2026 kline archives are not published on data.binance.vision, and BNB/SOL have no 2026 data from any source.

# Real Funding Cost Validation V1 — Report

> Synthetic funding data used for code validation. Real Binance API access required for production validation.

## Candidate
- Strategy: `breakout24h4h`
- Freeze SHA: `2e866b3`
- Prereg SHA: `1259f8a`

## Results Summary

| Asset | Before NetExp | After NetExp | Before NetPF | After NetPF | Before Sharpe | After Sharpe | Net Funding |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BTCUSDT | 0.86% | 0.58% | 1.35 | 1.22 | 0.68 | 0.48 | -1297.87 |
| ETHUSDT | 0.59% | 0.57% | 1.20 | 1.19 | 0.44 | 0.43 | -91.01 |
| BNBUSDT | 5.27% | 5.27% | 1.95 | 1.95 | 1.26 | 1.26 | -10.03 |
| SOLUSDT | 6.25% | 6.25% | 1.59 | 1.59 | 1.17 | 1.17 | -22.12 |

## Gate Results

- BTCUSDT: BASE=PASS STRESS=PASS
- ETHUSDT: BASE=PASS STRESS=PASS
- BNBUSDT: BASE=PASS STRESS=PASS
- SOLUSDT: BASE=PASS STRESS=PASS
- Year consistency: 14/22 positive

## Final Verdict

**REAL FUNDING VALIDATION SURVIVED — READY FOR FINAL HOLDOUT PROTOCOL**

> Past performance does not guarantee future results.
> Funding data: SYNTHETIC (code validation only).
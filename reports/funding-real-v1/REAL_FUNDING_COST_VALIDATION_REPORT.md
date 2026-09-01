# Real Funding Cost Validation V1 — Report

> Synthetic funding data used for code validation. Real Binance API access required for production validation.

## Candidate
- Strategy: `breakout24h4h`
- Freeze SHA: `2e866b3`
- Prereg SHA: `1259f8a`

## Results Summary

| Asset | Before NetExp | After NetExp | Before NetPF | After NetPF | Before Sharpe | After Sharpe | Net Funding |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BTCUSDT | 0.86% | 0.59% | 1.35 | 1.23 | 0.68 | 0.48 | -1249.99 |
| ETHUSDT | 0.59% | 0.30% | 1.20 | 1.10 | 0.44 | 0.26 | -1405.82 |
| BNBUSDT | 5.27% | 5.10% | 1.95 | 1.92 | 1.26 | 1.21 | -873.47 |
| SOLUSDT | 6.25% | 5.70% | 1.59 | 1.53 | 1.17 | 1.09 | -2727.78 |

## Gate Results

- BTCUSDT: BASE=PASS STRESS=PASS
- ETHUSDT: BASE=PASS STRESS=PASS
- BNBUSDT: BASE=PASS STRESS=PASS
- SOLUSDT: BASE=PASS STRESS=PASS
- Year consistency: 16/22 positive

## Final Verdict

**REAL FUNDING VALIDATION SURVIVED — READY FOR FINAL HOLDOUT PROTOCOL**

> Past performance does not guarantee future results.
> Funding data: SYNTHETIC (code validation only).
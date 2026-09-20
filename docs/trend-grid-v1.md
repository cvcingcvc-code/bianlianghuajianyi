# ETH trend-conditioned grid V1

## Scope and preregistration — 2026-09-20

The user's request authorizes a separate new trend/grid candidate. Frozen V4 code,
its validation claims, execution adapters and cost assumptions remain unchanged.
This candidate is research/paper only. No 2026 data, credentials or exchange orders.
Existing uncommitted paper-10u-15x work is outside this change.

## Selected hypothesis (fixed before results)

Use a trend-conditioned empirical forward-return distribution, not an extrapolated
price line. At every closed ETH 15m bar, classify the last 96 log returns by
24h return / (RMS return * sqrt(96)): below -1 = down, above +1 = up, otherwise flat.
For each state, learn separate distributions of actual subsequent 2-bar (30m)
and 672-bar (one week) log returns. Only labels whose endpoint has already closed
can enter training. Train on non-overlapping horizon-aligned origins to avoid
counting overlapping weekly labels as independent observations. Minimum 30 mature
labels per state/horizon. Report empirical up probability, median, 10/90 percentiles,
sample count and exact forecast/target times. These are uncalibrated empirical
estimates until chronological evaluation passes; no guaranteed prediction.

## Data and chronological evaluation

All 60 official data.binance.vision ETHUSDT 15m monthly archives, 2021-01 through
2025-12, verified against published CHECKSUMs. Reject missing, duplicate, unordered,
invalid or incomplete bars. 2021-2022 is initial training. Evaluate 2023, 2024, 2025
with expanding past-only training, non-overlapping test origins per horizon.
No random split, future normalization, parameter sweep or rescue after failure.
Compare Brier score with the contemporaneous unconditional mature-label probability;
compare absolute median-return error with zero-return persistence. Record 80% band
coverage, availability, each year and pooled scores. Both horizons must have >=100
forecasts overall, >=20 per year, >=80% availability, strictly lower Brier and MAE
than their baselines overall and in each year, and overall coverage in [0.70,0.90].
Failure disables the validated opening gate; insufficient evidence is not PASS.

## Paper grid policy

Weekly and 30m up probabilities both >=0.60 select LONG; both <=0.40 select SHORT;
otherwise wait. Weekly direction is a regime filter, not a week-long price promise.
Use the 30m return band's price bounds, expanded to include spot. Four geometric
grid intervals. Require each interval's gross return to exceed STRESS round-trip
commission/slippage (2*(0.0006+0.0005)). Default virtual capital 1000 USDT,
1x notional cap, at most 25% capital allocated, four equal maximum entry lots.
Grid expires after 30 minutes; no stacking/recentering active grids. Stop on range
escape, expiry or contrary/uncertain signal. A decision at close N can only activate
or close at open N+1. Stops take precedence over intrabar fills, adverse gap price
is respected, and no entry plus take-profit for the same lot in the same bar.
No live adapter exists in this module. Exploratory paper simulation can run even
when the forecast gate fails, but must prominently label results UNVALIDATED and
must not claim profitability or enable validated automatic opening.

BASE fees/slippage remain 0.0004/0.0002; STRESS 0.0006/0.0005. Any grid PnL without
verified real funding and mark prices is incomplete and cannot establish net edge.
Before live eligibility: separate frozen execution validation including funding,
exchange filters, liquidation/margin, latency and untouched prospective paper data.
Historical 2021-2025 data was used previously in this repository; this is chronological
development evidence, not a pristine final holdout. No current ETH forecast is supplied.

## References

- https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html
- https://www.binance.com/en/support/faq/detail/904e47602a3941b99e960a31e152a986

# Strategy V4 Hypotheses（docs/strategy-v4-hypotheses.md）

> 预注册文件。STRATEGY RESEARCH V4 — TIMEFRAME & LOW-TURNOVER TREND。
> 本文件冻结并 commit 后，才允许运行任何候选历史收益。

## Research Question

"15m 趋势策略的 edge 是否因为决策时间尺度过短，导致**单笔行情幅度与交易成本处于同一数量级**？
若在更高 timeframe（1h / 4h）上以**相同市场假设**（24 小时突破）决策，能否：
减少微噪声、减少 whipsaw、降低年换手、提高平均持仓时长、提高平均 move size、提高 gross edge / cost 比？"

> 这是待验证假设，不预设结果。

## 数据纪律（V4）

- **DEVELOPMENT DATA**：2021-01-01 → 2025-12-31。
- **FINAL HOLDOUT**：2026-01-01 → 2026-07-31，**LOCKED**，本轮禁止访问任何 2026 candle 用于候选结果。
- 禁止：`--unlock-holdout`、实盘、API key、杠杆、做空、ML、自动优化、Grid/Random Search、参数扫描、按结果改规则、扫描几十种 timeframe。
- 本轮**只测试 1h 和 4h**；不得加入 30m/2h/3h/6h/8h/12h 后选最好。

## Resampling（唯一数据源）

- 从已验证的 Binance 官方 15m（2021-2026-07）聚合：**1h = 4×15m，4h = 16×15m**，严格 UTC 对齐（`floor(ts/targetMs)`）。
- OHLCV：`open=first.open, high=max, low=min, close=last.close, volume=sum`；timestamp = 窗口第一根 15m 的 open_time。
- 禁止未来窗口、禁止跨缺口聚合、禁止用不完整窗口静默生成 candle → **不完整窗口 discard + warning**。
- 禁止使用任何第三方/未知历史数据。

## Candidate A — BREAKOUT_24H_1H

- **Timeframe**: 1h（resampled）。
- **Exact Entry**（仅空仓）: `close > EMA50` AND `EMA50 slope > 0`（ema50_t > ema50_{t-1}）AND `close > previous24hHigh`。
- **previous24hHigh**（1h）: 过去 **24 根完整 1h candle** 的 high 最大值 = `max(high[t-24 .. t-1])`，**绝不含 current candle**。
- **Execution**: 产生 LONG 后，**下一根 1h open** 模拟成交。
- **Exact Exit**: `emaFastPrev > emaSlowPrev` AND `emaFastNow < emaSlowNow`（EMA9/21 death cross）→ CLOSE，**下一根 1h open** 成交。
- **Known Data at Signal Time**: 当前 close + 前 24 根已完成的 high + EMA（均已知）。

## Candidate B — BREAKOUT_24H_4H

- **Timeframe**: 4h（resampled）。
- 规则与 Candidate A **完全相同**，指标与信号全部在 4h candle 上计算。
- **previous24hHigh**（4h）: 过去 **6 根完整 4h candle** 的 high 最大值 = `max(high[t-6 .. t-1])`，**绝不含 current candle**。
- **Execution**: LONG/CLOSE 均在**下一根 4h open** 成交。

## 指标周期换算纪律

EMA9 / EMA21 / EMA50 一律按 **bars** 在各 timeframe 上计算（9/21/50 bars）。
**禁止**为等价 15m 物理时间换算成 EMA36/EMA84/EMA200 —— 本轮研究"完整策略在不同决策尺度上的行为"，不是保持指标物理时间长度。

## Baseline（V3A_REFERENCE）

同时运行已冻结的 **15m `breakout24hTrend`**（V3A 实现，不得重新定义）作为参考，比较 15m/1h/4h。

## 统一资金与成本

- `positionSizePct = 0.25` 固定；`leverage ≤ 1x`（禁止隐式杠杆）；`initialCapital = 10000`。
- 成本：GROSS(0/0)、BASE(0.0004/0.0002)、STRESS(0.0006/0.0005)；**FUNDING NOT INCLUDED**。
- 若候选连 Base/Stress 都过不了，未来才考虑接 Funding。

## Evaluation

Anchored Walk Forward：Fold1 context 2021-2022→eval 2023；Fold2 2021-2023→eval 2024；Fold3 2021-2024→eval 2025。
BTC + ETH ⇒ 每候选 6 个 evaluation buckets（BTC2023/24/25, ETH2023/24/25）。

## Survival Gate（V4 提高）

BASE：`NetExpectancyPct > 0` AND `NetPF > 1.05` AND `Sharpe > 0`；
STRESS：`NetExpectancyPct >= 0` AND `NetPF >= 1.00`；
至少 `4/6` buckets BASE NetExpectancy > 0；BTC aggregate > 0 且 ETH aggregate > 0（否则 **CROSS-ASSET INCONSISTENT**）。
`Trade Count < 100` → **LOW SAMPLE**。
另检查 Edge Margin：BASE 净 edge 若仅 +0.00x%，标 **MARGINAL EDGE**，不得称为 robust。

## Forbidden Changes

不得：改 breakout window（24h 概念固定）、改 EMA 参数、改 exit、加 indicator、加 2h/6h/8h、改 position size、改成本模型、按结果修规则。
若全败 → **NO TIMEFRAME CANDIDATE SURVIVED**，任何后续方向属于新 preregistered research。

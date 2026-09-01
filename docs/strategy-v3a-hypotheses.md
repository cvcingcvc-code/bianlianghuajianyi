# Strategy V3A Hypotheses（docs/strategy-v3a-hypotheses.md）

> 预注册文件。本阶段只研究 **ENTRY QUALITY**，EXIT 固定为原始 `emaCrossover` 的
> **EMA9/21 death cross**（绝不改变退出，从而隔离 entry 的真实效果）。
> 本文件冻结并 commit 后，才允许运行任何候选历史测试（Rolling Walk-Forward）。
> **不得**在看过结果后修改本文件。

## 数据纪律（V3A）

- **DEVELOPMENT DATA**：2021-01-01 → 2025-12-31（2024-2025 已在 V2 观察过，不再称为 unseen/independent）。
- **FINAL HOLDOUT**：2026-01-01 → 2026-07-31，保持 **LOCKED**；本轮禁止 `--unlock-holdout`。
- 禁止：grid/random/auto 调参、EMA/RSI 参数扫描、ML、AI 预测、做空、杠杆、实盘、修改数据、删除亏损交易、同时改 entry+exit。

---

## Candidate A — EMA_CONFIRMATION

- **Name**: `emaConfirmation`
- **Market Hypothesis**: 裸 EMA 金叉在震荡中常"刚金叉就反转"。用一根确认 K 线过滤这种噪声。
- **Exact Entry**: 检测到 EMA9 bullish crossover EMA21 时**不买**；记录 crossover candle 的 `high`；
  等待**下一根完整 K 线**，仅当该 K 线收盘时满足 `EMA9 > EMA21` 且 `close > crossoverHigh` → 产生 LONG 信号（下一根 open 成交）。
- **Exact Exit**: EMA9 death cross EMA21（与 baseline 完全一致）。
- **Known Data at Signal Time**: 确认 K 线的 close + 历史 EMA9/21 + crossover 那根的 high（均已知）。
- **Expected Improvement**: 过滤"金叉即反转"，降低 <=24 bars 短命亏损交易比例。
- **Expected Failure Mode**: 确认后追价抬高了入场价，吞噬 edge；或确认过滤掉真正趋势的第一段。
- **Forbidden Parameter Changes**: 不允许改变确认窗口长度 / high 判定方式 / EMA 周期。

## Candidate B — TREND_PULLBACK_RECLAIM

- **Name**: `trendPullbackReclaim`
- **Market Hypothesis**: 已确立的上涨趋势中，"回踩后重新站上短均线"的入场质量优于"追金叉"。
- **Exact Entry**（仅空仓）: `close > EMA50` AND `EMA50 slope > 0` AND `EMA9 > EMA21`，
  AND 前一 bar `close <= EMA9(prev)`（回踩）AND 当前 bar `close > EMA9`（重新站上）→ LONG（下一根 open）。
- **Exact Exit**: EMA9/21 death cross。
- **Known Data at Signal Time**: 当前 close + 前一根 close + EMA9/21/50 当前与前一根（均已知）。
- **Expected Improvement**: 在趋势中低吸而非追高，减少入场即逆势；持仓更长、MAE 更小。
- **Expected Failure Mode**: 回踩信号在震荡中频繁出现；或趋势内回踩后继续下破导致亏损。
- **Forbidden Parameter Changes**: 不得添加 ATR/RSI/volume 阈值；不得改 EMA 周期。

## Candidate C — 24H_BREAKOUT_TREND

- **Name**: `breakout24hTrend`
- **Market Hypothesis**: 价格突破前 24h 高点（且处于趋势中）比"均线交叉"更能捕捉真实趋势启动。
- **Exact Entry**（仅空仓）: `close > EMA50` AND `EMA50 slope > 0` AND
  `close > max(high[t-96 .. t-1])`（之前 96 根已完成 15m K 线的最高 high，**不含当前 K 线**）→ LONG（下一根 open）。
- **Exact Exit**: EMA9/21 death cross。
- **Known Data at Signal Time**: 当前 close + 之前 96 根已完成 K 线的 high（均已知）。
- **Expected Improvement**: 更少追交叉噪声，捕捉真实动量突破；交易更少、持仓趋势质量更高。
- **Expected Failure Mode**: 假突破（24h 高点常被日内冲高制造）；突破后快速回落。
- **Forbidden Parameter Changes**: 不得扫描 48/72/96/192/288 窗口；96 = 15m×24h 为预注册尺度。

---

## 纪律（预注册承诺）

1. 三候选规则冻结；Rolling Walk-Forward（FOLD1/2/3）与报告只读数据，不改规则。
2. `positionSizePct=0.25` 固定；成本场景 GROSS/BASE/STRESS；Funding 不包含。
3. 若发现问题 → 记录 `HYPOTHESIS FAILED`，留给 V3B/V4 重新预注册，不在本实验内偷偷修补。
4. 2026 HOLDOUT 一律保持锁定。

# Cross-Asset External Validation V1（docs/cross-asset-external-validation-v1.md）

> 预注册文件。验证**完全未参与策略开发**的资产上，冻结的 `breakout24h4h` 是否仍具有历史正 edge。
> 本文件 commit 之后，才允许计算 BNB/SOL 策略收益。

## Assets（固定，不得增删替换）

- **BNBUSDT**（Binance 官方 USD-M Futures）
- **SOLUSDT**（Binance 官方 USD-M Futures）
- 不得因某资产表现差而删除/替换/添加资产稀释结果。BNB 与 SOL **必须完整报告**。

## Data Source

- 仅 `data.binance.vision` → `futures/um/monthly/klines/<SYMBOL>/15m/`。
- 自动发现最早真实可用月份：**BNBUSDT = 2020-02，SOLUSDT = 2020-09**（实际以下载结果为准）。
- 下载：最早可用 → **2025-12-31 UTC**。
- 所有官方 zip 校验官方 `.CHECKSUM`（SHA256）；失败则不用。
- 15m → 4h 聚合：**复用 V4 已审计的 `src/research/data/resampler.js`**，不得建立第二套逻辑。

## Exact Frozen Strategy（不得修改）

引用冻结 Candidate **`breakout24h4h`**（freeze SHA `2e866b3`；prereg `59578e9`）：

- **Timeframe**: 4h。
- **LONG**（仅空仓）: `close > EMA50` AND `EMA50 slope > 0`（`ema50_t > ema50_{t-1}`）AND `close > previous24hHigh`。
- **previous24hHigh** = 之前 **6 根完整 4h candle** 的最高 high = `max(high[t-6 .. t-1])`，**绝不含 current candle**。
- **LONG 成交**: 下一根 4h open。
- **EXIT**: EMA9/21 death cross（`emaFastPrev > emaSlowPrev` AND `emaFastNow < emaSlowNow`），下一根 4h open 成交。
- EMA9/21/50 按 bars（9/21/50）在 4h 上计算。
- 禁止修改：EMA9/21/50、24h breakout、6-bar lookback、entry/exit timing、position sizing、cost model。

## Date Rules

- **2026 完全禁止**：所有资产（BNB/SOL/BTC/ETH）2026-01-01 之后数据不得进入评估。
  evaluationEnd 硬限制 `<= 2025-12-31T23:59:59Z`；任何越界 → 报错 `FINAL HOLDOUT IS LOCKED`。
- **Listing-date 公平处理**：不要求 BNB/SOL 从 2021-01-01 开始。使用 `firstAvailableComplete4hCandle` 作为数据起点；
  策略指标 warmup 完成后才允许首笔交易。报告标明 `firstDataDate` 与 `firstEligibleTradeDate`。
- warmup 期不计为亏损/盈利区间。

## Cost Assumptions

- GROSS: commission 0, slippage 0。
- BASE: commission 0.0004, slippage 0.0002。
- STRESS: commission 0.0006, slippage 0.0005。
- **FUNDING NOT INCLUDED**（所有报告顶部标注）。

## Position Size / Capital

- `initialCapital = 10000`；`positionSizePct = 0.25`；`leverage <= 1x`。
- 禁止扫描仓位；不得因结果不好改变仓位。

## Metrics

- 年度（完整年份才计入；不完整年份标 `PARTIAL YEAR`，不与完整年份混同）与全周期：
  Trade Count / NetExpectancyPct / GrossExpectancyPct / NetPF / GrossPF / Sharpe / Sortino / MaxDD /
  Win Rate / Average Win / Average Loss / Average Holding Hours / MFE / MAE / Turnover / Fees。
- Edge 指标：`averageGrossReturnPctPerTrade` / `averageNetReturnPctPerTrade` / `averageRoundTripCostPct` / `GrossEdgeToCostRatio` / `NetPF` / `Sharpe` / `TradesPerYear`。
- Buy & Hold 参考：`BUY_HOLD_GROSS_REFERENCE` 与 `BUY_HOLD_COST_ADJUSTED_REFERENCE`（Return/MaxDD/Exposure/Sharpe 对照，不要求跑赢才能 survive）。
- Exposure / Capital efficiency（仅诊断）：`ExposurePct`、`ReturnWhileInvested`、`ReturnPerUnitExposure`。公式：
  - `ExposurePct = barsInPosition / totalBars × 100`
  - `ReturnWhileInvested = totalReturnPct / (ExposurePct/100)`
  - `ReturnPerUnitExposure = totalReturnPct / ExposurePct`（每 1% 暴露的收益）
  - **ReturnPerUnitExposure 不用于 Survival Gate。**

## Pass / Fail Rules（External Validation Survival Gate，预注册）

- **Asset-level Gate**：BNB BASE `NetExp>0` AND `NetPF>1.05` AND `Sharpe>0`；SOL BASE 同样。**两个外部资产都必须为正**。
- **Stress Gate**：BNB STRESS `NetExp>=0` AND `NetPF>=1.0`；SOL STRESS 同样。
- **Year Consistency**：所有**完整 asset-year buckets** 中至少 **60%** 的 BASE NetExpectancy > 0（按真实完整 bucket 数计算）。
- **Sample Gate**：每个外部资产 `Trade Count >= 100`，否则 `LOW SAMPLE` 且不得通过完整 gate。
- **Concentration Check**（不自动 FAIL，触发则升级 P1）：`bestYearNetPnL / totalPositiveNetPnL > 60%` → `HIGH YEAR CONCENTRATION`。

失败定义：
- Gross+ / Base- → `EDGE FAILS REALISTIC COST ASSUMPTION`。
- Base+ / Stress- → `COST SENSITIVE`。
- BNB+ / SOL- 或反之 → `CROSS-ASSET INCONSISTENT`。
- 两者皆负 → `EXTERNAL VALIDATION FAILED`。

## 2026 Holdout Policy

- 本轮 **不得运行 2026**。`--unlock-holdout` 禁止。
- 若外部验证通过：**只输出 `EXTERNAL VALIDATION SURVIVED — READY FOR FINAL HOLDOUT DECISION`，然后停止**；
  2026 最终 Holdout 留待单独的 `FINAL HOLDOUT PROTOCOL V1` 一次性运行。
- 若失败：`EXTERNAL VALIDATION FAILED — FINAL HOLDOUT NOT JUSTIFIED`，2026 继续 LOCKED。

## No Cherry Picking Rule

- 看到结果后不得：修改 breakout window / EMA / 加 ATR/RSI/volume / 加止损/移动止损 / 改 exit / 改 position size / 加第三个资产。
- 失败就失败；下一阶段重新预注册假设。

# V4 Final Development Candidate（docs/v4-final-development-candidate.md）

> 冻结文件：STRATEGY RESEARCH V4 唯一通过 Survival Gate 的 development candidate。
> 冻结后：不得修改规则；先进行 CROSS-ASSET EXTERNAL VALIDATION，再决定是否消耗 2026 HOLDOUT。
> **2026 FINAL HOLDOUT 保持 LOCKED。**

## Candidate

- **Name**: `breakout24h4h`
- **Timeframe**: 4h（由已验证 Binance 官方 15m 数据严格 UTC 对齐聚合，16×15m；不完整窗口丢弃）
- **Code**: `src/research/strategies/breakout24h4h.js`（基于 `breakout24hFactory.js`）
- **Preregistration SHA**: `59578e98f64446350db3c603896d243bc8b7d214`（docs/strategy-v4-hypotheses.md）
- **Freeze SHA**: `2e866b3fd4f0b38f0570ab31c9dfc77e1030c5a8`（本文件 commit）

## 完整规则（冻结）

- **Entry**（仅空仓）: `close > EMA50` AND `EMA50 slope > 0`（`ema50_t > ema50_{t-1}`）AND `close > previous24hHigh`。
- **previous24hHigh**（4h）: 过去 **6 根完整 4h candle** 的 high 最大值 = `max(high[t-6 .. t-1])`，**绝不含 current candle**。
- **Execution**: LONG 在**下一根 4h open** 模拟成交。
- **Exit**: EMA9/21 death cross（`emaFastPrev > emaSlowPrev` AND `emaFastNow < emaSlowNow`）→ CLOSE，**下一根 4h open** 成交。
- EMA9 / EMA21 / EMA50 均在 4h 上按 **bars** 计算（9/21/50）。
- 资金模型：`positionSizePct = 0.25`，`leverage ≤ 1x`，`initialCapital = 10000`。
- 成本（研究假设）：BASE commission 0.04% / slippage 0.02%；STRESS 0.06% / 0.05%。
- **FUNDING NOT INCLUDED**。

## Development 结果（Anchored WF 2023/2024/2025，BTC+ETH，BASE）

| 指标 | 值 |
|---|---|
| Trade Count | 234（~78/年，非 LOW SAMPLE） |
| Gross Expectancy | +0.90%/trade |
| Net Expectancy | **+0.78%/trade** |
| GrossPF / NetPF | 1.47 / **1.39** |
| Sharpe | **0.70** |
| STRESS NetExp / NetPF | +0.68% / 1.33（survive） |
| Edge/Cost ratio（BASE） | **10.73** |
| Avg / Median holding | 116.3h / 76h |
| MFE / MAE | +6.14% / -3.51%（ratio 1.75） |
| 6 evaluation buckets 正数 | 4/6（2023 双正、2024 双正、**2025 双负**） |
| BTC aggregate / ETH aggregate | +1.16% / +0.71%（无 CROSS-ASSET INCONSISTENT） |

## 风险 / 限制

1. **2025 两个 asset 的 BASE NetExpectancy 均为负**（BTC -0.74%，ETH -0.75%）——跨年一致性偏弱，仅 4/6 buckets 为正。
2. 仅 234 笔交易（~78/年）——样本中等，需外部资产验证。
3. 4h 相对 15m/1h 的改善来自**单笔行情幅度放大（0.12%→0.90%），而每笔成本不变（0.08%）** → edge/cost 从 ~1 提升到 ~10.7。
4. 这是 DEVELOPMENT 结果，**不代表未来盈利**；未经外部资产验证、未经 2026 HOLDOUT 验证。

## 下一步（不得在本阶段执行）

1. CROSS-ASSET EXTERNAL VALIDATION：用 Binance 官方 USD-M 数据验证 BNBUSDT / SOLUSDT（按真实 listing date 处理范围，不得因结果差删除资产）。
2. 若外部验证支持 → 再决定是否消耗 2026 FINAL HOLDOUT。

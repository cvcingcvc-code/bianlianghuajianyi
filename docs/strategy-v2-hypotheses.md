# Strategy V2 Hypotheses（docs/strategy-v2-hypotheses.md）

> 预注册文件。基于 `reports/v2/EDGE_DIAGNOSIS.md`（DISCOVERY 2021-2023）形成的研究假设。
> 本文件冻结后，候选策略才允许进入 VALIDATION（2024-2025）。
> **不得**在看过 VALIDATION / HOLDOUT 结果后修改本文件的规则。

## 预注册事实（DISCOVERY 关键观察，2021-2023）

| 观察 | 数值 |
|------|------|
| Combined 逐笔 gross expectancy | **-0.01%/笔**（BTC -0.03%，ETH +0.01%） |
| avg round-trip cost | 0.08%/笔 |
| \|gross\|/cost 比 | **0.11 → EDGE TOO THIN RELATIVE TO COST** |
| 短持仓（≤24 bars）交易占比 | 70%（5089 中 3545 笔），gross -0.5%~-0.84%，胜率 ~0-4% |
| 长持仓（>24 bars） | 25-48 bars gross +0.42%、49-96 +2.83%、>96 +8.59%（96-100% 胜率） |
| Trend regime | above+sloUp（4095 笔）与 below+sloDn（994 笔）逐笔 edge 均 ≈ -0.01% |
| Volatility regime | High ATR gross -0.06%，Low/Medium +0.01% |
| Crossover 密度（24h 内 ≥4 次） | gross +0.02%，**不**比稀疏差 → "whipsaw 密度"假设未被支持 |
| MFE/MAE | 输家中位 MFE 仅 0.32%（无浮盈即亏）；MFE≥1% 的交易 39.7% 最终亏损（出场慢） |

**总体判断**：emaCrossover 不存在一致的逐笔 gross edge；全部正向来自少数长持仓赢家，
70% 的短持仓 whipsaw 交易必亏，且换手成本（~1700 笔/年 × 0.08%）远超任何 edge。
因此候选方向聚焦"**减少无意义 whipsaw 交易**"，而非预测价格。

---

## Candidate 1 — emaTrendFilter

- **Name**: `emaTrendFilter`（代码 `src/research/strategies/emaTrendFilter.js`）
- **Hypothesis**: 过滤逆趋势的 golden cross（below+sloDn 状态下的入场），可减少 whipsaw 并降低换手，而不损害逐笔 edge。
- **Exact Entry**: 原始 EMA9/21 golden cross（上一根 below → 本根 above）AND 无持仓 AND `close > EMA50` AND `EMA50 slope > 0`（`ema50_t > ema50_{t-1}`）。
- **Exact Exit**: 原始 EMA9/21 death cross（上一根 above → 本根 below），且有持仓。
- **Why It May Work**: DISCOVERY 显示 below+sloDn 入场（994 笔）edge 为负且为逆趋势；过滤后换手约 -20%。
- **Expected Effect**: trade count 减少 ~20%；逐笔 gross edge 基本不变；总 fees 下降；净 edge 取决于被移除交易是否更差。
- **Failure Condition**: 若 net expectancy 未转正、或净 edge 相比 baseline 无改善（PF 未上升、Sharpe 未上升）。

## Candidate 2 — emaTrendDensityFilter

- **Name**: `emaTrendDensityFilter`（代码 `src/research/strategies/emaTrendDensityFilter.js`）
- **Hypothesis**: 短期反复 crossover（whipsaw 密集）应避免入场。预注册规则：过去 24h 内（含当前）EMA9/21 crossover 次数 **>= 4** 时禁止新 LONG。
- **Exact Entry**: Candidate 1 条件 AND `crossesLast24h < 4`。
- **Exact Exit**: 原始 EMA9/21 death cross。
- **Why It May Work**: 直接检验"whipsaw 密度 → 更差"假设。注意：DISCOVERY 的 24h 密度分层**未支持**该方向（≥4 bucket edge 不差），故本候选被明确预期可能失败，作为**证伪检验**。
- **Expected Effect**: trade count 大幅下降（可能 < 100，存在 INSUFFICIENT SAMPLE 风险）。
- **Failure Condition**: 样本 < 30（INSUFFICIENT SAMPLE）、或 net expectancy ≤ 0、或 edge 比 Candidate 1 更差。

## Candidate 3 — emaTrendVolFilter

- **Name**: `emaTrendVolFilter`（代码 `src/research/strategies/emaTrendVolFilter.js`）
- **Hypothesis**: 高波动（High ATR）状态下的 crossover 更容易失败，应避免入场。预注册阈值：`atrPct = ATR14/close < 0.629%`（DISCOVERY atrPct 的 Q3，见 volatility-regime-analysis.md）。
- **Exact Entry**: Candidate 1 条件 AND `atrPct < 0.629%`。
- **Exact Exit**: 原始 EMA9/21 death cross。
- **Why It May Work**: DISCOVERY 显示 High ATR 入场 gross -0.06% vs Low/Med +0.01%。
- **Expected Effect**: trade count 减少 ~25%（High bucket）；逐笔 edge 小幅改善。
- **Failure Condition**: 样本不足、或 net expectancy ≤ 0、或相比 Candidate 1 无改善。

---

## 纪律（预注册承诺）

1. 候选规则已冻结于本文件；VALIDATION（2024-2025）与 HOLDOUT（2026）**不得**触发修改。
2. 不扫描参数、不做 grid/random/Bayesian/ML 搜索。
3. `rsiEma` 保持为 NEGATIVE CONTROL，不修复其死代码退出分支（修复 = 新策略设计，需另命名 `rsiEmaV2`）。
4. 若无一候选满足筛选条件 → 输出 **NO CANDIDATE SURVIVED VALIDATION**。

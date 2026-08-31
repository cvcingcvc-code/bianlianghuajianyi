# Backtest Integrity Audit V2（docs/backtest-integrity-audit.md）

> 审计对象：`src/research/backtest/{backtester,portfolio,brokerSimulator}.js`
> 审计日期：2026-08-31
> Baseline 冻结：commit `97dbf15`（HISTORICAL VALIDATION V1 结果视为 BASELINE RESULT）

---

## 一、Position Sizing 精确规则（审计重点）

### 1.1 现状（审计时点）

| 项目 | 值 | 来源 |
|------|-----|------|
| initial equity | 10000（默认，可 `--initial-capital` 覆盖） | cli.js |
| available cash at entry | `state.cash`（空仓时 == equity） | portfolio.js:32 |
| position size percentage | `positionSizePct`（CLI 传百分比，内部 `sizePct = positionSizePct/100`） | portfolio.js:31 |
| position notional | `cash × sizePct` | portfolio.js:32 |
| quantity | `notional / fillPrice`（fillPrice 已含滑点） | portfolio.js:33 |
| entry fee | `notional × commissionPct` | portfolio.js:34 |
| cash after entry | `cash - notional - fees` | portfolio.js:35 |
| 是否复利 | **是**——每笔按当前 cash 的固定比例开仓，收益/亏损都滚入下一笔 | portfolio.js:32 |
| 是否固定 quantity | 否 | — |
| position notional > equity？ | 否（sizePct ≤ 1 时 notional ≤ cash） | — |
| 隐式 leverage？ | **否**（notional ≤ cash，≤ 1x） | — |
| 负 cash？ | **sizePct=1 时 cash 会为负（约 -fee 金额）** | portfolio.js:35 |

### 1.2 发现的问题

**P1：sizePct=1.0 时允许负 cash。**
`cash -= notional + fees`，当 `sizePct=1` 时 `notional=cash`，于是 `cash = -fees`（负数）。
这不等同于杠杆（notional 从未超过 equity），但违反了"不得负 cash / 不得借钱"的研究纪律，
且使 fee 相当于"借来的"资金垫付。

**修复（本阶段实施）**：把手续费**计入预算**求解仓位，保证 `notional + fee ≤ budget`：

```
budget  = cash × sizePct            // 本笔最多动用的资金（含费用）
notional = budget / (1 + commissionPct)   // 解 notional × (1+comm) = budget
fee     = notional × commissionPct
quantity = notional / fillPrice
cash    -= notional + fee            // == budget，cash ≥ 0
```

效果：
- `sizePct=1` → 买入后用尽 budget（现金归零），**不出现负 cash**。
- notional < equity（严格小于，因扣费）→ **无杠杆、无借钱**。
- `sizePct=0.25 / 0.50 / 1.00` 均可用作研究敏感性，见 `reports/position-size-sensitivity.md`。

### 1.3 明确回答（审计项）

- initial equity：`initialCapital`（默认 10000）
- available cash：`state.cash`（空仓即全部权益；持仓期间为剩余现金）
- position notional：`cash × sizePct / (1 + commissionPct)`（修复后）
- quantity：`notional / fillPrice`
- position size percentage：`positionSizePct`（默认 100%）
- 是否使用全部 equity：`sizePct=1` 时预算=全部 cash（费后略小于 notional）
- 是否固定 quantity：否（按比例、复利）
- 是否复利：是
- 是否允许负 cash：修复后**不允许**
- 是否允许 notional > equity：不允许
- 是否存在隐式 leverage：**不存在**（notional ≤ cash ≤ equity）

---

## 二、费用 / 滑点是否重复计算

### 2.1 commission
- 开仓一次：`broker.commission(entryNotional)` → 计入 `entryFees`，同时从 cash 扣除（portfolio.openPosition）。
- 平仓一次：`broker.commission(exitNotional)` → 计入 `exitFees`，同时计入 cash（portfolio.closePosition）。
- `PnL`（grossPnl）**只基于价格差 × quantity**，不包含 fee；`netPnl = grossPnl - (entryFees + exitFees)`。
- **不存在**"价格已含 fee 再另扣 fee"，也**不存在**"PnL 扣一次 + 账户再扣一次"的 double counting。
- 测试：`tests/metrics.test.js` + `tests/backtest-integrity.test.js`（fee single counting）。

### 2.2 slippage
- LONG entry：`fillPrice = open × (1 + slippage)`；CLOSE：`fillPrice = open × (1 - slippage)`（brokerSimulator）。
- `PnL` 与 cash 均基于 `fillPrice` 计算；**没有**在 fillPrice 之外再额外扣除 slippage。
- 测试：slippage single counting。

---

## 三、Equity Curve / 收益公式

- `equity = cash + position.quantity × markPrice(bar.close)`（持仓中），否则 `equity = cash`（portfolio.markToMarket）。
- 每根 bar 记录一条 equity；持仓期间的未实现盈亏**计入估值**，但不产生成交。
- **Total Return = (finalEquity / initialEquity) - 1**（不是把 trade return 相加）。
- **Annualized Return** 由 `initialEquity / finalEquity / 真实时长` 推导。
- 测试：10000 → 11000 ⇒ 10%。

---

## 四、指标口径

| 指标 | 口径（V2） |
|------|-----------|
| Expectancy | 拆分输出 `ExpectancyDollar`（每笔净盈亏均值，USDT）与 `ExpectancyPctPerTrade`（每笔 returnPct 均值，%） |
| Profit Factor | 同时输出 `GrossProfitFactor = |sum(grossPnl>0)/sum(grossPnl<0)|` 与 `NetProfitFactor = |sum(netPnl>0)/sum(netPnl<0)|` |
| Sharpe / Sortino | 基于**等间隔 bar 级 equity returns**（`equity_t/equity_{t-1}-1`），非交易级收益；15m ⇒ periodsPerYear=35040 |
| Exposure | `barsInMarket / totalBars`（bar 级在仓比例） |

---

## 五、结束处理 / Benchmark

- 末根 bar 后仍持仓 → **FORCED_RESEARCH_EXIT**：以最后一根 close（滑点调整后）强制平仓并记账，`forcedExit=true`，`openPositionAtEnd=false`（V2 起）。仅用于结束回测估值，不代表真实成交。
- Benchmark 输出两个版本：
  - `BUY_HOLD_GROSS_REFERENCE`（无成本，首 open 买 / 末 close 卖）
  - `BUY_HOLD_COST_ADJUSTED_REFERENCE`（按研究费率计入双边费用+滑点）
  - 报告中明确 benchmark 是否计费，避免"无成本基准 vs 有成本策略"的不公平对比。

---

## 六、结论

- 未发现 P0（资金模型 / 收益口径无根本性错误）。
- 发现 1 个 P1：`sizePct=1` 时出现负 cash（费用垫付）——已修复为"费用含入预算"。
- 其余为口径/文档改进：Expectancy 拆单位、PF 分 gross/net、forced exit、双 benchmark。
- rsiEma 退出条件存在**死代码**（RSI take-profit 分支恒为假，见 `docs/strategy-parity-audit.md`），本阶段**不修改策略行为**，仅记录。

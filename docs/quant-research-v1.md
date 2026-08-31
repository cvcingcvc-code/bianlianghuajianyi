# Quant Research V1 架构文档（docs/quant-research-v1.md）

> 本文档记录 Quant Research V1 的整体架构、模块职责、数据流与假设。
> 目标：在**不下单、不接实盘**的前提下，验证 `emaCrossover` 与 `rsiEma` 两个策略是否具有正期望。

---

## 1. 设计原则

1. **只读研究**：不触碰 `src/index.js` 实时链路、不修改任何实盘配置、默认禁止下单。
2. **单一信号逻辑**：回测与实时共用 `src/strategy/*` 的同一个 `computeSignal`，防止两套逻辑漂移。
3. **防未来函数**：信号在 K 线 N 收盘后产生 → 以 K 线 N+1 的 open 成交；成交永远不用信号当根 close。
4. **诚实指标**：样本不足的指标一律返回 `null`，不编造数据。
5. **离线可运行**：只需 CSV 行情文件，无需任何 API key。
6. **架构留好扩展位**：Funding 通过 Provider 接口接入，V1 默认 `none`（报告中明确标注未包含）。

---

## 2. 目录结构

```
src/research/
├── cli.js                    # 命令行入口与参数校验
├── strategyAdapter.js        # 把 src/strategy/* 暴露为 { name, createState, computeSignal }
├── data/
│   ├── csvLoader.js          # CSV 底层解析（列检测、BOM/CRLF/空行处理）
│   ├── dataValidator.js      # K 线质量校验（NaN/OHLC/close<=0/升序/重复/缺口）
│   └── candleRepository.js   # 读取 + 清洗 + 类型化 K 线，产出质量报告
├── backtest/
│   ├── backtester.js         # 严格回测主循环（next-bar 执行）
│   ├── brokerSimulator.js    # 手续费/滑点/Funding 模拟
│   ├── portfolio.js          # 现金/单仓位/equity curve 记账
│   └── tradeLedger.js        # 交易记录 + CSV 序列化
├── metrics/
│   ├── performance.js        # 全部绩效指标
│   └── drawdown.js           # 最大回撤
└── experiments/
    └── runner.js             # 单跑 / Walk-Forward / 批量对比 + 报告落盘
```

---

## 3. 数据流

```
CSV (timestamp,open,high,low,close,volume)
  → csvLoader（列检测）→ candleRepository（清洗/去重/校验/类型化）
  → validateCandles（质量报告）
  → splitCandles（可选 Walk-Forward 严格切分 train/test）
  → runBacktest（逐 bar：先执行上一根 pending 订单@本根 open → funding → mark-to-market → 本根 close 产生新信号）
  → computeMetrics / maxDrawdown
  → 落盘 reports/<ts>-<symbol>-<strategy>/{summary.json,trades.csv,equity.csv,report.md}
```

### 回测主循环（严格时序）

```
for bar in bars:
  1. 若存在 pending 订单 → 用本 bar.open 成交（ENTRY: open*(1+slip)，EXIT: open*(1-slip)），记录费用
  2. 若有持仓 → 计算 funding（V1 默认 0）
  3. mark-to-market：以本 bar.close 估值并记录 equity
  4. computeSignal(state, bar.close, { hasPosition, warmup:false })
     - LONG 且空仓 → 置 pending ENTRY
     - CLOSE 且持仓 → 置 pending EXIT
     （订单在下一根 bar 的 open 执行）
```

- 策略状态在 `runBacktest` 内部通过 `adapter.createState()` 创建，每次运行独立。
- 信号使用到 `bar.close`（含之前所有 close），成交只使用下一根 `bar.open`，两者严格分离。

---

## 4. 复用现有策略

- `src/strategy/emaCrossover.js` / `rsiEma.js` 各新增两个导出：
  - `createState()`：返回独立的每符号状态对象。
  - `computeSignal(state, close, { hasPosition, warmup })`：纯信号计算，返回 `{ action, reason }`。
- 原 `onTick` 改为**委托** `computeSignal`，日志/事件格式保持不变，`strategy/engine.js` 与实时链路零改动。
- `strategyAdapter.js` 只做加载与接口规整，不复制策略逻辑。

---

## 5. 成交与成本模型

| 参数 | 默认 | 说明 |
|------|------|------|
| `initialCapital` | 10000 | 初始资金 |
| `commissionPct` | 0.0004 | 每笔成交手续费（开+平各收一次） |
| `slippagePct` | 0.0002 | 滑点（多头买入上浮，卖出下浮） |
| `positionSizePct` | 100 | 每仓使用可用资金比例（**无杠杆**） |
| `fundingRate` | 0 | V1 默认不建模 |

- 所有参数均可被 CLI 覆盖。
- `LONG` 成交价 = `open × (1 + slippagePct)`；`CLOSE` 成交价 = `open × (1 - slippagePct)`。
- 交易记录字段：`symbol, strategy, entryTime, entryPrice, exitTime, exitPrice, quantity, grossPnl, fees, netPnl, returnPct, holdingBars`。

### Funding 接口（预留）

`brokerSimulator.createFundingProvider({ type: 'none' | 'constant', rate })` 暴露
`getRate(symbol, timestamp)` 接口。V1 默认 `none`（恒返回 null，报告中标注
`funding rate not included`）。未来可从真实 funding CSV 实现新的 Provider。

---

## 6. 绩效指标

`computeMetrics` 返回（样本不足时对应字段为 `null`）：

- `totalReturnPct` / `annualizedReturnPct`（按实际时间跨度年化，非简单 ×252）
- `maxDrawdownPct` / `maxDrawdownAbs`（running-peak 计算）
- `sharpe` / `sortino`（基于逐 bar equity 收益，`periodsPerYear = 365天×24h×3600s / intervalMs`，riskFree=0）
- `winRatePct` / `avgWin` / `avgLoss` / `profitFactor` / `expectancy`
- `tradeCount` / `exposurePct` / `maxConsecutiveLoss`
- `grossProfit` / `grossLoss` / `totalFees` / `finalEquity`

---

## 7. 报告输出

- 单策略：`reports/<ISO时间戳>-<symbol>-<strategy>/{summary.json,trades.csv,equity.csv,report.md}`
- Walk-Forward：同一目录下 `train/`、`test/` 两套完整报告 + `walkforward.md`（TRAIN/TEST 分开呈现）
- 批量对比：`reports/comparison-<ISO时间戳>.md`，表格 + 三条客观结论
  （Highest Return / Best Sharpe / Lowest Drawdown）+ 免责声明。

报告中的 Warnings 会自动生成，例如：
`sample size too small`、`funding rate not included`、`insufficient trading history`、
`position still open at end of backtest`。

---

## 8. 测试

- 框架：Node.js 原生 test runner（`node:test`，无第三方依赖）。
- 入口：`npm test`（`node --test "tests/**/*.test.js"`）。
- 覆盖：CSV 解析、非法 K 线、重复时间戳、双策略信号、next-bar 执行、无未来函数、
  手续费/滑点、PnL、最大回撤、Sharpe、Profit Factor、亏损/盈利/零交易/单笔交易、
  Walk-Forward 切分等 42 个断言用例。

---

## 9. 假设与限制（V1）

1. **无杠杆、单仓位、仅做多**；未模拟止损/止盈挂单与保证金校验。
2. **Funding 默认不包含**；手续费/滑点为固定比例（非吃单/挂单分层费率）。
3. **CSV 时间戳需严格升序**，缺口只警告不填充。
4. **信号在收盘后产生，下一根 open 成交**——与实盘"收盘瞬间市价单"存在模型差异。
5. 未做参数寻优、未做滑点/手续费敏感性分析（V2 方向）。
6. 使用的任何 synthetic 数据仅用于软件验证，**不能用于判断策略盈利能力**。

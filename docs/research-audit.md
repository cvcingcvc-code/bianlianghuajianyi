# Research 前置审计报告（research-audit.md）

> 本文档是 Quant Research V1 开发前对现有 `binance-trader` 项目的审计。
> 审计对象：`src/strategy/*`、`src/risk/*`、`src/execution/*`、`src/state/*`、`src/index.js`、`src/config.js`。
> 审计日期：2026-08-31

---

## 0. 结论摘要

现有项目是一个**可运行的长多实时交易机器人**，策略实现为"事件驱动 + 模块级可变状态"风格，**不能直接用于回测**，但核心信号计算逻辑（EMA / RSI）本身是**纯计算、无未来函数**的，具备最小改造后复用的条件。

主要改造点：把 `onTick` 内的信号判定提取为独立的**纯函数**（`computeSignal`），并让实时链路与回测链路调用同一函数，避免两套逻辑漂移。

---

## 1. 当前策略实现方式

### 1.1 emaCrossover（`src/strategy/emaCrossover.js`）

- 模块级可变状态：`state.prices[symbol]`（收盘价滚动数组，上限 60）、`state.lastCrossState[symbol]`。
- `onTick(kline, repo, eventBus, logger)`：
  1. 忽略未收盘 K 线（`!isFinal`）。
  2. 把 `close` 推入 `state.prices[symbol]`，超长则 `shift`。
  3. 计算 EMA9 / EMA21，判断 `currentCross`（above/below）。
  4. **始终更新** `lastCrossState`；`warmup` 期间不产生信号。
  5. 金叉（below→above）且 `!repo.hasPosition(symbol)` → emit `strategySignal(LONG)`。
  6. 死叉（above→below）且 `repo.hasPosition(symbol)` → emit `strategySignal(CLOSE)`。

### 1.2 rsiEma（`src/strategy/rsiEma.js`）

- 模块级状态更多：`prices/rsi/emaFast/emaSlow/emaTrend/lastSignal/rsiPrev/emaFastPrev/emaSlowPrev`（均为 `[symbol]` 索引）。
- `onTick` 流程：
  1. 忽略非最终 K 线；更新 `prices` 滚动数组。
  2. 长度不足 `max(RSI_PERIOD+1, EMA_TREND+1)` 时返回。
  3. 计算 RSI(14)、EMA9、EMA21、EMA50。
  4. `warmup` 时只记录 prev 状态并返回。
  5. 开多条件：`!hasPosition && close > emaTrend && emaFast > emaSlow && rsiPrev<=40 且 rsi>40 && rsi<55`。
  6. 平仓条件（有仓位时）：EMA 死叉，或 RSI 从 >=60 跌回 <60 且 `rsi>65`。
  7. 每次调用末尾更新 prev 状态。

### 1.3 共同特征

- 全部通过 `eventBus.emit('strategySignal')` 通知下游，信号含 `symbol/direction/price/reason`。
- `strategy/engine.js` 按 `config.strategy` 加载策略，监听 `kline` 事件调用 `onTick`。
- 信号方向只有 `LONG` / `CLOSE`（`utils/constants.js` 中 `DIRECTION` 无 SHORT），**仅做多**。
- 持仓判断依赖 `repo.hasPosition(symbol)`（`state/` 模块，内存 + JSON 持久化）。

---

## 2. 策略是否容易复用于回测

**结论：不能直接复用，但改造成本低。**

障碍点：

| 障碍 | 说明 |
|------|------|
| 事件总线耦合 | `onTick` 直接 emit 事件、打印日志，回测不需要这两者 |
| 仓库耦合 | 用 `repo.hasPosition(symbol)` 判断持仓，回测有自己的仓位状态 |
| 模块级单例状态 | 状态挂在模块级 `state` 上，同一进程内多符号共用；回测需要**每次运行独立状态**，还要支持同一进程跑多个回测（批量对比） |
| 实时专用字段 | `isFinal / warmup` 是 WebSocket K 线流特有概念 |

**复用策略**（本模块采用的方案）：

> 在每个策略文件中提取一个**纯函数** `computeSignal(strategyState, close, opts)`：
> - `opts.hasPosition`：是否持仓（由调用方传入，回测/实时各自维护）
> - `opts.warmup`：是否预热期（实时专用，回测恒为 false）
> - 返回 `{ action: 'LONG'|'CLOSE'|'HOLD', reason, ...指标 }`
>
> 实时 `onTick` 改为内部委托该纯函数（保留原有日志/emit 行为不变）；
> 回测引擎也调用同一个纯函数。**两边共享同一套信号逻辑。**

---

## 3. 是否存在未来函数风险

**结论：现有策略信号计算本身没有未来函数，但"实时执行时机"需要留意。**

- `calcEMA` / `calcRSI` 只使用 `prices[0..i]`（当前及之前的收盘价），不读取未来数据。✅
- 信号在**当前 K 线收盘后**计算（`isFinal` 判定），实时链路在收盘瞬间下单，属于"接近收盘价成交"，对回测而言存在偷看同一根 K 线收盘价的风险。
- **回测必须改为：信号产生于 K 线 N 收盘 → 以 K 线 N+1 的 open 成交**。这是本模块回测器强制执行的规则。
- `warmup` 机制仅影响实时首次历史批次，不影响回测。

> 注意：实时交易中"信号当根 K 线收盘时立即市价单"与"回测下一根 open 成交"存在模型差异，属正常现象，需要在报告中以 Assumptions 说明。

---

## 4. 当前交易成本是否被考虑

**结论：实时链路没有显式交易成本模型；回测必须自己实现。**

- 实时 `orderExecutor.js` 只做 `futuresMarketBuy/Sell`，未计算手续费/滑点；实际费用由交易所收取，但代码不记录。
- 实时链路的盈亏计算（`executeClose` 中 `pnl = (exitPrice-entryPrice)*qty`）**不含手续费与滑点**。
- `README` 中提到的 `MAX_SLIPPAGE` 配置在代码中**未被使用**。
- 回测模块需要独立实现 `commissionPct`（默认 0.0004）与 `slippagePct`（默认 0.0002），开平仓双向收取，且可被 CLI 覆盖。

---

## 5. 当前仓位管理逻辑

- **仓位大小**：`risk/limits.calculatePositionSize`：`notional = balance * positionSizePct% * leverage`，再受 `maxNotionalPerTrade` 封顶。
- **杠杆**：`MAX_LEVERAGE`（默认 10x，当前 `.env` 为 10）。
- **单一持仓上限**：`MAX_OPEN_POSITIONS`（默认 3）。
- **保证金校验**：`risk/manager` 要求模拟保证金比例 ≥ 200%。
- **止盈止损**：开仓时按 `STOP_LOSS_PCT` / `TAKE_PROFIT_PCT` 计算并挂单。

**对回测的影响**：
- 回测遵循约束"不得用杠杆美化收益"，因此**回测默认不使用杠杆**，采用"单仓位、按 `positionSizePct`（默认 100%，即满仓单仓）分配可用资金"的简化模型。
- 保证金比例校验、最大持仓数、止损/止盈挂单等实时风控逻辑**不属于 V1 回测范围**（V1 只验证策略信号期望值）。

---

## 6. 当前已有代码哪些可以复用

| 模块 | 内容 | 复用方式 |
|------|------|----------|
| `src/strategy/emaCrossover.js` | EMA9/21 信号 | 提取 `computeSignal` 后由回测直接调用 |
| `src/strategy/rsiEma.js` | RSI+EMA 信号 | 同上 |
| `src/utils/constants.js` | `DIRECTION`（LONG/CLOSE） | 回测动作枚举直接引用 |
| `src/strategy/engine.js` | 策略注册/加载 | 可参考其 `strategies` 映射表设计回测的 strategyAdapter |
| `src/utils/validators.js` | `isNumber` 等参数校验 | CLI 参数校验可复用其思路 |

**不可直接复用**：`eventBus` 事件链、`risk/*` 风控、`execution/orderExecutor`（真实下单）、`state/*`（实时状态仓库）。

---

## 7. 需要最小重构的点

1. **策略纯函数化（必须，最小改动）**
   - `emaCrossover.js`：新增导出 `createState()` 与 `computeSignal(symState, close, opts)`；`onTick` 改为委托 `computeSignal`，日志/emit 行为保持逐字不变。
   - `rsiEma.js`：同样新增 `createState()` / `computeSignal`，并把 `trackState` 改为操作传入的 state 对象；`onTick` 委托后把更新后的指标写回模块级 map 以维持 `getStatus()` 输出。
   - 保持原有导出 `name/init/onTick/getStatus` 不变 → `strategy/engine.js` 与 `src/index.js` 无需改动。
2. **回测引擎引入 next-bar 成交**：信号在 N 收盘产生，N+1 open 成交；强制防未来函数（这是新增模块的职责，不改实时代码）。
3. **不改动**：`src/index.js` 实时链路、`risk/*`、`execution/*`、`state/*`、`.env` 实盘行为。

---

## 8. 关于实时核心逻辑

按约定，本阶段**不删除、不重构**现有稳定交易代码。唯一的源码改动是上面"策略纯函数化"这一项（行为等价、由测试保证），其余均为**新增独立模块**（`src/research/*`）。

> 该重构的风险点：若 `onTick` 委托后行为与原来有偏差，会同时影响实时交易。因此：
> 1. 对重构后的策略写信号级单元测试（金叉/死叉/RSI 恢复等）。
> 2. 保留原始日志格式，便于人工比对。
> 3. 实时链路仍以 dry-run + testnet 验证为主。

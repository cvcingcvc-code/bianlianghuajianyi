# 策略行为一致性审计（docs/strategy-parity-audit.md）

> 审计对象：`src/strategy/rsiEma.js`、`src/strategy/emaCrossover.js`
> 审计日期：2026-08-31
> 关联：`HANDOVER.md`、`README.md`、`docs/research-audit.md`、基线 commit `c681348`

---

## 背景

Quant Research V1 阶段对两个策略做了"纯函数化"改造：把 `onTick` 内的信号判定提取为
`computeSignal(state, close, { hasPosition, warmup })`，`onTick` 改为委托同一函数。
本审计回答：**重构前后行为是否一致**，以及 **HANDOVER/README 对 rsiEma 的描述与代码是否一致**。

---

## 1. rsiEma 的 LONG 真实代码条件（`src/strategy/rsiEma.js:62-76`）

LONG 触发需要 **同时** 满足（且当前无持仓）：

| # | 条件 | 代码 | 说明 |
|---|------|------|------|
| 1 | `!hasPosition` | 由调用方传入 | 空仓才开多 |
| 2 | `close > emaTrend` | `trendUp` | 收盘价高于 EMA50 |
| 3 | `emaFast > emaSlow` | `fastAboveSlow` | **当前** EMA9 > EMA21（状态比较，不是"刚金叉"） |
| 4 | `rsi > 40 && rsiPrev <= 40` | `rsiRecovering` | RSI 从 <=40 回升越过 40（相对上一根） |
| 5 | `rsi < 55` | 直接条件 | RSI 仍处于"回升中"区间 |

CLOSE 条件（有持仓时，满足任一）：EMA 死叉（`!fastAboveSlow && emaFastPrev > emaSlowPrev`）
或 RSI 从 >=60 回落且 `rsi > 65`（`rsiWeakening && rsi > 65`）。

---

## 2. 逐项回答

### Q1. LONG 的真实代码条件是什么？
见上表 5 条。**关键**：条件是"EMA9 > EMA21 的状态" + "RSI 当前在 (40,55) 且上一根 <=40" + "收盘价 > EMA50"，全部基于当前/过去数据。

### Q2. 是否要求真正发生 EMA 金叉？
**否**。入场只看 `emaFast > emaSlow`（当前状态）。代码里没有任何"上一根 emaFast <= emaSlow"的入场判定。
`emaFastPrev / emaSlowPrev` 只用于**出场**的死叉判断，不用于入场。

### Q3. 还是只要求 EMA9 > EMA21？
**是**。入场对 EMA 只有这一个状态比较，不是"穿越"。

### Q4. 是否要求 RSI 曾经 <35？
**否**。`rsiOversold = rsi < 35`（第 64 行）被计算但**从未在任何条件中引用**（死代码/预留）。
入场只要求"上一根 RSI <= 40 且本根 > 40"。RSI 可能从 39 → 42 即可触发，不必先到 35 以下。
→ 这与 HANDOVER.md 中"RSI 曾进入 oversold <35，之后回升突破 40 才 LONG"的描述**不一致**。

### Q5. 是否要求 RSI crossing 40？
**是**。`rsiRecovering` 要求 `rsiPrev <= 40 && rsi > 40`，即相对上一根发生向上穿越 40。

### Q6. RSI <55 的条件从哪里来？
在代码 `rsiEma.js:72` 中（`&& rsi < 55`），是现状事实。项目在基线 commit 前**无任何 git 历史**，
无法追踪到更早的版本；HANDOVER/README 均未记录该阈值。合理推断：这是"只在上冲初期（RSI 未过热）入场"的
保守设计，但**出处无法考证**，只能作为代码事实记录。

### Q7. 重构前后是否有可证明的行为一致性证据？
- 项目在 baseline commit（`c681348`）之前**没有项目级 git 历史**，因此磁盘上不存在"重构前文件"可供字节级 diff。
- 但重构前 `rsiEma.js` / `emaCrossover.js` 的完整源码在审计时被逐字读取并保存于对话记录。
- 据此在 `tests/parity.test.js` 中**逐字重建**了重构前的 `onTick` 信号逻辑（`oldEmaSignal` / `oldRsiSignal`），
  并对多组确定性价格序列（flat / up-down / down-up / 震荡 / 上拉-回调-恢复）逐根比较：
  **每根 K 线的 LONG / CLOSE / HOLD 完全一致**（含 warmup 首批发包路径）。

**结论表述（诚实版）**：
> 当前未发现明显行为变化；golden-master 回归测试证明"从重构前源码快照逐字重建的逻辑"与
> 现有 `computeSignal` 在测试序列上完全一致。但因缺少受版本控制的重构前原文件，无法做出
> "逐字节等价已严格证明"的绝对声明。该证明强度为"基于忠实重建 + 黄金主测试的行为级一致"。

---

## 3. 文档与代码的不一致（本阶段仅记录，不改策略）

| 来源 | 描述 | 与代码实际 | 结论 |
|------|------|-----------|------|
| HANDOVER.md | "趋势向上 + 金叉 + RSI 从超卖(<35)回升越过 40" | 入场无需真金叉，无需 RSI<35 | **不符** |
| README.md | "Trend up + EMA golden cross + RSI recovering from oversold (<40)" | "金叉"实为状态比较；"oversold(<40)" 实为 rsiPrev<=40 | **部分不符** |
| 代码注释（rsiEma.js:71） | "Entry: ... EMA golden cross" | 实际为 `emaFast > emaSlow` 状态比较 | **注释误导** |

> 依据任务约束："本阶段禁止为了让回测好看而修改策略条件"。因此**不改策略逻辑**，只记录差异。
> 建议后续把 HANDOVER/README/注释改为与代码一致的真实描述。

---

## 4. 结论

1. 重构未引入行为变化（有 golden-master 测试支撑）。
2. 现有代码的入场条件比文档描述更宽松（无需真金叉、无需 RSI<35），且多一个 `RSI<55` 上限。
3. 这些条件直接影响样本数量：`rsiEma` 在真实数据上的成交次数预计会很少，需结合样本量审慎解读。
4. 本阶段所有回测均以**代码实际条件**为准，不以文档描述为准。

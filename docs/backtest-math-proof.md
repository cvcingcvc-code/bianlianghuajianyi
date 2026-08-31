# Backtest Math Proof（docs/backtest-math-proof.md）

> 手工公式验证，用于证明 `src/research/backtest/` 的资金与 PnL 计算与人工公式一致。
> 公式以 `portfolio.js` / `brokerSimulator.js` 的 **fee-inclusive sizing**（BACKTEST INTEGRITY AUDIT V2 修复后）为准。
> 数值容差：≤ 1e-6 相对误差（测试中按 1e-6 绝对值容差断言）。

---

## 0. 参数

- `initialCapital = 10000`
- `commissionPct = 0.0004`（每笔成交，开+平各收一次）
- `slippagePct = 0.0002`
- `positionSizePct = 100`（即 fraction = 1.0，全部可用资金）

## 1. 开仓（LONG）

```
entryFill   = entryOpen × (1 + slippagePct)      // 例：100 × 1.0002 = 100.02
budget      = cash × fraction                     // 例：10000
notional    = budget / (1 + commissionPct)        // 例：10000 / 1.0004 = 9996.001599...
entryFee    = notional × commissionPct            // 例：3.998400...
quantity    = notional / entryFill                 // 例：99.940028...
cash       -= notional + entryFee                  // == budget（费后现金不取负）
```

## 2. 平仓（CLOSE / LONG）

```
exitFill    = exitOpen × (1 - slippagePct)        // 例：110 × 0.9998 = 109.978
exitNotional= exitFill × quantity
exitFee     = exitNotional × commissionPct
grossPnl    = (exitFill - entryFill) × quantity   // 只含价格差，不含费
fees        = entryFee + exitFee                  // 开一次 + 平一次（无重复）
netPnl      = grossPnl - fees
cash       += exitNotional - exitFee
finalEquity = cash（空仓）
```

## 3. 恒等式（必须成立）

```
cashAfterEntry = initialCapital - notional - entryFee   == 0（fraction=1）
finalEquity    = initialCapital + grossPnl - fees
               = initialCapital + netPnl
totalReturnPct = (finalEquity / initialCapital - 1) × 100
returnPct      = (netPnl / notional) × 100   // 每笔相对投入本金的收益率
```

## 4. 赢利交易（entry open = 100，exit open = 110）

| 量 | 人工公式值 |
|---|---|
| entryFill | 100.020000 |
| exitFill | 109.978000 |
| notional | 9996.001599 |
| entryFee | 3.998401 |
| quantity | 99.940028 |
| exitNotional | 10991.204398 |
| exitFee | 4.396482 |
| grossPnl | +995.202799 |
| fees | 8.394882 |
| netPnl | **+986.807916** |
| finalEquity | **10986.807916** |
| totalReturnPct | **+9.868079%** |
| returnPct | +9.872026% |

## 5. 亏损交易（entry open = 100，exit open = 90）

| 量 | 人工公式值 |
|---|---|
| entryFill | 100.020000 |
| exitFill | 89.982000 |
| grossPnl | -1003.198001 |
| fees | 7.595522 |
| netPnl | **-1010.793523** |
| finalEquity | **8989.206477** |
| totalReturnPct | **-10.107935%** |

## 6. 无隐式杠杆证明

```
fraction ≤ 1  ⇒  notional = budget/(1+comm) ≤ cash
quantity × entryFill = notional ≤ cash ≤ equity
```

开仓后 `cash ≥ 0`，`notional ≤ equity` → 杠杆 ≤ 1x，无借钱。✓

## 7. 费用/滑点单次计数

- commission：开仓一次（entryFee）+ 平仓一次（exitFee），`netPnl` 扣一次，`cash` 同一次。无重复。
- slippage：只在 `entryFill / exitFill` 中体现一次；`PnL` 与 `cash` 均基于该 fill 价，不再额外扣。
- 测试 `NetPnL_difference(comm=0 → comm>0)` 必须严格等于手续费差（见 `tests/backtest-integrity.test.js`）。

## 8. Equity Curve / 收益率

```
equity(bar) = cash + (持仓中 ? quantity × bar.close : 0)
Total Return      = finalEquity/initialCapital - 1     // 不是 trade 收益相加
Annualized Return = (finalEquity/initialCapital)^(1/years) - 1，years 由真实起止时间推导
```

例：10000 → 11000 ⇒ Total Return = **10.00%**。

## 9. 结束处理

末根 bar 后仍持仓 → 以最后一根 close（滑点调整）强制平仓记账（`forcedExit=true`），
`finalEquity` 为该平仓后的现金。仅用于回测估值。

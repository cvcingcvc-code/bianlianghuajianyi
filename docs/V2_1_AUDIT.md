# ETH Quant Research V2.1 — Phase 1 Audit

Date: 2026-09-15
Baseline: `8cb2dc4d6a410a16b46b95ae5f308849ba8d08ca`

## Scope

This audit is read-only with respect to strategy behavior. No strategy parameters,
holdout data, cost assumptions, or live-trading settings were changed.

## Repository and test baseline

- Repository: `C:\Users\lin\Documents\GitHub\bianlianghuajianyi`
- Remote: `https://github.com/cvcingcvc-code/bianlianghuajianyi.git`
- Branch: `master`
- Working tree before audit: clean
- `npm install`: passed
- `npm test`: failed because the clone intentionally does not contain ignored market CSVs under `data/market/`; the failure set is recorded in the handoff report.
- `npm run typecheck`, `npm run build`, and `npm run lint`: no such scripts are defined in `package.json`.

## Architecture observed

| Area | Current implementation | Audit result |
| --- | --- | --- |
| Strategy | `src/strategy/emaCrossover.js`, `src/strategy/rsiEma.js`; research candidates under `src/research/strategies/` | Existing strategy code is frozen by repository rules; changes deferred to later approved phase |
| Execution timing | `src/research/backtest/backtester.js` queues signals and fills at the next bar open | PASS; no same-bar fill observed |
| Costs | `src/research/backtest/brokerSimulator.js` models commission, slippage, and optional funding | Existing model is covered by tests; unified V2.1 accounting remains future work |
| Portfolio/risk | `src/research/backtest/portfolio.js` tracks one long position, cash, equity, fees, and funding | Single-position long-only invariant is explicit |
| Funding | `src/research/funding/` provides historical and synthetic providers plus validation | Existing funding tests pass where required data is present |
| Holdout | `src/research/holdoutGuard.js` protects 2026 strategy execution | PASS; no holdout unlock performed |
| Data | Market CSVs are ignored/not included in this clone; funding and mark-price data are present | Data-dependent tests cannot complete until approved local data is available |
| State/live execution | Runtime modules exist under `src/`; no V2.1 no-trade, shadow, replay, or sentiment layer is present | Future phases |

## Signal timing and look-ahead review

`runBacktest` computes a signal from candle N after marking candle N and stores a
pending order. That order is executed at candle N+1 `open`. The forced terminal
exit is explicitly marked as a research valuation device. Existing tests cover
next-bar execution and no look-ahead behavior.

The strategy implementations update their state with the current close and use
previous state fields for crossover detection. No future candle access was found
in the reviewed paths.

## Findings requiring Phase 2

### F1 — RSI exit is unreachable (HIGH)

In `src/strategy/rsiEma.js`, `rsiWeakening` requires the current RSI to be below
60, while `rsiTakeProfit` additionally requires the same RSI to be above 65.
The conjunction is impossible, so the RSI take-profit branch can never emit
`CLOSE`. The EMA death-cross exit remains reachable.

This finding is consistent with the requested Phase 2 investigation. It must be
fixed with boundary tests before any later phase proceeds.

### F2 — EMA crossover semantics are already explicit (PASS)

`src/strategy/emaCrossover.js` emits a LONG only for `previousCross === 'below'`
and `currentCross === 'above'`, and emits CLOSE for the inverse transition while
in a position. It does not duplicate signals while already above or below.

## Risk and safety checks

- No Martingale, loss-based position increase, automatic leverage increase, or
  LLM-directed order path was added.
- No real-money execution was enabled. Repository decisions require research-only
  operation.
- No 2026 holdout execution or `--unlock-holdout` invocation was performed.
- Existing strategy and cost assumptions were not modified during this phase.

## Phase 1 conclusion

**PARTIAL / READY FOR PHASE 2**: architecture and timing controls are in place;
the RSI exit bug is confirmed and is the next bounded change. Data-dependent
baseline tests remain blocked by ignored market CSVs absent from the clone.

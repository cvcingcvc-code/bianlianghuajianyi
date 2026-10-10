## D022: Quant 2.0 three-role architecture freeze (2026-10-10)

The user's latest scope is documentation and source audit only, preserving all
existing code/history. Spider collects contract OHLCV/time/provenance/quality;
Jev produces structured market direction, probability, uncertainty, validity and
actual model identity; Grok Bot creates paper drafts linked to Jev assessments
and coordinates bounded simulated cloud tasks. Responsibilities do not overlap.
Independent code risk owns final veto and reduce-only code protection; Paper
Engine handles virtual orders only and cannot import real/private/testnet order
transports. LIVE_TRADING=false, REAL_ORDERS=0.

Existing DeepSeek confidence/action interfaces and mixed local pipelines are
legacy integration candidates, not proof of a Jev Provider or Grok/cloud system.
No score-to-probability substitution, spot-to-contract relabeling, fabricated
quote depth or frozen strategy/risk/cost changes. Freeze specifications and
future A1/A2 gates in docs/quant2/; first complete reproducible single offline
paper flow must pass before other research features. A0 completion does not
release existing research/market/readiness gates; A1/A2 are not started this turn.

## D021: Explicit live product authorization preserves research freezes (2026-10-06)

## Phase8A decision — paper-only autonomous product (2026-10-06)

The latest user instruction supersedes earlier live authorization: LIVE_TRADING=false, EXECUTION_MODE=paper, no private transport in the autonomous namespace. Legacy live component gates are retained; startup/unsafe HTTP controls/UI/launcher are additionally disabled. A cached prior process is paused and keyless but cannot be declared reloaded/terminated after a prior approval rejection; that limitation is recorded.

Build the collector/scanner/math/model/risk/executor/evaluation boundary in src/autonomous without altering frozen research. The code, not the LLM, owns costs, qualification, capital15USDT/default1x/max20, stops/horizon/loss caps and readiness. Theoretical index convergence is an unvalidated paper estimate, not proven arbitrage. Near funding events degrade quality. Settled funding/API tariff uncertainty stays unknown. Actual batch decisions are distinct from safety fallbacks and candidate risk outcomes.

Hash-chained order and evaluation WAL, persistent model attempt reservations/circuit state, process lease and idempotent reconciliation prevent duplicate execution, quota reset and lost evaluation after crash. Unknown interrupted attempts retain billing uncertainty. Existing13 data/acquisition test failures remain failures; do not weaken tests or unlock holdouts to claim completion. Full Phase8A stays BLOCKED until explicit exit gates actually pass. Deployment preparation does not imply a verified Docker build.

The user replaced simulation with Binance real trading and explicitly specified at most15USDT investment and at most20x leverage. A separate execution product in src/aiTrader implements that request; research strategies, costs, holdout gates and earlier reports remain frozen. Default leverage is1x, global account modes are only read, and live order permission is never inferred from startup/configuration/read-only connection. The user starts trading from the reviewed local control panel. Keys stay in process memory. Fixed official endpoints, actual exchange account/rules/fees, single-position ownership and durable client IDs prevent simulated fills and blind mutation retries. Persistent negative-PnL/fee/funding accounting cannot reset on pause/restart/config or replenish from gains. No guaranteed profitability/arbitrage or absolute15USDT loss guarantee is claimed. Real exchange validation remains pending credentials and working official transport.

## D020: Independent historical identifiability and forward operational evidence (2026-10-03)

User authorized separate exchange-time protocol and current public capture. Historical completed bars/prior realized funding are identifiable in exchange time; local receipt without original logs is not reconstructible. Original V1 requires actual quote midpoint and unbound fit, so zero rows are eligible and amendment001 remains proposed, inactive. No original gate is weakened or candidate rewritten. Forward seven-day fixed cohort captures receipts/clocks without accounts/orders; actual network failures retain NOT_READY. See E004_IDENTIFIABILITY_MATRIX.md and E004_FORWARD_CAPTURE_PROTOCOL_V1.md.

# DECISIONS.md — Technical and Research Decisions

> Each decision records: what was decided, when, why, and what the alternatives were.
> Based on git history and actual code, not chat memory.

## D019: E003 definitions freeze does not release incomplete evidence (2026-10-03)

E003 is an independent directional-strategy protocol. Its fixed B0–B3 definitions and cost/inference/gate rules are in docs/eth-v4/E003_PREREGISTRATION.md and companion policies. Historical 2021–2025 stays exposed; 2026 remains excluded/locked; only the fixed 2027 prospective window may later qualify for confirmatory evidence after an explicit release and exposure audit. The specification freeze timestamp is the real Git commit time, recorded separately from config identity.

Mandatory funding-settlement, bid/ask and fee-applicability provenance is unresolved, so Phase 7B.2 remains PREREGISTRATION_INCOMPLETE despite completed definitions and protocol tests. No E002 repair/reopening, strategy execution, training or PnL is authorized. NO VERIFIED EDGE => NO TRADE is the default. Missing evidence must not be converted to EDGE_NOT_SUPPORTED or SHADOW_READY.

## D017: ETH V2 closure and independent V3 preregistration (2026-09-23)

V2 is closed with Prediction FAIL, Trading INCOMPLETE, Engineering COMPLETE and Data Integrity INCOMPLETE; no artifact repair by interpolation or parameter tuning. Existing baseline failures remain disclosed. A final size/hash/timestamp manifest preserves the six requested core files and closure record.

V3 adopts deterministic missing-minute exclusions before any model results and chooses position rule B: the containing validation window becomes INCOMPLETE. High coverage cannot override this. Historical 2021–2025 is reused evidence; conflicting old 2026 exposure notes prevent assuming it is pristine. 2026 remains locked and excluded; 2027 is the prospective locked final holdout. No model runs in this phase. See docs/eth-v3/RESEARCH_PLAN.md and MISSING_DATA_POLICY.md for frozen dates, baselines, gates and stop rule. Null V3 data SHA explicitly means acquisition/binding has not happened, not complete evidence.

## D018: ETH-V3-E001 binds actual inputs before gate execution (2026-09-23)

E001's dataset SHA covers exact bytes of the selected official archives and CHECKSUM files through 2025-12-31, with no transforms. The preregistered constructor requires one-minute trade OHLC, while the available source is 15m, and the frozen structural policy also requires continuous event-coverage and execution-price evidence. Coverage cannot be inferred from funding event counts or candle prices. Thus all three partitions are DATA_INCOMPLETE and the pipeline stops before baseline computation. Prediction status remains NOT EVALUATED. The bound dataset cannot be replaced; descriptive metadata corrections are separate append-only artifacts.

## D001: Next-bar execution model

**Date**: V1 baseline (commit `c681348`)
**Decision**: Signal at bar N close → fill at bar N+1 open. Never at bar N close.
**Why**: Prevents look-ahead bias by construction. A strategy that computes a signal at 4h close cannot realistically fill at that exact close price.
**Alternatives considered**: Same-bar execution (rejected: look-ahead bias).
**Evidence**: `src/research/backtest/backtester.js` — pending order executed at next bar's open.

## D002: Fee-inclusive position sizing

**Date**: Backtest Integrity Audit V2 (commit `6422ea9`)
**Decision**: Position budget = cash × sizePct; notional = budget / (1 + commissionPct). Cash never goes negative. No implicit leverage.
**Why**: Prevents unrealistic leverage and ensures fees are accounted for in sizing.
**Alternatives considered**: Notional = cash × sizePct with fees deducted separately (rejected: allows cash to go negative).
**Evidence**: `src/research/backtest/portfolio.js` — `openPosition()` method.

## D003: Position size 25%

**Date**: V4 development (commit `abfd04d`)
**Decision**: positionSizePct = 25% for all research backtests.
**Why**: Conservative sizing to limit drawdown while allowing meaningful absolute returns.
**Alternatives considered**: 100% (too aggressive), 10% (too conservative for research).
**Evidence**: `scripts/external-validation-v1.js` line: `POSITION_SIZE_PCT = 25`.

## D004: Single-position long-only

**Date**: V1 baseline
**Decision**: Portfolio holds at most one position at a time, long only.
**Why**: Simplifies analysis, avoids short-selling complexity, matches Binance USD-M futures long-side research focus.
**Alternatives considered**: Multi-position, long+short (deferred to future work).
**Evidence**: `src/research/backtest/portfolio.js` — `openPosition()` throws if position already exists.

## D005: UTC-aligned resampling

**Date**: V4 development (commit `abfd04d`)
**Decision**: 15m → 4h resampling uses UTC-aligned boundaries (00:00, 04:00, 08:00, ...). Incomplete windows discarded.
**Why**: Prevents phantom bars and ensures consistent aggregation across all assets.
**Alternatives considered**: Rolling window (rejected: creates inconsistent bars across timezones).
**Evidence**: `src/research/data/resampler.js` — exports `TARGETS` with `'4h': 14400000`.

## D006: 2026 FINAL HOLDOUT = LOCKED

**Date**: V4 freeze (commit `2e866b3`)
**Decision**: All research strategies are blocked from accessing data at/after 2026-01-01. Hard-coded in `holdoutGuard.js`.
**Why**: Prevents data leakage into the final evaluation window. The holdout must remain pristine.
**Alternatives considered**: Soft lock via CLI flag only (rejected: too easy to bypass).
**Evidence**: `src/research/holdoutGuard.js` — `HOLDOUT_START_MS = Date.UTC(2026, 0, 1)`.

## D007: External validation on unseen assets only

**Date**: External Validation V1 (commit `eab2a78`)
**Decision**: BNBUSDT and SOLUSDT were never used in any development stage. They are pure out-of-sample assets.
**Why**: Tests whether the strategy's edge generalizes beyond the assets it was developed on.
**Alternatives considered**: Using all 4 assets in development (rejected: reduces external validity).
**Evidence**: Git history shows no BNB/SOL usage before `scripts/external-validation-v1.js`.

## D008: 4h timeframe selected over 15m/1h

**Date**: V4 development (commit `abfd04d`)
**Decision**: 4h timeframe (`breakout24h4h`) survived development gate; 15m and 1h did not.
**Why**: 4h reduced turnover (234 vs 1132 trades), improved edge/cost ratio (10.73 vs 1.05), and had positive NetExp at BASE cost.
**Alternatives considered**: 15m (too much noise, cost destroys edge), 1h (marginal, NetExp≈0 at BASE).
**Evidence**: `reports/v4/STRATEGY_RESEARCH_V4_REPORT.md` — survival gate table.

## D009: Cost scenarios are fixed, not tunable

**Date**: Backtest Integrity Audit V2 (commit `6422ea9`)
**Decision**: GROSS(0/0), BASE(0.0004/0.0002), STRESS(0.0006/0.0005). These are fixed, not parameters to optimize.
**Why**: Cost parameters represent real market conditions, not optimization targets. Tuning costs = cheating.
**Alternatives considered**: Cost-as-parameter optimization (rejected: overfitting to cost assumptions).
**Evidence**: `scripts/external-validation-v1.js` — `SCENARIOS` object.

## D010: Funding is NOT assumed to be always a cost

**Date**: Real Funding Cost Validation V1 preregistration (pending)
**Decision**: When funding rate is negative, LONG positions RECEIVE funding (cashflow > 0). Funding must be computed from actual historical rates, not assumed positive.
**Why**: Binance funding rates can be negative (especially in bear markets). Assuming always-positive funding would be inaccurate.
**Alternatives considered**: Fixed funding cost (rejected: unrealistic).
**Evidence**: User specification section IX: "不得把所有 funding 都当负成本".

## D011: Funding events are based on actual API data, not synthetic

**Date**: Real Funding Cost Validation V1 preregistration (pending)
**Decision**: Funding must come from Binance `GET /fapi/v1/fundingRate` with full pagination. No 8h-interval synthesis.
**Why**: Historical funding intervals may have changed during special periods. Only actual API data is trustworthy.
**Alternatives considered**: Generate funding events every 8h (rejected: may not match reality).
**Evidence**: User specification section VII: "不要假设 Funding 永远每 8 小时".

## D012: Edge preservation is a hard gate

**Date**: Real Funding Cost Validation V1 preregistration (pending)
**Decision**: If BASE_REAL_FUNDING NetExpectancy drops to ≤0 for any asset, the candidate FAILS. No rescue attempts.
**Why**: If funding destroys the edge, the strategy is not viable for real trading. Modifying the strategy to "fix" this would be overfitting.
**Alternatives considered**: Adjust strategy to account for funding (rejected: violates freeze protocol).
**Evidence**: User specification section XXIII: "若变负：FUNDING DESTROYS EDGE 直接 FAIL".

## D013: Tests use node:test + node:assert

**Date**: V1 baseline
**Decision**: Test framework is Node.js built-in `node:test` with `node:assert`. No external test framework.
**Why**: Zero dependencies, built into Node.js, sufficient for the project's needs.
**Alternatives considered**: Jest, Mocha (rejected: unnecessary dependency).
**Evidence**: All test files in `tests/` use `require('node:test')` and `require('node:assert')`.

## D014: Official Binance data only

**Date**: Historical Data Validation V1 (commit `97dbf15`)
**Decision**: All price data must come from `data.binance.vision` with SHA256 checksum verification.
**Why**: Third-party or aggregated data may have gaps, errors, or adjustments. Official data is the ground truth.
**Alternatives considered**: CoinGecko, TradingView, other aggregators (rejected: reliability concerns).
**Evidence**: `scripts/fetch-binance-um-history.js` — checksum verification, `data/market/*.CHECKSUM` files.

## D015: No live trading during research

**Date**: Always
**Decision**: This repository is purely for research. No live trading, no API keys, no real money.
**Why**: Research integrity. Live trading introduces emotional and financial pressure that can corrupt research methodology.
**Alternatives considered**: Paper trading integration (deferred).
**Evidence**: No API key files, no live trading code in `src/strategy/` that connects to exchange.

## D016: Funding data from data.binance.vision, not fapi.binance.com

**Date**: Real Funding Validation (commit `00d0daf`)
**Decision**: Download official funding rate archives from `data.binance.vision` (public S3 bucket) instead of `fapi.binance.com` (API).
**Why**: `fapi.binance.com` is unreachable (ETIMEDOUT) from OpenCode environment. `data.binance.vision` provides identical official data as monthly ZIP archives with checksums.
**Alternatives considered**: fapi.binance.com streaming/pagination (blocked by network), synthetic funding (rejected for validation).
**Evidence**: `scripts/download-real-funding-archive.js` — downloads from `https://data.binance.vision/data/futures/um/monthly/fundingRate/`

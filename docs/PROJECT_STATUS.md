# PROJECT_STATUS.md — Binance-Trader Quantitative Research

## ETH 预测与合约模拟 V2 — 预登记阶段 2026-09-22

- 用户明确授权独立V2候选例外；原策略、V1和报告不改，2026仍禁止访问，无Live及自动推送。
- 审计见 docs/eth-v2/AUDIT.md；固定研究方案见 docs/eth-v2/RESEARCH_PLAN.md，先提交后计算。
- 基线242项，229通过，13既有失败；待实现唯一4h模型、独立执行与中文页面。

## Dry-run 保护性止损 / 止盈闭环 — 2026-09-22

- 按用户本轮明确授权，仅补齐模拟执行层保护性退出；冻结策略、UI、成本参数、历史研究结果及 Live 均未修改。
- LONG 仓位按已完成 K 线的 low/high 检查 SL/TP；支持跳空成交，同根双触发固定止损优先，记录歧义原因。
- 沿用下一根开盘执行排队订单；开仓成交后当根即可保护。已在开盘完成的策略 CLOSE 优先于后续盘中检查，避免使用未来高低价改变开盘成交。
- 平仓统一更新仓位、钱包、当日已实现盈亏、成交记录和 fill 事件；清理待平仓订单并拒绝空仓重复 CLOSE。
- 既有 Pipeline → RiskBridge → circuit breaker 接收保护性 CLOSE，连续五次亏损熔断的集成测试通过。
- 新增 12 项测试：`npm run test:v1` 27/27 通过；`npm test` 242 项、229 通过、13 项既有失败，与修改前失败名称集合完全一致，无新增回归。
- 限制：OHLC 无法提供真实盘中顺序/时间；非跳空 fill 时间记录为收盘检测时点。模拟权益仍未计资金费率，不构成新的策略收益验证。
- 实现提交：`01d6f90`。既有无关工作区改动保留，未纳入本轮。

## 中文界面 — 2026-09-22

- 默认研究工作台已汉化：标题、指标、连接状态、舆情、风控、成交状态和拒绝原因。
- 趋势网格的验收结果、决策原因、周期和成本情景，以及旧版看板的固定文案已汉化。
- 仅修改显示层和对应的界面文案断言；策略、参数、接口字段与风控逻辑保持原样。
- 验证：230 项测试，217 项通过，13 项既有数据缺失/校验失败；无新增失败。
- 浏览器检查：默认工作台中文状态、信号表和图表显示正常；JavaScript 语法及 diff 检查通过。
- 原有未提交的模拟控制、paper 分析及配置改动保留在本地，未纳入本次提交。
- 实现提交：`fb1f4bf`。

## ETH dual-horizon trend grid V1 — 2026-09-20

- Preregistration: `50a56d9`; independent candidate explicitly requested by user.
- Added official checksum-verified ETH 15m acquisition, online mature-label 30m/1w
  forecast distributions, chronological baseline comparisons, automated exploratory
  LONG/SHORT paper grid lifecycle and separate local dashboard on port 3001.
- 2021-2025: 60 archives / 175,296 bars. 2026 remains locked for this work.
- Combined forecast gate **FAIL**: weekly forecasts worse than baselines every year.
  30m marginally better; this does not establish a tradable or significant edge.
- Exploratory grid run: 0 entries; thresholds unchanged. Funding not modeled in this
  new simulator; no net-profit claim, no live adapter, automatic validated opening disabled.
- Full tests: 227 / 214 pass / 13 pre-existing failures. New tests: 9 / 9 pass.
- Existing dirty paper-10u-15x files, package.json and .gitattributes left untouched.
- Runbook, limitations and diagnostic/reproducibility distinction: [trend-grid-v1.md](trend-grid-v1.md).
- Implementation SHA: `00d398b`. Reproducibility report:
  `reports/trend-grid-v1/2026-09-20T13-22-17-319Z/report.json` (clean candidate code,
  identical FAIL and zero-trade outcome). The first two diagnostic reports remain local.

## Minimal Trading Research V1 — 2026-09-15

- Branch: `feature/minimal-trading-v1`, implementation based on `8cb2dc4`.
- Delivered a separate minimal runtime: official 2025-01 BTC/ETH replay → frozen breakout24h4h → sentiment gate → existing Risk Manager → dry-run next-bar fill → local Dashboard.
- Five read-only APIs; light single-page UI; no Live execution. Legacy non-dry SDK execution also hard-disabled.
- 15 new V1 tests pass. Full suite: 212 tests, 199 pass, 13 pre-existing failures unchanged from baseline (197 / 184 / 13).
- No build script; Node server and browser/API checks completed. Testnet public REST times out in this environment; testnet orders are validation-only, and missing daily loss state blocks LONG.
- Research core, frozen strategies, risk rules, Funding, Holdout and existing research reports were not modified.
- Run `npm start`, open http://127.0.0.1:3000. Read [V1 runbook and acceptance](minimal-v1/README.md) before continuing.
- Implementation commit: `1c0b6cb`. Prior research status is preserved verbatim below; V1 does not resolve inconsistencies in historical handoff notes.

> Last updated: 2026-09-01. Status verified against baseline SHA: `619edc9`.

## Project Goal

Build and validate a systematic long-only futures strategy for Binance USD-M perpetual contracts, using official historical data. The strategy must survive multiple independent validation gates before being considered for final holdout testing.

## Current Stage

**FINAL HOLDOUT DATA READY — STRATEGY STILL LOCKED**

The frozen `breakout24h4h` candidate has passed:
1. Development validation (BTC/ETH, 2021-2025)
2. Cross-asset external validation (BNB/SOL, full available history)
3. Real historical funding validation (all 4 assets, 2021-2025)

Final Holdout data acquisition complete. All 2026 data downloaded from data.binance.vision (28 kline archives + 28 funding archives). Strategy execution remains LOCKED.

## Completed Stages

| Stage | Status | Commit | Report |
| --- | --- | --- | --- |
| Quant Research V1 (baseline) | COMPLETE | `c681348` | `docs/quant-research-v1.md` |
| Historical Data Validation V1 | COMPLETE | `97dbf15` | `reports/HISTORICAL_VALIDATION_REPORT.md` |
| Backtest Integrity Audit V2 | COMPLETE | `6422ea9` | `docs/backtest-integrity-audit.md` |
| Strategy Research V2 (edge diagnosis) | COMPLETE — no candidate survived | `d1430c8` | `reports/v2/STRATEGY_RESEARCH_V2_REPORT.md` |
| Strategy Research V3A (entry quality) | COMPLETE — no candidate survived | `92e784e` | `reports/v3a/STRATEGY_RESEARCH_V3A_REPORT.md` |
| Strategy Research V4 (timeframe) | COMPLETE — breakout24h4h survived | `abfd04d` | `reports/v4/STRATEGY_RESEARCH_V4_REPORT.md` |
| V4 Candidate Freeze | COMPLETE | `2e866b3` | `docs/v4-final-development-candidate.md` |
| Cross-Asset External Validation V1 | COMPLETE — SURVIVED | `eab2a78` | `reports/external-v1/CROSS_ASSET_EXTERNAL_VALIDATION_REPORT.md` |
| Funding Engine Validation (synthetic) | COMPLETE (engine only) | `fda1332` | `reports/funding-v1/REAL_FUNDING_COST_VALIDATION_REPORT.md` |
| Real Funding Data Acquisition (data.vision) | COMPLETE — 23,292 events | `00d0daf` | `data/funding-real/manifest.json` |
| Real Funding Cost Validation V1 | COMPLETE — ALL PASS | `00d0daf` | `reports/funding-real-v1/REAL_FUNDING_COST_VALIDATION_REPORT.md` |
| Final Holdout Protocol V1 | PREREGISTERED + FUNDING REPAIRED | `3eb66b3` / `bbc44c9` | `reports/final-holdout-v1/` |

## Current Frozen Candidate

- **Strategy**: `breakout24h4h` — 4h timeframe, 24-calendar-hour close > prior 6-bar-high breakout + EMA50 trend filter, exit on EMA9/21 death cross
- **Code**: `src/research/strategies/breakout24h4h.js` (thin wrapper around `breakout24hFactory.js` with `windowBars: 6`)
- **Freeze SHA**: `2e866b3fd4f0b38f0570ab31c9dfc77e1030c5a8`
- **Preregistration SHA (V4)**: `59578e98f64446350db3c603896d243bc8b7d214`
- **External Validation Prereg SHA**: `1b886f74ba17fb8f7813e39c7072677ae2809061`
- **External Validation Result SHA**: `eab2a781789403f2ba84970d542d654b9a811ebf`

## Latest Validation Results

### Development (BTC/ETH, 2021-2025, 4h)

| Metric | GROSS | BASE | STRESS |
| --- | --- | --- | --- |
| NetExp% | 0.9% | 0.78% | 0.68% |
| NetPF | 1.47 | 1.39 | 1.33 |
| Sharpe | 0.82 | 0.7 | 0.6 |
| Trades | 234 | 234 | 234 |
| Edge/Cost | N/A | 10.73 | 6.65 |

### External Validation (BNB/SOL, full available history, 4h)

| Asset | NetExp% | NetPF | Sharpe | Trades | STRESS survive |
| --- | --- | --- | --- | --- | --- |
| BNBUSDT | +3.28% | 2.64 | 1.26 | 212 | YES |
| SOLUSDT | +3.49% | 1.99 | 1.17 | 196 | YES |

- Year consistency: 7/10 complete buckets positive (70% ≥ 60% threshold)
- 2025 regime: mixed (not systematic) — BNB +0.35%, SOL -0.64%, BTC -0.74%, ETH -0.75%

### What Has Been Validated (Updated)

- **Funding costs**: All 4 assets validated with real Binance data.vision funding rates (23,292 events, 2021-2025). BTC/ETH show MATERIAL impact (31.6%/48.9% NetPF ratio), BNB/SOL show NEGLIGIBLE impact. All PASS funding-adjusted survival gate.
- **2026 holdout**: LOCKED. Never accessed.

## Current In-Progress / Next Steps

1. **Final Holdout Protocol V1** (DATA READY, AWAITING EXECUTION):
   - Preregistered at `3eb66b3`
   - Data acquired at `902273e`
   - Awaiting human instruction to execute
   - Strategy still LOCKED

## Blockers

- None — all data and prerequisites are ready
- Awaiting human instruction to run Final Holdout

## Prohibitions

- Do NOT modify strategy code or parameters.
- Do NOT unlock 2026 holdout data.
- Do NOT run `--unlock-holdout`.
- Do NOT add new strategies.
- Do NOT change cost model assumptions.
- Do NOT commit secrets or API keys.
- Do NOT skip tests.
- Do NOT use chat memory as sole source of truth.

## Key File Paths

| Path | Purpose |
| --- | --- |
| `src/research/strategies/breakout24h4h.js` | Frozen V4 candidate (windowBars=6) |
| `src/research/strategies/breakout24hFactory.js` | Shared 24h breakout factory |
| `src/research/backtest/backtester.js` | Core backtester (next-bar execution) |
| `src/research/backtest/portfolio.js` | Cash/position/equity tracking |
| `src/research/backtest/brokerSimulator.js` | Commission/slippage/funding modeling |
| `src/research/holdoutGuard.js` | 2026 lock (HOLDOUT_START_MS = Date.UTC(2026,0,1)) |
| `src/research/externalGate.js` | External validation gate functions |
| `src/research/strategyAdapter.js` | Uniform strategy interface |
| `src/research/data/resampler.js` | 15m → 1h/4h UTC-aligned resampler |
| `src/research/data/candleRepository.js` | CSV data loader + validator |
| `docs/v4-final-development-candidate.md` | Freeze rules and candidate spec |
| `docs/cross-asset-external-validation-v1.md` | External validation preregistration |
| `reports/v4/STRATEGY_RESEARCH_V4_REPORT.md` | V4 development report |
| `reports/external-v1/CROSS_ASSET_EXTERNAL_VALIDATION_REPORT.md` | External validation report |
| `reports/external-v1/DATA_QUALITY_REPORT.md` | BNB/SOL data quality |
| `data/market/BTCUSDT-15m.csv` | BTC 15m (2021-01 → 2026-07, 175296 rows) |
| `data/market/ETHUSDT-15m.csv` | ETH 15m (2021-01 → 2026-07, 175296 rows) |
| `data/market/BNBUSDT-15m.csv` | BNB 15m (2020-02 → 2025-12, 206560 rows) |
| `data/market/SOLUSDT-15m.csv` | SOL 15m (2020-09 → 2025-12, 185252 rows) |
| `data/funding-real/` | Real Binance funding data (23,292 events, CSV + manifest) |
| `reports/funding-real-v1/` | Real funding validation reports |
| `docs/final-holdout-protocol-v1.md` | Final Holdout V1 preregistration |
| `data/holdout-2026/` | Holdout data manifest (metadata only) |
| `reports/final-holdout-v1/` | Final Holdout V1 reports |

## Test Status

- 15 test files, 164 tests, all passing
- Run: `npm test`
- Framework: `node:test` + `node:assert`

## Git Status

- Baseline SHA: `619edc9` (docs: update PROJECT_STATUS with funding result SHA)
- Frozen Candidate Freeze SHA: `2e866b3`
- External Validation Prereg SHA: `1b886f7`
- External Validation Result SHA: `eab2a78`
- Funding Preregistration SHA: `1259f8a`
- Synthetic Funding Engine SHA: `fda1332` (engine validation only, NOT real funding evidence)
- Real Funding Data Acquisition SHA: `00d0daf` (data.vision archives + validation)
- Real Funding Validation Result SHA: `00d0daf` (all 4 assets PASS)
- Final Holdout Prereg SHA: `3eb66b3`
- Final Holdout Data Acquisition SHA: `902273e` (all 2026 data downloaded)
- Mark Price Repair SHA: `bbc44c9` (official markPriceKlines, all gates PASS)
- Final Holdout Result: **EXECUTED** (see final-holdout-v1/)
- 2026 Holdout Status: **CONSUMED**

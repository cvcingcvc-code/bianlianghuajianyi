# AGENTS.md — AI Development Context Rules

> This file governs how AI assistants interact with this repository.
> Every AI session MUST read this file before doing any work.

## 1. Session Handoff Protocol

### Before Starting Any Task
1. Read `docs/PROJECT_STATUS.md` — this is the single source of truth for project state.
2. Read `docs/DECISIONS.md` — understand why things are the way they are.
3. Read `docs/VALIDATION_PROTOCOL.md` — understand what gates exist and why.
4. Run `git log --oneline -15` — see recent commits.
5. Run `npm test` — verify current test status.
6. Check `git status --short` — know if working tree is clean.

### After Completing Any Phase
1. Update `docs/PROJECT_STATUS.md` with new status.
2. Commit with a descriptive message.
3. Record the commit SHA in `docs/PROJECT_STATUS.md`.

### Context Hierarchy (Priority Order)
1. **Git history** — `git log`, `git show`, `git diff` are ground truth.
2. **Code** — source files in `src/` are ground truth.
3. **Tests** — `npm test` results are ground truth.
4. **Reports** — `reports/` directories contain official outputs.
5. **Docs** — `docs/` files record decisions and status.
6. **Chat memory** — NEVER treat chat conversation as sole source of truth.

## 2. Forbidden Actions

- Do NOT modify strategy parameters, entry/exit logic, or indicator settings.
- Do NOT unlock 2026 holdout data without explicit user instruction.
- Do NOT run `--unlock-holdout` flag.
- Do NOT add new strategies or modify existing strategy code.
- Do NOT change cost model assumptions (commission/slippage percentages).
- Do NOT delete or overwrite existing reports.
- Do NOT commit secrets, API keys, or credentials.
- Do NOT assume a library is available — check `package.json` first.
- Do NOT skip tests after making changes.
- Do NOT use chat memory as the sole source of truth.

## 3. Coding Conventions

- Run `npm test` after any code change.
- Run `git diff --check` before committing.
- Use `node:assert` for tests (the project uses `node:test` and `node:assert`).
- Follow existing code style — no new dependencies without checking `package.json`.
- Research strategies go in `src/research/strategies/`.
- Research backtests go in `scripts/`.
- Research reports go in `reports/<phase>/`.
- Research docs go in `docs/`.

## 4. Data Discipline

- Official Binance USD-M futures data from `data.binance.vision` only.
- Checksum-verified with `.CHECKSUM` files.
- Development data: 2021-01-01 to 2025-12-31.
- External validation data: per-asset actual listing date to 2025-12-31.
- 2026 = FINAL HOLDOUT = LOCKED (never accessed without explicit unlock).
- No fabricated, interpolated, or synthetic price data.

## 5. Strategy Freeze Protocol

When a candidate is frozen:
1. Record freeze SHA in `docs/v4-final-development-candidate.md`.
2. Never modify the frozen strategy code.
3. All validation must reference the freeze SHA.
4. Any modification = new candidate = new freeze = restart validation.

## 6. Key File Paths

| Path | Purpose |
| --- | --- |
| `docs/PROJECT_STATUS.md` | Current project state (single source of truth) |
| `docs/DECISIONS.md` | Important technical and research decisions |
| `docs/VALIDATION_PROTOCOL.md` | Validation gates and anti-tampering rules |
| `src/research/strategies/breakout24h4h.js` | Frozen V4 candidate |
| `src/research/strategies/breakout24hFactory.js` | Shared 24h breakout factory |
| `src/research/backtest/backtester.js` | Core backtester (next-bar execution) |
| `src/research/backtest/portfolio.js` | Cash/position/equity tracking |
| `src/research/backtest/brokerSimulator.js` | Commission/slippage/funding modeling |
| `src/research/holdoutGuard.js` | 2026 lock mechanism |
| `src/research/externalGate.js` | External validation gate functions |
| `src/research/strategyAdapter.js` | Uniform strategy interface |
| `src/research/data/resampler.js` | 15m → 1h/4h UTC-aligned resampler |
| `src/research/data/candleRepository.js` | CSV data loader + validator |
| `tests/` | All test files (14 files, 126 tests) |
| `reports/` | All official reports |
| `data/market/` | Price CSV data files |

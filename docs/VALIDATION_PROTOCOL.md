# VALIDATION_PROTOCOL.md — Anti-Tampering and Gate Rules

> This document defines the validation gates, their pass/fail criteria, and rules
> that prevent subsequent AI sessions from weakening criteria due to bad results.

## Core Principle

**Gates are written BEFORE results. Once a gate is defined, it cannot be weakened.
If a candidate fails, it fails. Do not modify the gate, the strategy, or the data
to make it pass.**

## Gate Registry

### Gate 1: Development Survival (V4)

**Defined in**: `docs/strategy-v4-hypotheses.md` (SHA `59578e9`)
**Evaluated on**: BTCUSDT + ETHUSDT, 2021-2025, 4h

| Criterion | Threshold | Required |
| --- | --- | --- |
| BASE NetExpectancy | > 0% | YES |
| BASE NetPF | > 1.05 | YES |
| BASE Sharpe | > 0 | YES |
| STRESS NetExpectancy | >= 0% | YES |
| STRESS NetPF | >= 1.0 | YES |
| Year buckets positive | >= 4/6 | YES |
| BTC positive | > 0% | YES |
| ETH positive | > 0% | YES |
| Trades | >= 100 | YES |

**Result**: `breakout24h4h` PASSED. Commit `abfd04d`.

### Gate 2: External Validation (V1)

**Defined in**: `docs/cross-asset-external-validation-v1.md` (SHA `1b886f7`)
**Evaluated on**: BNBUSDT + SOLUSDT, full available history, 4h

| Criterion | Threshold | Required |
| --- | --- | --- |
| Asset gate (each): BASE NetExp > 0 | > 0% | YES |
| Asset gate (each): BASE NetPF > 1.05 | > 1.05 | YES |
| Asset gate (each): BASE Sharpe > 0 | > 0 | YES |
| Stress gate (each): STRESS NetExp >= 0 | >= 0% | YES |
| Stress gate (each): STRESS NetPF >= 1.0 | >= 1.0 | YES |
| Year consistency | >= 60% positive | YES |
| Sample size (each asset) | >= 100 trades | YES |
| Year concentration | Diagnostic only (P1 flag if > 60%) | NO (diagnostic) |
| 2025 regime | Diagnostic only | NO (diagnostic) |

**Result**: BNBUSDT PASSED, SOLUSDT PASSED. 7/10 year buckets positive. Commit `eab2a78`.

### Gate 3: Funding-Adjusted Validation (V1) — NOT YET DEFINED

**Status**: Pending — must be preregistered before computation.
**See**: User specification sections XXIII-XXIV for proposed gate criteria.

**Proposed criteria** (must be written to `docs/real-funding-cost-validation-v1.md` BEFORE any funding-adjusted results are computed):

| Criterion | Threshold | Required |
| --- | --- | --- |
| Each asset BASE_REAL_FUNDING NetExp | > 0% | YES |
| Each asset BASE_REAL_FUNDING NetPF | > 1.05 | YES |
| Each asset BASE_REAL_FUNDING Sharpe | > 0 | YES |
| Each asset STRESS_REAL_FUNDING NetExp | >= 0% | YES |
| Each asset STRESS_REAL_FUNDING NetPF | >= 1.0 | YES |
| Year consistency (all assets) | >= 60% positive | YES |
| Edge preservation | No asset NetExp drops to <= 0 | YES |
| Funding data completeness | All 4 assets have verified data | YES |

**If any criterion FAIL**: `REAL FUNDING VALIDATION FAILED — FINAL HOLDOUT NOT JUSTIFIED`

### Gate 4: Final Holdout (V1) — LOCKED

**Status**: 2026 data LOCKED. Not accessible without explicit unlock.
**Criteria**: Not yet defined (defined in future phase).

## Anti-Tampering Rules

### Rule 1: Preregistration Before Computation

Every validation phase MUST:
1. Write the gate criteria to a doc file BEFORE computing results.
2. Commit the preregistration doc.
3. Record the preregistration SHA.
4. ONLY THEN run the computation.

**Never**: Compute results first, then define gates to match.

### Rule 2: Freeze SHA Is Immutable

The freeze SHA (`2e866b3`) identifies the exact strategy code being validated.
If ANY code change is made to the strategy, it is a NEW candidate with a NEW freeze SHA.
The old validation results no longer apply.

**Never**: Modify strategy code and claim old validation still holds.

### Rule 3: Cost Parameters Are Not Tunable

Cost scenarios (GROSS/BASE/STRESS) represent real market conditions.
They are NOT parameters to optimize. Changing cost assumptions to make a
candidate pass = cheating.

**Never**: Adjust commission/slippage percentages to improve results.

### Rule 4: Data Is Not Selectable

All available data within the declared time range MUST be used.
You cannot drop years, assets, or time periods because they produce bad results.

**Never**: Shorten data range to avoid bad years.

### Rule 5: 2026 Holdout Is Sacred

2026 data is the FINAL HOLDOUT. It must remain untouched until the final phase.
Accessing it early = invalidates the entire validation framework.

**Never**: Run `--unlock-holdout`. Never read 2026 data during development or validation.

### Rule 6: Failed Candidates Stay Failed

If a candidate fails a gate, it fails. Do not:
- Modify the strategy to make it pass.
- Modify the gate to make it pass.
- Modify the data to make it pass.
- Modify the cost model to make it pass.
- Re-run with different random seeds.

**Instead**: Accept the failure, document it, move to the next candidate (if any).

### Rule 7: Chat Memory Is Not Ground Truth

AI assistants may have conversation context that contradicts the repo.
The repo (git history, code, tests, reports) is ALWAYS the ground truth.

**Never**: Say "I remember from our conversation that..." as evidence.
**Always**: Say "According to git commit X..." or "The report at Y shows..."

### Rule 8: No Silent Continues on Missing Data

If funding data (or any required data) is missing for an asset, that asset
MUST be reported as `FUNDING DATA INCOMPLETE` and CANNOT pass the gate.

**Never**: Assume missing data = zero cost.

## Gate Execution Order

```
1. Preregister gate criteria → commit
2. Download/verify data → commit
3. Run backtests → generate results
4. Evaluate gate criteria → pass/fail
5. Generate report → commit
6. Record result SHA
```

Steps 1-2 MUST complete before step 3.
Step 4 MUST use the preregistered criteria, not post-hoc criteria.

## Verification Commands

Before any commit, run:
```bash
npm test                    # All tests must pass
git diff --check            # No whitespace errors
git status --short          # Verify only intended files changed
```

For funding validation specifically:
```bash
node scripts/funding-validation-v1.js    # Main computation
npm test                                 # Including new funding tests
```

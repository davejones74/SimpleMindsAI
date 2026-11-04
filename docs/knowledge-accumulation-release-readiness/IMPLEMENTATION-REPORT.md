# Implementation Report — Knowledge Accumulation Release Readiness

## 1. Recommendation

**READY WITH CONDITIONS.**

The working-checkpoint architecture, replay-eligibility migration, optimizer bootstrap and crash recovery are safe and demonstrably operational in isolation. The release branch hardens the guard and retention boundaries. A controlled production rollout is appropriate only after the conditions in §8 are met.

No production activation, migration, service restart, training, acquisition or pointer change occurred.

## 2. Branch and commits

| Item | Value |
|---|---|
| Pilot branch preserved | `knowledge-accumulation-pilot-20261102` |
| Pilot implementation | `13a0962` |
| Pilot docs/manifest | `79a9f2c` |
| Release branch | `knowledge-accumulation-release-readiness-20261103` |
| Base | `79a9f2c` |
| Release code commit | `00f338d` |
| Release docs/manifest commit | recorded in `RELEASE-MANIFEST.json` |
| Worktree | `/home/dave/sma-experiments/worktrees/knowledge-accumulation-release-readiness-20261103` |

## 3. Changed files

| File | Change |
|---|---|
| `src/config.js` | default working drift 0.25 → 0.10 |
| `src/training/working-guard.js` | v2: hard individual-group rejection, broad-share based on per-run tolerance, drift fallback 0.10 |
| `src/training/lifecycle.js` | recovery forwards consumption metadata; working recovery metadata |
| `src/training/python-trainer.js` | optimizer mode passthrough |
| `python/sma/brain.py` | explicit optimizer mode (`fresh`, `reset-no-parent-state`, `carried`, `restored`) |
| `python/sma/store.py` | atomic JSON writes; working/last-good protection in prune and prune-runs |
| `scripts/knowledge-pilot/classify-replay.mjs` | reason/domain aggregation for unresolved reconciliation |
| `scripts/knowledge-pilot/analyze-guard-calibration.mjs` | read-only historical guard calibration |
| `test/working-guard-calibration.test.js` | default and threshold scenarios |
| `test/working-crash-subprocess.test.js` | six actual SIGKILL recovery scenarios |
| `test-support/working-crash-child.mjs`, `working-recovery-child.mjs` | subprocess harness |
| `test/working-checkpoint-lifecycle.test.js` | release default/test adjustment |
| `python/tests/test_portability.py` | NVIDIA-only memory test skips on ROCm |
| `python/tests/test_retention.py` | working/last-good prune protection; atomic write |
| `python/tests/test_working_checkpoint.py` | incompatible optimizer state test |

## 4. Guard defaults and calibration

Effective release defaults:

```text
maxRegressionNats       0.05
maxGroupRegressionNats  0.15
maxDriftNats            0.10
minGroupTokens          100
maxRegressedGroupShare  0.75
minGroups               5
```

Pilot Scenario A used `0.10 / 0.20 / 0.25`; its −0.0613 candidate fails the defaults and passes the pilot-wide guard. A real release candidate at −0.0472 passes the defaults; see `pilot-default-1.json` and `GUARD-CALIBRATION.md`.

Historical 83 paired runs: 59 rejected, 13 promoted, 11 inconclusive; rejected overall regression median 0.0212, p90 0.0487, max 0.0852. The release defaults accept 53/59 rejected candidates at the overall level, but the hard group and broad-share rules stop broad/catastrophic cases. Successive +0.04 updates pass at drift 0.04 and 0.08, then reject at 0.12.

## 5. ROCm

Real ROCm environment:

```text
Python 3.14.4
torch 2.12.0+rocm7.14.0
HIP 7.14.60850
AMD Radeon 890M Graphics
```

Focused ROCm validation:

- `tests/test_portability.py` passes after making the NVIDIA-only memory test skip on ROCm; ROCm-aware portability test passes.
- `tests/test_working_checkpoint.py tests/test_retention.py`: 48 passed.
- Real ROCm training: candidate `v001` from `v389`, stable rejected −0.0459, working accepted +0.0472 under defaults, active `v389` unchanged.
- Real ROCm optimizer bootstrap: `reset-no-parent-state` with no parent optimizer; `carried` with `carryOptimizerFrom=v001`.
- Incompatible optimizer state fails closed.

Full ROCm suite: **260 passed, 19 skipped, 0 failed** (`pytest-rocm-full.log`).

## 6. Test results

### Node (release worktree, full suite)

```text
789 tests, 782 passed, 0 failed, 7 skipped
```

New focused suites:

- `test/working-guard-calibration.test.js` — 5 pass.
- `test/working-crash-subprocess.test.js` — 6 pass (actual subprocess SIGKILL at six boundaries).
- `test/working-checkpoint-lifecycle.test.js` — 6 pass.

### Python

- CPU-only focused: working checkpoint/retention/optimizer tests pass; the ROCm-only portability test is expected to fail/skip on CPU.
- ROCm focused: portability passes; working checkpoint + retention 47 passed.
- Full ROCm: **260 passed, 19 skipped, 0 failed** (`pytest-rocm-full.log`).

## 7. Crash, optimizer, retention and replay evidence

- **Crash:** six actual SIGKILL scenarios pass; no incomplete checkpoint is committed, weights/optimizer are not promoted without `COMMITTED`, previous working remains, recovery is idempotent, consumption is exactly once, active unchanged.
- **Optimizer:** explicit modes recorded; incompatible/corrupt state fails closed; no silent pairing.
- **Retention:** working and last-good pointers auto-protected by `plan_prune`/`plan_prune_runs`; atomic JSON writes; no broad pruning added; ~3.0–3.5 GB steady-state bound for 62M.
- **Replay:** production dry run 25,438 scanned; 377 eligible, 3,875 unresolved (1,054 licence-uncertain, 1,312 licence-unknown, 1,509 no-decision), 13,892 ineligible, 7,103 already eligible, 191 not target. No production apply.

## 8. Conditions for rollout

1. ROCm full suite is complete (260 passed, 19 skipped, 0 failed).
2. Approve the release guard defaults and v2 group rules.
3. Rehearse replay migration on a verified snapshot; resolve unresolved records progressively.
4. Verify backups, active identity, storage headroom and rollback drills.
5. Enable working training in a separately authorised bounded production-adjacent pilot before normal production use.
6. Keep `active.json`, frozen eval and stable promotion thresholds unchanged until D5 is separately authorised.

## 9. Remaining risks

- Full ROCm suite is complete and clean; the release environment is CPU/ROCm test hardware, not the production X1 Pro service.
- The crash harness terminates a file-based checkpoint/pointer process, not a full 62M training subprocess mid-step.
- Guard defaults are conservative and evidence-based but not yet validated by a large real calibration run; the 0.05–0.10 band needs more data.
- Replay migration licence classification is source-family-based; unresolved records need item-level review.
- Working checkpoint storage grows with retained optimizer state; retention is explicit, not automatic.
- Working training remains off until a separate decision; code defaults must be reviewed at deployment.

## 10. Final answer

The implementation is **READY WITH CONDITIONS**, not unconditionally ready. The architecture and safeguards are sound; the remaining conditions are operational validation and policy approval, not identified blocking defects. No production state was changed.

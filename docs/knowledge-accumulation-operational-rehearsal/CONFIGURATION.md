# Configuration Verification and ROCm Count Reconciliation

## 1. Approved working guard

The rehearsal used the approved defaults exactly:

| Setting | Value |
|---|---:|
| `WORKING_GUARD_MAX_REGRESSION_NATS` | 0.05 |
| `WORKING_GUARD_MAX_GROUP_REGRESSION_NATS` | 0.15 |
| `WORKING_GUARD_MAX_DRIFT_NATS` | 0.10 |
| `WORKING_GUARD_MIN_GROUP_TOKENS` | 100 |
| `WORKING_GUARD_MAX_REGRESSED_GROUP_SHARE` | 0.75 |
| `WORKING_GUARD_MIN_GROUPS` | 5 |

The working guard is `working-guard-v2` on the release branch. Stable promotion thresholds, the frozen `eval-002` set and `active.json` semantics were unchanged.

## 2. Rehearsal training configuration

| Setting | Value |
|---|---|
| Model lineage | 62M `v389` stable / `v001` working |
| Device | ROCm (`SMA_DEVICE=cuda`) |
| Compute dtype | `bfloat16` |
| Parent | working `v001` (except disabled test: stable `v389`) |
| Corpus | 32 isolated accepted articles (~7.7k estimated tokens) |
| Snapshot limit | 30 rows |
| Replay target | 50% |
| Sequence length | 64 |
| Target epochs | 8 |
| Max steps | 120 |
| Learning rate | `5e-5` |
| Validation | document/source-disjoint, prospective |
| Frozen eval | `eval-002` |
| Stable gate | unchanged `enforce` paired bootstrap, 20 groups |
| Working training | enabled for crash tests; disabled in the restore test |
| Optimizer carry | enabled |
| Active pointer | never changed |

## 3. ROCm count reconciliation

The release documentation contained a stale line:

```text
IMPLEMENTATION-REPORT.md: "- ROCm focused: ... 47 passed."
```

Actual focused count is **48**:

```text
tests/test_working_checkpoint.py   5 tests
tests/test_retention.py           43 tests
                                  --
                                  48 passed
```

Verified with:

```bash
/opt/simpleminds/python/.venv/bin/python -m pytest \
  tests/test_working_checkpoint.py tests/test_retention.py -q
# 48 passed
```

The release branch is preserved at `7f49a8f`; this rehearsal document is the corrected reconciliation. The ROCm full suite result is **260 passed, 19 skipped, 0 failed** (`pytest-rocm-full.log`). Portability-specific ROCm tests pass after skipping the NVIDIA-only dedicated-memory simulation on ROCm.

## 4. Environment

```text
Python 3.14.4
torch 2.12.0+rocm7.14.0
HIP 7.14.60850
AMD Radeon 890M Graphics
```

No production configuration or environment file was changed.

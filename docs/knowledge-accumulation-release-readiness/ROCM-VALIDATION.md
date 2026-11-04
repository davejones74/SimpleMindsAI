# ROCm Validation

## 1. Environment

The supported ROCm runtime was available at `/opt/simpleminds/python/.venv`:

| Item | Value |
|---|---|
| Python | 3.14.4 |
| PyTorch | `2.12.0+rocm7.14.0` |
| HIP | `7.14.60850` |
| Device | AMD Radeon 890M Graphics |
| `torch.cuda.is_available()` | true |
| Device count | 1 |

The CPU-only pilot venv remains `torch 2.14.1+cpu`; it is not evidence for ROCm. The full ROCm suite completed cleanly: 260 passed, 19 skipped, 0 failed.

## 2. Portability test

Initial ROCm run of `tests/test_portability.py` exposed one pre-existing test assumption:

```text
test_cuda_reports_dedicated_memory
assert report["memorySharedWithHost"] is False  ->  True
```

The test monkeypatches NVIDIA `get_device_properties` while running on ROCm, where the APU reports shared host memory. The release branch skips that NVIDIA-only simulation when `torch.version.hip` is set. The ROCm-aware portability test (`test_rocm_environment_device_is_cuda_but_backend_is_rocm`) passes.

After the test fix:

```text
tests/test_portability.py: passed, 2 skipped (ROCm)
```

## 3. Working-checkpoint and retention tests on ROCm

```text
tests/test_working_checkpoint.py tests/test_retention.py
48 passed
```

This includes:

- working/last-good pointer separation;
- optimizer continuity across a new corpus;
- incompatible optimizer state fails closed;
- prune protection for working/last-good;
- atomic JSON writes.

## 4. Real ROCm training checks

The release guard-calibration candidate was trained through the real 62M lineage on ROCm (`SMA_DEVICE=cuda`, bf16 compute, CPU-independent Python eval):

- parent `v389`, candidate `v001`, 120 steps, 30,720 presented tokens, 5,391 unique training tokens;
- stable gate rejected at −0.0459 (paired CI −0.0534..−0.0377);
- working guard accepted at +0.0472 under the release defaults;
- `active.json` stayed `v389`;
- working pointer advanced to `v001`;
- snapshot had 22 fresh, 4 replay, 4 validation rows.

Optimizer bootstrap evidence on ROCm:

| Case | Recorded mode | Evidence |
|---|---|---|
| No retained parent optimizer state | `reset-no-parent-state` | `optimizer-bootstrap-stderr.log` and staged `v001/train-state.json` |
| Parent optimizer state present | `carried` | `optimizer-carry.stderr.log` and staged `v002/train-state.json`, `carryOptimizerFrom=v001` |
| Incompatible state | exception, no checkpoint | `test_working_checkpoint.py::test_incompatible_carried_optimizer_state_fails_closed` |

## 5. Full ROCm suite

The complete Python suite was run in the supported ROCm venv after the portability fix:

```text
260 passed, 19 skipped, 0 failed
```

Log: `pytest-rocm-full.log`. This completes the ROCm validation requirement. The CPU-only venv remains supported for fast logic tests; its expected ROCm-only failure is an environment limitation, not a working-checkpoint regression.

## 6. CPU-only support

The CPU-only venv remains supported for fast logic, retention and pointer tests. It intentionally fails the ROCm-specific portability test because `torch.cuda.is_available()` is false. That is an environment limitation, not a working-checkpoint regression.

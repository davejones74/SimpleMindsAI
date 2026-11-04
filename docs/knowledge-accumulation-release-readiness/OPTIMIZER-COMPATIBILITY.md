# Optimizer Bootstrap and Compatibility

## 1. Explicit modes

The Python trainer records one of four modes in `train-state.json` and the Node run record:

| Mode | Meaning |
|---|---|
| `fresh` | No carry requested; AdamW moments start at zero |
| `reset-no-parent-state` | Carry requested, but the working parent has no `_runs/<parent>.train-state.pt`; a fresh optimizer is used and the reset is recorded |
| `carried` | Carry requested and moments were loaded from the working parent |
| `restored` | Exact `--resume-from` restore (same dataset/config); not the working carry path |

The execution-time mode is in `optimizerMode`; `carryOptimizerFrom` names the parent only when moments were actually carried.

## 2. Safety rules

`python/sma/train.py:648` loads `carry_optimizer_state` with `optimizer.load_state_dict()`. A shape/parameter mismatch raises `ValueError("carry_optimizer_state does not match this model/optimizer…")` before any checkpoint is written. The current run's learning rate, betas, eps and weight decay are reapplied after loading; only moments/step counters are carried.

`python/sma/brain.py:571` loads `_runs/<parent>.train-state.pt` only for the working carry path. It refuses to combine `--carry-optimizer` with `--resume-from`.

No code path pairs weights with an unrelated optimizer file: the staged candidate's weights and optimizer pickle are written from the same training run, and publication moves them together.

## 3. Tested cases

| Case | Result | Evidence |
|---|---|---|
| No parent optimizer state | `reset-no-parent-state`; fresh AdamW; checkpoint published normally | Real ROCm run `optimizer-bootstrap*.log`; staged `v001/train-state.json` |
| Parent optimizer present | `carried`; moments loaded; `carryOptimizerFrom=v001` | Real ROCm run `optimizer-carry*.log`; staged `v002/train-state.json` |
| Incompatible state | fails closed with `ValueError`; no checkpoint | `test_working_checkpoint.py::test_incompatible_carried_optimizer_state_fails_closed` |
| Corrupt metadata/unreadable pickle | load raises; run fails before publish | `load_train_state()` fail-closed path; no fallback to unrelated state |
| Different model configuration | parameter/state shape mismatch → fail closed | same `optimizer.load_state_dict` guard |
| Working newer than stable | training parent = working; stable baseline = active | `pilot-default-1.json`, `parentSelection = stable-bootstrap-working`; lifecycle working tests |
| Rollback to last-known-good | training parent = restored last-good; active unchanged | `test/working-checkpoint-lifecycle.test.js` drift rollback test |
| Interrupted consolidation | working recovery is idempotent; previous working/last-good remain | subprocess crash tests 5–6; `completeWorkingAdvancement` |
| Exact resume | unchanged `--resume-from` path; requires same dataset/config | existing Python resume tests |

## 4. Reset policy

If carry is requested but no optimizer state exists, the trainer **resets** rather than failing the run. The reset is explicit and auditable:

```json
{
  "optimizerMode": "reset-no-parent-state",
  "carryOptimizerFrom": null,
  "carryOptimizerState": null
}
```

If state exists but is incompatible or corrupt, the trainer **fails closed** and writes no checkpoint. It never silently resets in that case.

## 5. Remaining risk

The carry path validates parameter shapes and optimizer structure, but it does not prove that carried moments are semantically optimal for a materially different corpus. The pilot shows it is safe operationally; whether it improves cumulative learning is a training-quality question for the separately authorised calibration run.

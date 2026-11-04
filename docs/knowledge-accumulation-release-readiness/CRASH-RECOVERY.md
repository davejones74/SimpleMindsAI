# Crash Recovery — Actual Subprocess Termination

## 1. Method

`test/working-crash-subprocess.test.js` spawns `test-support/working-crash-child.mjs`. Each child performs one deterministic checkpoint/pointer/consumption step and then calls:

```js
process.kill(process.pid, "SIGKILL");
```

The parent asserts `signal === "SIGKILL"`, then inspects the persisted files. Recovery is run in a second subprocess (`test-support/working-recovery-child.mjs`) using the real `recoverPendingPromotions()` and `completeWorkingAdvancement()` code. A file-based working store is used so the crash is real but the pilot does not touch production.

The fixture starts with:

- stable active `v100`;
- working `v200`;
- last-good `v100`;
- no `v201` candidate;
- no consumption.

No test calls `setActive`; the recovery child deliberately throws if active would move.

## 2. Results

| # | Crash point | Persisted result | Recovery result |
|---|---|---|---|
| 1 | During candidate checkpoint creation | No `v201/COMMITTED`; working `v200`; active `v100`; no optimizer blob | Not treated as committed |
| 2 | After weights written, before optimizer | Staged temp contains weights only; no `COMMITTED`; no optimizer blob; working `v200` | Not treated as committed |
| 3 | After weights + optimizer written, before commit | Staged temp contains both; no `COMMITTED`; working `v200` | Staged pair remains unpublished/unconsumed |
| 4 | During working-pointer write | Candidate `v201` is committed; old `working.json` still `v200`; temporary pointer file is ignored; active `v100`; consumption 0 | Old pointer remains authoritative |
| 5 | After pointer advances, before consumption | `working.json = v201`; `active.json = v100`; consumption 0; weights + optimizer present | Recovery consumes `a1,a2` exactly once; second recovery adds nothing |
| 6 | During recovery/consumption | `working.json = v201`; consumption has `a1`; active `v100` | Recovery adds `a2` only; second recovery adds nothing |

All six Node tests pass. The suite verifies:

- no incomplete checkpoint is treated as committed;
- weights and optimizer artifacts are not promoted without `COMMITTED`;
- the previous valid working checkpoint remains available;
- recovery is idempotent;
- consumption is not duplicated;
- replay/eligibility files are not deleted;
- `active.json` never changes.

## 3. Code fixes required by the exercise

1. **Atomic JSON writes.** `python/sma/store.py:write_json` now writes a sibling temp file, fsyncs, then `os.replace`s the target. A killed pointer writer leaves the old pointer, never a half-written JSON document.
2. **Working recovery metadata.** `recoverPendingPromotions()` now forwards `checkpointRole`/version metadata to `markConsumed`; without this, a recovered working consumption could be recorded without role/version provenance.
3. **Working recovery path.** `completeWorkingAdvancement()` re-drives publish → last-good → working pointer → consumption → manifest settle, idempotently.

## 4. Limitation

This is an actual OS-process termination test at the checkpoint/pointer/consumption boundaries, but it uses a deterministic file-based working store rather than killing a full 62M training subprocess mid-step. A full training-process kill is still subject to Python/PyTorch signal behavior and should be included in the separately authorised production-adjacent pilot.

# Job-41 Repair Report — 2026-10-30

Work Package A only. Work Package B has not been started.

## 1. Exact failure and root cause

Recorded failure (job-41, 2026-10-30T02:00:30.446Z):

```text
python -m sma.brain: error: unrecognized arguments:
--validation-policy document-source-disjoint
--require-prospective-validation
```

Production execution path established:

- Node server PID `2124165`, command `node src/server.js`, started 2026-10-30 01:28:40.
- Deployed Node package version: `0.2.0`.
- Deployed Python executable: `/opt/simpleminds/python/.venv/bin/python` → `/usr/bin/python3` (Python 3.14.4).
- Actual imported module: `/opt/simpleminds/python/sma/brain.py`.
- Deployed `brain.py` mtime: 2026-10-27 21:52:47 UTC.
- Deployed `brain.py` contained **no** `--validation-policy` or `--require-prospective-validation` argparse definitions.
- Deployed `src/training/python-trainer.js`, `src/training/lifecycle.js` and `src/config.js` matched the authoritative checkout and already constructed/passed the new arguments.
- The argument array was correctly ordered after the `train` subcommand.

**Root cause:** deployment/runtime mismatch. Node was updated and passing the new arguments, but the deployed Python `sma` package was an older version that did not define them. This was not an argument-ordering bug and not a wrong virtual environment: the deployed interpreter correctly imports `/opt/simpleminds/python/sma`.

## 2. Fix applied

Updated and deployed only the four required Python source files from the authoritative checkout:

- `python/sma/brain.py`
- `python/sma/data.py`
- `python/sma/train.py`
- `python/sma/portability.py`

Backup of the previous deployed files:

`/opt/simpleminds/.deploy-backup/job41-python-20261030T221635Z/python/sma/`

Deployed file hashes match the authoritative checkout:

| File | SHA-256 |
|---|---|
| `brain.py` | `c2f573386f0ea64c12b0fd79daeec173aef368962e9a53197bf6d0a6125ef8d1` |
| `data.py` | `d8425fb5378b6e8968679e94cdd8c91475afe01710f451e1a0e0105b7a1120af` |
| `train.py` | `6459debfebd031d99ad9e1a2da20daee98c4f207dc9c899b2e8eae758484cc2e` |
| `portability.py` | `98610a5edcaac4ae9e6308733e711cc9466ed98d8a412b86ca3517f6ea45a4fe` |

No Node file was changed for deployment. No service restart was performed. The running Node server and Python student worker were not restarted.

## 3. Node/Python CLI contract

Added a shared Node argument builder in `src/training/python-trainer.js`:

`buildPythonTrainArgs(...)`

The trainer now uses that exact builder. Added `test/python-cli-contract.test.js`, which verifies:

- Every option appears after the `train` subcommand.
- `--validation-policy document-source-disjoint` is present.
- `--require-prospective-validation` is present.
- `--seed` is present and correctly valued.
- The real Python CLI accepts the exact Node-generated argument array.

The deployed runtime was also verified directly:

```text
/opt/simpleminds/python/.venv/bin/python -m sma.brain train ... \
  --validation-policy document-source-disjoint \
  --require-prospective-validation ... --help
```

Result: exit 0; help output includes both options. The deployed module path is `/opt/simpleminds/python/sma/brain.py`.

## 4. Production impact and active job safety

- Active job: **job-40** (learning, continuous), running cycle 106 at inspection time; `trainable: 905`.
- Job-40 was **not stopped, restarted, reconfigured or consumed**.
- Job-41 remains terminally `failed`; it was **not retried**.
- The running server and student worker PIDs were unchanged after deployment:
  - `2124165 node src/server.js`
  - `2124179 /opt/simpleminds/python/.venv/bin/python -m sma.student ...`
- Deploying the Python source files affects future Python training subprocesses. It does not affect the already-running student worker's in-memory code.
- No production active pointer, registry, article store, or timer state was changed.

## 5. Verification results

- New Node/Python CLI contract test: **2 passed**.
- Full Node suite: **724 tests, 717 passed, 0 failed, 7 skipped**.
- Focused Python tests (`test_validation_policy.py`, `test_corpus_roles.py`, `test_training.py`, `test_eval_record.py`, `test_preflight.py`): passed.
- `git diff --check`: clean.
- Deployed runtime module import and exact-argument `--help` parse: passed.
- Python venv emitted an existing `sys.prefix`/`sys.exec_prefix` warning; it did not affect results.

## 6. Can job-41 be retried?

Yes, the original CLI-argument failure is repaired. A retry is safe from the argparse perspective.

A retry may still fail closed with `INSUFFICIENT_VALIDATION` if the current trainable cohort cannot satisfy the mandatory prospective-only validation minimum. That would be the correct policy outcome, not a regression. Job-41 was not retried as part of this repair.

## 7. Git and working-tree status

- HEAD: `42d3b8c` (`Reworking training process.`).
- No commit or push was performed by this assistant.
- Working-tree changes for this repair:
  - modified: `src/training/python-trainer.js`
  - new: `test/python-cli-contract.test.js`
  - new: `docs/JOB-41-REPAIR-REPORT-2026-10-30.md`
  - pre-existing untracked: `scripts/phase2-acquisition-pilot.mjs`, `docs/PHASE2-PROSPECTIVE-PILOT-REPORT-2026-10-30.md`
- The earlier unexpected commit `42d3b8c` remains; it was not created by this assistant.

## 8. Stop state

Work Package A is complete and reported. Work Package B has **not** been started. No candidate training, promotion, deployment restart, or perpetual timer action occurred.

# EXPERIMENT-TEST-REPORT

## Verification completed

| Check | Result |
|---|---|
| Corpus manifest SHA-256 equals frozen identity | PASS |
| All 13 frozen corpus artifacts re-hashed | PASS |
| Training/validation document roles | PASS |
| Exact content-hash overlap | 0 |
| Source overlap | 0 |
| Cluster overlap | 0 |
| Parent model SHA-256 recorded | PASS |
| Parent weights verify against init manifest | PASS |
| Parent lineage RANDOM-rooted, no pretrained weights | PASS |
| Tokenizer hash matches parent and manifest | PASS |
| Experiment manifest generated | PASS |
| Baseline validation evidence | PASS |
| Baseline training evidence | PASS |
| Baseline generation evidence | PASS |
| Training blocked without explicit opt-in | PASS |

## Baseline verification

- Parent: v389.
- Parent model SHA-256: `4ca50873039fa3d0f5af92fc004c368e6a5c40c33a5122b05b337e98627627ff`.
- Weight fingerprint: `a2aa77c0c3efb6b59fea452e206d7e3cc02a5f22a60d4db4527869f338db92a9`.
- `--verify-weights`: **true**.
- Validation loss: **8.316381543489129**.
- Training loss: **8.256554264328038**.
- Validation group 95% half-width: **0.14962623588748258**.
- Generation: `meanRep1 0.30057471264367813`, `maxRun 4`.

## Automated tests

### Full Node suite

Run single-threaded to avoid an unrelated concurrency timeout observed with the default parallel runner:

```text
node --test --test-concurrency=1
745 tests, 738 passed, 0 failed, 7 skipped
```

### Experiment-specific tests

`test/experiment-controlled.test.js`: **21 passed**.

Covered:

- Frozen corpus manifest/hash and disjointness.
- Fail-closed behaviour on a mismatched manifest.
- Isolated parent snapshot lineage and weight identity.
- Manifest includes corpus, parent, tokenizer, protocol and seeds.
- Training arguments preserve document-source-disjoint and prospective-only validation, without legacy fallback.
- Training is blocked unless explicitly enabled.
- Every classifier success/inconclusive/failure condition, including missing/duplicate/incomplete evidence.
- Manifest identity/tampering and fingerprint changes.
- Runtime fingerprint completeness failure.
- Baseline artifact changes.
- Candidate-version collisions and production-path rejection.
- Mandatory pre-flight verification.

### Focused Python tests

Passed:

- `tests/test_corpus_roles.py`
- `tests/test_validation_policy.py`
- `tests/test_training.py`
- `tests/test_eval_record.py`
- `tests/test_preflight.py`

Python venv emitted an existing `sys.prefix`/`sys.exec_prefix` warning; it did not affect results.

### Other checks

- `git diff --check`: clean.
- `node --check scripts/experiment-controlled.mjs`: clean.
- `bash -n deploy/deploy-x1pro-files.sh`: clean (existing deployment helper).
- Test temp directories redirected to `/home/dave/tmp-sma-tests` because `/tmp` tmpfs was near quota.

## What was not tested

- No candidate training was started.
- No optimizer step, promotion, activation, production deployment or final-test access occurred.
- Candidate evaluation orchestration has not been exercised end-to-end because there are no candidate versions yet. Its command construction and classification logic are syntax-tested and the training path is fail-closed.

## Readiness

The experiment is ready for a separate execution authorisation decision. It is not authorised to start training by this report.

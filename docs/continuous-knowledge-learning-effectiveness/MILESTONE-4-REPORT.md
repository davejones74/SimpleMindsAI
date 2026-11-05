# Milestone 4 — Reliable Replay and Demonstrable Learning

**Date:** 2026-11-05  
**Deployed commit:** `7662797` (`Enforce tokenizer-authoritative replay budget`)  
**Stable active:** **`v506`** (promoted by the unchanged gate)  
**Working / last-good:** **`v506`**  
**Production status:** healthy; bounded trial complete; jobs stopped.

This milestone fixed replay composition and produced the first sealed-cohort evidence of cumulative learning.

---

## 1. Replay composition fix

### Root problem

Milestone 3 measured replay shares of 40.8%, 27.8% and 44.8% against a 20% target. The trim function worked on frozen snapshots, but the runtime path did not reliably apply it, and character/4 estimates were not the training denominator.

### Implemented fix

New `src/training/replay-budget.js` and lifecycle integration:

- Measures the **exact snapshot rows** with the student tokenizer after validation partitioning.
- Computes the replay budget from **actual fresh tokens**.
- Rebuilds the snapshot to remove over-budget replay rows before the plan/run are created.
- Applies a final fail-closed check on the trainer preflight, which packs the exact corpus the trainer consumes.
- Default tolerance: **2 percentage points** (`TRAIN_REPLAY_TOLERANCE_POINTS=2`).
- Fails with `REPLAY_SHARE_EXCEEDED` if composition cannot be brought within tolerance.
- Fails with `REPLAY_BUDGET_UNVERIFIABLE` if the tokenizer is unavailable.
- Preserves minimum fresh material; it never silently drops all fresh knowledge.
- The final snapshot manifest and content hash are the auditable artifact.

### Verified production result

| Run | Actual fresh tokens | Actual replay tokens | Measured replay share |
|---|---:|---:|---:|
| `run-430` | 1,553 | 388 | **19.99%** |
| `run-431` | 3,406 | 840 | **19.78%** |
| `run-432` | 7,209 | 1,782 | **19.82%** |

All are within the configured 20% + 2-point tolerance, and in practice essentially at target.

Tests: `test/replay-budget.test.js` (6 tests) covers short/long rows, oversized replay rows, zero-fit, tolerance boundaries and deterministic selection.

---

## 2. Curation and acquisition

### Curation

- Segmented full-source curation remained enabled.
- Cross-domain unit merging remained enabled.
- Source fallback remained enabled: if teacher output is still unusably fragmented, the cleaned source is used rather than discarded.
- Partial chunk failures remain retryable and source completion remains explicit.
- Production logs showed English full-source curation (`Zero-shot_learning`, `Online_machine_learning`, `Batch_learning`, `Curriculum_learning`, `AI_data_center`) with 90–97% coverage.
- Teacher timeouts and partial-source failures still occur; those sources are not marked complete and remain retryable.

### Acquisition and validation supply

- Original frontier preserved untouched.
- Trial used the isolated English-seeded frontier with declared non-English rejection and URL-quality enforcement.
- Fresh English sources were acquired and reviewed.
- Validation supply improved materially:

| Run | Validation blocks | Validation tokens | Shortfall vs 32 |
|---|---:|---:|---:|
| `run-430` | 26 | 3,406 | 6 |
| `run-431` | 32 | 5,280 | 0 |
| `run-432` | 32 | 4,279 | 0 |

No validation requirement was weakened.

---

## 3. Working lineage and optimiser continuity

The working lineage was reset to stable `v493` before the corrected trial, then advanced:

| Version | Parent | Optimizer | Steps completed | AdamW step counter | Weight decay groups | Stable gate | Working guard |
|---|---|---|---|---:|---|---|---|
| `v493` | — | — | 7 | 7 | `[0.01, 0.0]` | previous serving | anchor |
| `v505` | `v493` | carried | 8 | 15 | `[0.01, 0.0]` | **promoted** | accepted |
| `v506` | `v505` | carried | 17 | 32 | `[0.01, 0.0]` | **promoted** | accepted |
| `v507` | `v506` | carried | 35 | 67 | `[0.01, 0.0]` | inconclusive | accepted, then rolled back |

`v506` is now serving and working/last-good. `v507` was rolled back after sealed evaluation showed regression.

---

## 4. Sealed learning results

Cohorts unchanged: prospective 30 docs / 7,861 tokens / 61 blocks; retention 10 docs / 2,017 tokens / 15 blocks.

### Prospective (v493 baseline 8.5510)

| Version | Loss | Mean Δ vs v493 | 95% CI | Worse docs | >0.05 regressions |
|---|---:|---:|---|---:|---:|
| `v493` | 8.5510 | baseline | — | — | — |
| `v505` | **8.5415** | **−0.0098** | **−0.0141 .. −0.0060** | 4/30 | 0 |
| `v506` | **8.5415** | **−0.0106** | **−0.0178 .. −0.0043** | 8/30 | 0 |
| `v507` | 8.5520 | +0.0027 | −0.0215 .. +0.0250 | 18/30 | 7 |

### Retention (v493 baseline 8.4551)

| Version | Loss | Mean Δ vs v493 | 95% CI | Worse docs | >0.05 regressions |
|---|---:|---:|---|---:|---:|
| `v493` | 8.4551 | baseline | — | — | — |
| `v505` | 8.4510 | −0.0091 | −0.0221 .. +0.0018 | 4/10 | 0 |
| `v506` | **8.4398** | **−0.0231** | **−0.0417 .. −0.0052** | 2/10 | 0 |
| `v507` | 8.5142 | +0.0206 | −0.0469 .. +0.0843 | 6/10 | 5 |

**Result:** `v505` and `v506` significantly improved unseen prospective knowledge. `v506` also significantly improved retention. `v507` did not, and was rolled back to `v506`.

The unchanged stable promotion gate independently approved `v505` and `v506`. Stable serving moved from `v493` to `v506` through the gate, not by manual pointer change.

---

## 5. Training activity

| Run | Dataset | Parent | Steps | Tokens presented | Fresh tokens | Replay tokens | Validation tokens | Replay share | Stable | Working |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---|
| `run-430` | `dataset-20261105-142` | `v493` | 8 | 5,347 | 1,553 | 388 | 3,406 | 19.99% | promoted | `v505` |
| `run-431` | `dataset-20261105-144` | `v505` | 17 | 9,526 | 3,406 | 840 | 5,280 | 19.78% | promoted | `v506` |
| `run-432` | `dataset-20261105-146` | `v506` | 35 | 13,270 | 7,209 | 1,782 | 4,279 | 19.82% | inconclusive | `v507` → rolled back |

Throughput: ~560–865 tokens/s on the 62M model; `run-432` presented 13,270 tokens in 23.7 s.

---

## 6. Short-prose subset

The 596-record short-prose subset remained excluded from general production replay. Milestone 3's isolated experiment showed it worsened prospective/validation learning in both seeds; no change to that policy was made.

---

## 7. Tests and operational verification

| Check | Result |
|---|---|
| Node full suite after final code | **832 tests, 825 passed, 0 failed, 7 skipped** |
| Python full suite | all passing except pre-existing CPU-only ROCm portability test |
| Replay budget tests | 6/6 passed |
| Optimizer continuity | `[0.01, 0.0]` preserved; step counters 7→15→32→67 |
| Deployment/migration rehearsal | passed |
| Recovery/crash tests | passed |
| Service health | `ok: true`, 26,115 articles |
| Stable pointer | `v506`, set by promotion gate |
| Working/last-good | `v506` |

---

## 8. Incidents and limitations

1. **Teacher timeouts and partial curation remain.** Long sources can still take multiple teacher calls; failed chunks are retried and sources are not marked complete.
2. **Validation supply can still be tight.** `run-430` had 26 validation blocks; later runs reached 32.
3. **Working checkpoint noise.** `v507` was a meaningful-size update but regressed sealed cohorts; it was rolled back.
4. **Replay budget overhead.** The post-snapshot tokenizer measurement adds a short Python process per run; it is included in the run path but does not change training.
5. **The original frontier remains preserved but unusable for fast English trials**; the isolated English frontier remains the trial source.

---

## 9. Cumulative-learning conclusion

**Cumulative learning has now been demonstrated on the sealed cohorts.**

- `v505` and `v506` improved prospective knowledge with CIs excluding zero.
- `v506` improved retention with a CI excluding zero.
- `v507` regressed and was rolled back.
- Stable serving advanced to `v506` through the unchanged promotion gate.
- Replay composition is now measured on actual tokenizer tokens and meets the configured target within tolerance.

This is a modest but real improvement, not merely more articles, tokens or working advances.

Recommended next actions:

1. Continue the corrected lineage from `v506`, but require sealed-cohort improvement before retaining further working advances.
2. Keep the 596 short-prose subset excluded.
3. Continue on the English frontier and preserve the 32-block prospective validation requirement.
4. Monitor teacher timeout rates and raise curation throughput only through measured improvements.
5. Preserve `v506` as the current serving and rollback anchor.

---

## 10. Evidence

- `evidence/milestone4-sealed-summary-2026-11-05.json`
- `evidence/milestone4-optimizer-2026-11-05.json`
- `evidence/milestone4-final-state-2026-11-05.json`
- `evidence/milestone4-deployment-log-2026-11-05.txt`
- `evidence/milestone4-node-full-suite-2026-11-05.log`
- `evidence/lineage-evals/` (per-version sealed evaluations)
- `evidence/milestone3-licence-backfill-apply-2026-11-05.json`
- `evidence/milestone3-retired-audit-postdeploy-2026-11-05.json`

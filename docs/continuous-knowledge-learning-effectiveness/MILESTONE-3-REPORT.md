# Milestone 3 — Controlled Release and Fresh-Lineage Learning Trial

**Date:** 2026-11-05  
**Deployed commit:** `c4fa71261341a6d9cd82903f87ce88e19178b296`  
**Stable active:** `v493`  
**Working after trial:** `v503` (v504 rolled back)  
**Production status:** deployed, healthy, trial jobs stopped. Stable serving unchanged.

This report distinguishes:
- **deployed/verified** code and configuration;
- **real pipeline throughput** from the production trial;
- **demonstrated learning** on sealed prospective/retention cohorts.

The central conclusion is: the release is deployed and the pipeline processed real material, but **cumulative learning was not demonstrated**. The new working lineage did not beat `v493` on the sealed prospective or retention cohorts.

---

## 1. Release and deployment

### Deployed commits and backups

| Item | Value |
|---|---|
| Final deployed source | `c4fa712` (`Harden replay trimming against missing validation roles`) |
| Implementation commits | `9b82bb7`, `61f897c`, `0300399`, `70c7beb`, `5ac4fde`, `c4fa712` |
| Full production backup | `/var/lib/simpleminds/backups/milestone3-20261104T223215Z` |
| Full backup archive | `store-and-data.tar`, **27G**, SHA-256 `04d278f7c06efa5118856270b036af52f2ecd886478779a7784be4cb02bb12f2` |
| Code backups | `deploy-20261104T223445Z`, `deploy-20261104T225948Z`, `deploy-20261104T232531Z`, `deploy-20261105T005952Z` |
| Service restart | `2026-11-05 00:59:52` UTC |
| Environment | `/etc/simpleminds/simpleminds.env`, SHA-256 `f75d6845be1d6080f64a98ae7cc7af5aeb3079d9809f8770d7dd2fe4dab42046` |
| Health after deployment | `ok: true`, 25,968 articles |

### Effective production configuration

Verified from the running process environment and deployed config:

```text
CURATOR_STRATEGY=segmented
CURATOR_MERGE_ACROSS_DOMAINS=true
CURATOR_FALLBACK_TO_SOURCE=true
CURATOR_FALLBACK_MIN_CHARS=800
LICENCE_ENFORCEMENT=shadow
DISCOVERY_URL_QUALITY=enforce
DISCOVERY_LANGUAGE_PRIOR=reject
REVIEW_PREFILTER_MODE=shadow
TRAIN_CORPUS_MODE=fragment
TRAIN_USE_WORKING_CHECKPOINT=true
TRAIN_CARRY_OPTIMIZER=true
TRAIN_VALIDATION_POLICY=document-source-disjoint
TRAIN_VALIDATION_REQUIRE_PROSPECTIVE=true
TRAIN_REPLAY_PERCENT=20
TRAIN_VAL_BLOCKS=32
EVAL_DATASET_ID=eval-002
PROMOTE_EVAL_SET=/var/lib/simpleminds/data/evaluation/eval-002.jsonl
```

`FRONTIER_DIR` was temporarily redirected to a fresh `/var/lib/simpleminds/data/frontier-milestone3` seeded from the existing English/CRAWL_URLS host set. The original 420k-URL frontier remains untouched at `/var/lib/simpleminds/data/frontier` for rollback.

### Licence migration and audit

Licence backfill was applied to production:

| Result | Count |
|---|---:|
| Scanned | 25,888 |
| Resolved | 25,887 |
| Already resolved | 0 |
| No source host | 1 |
| Safe / allow | 2,765 |
| Uncertain / review | 8,036 |
| Unknown / review | 15,086 |

All non-licence state was unchanged: statuses, reviews, consumption, replay eligibility, trainable count and unique-consumed count were identical before/after.

Retired replay audit after migration was unchanged: 0 automatically safe full records; 596 safe short-prose policy candidates; 944 licence-uncertain; 949 licence-unknown; 4,517 quality-blocked; 2,870 retired-never-consumed; 377 already eligible.

Evidence:

- `evidence/milestone3-licence-backfill-apply-2026-11-05.json`
- `evidence/milestone3-retired-audit-postdeploy-2026-11-05.json`

---

## 2. Fresh working lineage

The old `v493 → v500` working trajectory was abandoned. Working and last-good were explicitly reset to `v493`, then the production trial created a new lineage:

| Version | Parent | Optimizer | Steps completed | AdamW step counter | Weight decay groups | Stable gate | Working guard |
|---|---|---|---|---:|---|---|---|
| `v493` | — | — | 7 | 7 | `[0.01, 0.0]` | serving | rollback anchor |
| `v501` | `v493` | carried | 8 | 15 | `[0.01, 0.0]` | rejected | accepted |
| `v503` | `v501` | carried | 22 | 37 | `[0.01, 0.0]` | inconclusive | accepted |
| `v504` | `v503` | carried | 7 | 44 | `[0.01, 0.0]` | inconclusive | accepted, then rolled back |

`v502` was an interrupted/cancelled attempt (`run-427`), not a working checkpoint.

The corrected parameter-group split is present in every new checkpoint, and step counters continue across carries. `active.json` remained `v493` throughout.

After sealed-cohort evaluation showed `v504` regressed significantly, the existing working rollback restored `v503` as working and last-good. Stable serving was never changed.

---

## 3. Real production trial

### Runs

| Run | Dataset | Parent | Steps | Tokens presented | Fresh docs/tokens | Replay docs/tokens | Validation docs/tokens | Measured replay share | Stable | Working |
|---|---|---|---:|---:|---|---|---|---:|---|---|
| `run-426` | `dataset-20261105-049` | `v493` | 8 | 5,057 | 15 / 1,239 | 20 / 853 | 40 / 2,965 | **40.8%** | rejected | accepted → `v501` |
| `run-428` | `dataset-20261105-051` | `v501` | 22 | 6,639 | 43 / 4,105 | 31 / 1,579 | 3 / 955 | **27.8%** | inconclusive | accepted → `v503` |
| `run-429` | `dataset-20261105-052` | `v503` | 7 | 1,930 | 3 / 955 | 19 / 775 | 1 / 200 | **44.8%** | inconclusive | accepted → `v504`, then rolled back |

### Pipeline observations

- Segmented curation processed real sources and produced full-source coverage logs.
- The teacher still frequently returned very small units; a **source fallback** was added and deployed so long sources are not discarded as sub-block fragments.
- Unit merging across teacher domain labels was added and deployed.
- Discovery language prior was set to `reject`; the original frontier was too dominated by foreign/low-value URLs to yield useful English material quickly, so the trial used a fresh isolated frontier seeded from the existing English/CRAWL_URLS set.
- Training throughput was ~770–865 tokens/s on the 62M model.
- Validation supply improved to 23–32 blocks in some runs but was still erratic; `run-429` used 1 validation document / 200 tokens.

### Replay correction finding — unresolved

The post-partition replay trim did **not** achieve the configured 20% target in production:

- `run-426`: 40.8%
- `run-428`: 27.8%
- `run-429`: 44.8%

The trim function itself works on the frozen snapshots, and the lifecycle call now passes explicit validation IDs. The runtime path still produced higher measured replay shares than the estimate. This is an **open defect**; it did not prevent the working lineage from advancing, but replay composition in these runs is not compliant with the configured target.

---

## 4. Sealed learning results

Cohorts and hashes are unchanged from Milestone 2:

- Prospective: 30 docs / 7,861 actual tokens / 61 blocks.
- Retention: 10 docs / 2,017 actual tokens / 15 blocks.
- Leakage/disjointness checks passed.

### Prospective cohort (v493 baseline 8.5510)

| Version | Loss | Mean Δ vs v493 | 95% CI | Worse docs | >0.05 regressions |
|---|---:|---:|---|---:|---:|
| `v493` | 8.5510 | baseline | — | — | — |
| `v501` | 8.5716 | **+0.0201** | −0.0025 .. +0.0404 | 23/30 | 12 |
| `v503` | 8.5567 | +0.0030 | −0.0224 .. +0.0262 | 20/30 | 8 |
| `v504` | 8.5770 | **+0.0218** | +0.0006 .. +0.0422 | 20/30 | 10 |

### Retention cohort (v493 baseline 8.4551)

| Version | Loss | Mean Δ vs v493 | 95% CI | Worse docs | >0.05 regressions |
|---|---:|---:|---|---:|---:|
| `v493` | 8.4551 | baseline | — | — | — |
| `v501` | 8.4807 | −0.0025 | −0.0599 .. +0.0502 | 6/10 | 3 |
| `v503` | 8.4943 | +0.0087 | −0.0461 .. +0.0612 | 6/10 | 2 |
| `v504` | 8.5192 | **+0.0503** | +0.0147 .. +0.0869 | 8/10 | 5 |

**Conclusion:** no working checkpoint demonstrated improvement on genuinely unseen knowledge. `v504` significantly regressed both prospective and retention; it was rolled back. `v503` is statistically indistinguishable from `v493` and was retained as the least-damaged working checkpoint only.

Evidence: `evidence/milestone3-sealed-summary-2026-11-05.json`, `evidence/lineage-evals/`.

---

## 5. Short-prose replay experiment

The 596-record safe short-prose candidate subset was extracted read-only and kept out of the main trial.

- 596/596 records validated; all safe licence; 14,103 actual tokens / 110 blocks.
- Isolated treatment added them to the segmented training corpus at the same 68-step budget.
- Controls were the matching segmented equal-token runs.

| Seed | Prospective control | Prospective treatment | Retention control | Retention treatment | Validation control | Validation treatment |
|---|---:|---:|---:|---:|---:|---:|
| 4242 | 1.7162 | 1.6630 | 1.6487 | 1.6658 | 1.7130 | 1.6674 |
| 4243 | 1.7215 | 1.6787 | 1.6766 | 1.7158 | 1.7276 | 1.6897 |

Adding the 596 records **reduced prospective and validation improvement** in both seeds; retention improved slightly. Recommendation: **do not enable** these records in general production replay. A future experiment could test a retention-focused use, but current evidence does not justify it.

Evidence: `evidence/short-prose-candidate-manifest-2026-11-04.json`, `evidence/short-prose-experiment-summary-2026-11-04.json`, `evidence/short-prose-experiment-summary-seed2-2026-11-04.json`.

---

## 6. Tests and correctness

| Check | Result |
|---|---|
| Node full suite after final code | **826 tests, 819 passed, 0 failed, 7 skipped** |
| Python full suite | all passing except pre-existing CPU-only ROCm portability test |
| Optimizer continuity | `[0.01, 0.0]` preserved; step counters 7→15→37→44; all carries recorded |
| Deployment/migration rehearsal | backfill apply, audit, rollback, config parse passed |
| Recovery tests | lifecycle crash/exactly-once consumption/working rollback suites pass |
| `git diff --check` | clean |

---

## 7. Incidents and limitations

1. **Replay trim is not accurate in production.** Measured replay share remains 27.8–44.8% despite a 20% target. This is the main unresolved pipeline defect.
2. **Teacher fragmentation remains a constraint.** Even with full-source chunking, the teacher often returns sub-block units. The source fallback and cross-domain merge were added during the trial to mitigate this.
3. **The original frontier is unusable for a fast English trial.** It is dominated by hundreds of thousands of foreign/low-value URLs. A fresh isolated frontier was used; the original remains preserved.
4. **Validation supply is still erratic.** Some runs used 3 validation documents or 1 document; fail-closed behaviour was preserved.
5. **The trial was bounded and then stopped.** Only two meaningful working checkpoints (`v501`, `v503`) plus one rolled-back attempt (`v504`) were produced.
6. **No sealed-cohort improvement was achieved.** Stable serving remains `v493`.

---

## 8. Production readiness recommendation

**The release is operationally deployed and stable, but cumulative learning is NOT demonstrated.**

- Stable v493 remains serving; active pointer unchanged.
- The new working lineage genuinely descends from v493 and uses the corrected optimizer.
- Real production material was acquired, curated, reviewed and trained.
- The sealed prospective/retention results show no improvement; `v504` regressed and was rolled back.
- The replay-mix correction is not yet reliable and needs a follow-up fix before the configured 20% target can be trusted.

Recommended next actions:

1. Fix tokenizer-aware replay trimming (use actual tokenizer counts, not char/4 estimates, or re-trim after preflight).
2. Continue acquisition from the validated English frontier and let the new lineage accumulate more useful tokens before another trial.
3. Do not claim cumulative learning; do not promote a new stable model.
4. Keep the 596 short-prose subset excluded.
5. Preserve the full backup and original frontier for rollback.

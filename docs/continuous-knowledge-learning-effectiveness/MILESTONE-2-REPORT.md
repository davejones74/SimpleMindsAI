# Milestone 2 — Demonstrated Trainability and Cumulative Learning

**Date:** 2026-11-04  
**Branch:** `programme/continuous-knowledge-learning-effectiveness-20261104`  
**Status:** implementation, isolated experiments and deployment rehearsal complete. **Not deployed.** Production remained read-only.

This milestone moved from "the pipeline should improve" to controlled measurement of whether the changes actually produce more useful trainable knowledge and better learning.

---

## 1. Executive result

- Full-source segmentation and raw-text curation produce **~10× more usable tokenizer tokens/blocks** from the same fresh sources than the legacy 14k-slice path.
- In controlled training with the same parent checkpoint, segmented/raw-text curation learned substantially more on a **sealed prospective benchmark** than legacy curation.
- At an **equal token budget**, segmented curation still improved prospective loss by ~**0.08 nats more** than legacy (two seeds); raw-text was ~**0.05 nats** better. No mode caused a regression on the sealed prospective or validation cohorts.
- Legacy curation showed better **retention-probe memorisation** because it repeats the first 14k characters, including the probe. This is expected and is why retention and prospective generalisation are reported separately.
- On the **existing production working lineage**, sealed prospective and retention measurements show no reliable cumulative gain: `v495`/`v497` were significantly worse than `v493` on prospective knowledge, and `v500` remained slightly worse on retention. This confirms that working advancement alone is not learning.
- Legacy replay recovery found **0 automatically safe full records** under the current conservative policy, but identified a defensible **596-record / 17,573-estimated-token safe short-prose subset** that requires an explicit replay policy decision.
- The optimiser correction is verified end-to-end: carried state preserved `[0.01, 0.0]`, step counters advanced, and all 148 moment tensors changed.
- The isolated migration/deployment rehearsal passed licence apply, audit, rollback and config parsing.

---

## 2. Sealed evaluation cohorts

### 2.1 Construction

Cohorts were built from Project Gutenberg public-domain books, separate from all training/validation sources:

- **Prospective:** 6 books, 30 fixed documents, **7,861 actual tokens / 61 blocks**.
- **Retention:** fixed probe from the first 2k chars of each training source, 10 documents, **2,017 actual tokens / 15 blocks**.
- Training/validation sources: Pride and Prejudice, Frankenstein, Moby Dick, Sherlock Holmes, A Tale of Two Cities; validation: War and Peace.
- Prospective sources: Alice, War of the Worlds, Tom Sawyer, Huck Finn, Dracula, Emma.

### 2.2 Leakage and disjointness

- All cohort manifests are sealed (`sealed: true`, `neverTrain: true`) with content hashes and dataset hashes.
- Prospective content-hash and source-URL leak check against all training corpora: **passed**.
- Prospective/retention disjointness: **passed**.
- No training code reads the cohort directories.

Evidence: `evidence/curation-experiment-corpus-manifest-2026-11-04.json`, `evidence/curation-experiment-token-measurements-2026-11-04.json`.

### 2.3 Existing production lineage baseline

The production checkpoint weights were copied read-only into an isolated store and scored on both sealed cohorts. No production file was modified.

**Prospective cohort (30 docs / 7,861 tokens / 61 blocks):**

| Version | Loss | Δ vs `v493` | 95% paired CI | Worse docs |
|---|---:|---:|---|---:|
| `v493` | 8.5510 | baseline | — | — |
| `v495` | 8.5725 | **+0.0188** | +0.0088 .. +0.0288 | 24/30 |
| `v497` | 8.5708 | **+0.0193** | +0.0006 .. +0.0354 | 25/30 |
| `v499` | 8.5651 | +0.0128 | −0.0010 .. +0.0273 | 20/30 |
| `v500` | 8.5420 | −0.0071 | −0.0252 .. +0.0104 | 14/30 |

**Retention cohort (10 docs / 2,017 tokens / 15 blocks):**

| Version | Loss | Δ vs `v493` | 95% paired CI | Worse docs |
|---|---:|---:|---|---:|
| `v493` | 8.4551 | baseline | — | — |
| `v495` | 8.4723 | +0.0201 | −0.0024 .. +0.0413 | 8/10 |
| `v497` | 8.5151 | +0.0430 | −0.0129 .. +0.0960 | 7/10 |
| `v499` | 8.4842 | **+0.0320** | +0.0012 .. +0.0653 | 7/10 |
| `v500` | 8.5446 | +0.0629 | −0.0038 .. +0.1319 | 6/10 |

Interpretation:

- Working advancement did not produce a reliable improvement on unseen prospective knowledge.
- `v500` improved significantly versus `v499` on the prospective cohort (`−0.0199`, CI −0.0329 .. −0.0072) but is still not better than `v493`.
- Retention on the sealed probe did not improve; `v499` was significantly worse than `v493`.

Evidence: `evidence/lineage-sealed-baseline-2026-11-04.json`.

---

## 3. Legacy vs segmented vs raw-text curation

### 3.1 Controlled design

- Same randomly-initialised 62M parent for all modes (`sma.brain init --config small --seed 4242`), copied into isolated stores.
- Same training sources, validation source and sealed cohorts.
- Corpus caps: 60k chars per training source; 40k chars validation.
- Tokenizer: the production SmolLM3 tokenizer.
- No teacher variance: deterministic sentence-aligned units simulate curation output so the comparison isolates **source coverage**, not LLM sampling.
- Licence: all sources are Gutenberg public-domain (safe).
- Deterministic quality gate: all constructed rows passed; this is not a claim about teacher approval.

### 3.2 Token/block yield from the same sources

| Mode | Train rows | Train tokens | Train blocks | Validation tokens | Validation blocks |
|---|---:|---:|---:|---:|---:|
| Legacy (14k slice) | 76 | 17,254 | 134 | 3,450 | 26 |
| Segmented (full source) | 322 | 73,284 | 572 | 9,742 | 76 |
| Raw-text | 5 | 73,361 | 573 | 9,749 | 76 |

Segmented/raw-text produce **~4.2× fresh training tokens and ~4.3× training blocks** from the same sources.

### 3.3 Full two-epoch run (seed 4242)

| Mode | Steps | Tokens presented | Prospective Δ | Retention Δ | Validation Δ | Final train loss | Final val loss | Throughput |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Legacy | 68 | 34,816 | **1.6353** | **2.0532** | **1.6010** | 9.665 | 10.166 | ~1,706 tok/s |
| Segmented | 288 | 147,456 | **4.2384** | **4.5310** | **4.1990** | 6.539 | 7.631 | ~1,702 tok/s |
| Raw-text | 287 | 146,944 | **4.2180** | **4.4300** | **4.0996** | 7.014 | 7.813 | ~1,710 tok/s |

All improvements are positive reductions in loss; **0 regressing documents** on prospective and retention cohorts in every mode.

### 3.4 Equal-token control (68 steps = 34,816 tokens, two seeds)

| Mode | Seed 4242 prospective | Seed 4243 prospective | Avg | Avg retention | Avg validation |
|---|---:|---:|---:|---:|---:|
| Legacy | 1.6353 | 1.6371 | **1.6362** | **2.0677** | 1.6443 |
| Segmented | 1.7162 | 1.7215 | **1.7188** | 1.6626 | 1.7203 |
| Raw-text | 1.6818 | 1.6992 | **1.6905** | 1.6331 | 1.6411 |

At equal token cost, segmented curation beats legacy by **~0.083 nats** on sealed prospective knowledge and **~0.076 nats** on validation; raw-text beats legacy by **~0.054 nats** prospective. No mode regressed any prospective document.

Legacy's retention result is higher because its 14k slice repeats the first 2k chars used by the retention probe; this is a memorisation effect, not better generalisation. Segmented/raw-text still retain the probe strongly while generalising better.

### 3.5 What this does and does not show

**Shows:** more of the same source becomes useful trainable material, and that material produces substantially more learning on genuinely unseen documents.

**Does not show:** that token volume alone is sufficient. Equal-token results show a smaller but consistent data-quality effect; the large two-epoch gains come from both more data and more steps. Raw-text was competitive with segmented but not clearly better.

Evidence:

- `evidence/curation-experiment-summary-2026-11-04.json`
- `evidence/curation-experiment-equal-summary-2026-11-04.json`
- `evidence/curation-experiment-equal2-summary-2026-11-04.json`
- `evidence/curation-experiment-token-measurements-2026-11-04.json`

---

## 4. Legacy replay recovery

Read-only audit of 10,253 retired records:

| Classification | Count | Est. tokens |
|---|---:|---:|
| Already eligible | 377 | 27,781 |
| Retired, never consumed | 2,870 | 160,809 |
| Blocked by quality/completeness | 4,517 | 87,256 |
| Blocked by uncertain licence | 944 | 108,926 |
| Blocked by unknown licence | 949 | 106,864 |
| **Safe short-prose policy candidate** | **596** | **17,573** |
| **Automatically safe full records** | **0** | **0** |

Cross-tab of the consumed/approved/non-replayable cohort:

- Safe-licence, quality-blocked: 933 records / 10,143 est. tokens.
- Safe-licence, short-prose completeness quarantine only: **596 records / 17,573 est. tokens**.
- Uncertain/unknown licence quality-blocked: 3,584 records / 77,113 est. tokens.
- Uncertain/unknown licence explicit blocks: 1,893 records.

**Recommendation:** do not auto-enable the 596 safe short-prose records. They are licence-safe and language/quality pass, but are very small fragments (average ~29 estimated tokens). They are a defensible candidate for a **controlled replay experiment**, not a blanket migration. Uncertain and unknown records remain excluded.

Evidence: `evidence/retired-replay-audit-2026-11-04.json`.

---

## 5. Integrated correctness

### Optimiser carry

Isolated end-to-end continuation `v494 → v495` on the segmented corpus:

| Check | Result |
|---|---|
| Parameter groups | `57 + 17` |
| Weight decay | `[0.01, 0.0]` before and after carry |
| Optimiser steps | `68 → 70` |
| State entries | 74 |
| Moment tensors compared | 148 |
| Moment tensors changed | **148 / 148** |

The carry preserved the intended no-decay group, continued the counters, and advanced the moments.

Evidence: `evidence/optimizer-integrated-verification-2026-11-04.json`.

### Replay, validation, recovery and defaults

Focused integrated suite passed **43/43**:

- post-partition replay trimming;
- working-checkpoint crash recovery and exactly-once consumption;
- validation role packing and preflight;
- discovery URL-quality enforcement;
- segmented curation;
- tokenizer measurement.

Evidence: `evidence/integrated-correctness-tests-2026-11-04.log`.

---

## 6. Deployment/migration rehearsal

Isolated rehearsal performed on a throwaway store:

| Check | Result |
|---|---|
| Licence backfill dry-run read-only | passed |
| Licence backfill apply | 3/3 records resolved |
| Retired audit classification | safe full 1, safe short 1, uncertain 1 |
| Rollback restored pre-migration licences | passed (all `null`) |
| New environment config parsed | `segmented`, `enforce`, `shadow`, `shadow` |

No production store, service, job, pointer, environment or data was touched.

Evidence: `evidence/deployment-rehearsal-2026-11-04.json`.

---

## 7. Before/after against the initial assessment

| Measure | Initial assessment | Milestone 2 result |
|---|---:|---:|
| Current fresh trainable tokens | 3,103 actual tokens / 24 blocks | same production baseline, but segmentation exposes **~40,947 cleaned raw tokens / 319 blocks** from the same fresh cohort (~10.5×) |
| Legacy source coverage | ~25.7–30.4% of source chars | segmented **95.7%** |
| Prospective validation supply | 97 actual tokens / 0 blocks | current cohort **1,208 tokens / 9 blocks**; still 23 blocks short of target |
| Legacy replay loss | 7,006 non-replayable | 0 auto-safe; **596 safe short-prose candidates / 17,573 est. tokens** requiring policy decision |
| Working lineage sealed prospective | not measured | `v495`/`v497` significantly worse than `v493`; `v500` slightly better but not significant |
| Working lineage sealed retention | not measured | `v499` significantly worse than `v493`; `v500` +0.063 nats (CI includes zero) |
| Optimiser group decay | corrupted `[0.01, 0.01]` | verified `[0.01, 0.0]` with continuous moments/counters |
| Controlled curation learning | not measured | segmented vs legacy equal-token: **+0.083 nats** prospective advantage across two seeds |

---

## 7b. Test evidence

- Node full suite: **824 tests, 817 passed, 0 failed, 7 skipped**.
- Python full suite: all passing except the pre-existing CPU-only ROCm portability test.
- Focused integrated correctness: **43/43 passed**.
- `git diff --check`: clean.

Logs: `evidence/node-full-suite-2026-11-04.log`, `evidence/python-full-suite-2026-11-04.log`, `evidence/integrated-correctness-tests-2026-11-04.log`.

---

## 8. Remaining risks

1. **Production weights require privileged access for sealed scoring.** The lineage baseline was measured from an isolated read-only copy; the normal development user cannot read the production model files.
2. **The 596 safe-short replay subset is untested as training material.** It is licence-safe but tiny; do not migrate without a controlled replay experiment.
3. **The curation experiment used deterministic curation units, not the live teacher.** It isolates source coverage; teacher output quality remains a separate variable.
4. **Raw-text mode was competitive, not superior.** Segmenting curated full source is the safer default; raw-text needs cleaning/quality validation before adoption.
5. **The production working lineage still does not show cumulative improvement.** New data pipeline improvements do not retroactively fix the existing `v493…v500` lineage.
6. **Deployment rehearsal covered data migration and config, not a live service restart.** That remains a separately authorised production step.

---

## 9. Recommendation

**Not yet production-ready as a cumulative-learning claim.** The engineering changes are ready for a controlled production release candidate, but the existing working lineage should not be presented as evidence of cumulative improvement.

Recommended order:

1. Deploy the release candidate behind the prepared procedure with licence and prefilter still in `shadow` mode.
2. Run one production cycle with segmentation enabled; verify actual replay share, tokenizer validation blocks and licence provenance.
3. Start a **new working lineage** from the stable checkpoint under the corrected optimizer and segmented curation.
4. Score that lineage on the sealed prospective and retention cohorts; require paired improvement before claiming cumulative learning.
5. Only then consider the 596 safe-short replay subset as a controlled experiment.

**Production readiness:** implementation and isolated evidence are ready for review; deployment requires separate authorisation.

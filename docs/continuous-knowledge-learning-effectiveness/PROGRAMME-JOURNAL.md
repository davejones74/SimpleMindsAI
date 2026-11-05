# Continuous Knowledge and Learning Effectiveness — Programme Journal

**Branch:** `programme/continuous-knowledge-learning-effectiveness-20261104`  
**Base:** `master` @ `ced98fd`  
**Started:** 2026-11-04  
**Production authority:** read-only. No deployment, restart, job change, pointer change, migration or production training data mutation was performed.

This journal is a living milestone record. It distinguishes **implemented**, **tested**, **measured in an isolated/read-only context**, and **production-verified** results.

---

## Milestone 1 — baseline and workstream scaffolding

### Investigated

- Confirmed `master` is authoritative and production `/opt/simpleminds` matched the starting commit.
- Re-ran the baseline suites:
  - Node: **795 tests, 788 passed, 0 failed, 7 skipped**.
  - Python: all tests passed except the pre-existing CPU-only `test_portability.py::test_rocm_environment_device_is_cuda_but_backend_is_rocm` failure (Torch in the test venv is CPU-only).

### Implemented

- Created the programme branch.
- Created the initial read-only assessment at `docs/continuous-knowledge-learning-effectiveness/ASSESSMENT-2026-11-04.md`.

---

## Milestone 2 — optimiser continuity

### Investigated

- Verified `v493` had parameter-group weight decay `[0.01, 0.0]`.
- Verified `v495…v500` had `[0.01, 0.01]`.
- Traced the defect to the carry path in `python/sma/train.py`: every group was overwritten with `cfg.weightDecay`, collapsing the intended no-decay RMSNorm group.

### Implemented

- Carry now captures the constructed per-group decays and re-applies **those** values after loading the parent state.
- Added a regression assertion in `python/tests/test_working_checkpoint.py` that the carried optimizer keeps `[0.01, 0.0]`.

### Verified

- Focused Python test: `test_working_checkpoint.py` passed.
- This is a deliberate hyperparameter transition for the next working run and must be recorded in its provenance; it is not a silent reset of moments or step counters.

---

## Milestone 3 — durable licensing and provenance

### Implemented

- New `src/domain/licence.js`:
  - conservative safe/uncertain/restricted/unknown resolution;
  - explicit licence registry (CC0, public domain, CC BY, CC BY-SA, CC BY-NC, MIT, Apache, BSD);
  - host-based fallback (NASA, NIST, PLOS, Wikipedia, arXiv, etc.);
  - `allow` / `review` / `deny` decisions;
  - training/replay eligibility helpers.
- Article records now carry a durable `licence` object and append-only `licence` events.
- Ingest resolves licence provenance from `sourceUrl` and optional declared `licenceId` / `licenceUrl` / attribution.
- `LICENCE_ENFORCEMENT` supports `off`, `shadow` (default), and `enforce`.
- Restricted/denied licences are excluded from replay even if review history was positive.
- Snapshot rows carry compact licence provenance (`licenceId`, `licenceStatus`, `licenceDecision`, `licencePolicyVersion`, `licenceAttribution`).
- GraphQL `Article` exposes `licence`; `ArticleInput` accepts declared licence fields.
- Store stats expose licence buckets and the approved/consumed/retired replay-loss funnel.
- Runtime policy is pinned to the audited replay policy by `test/licence.test.js`.

### Verified

- New `test/licence.test.js`: 6/6 passed.
- Full Node suite passed after integration.

---

## Milestone 4 — retired-record recovery audit

### Implemented

- New pure classifier `src/training/retired-replay-audit.js`.
- New read-only script `scripts/knowledge-pilot/audit-retired-replay.mjs`.

### Measured (production store, read-only, 2026-11-04)

| Classification | Count | Est. tokens |
|---|---:|---:|
| `ALREADY_ELIGIBLE` | 377 | 27,781 |
| `NOT_CONSUMED_RETIRED` | 2,869 | 160,722 |
| `BLOCKED_QUALITY` | 5,113 | 104,829 |
| `BLOCKED_LICENCE_UNCERTAIN` | 944 | 108,926 |
| `BLOCKED_LICENCE_UNKNOWN` | 949 | 106,864 |
| **`RECOVERABLE_SAFE`** | **0** | **0** |

This is an important negative result: under the current conservative quality + licence policy, **none of the 7,006 consumed/approved/non-replayable records can be safely auto-recovered**. The largest blocker is the deterministic completeness gate (5,113 records), followed by unresolved licences (1,893). A blanket migration would be unsafe and is not proposed.

### Verified

- New `test/retired-replay-audit.test.js`: 4/4 passed.

---

## Milestone 5 — full-source curation and token yield

### Implemented

- New `src/services/curator-segmentation.js`:
  - complete, sentence-aligned source chunking;
  - legacy 14k slice preserved as an explicit strategy;
  - adjacent-unit merging within one domain;
  - coverage accounting.
- Learning cycle now curates **every chunk** of a source, not just the first 14k characters.
- `CURATOR_STRATEGY=segmented` is the new default; `legacy` restores the old path.
- Partial curation no longer marks a source complete, so failed chunks can be retried; content-hash dedup prevents duplicate ingestion of successful chunks.
- The standalone `Curator` class uses the same segmentation path.
- Added `scripts/learning-effectiveness/measure-segmentation.mjs` for read-only before/after measurement.

### Measured (production fresh cohort, read-only, 2026-11-04)

- 40 fresh trainable articles from 13 unique sources.
- Historical 14k plan saw **148,301 / 487,860 chars = 30.4%** of source text.
- Segmented plan sees **467,045 / 487,860 chars = 95.7%**.
- Curated text: **3,882 actual tokens / 30 blocks**.
- Raw representative text: **123,529 actual tokens / 965 blocks** (upper bound; includes boilerplate).
- Cleaned raw text (`raw-text` corpus mode policy): **40,947 actual tokens / 319 blocks** from 6 accepted sources; 7 sources fell back/rejected.
- Conservative cleaned raw-text yield is therefore ~**10.5× the curated token mass** and ~**10.6× the block count** for this cohort, before any new acquisition.

### Verified

- New `test/curator-segmentation.test.js`: 4/4 passed.
- Full Node suite passed.

---

## Milestone 6 — acquisition URL quality

### Implemented

- New `src/discovery/source-quality.js`:
  - rejects Wikimedia File/Category/Special/Template/Talk/User/Portal/Module namespaces;
  - rejects images, media, archives and non-content extensions;
  - rejects login/search/account/cart/checkout/API endpoints;
  - rejects known non-content Wikimedia hosts.
- Discovery policy applies the filter before enqueueing and before seed trust.
- `DISCOVERY_URL_QUALITY=off|shadow|enforce`, default `enforce`.

### Verified

- New `test/discovery-source-quality.test.js`: 4/4 passed.
- Full Node suite passed.

---

## Milestone 7 — review efficiency

### Implemented

- New `src/domain/review-prefilter.js`:
  - deterministic hard non-prose rejection;
  - explicit length/word floor;
  - `off|shadow|enforce`, default `shadow`.
- Review pass runs the prefilter before the teacher and records an automation reject with `gate: "prefilter"` in enforce mode.
- Learning ingest in enforce mode does not immediately queue obvious non-prose for teacher review (it remains retained and recoverable).
- Counters expose `prefilterRejected` and `prefilterShadow`.

### Verified

- New `test/review-prefilter.test.js`: 4/4 passed.
- Full Node suite passed.

---

## Milestone 8 — cumulative learning effectiveness and sealed cohorts

### Implemented

- New `src/training/learning-effectiveness.js`:
  - working trajectory from durable contributions/evaluations;
  - delta vs stable, best/worst, regressions, drift, drift velocity, tokens and efficiency;
  - explicit separation of activity from effect;
  - Markdown renderer.
- New `src/training/sealed-cohort.js`:
  - immutable prospective/retention cohort manifests;
  - content hashes and dataset hash;
  - leak guard against seen content/source URLs;
  - prospective/retention disjointness checks.
- New `scripts/learning-effectiveness/report.mjs` (read-only production report).
- Admin knowledge view now exposes funnel, licence buckets and learning-effectiveness summary/trajectory.

### Measured (production, read-only, 2026-11-04)

- Working advances: 6; measured: 6.
- Net Δ vs stable `v493`: **+0.011532 nats** (worse).
- Best transient: `v497` **−0.006051 nats**.
- Worst: `v496` **+0.027715 nats**.
- Regressions vs stable: **4 / 6**.
- Drift velocity: **+0.002306 nats/advance**.
- Sealed prospective benchmark: **not configured**.
- Retention probe: **not configured**.

This baseline confirms the assessment: the system has working-checkpoint activity, but no demonstrated cumulative improvement, and no sealed prospective/retention measurement yet.

### Verified

- New `test/learning-effectiveness.test.js`: 4/4 passed.

---

## Milestone 9 — tokenizer-aware validation supply

### Implemented

- New model-free Python module `python/sma/measure.py` and CLI.
- New Node wrapper `src/training/tokenizer-measurement.js`.
- New `scripts/learning-effectiveness/measure-validation.mjs` read-only script.
- Optional `KNOWLEDGE_TOKENIZER_MEASUREMENT=true` in the admin knowledge view; default off to avoid spawning Python on every pull.
- `validationAvailability` can now report actual tokenizer tokens, blocks, documents meeting one block, and authoritative shortfall.

### Measured (production, read-only, 2026-11-04)

- Current cohort: 19 articles / 5 prospective clusters.
- Estimated tokens: 1,547.
- **Actual tokens: 1,208.**
- **Actual blocks: 9 / 32 target.**
- Documents meeting one block: 1.
- Shortfall: **23 blocks**.
- Earlier cohort: 3 articles / 131 estimated / **97 actual / 0 blocks**.

### Verified

- New `python/tests/test_measure.py`: 2/2 passed.
- New `test/tokenizer-measurement.test.js`: 2/2 passed.

---

## Milestone 10 — observability and UI

### Implemented

- Knowledge API now returns `funnel`, `licence`, and `learningEffectiveness`.
- Brain knowledge view renders:
  - knowledge-to-trainability funnel;
  - licence provenance buckets;
  - cumulative learning effect;
  - working learning trajectory;
  - authoritative tokenizer blocks when enabled.
- Replay note updated to reflect that the correction is present and the next completed run is authoritative.

### Verified

- `test/knowledge-observability.test.js` extended and passing.
- Full Node suite passing.

---

## Current test status

| Suite | Result |
|---|---|
| Node full suite | **824 tests, 817 passed, 0 failed, 7 skipped** |
| New Node tests | 29 tests across 8 new files, all passing |
| Python focused (`test_working_checkpoint`, `test_measure`) | passing |
| Python full suite | all passing except the pre-existing CPU-only ROCm portability test |

---

## Outstanding risks and blockers

1. **No sealed prospective benchmark or retention probe exists yet.** The framework and tests are implemented; the cohorts must be created from authorised, never-trained source material. This is the main blocker to proving cumulative learning.
2. **No post-deployment production run has exercised the replay correction.** The code is active in production, but the last run predates it. The next completed run is the authoritative test.
3. **Licence recovery is blocked by policy, not by code.** 7,006 legacy records are not auto-recoverable under the current conservative gate. Unlocking them requires item-level licence decisions and a completeness-policy decision.
4. **New defaults change behaviour when deployed.** `CURATOR_STRATEGY=segmented`, `DISCOVERY_URL_QUALITY=enforce`, licence resolution in shadow mode, and the optimiser group-decay fix are release-candidate changes, not deployed.
5. **Cleaned raw-text mode has not been run through the full pipeline.** The isolated measurement is promising (~10× tokens/blocks), but it must be tested with the actual trainer and frozen/sealed evaluation before adoption.
6. **Teacher cost increases** with full-source segmentation. The chunk target and per-cycle caps must be calibrated to available teacher throughput.

## Immediate next steps

1. Create an authorised, never-trained prospective cohort and a disjoint retention probe; run paired scoring on the working lineage.
2. Run an isolated end-to-end `raw-text`/segmented curation experiment with a frozen corpus and measure train/validation/frozen deltas.
3. Review the licence policy with the operator: decide which Wikipedia/arXiv/item-level families may be resolved safe, and whether the completeness floor should be refined.
4. Prepare the release-candidate deployment/migration procedure; do not deploy without separate approval.

---

## Final verification snapshot

- Node full suite after the final code change: **824 tests, 817 passed, 0 failed, 7 skipped**.
- Python focused suites (`test_working_checkpoint.py`, `test_measure.py`): **7 passed**.
- Python full suite: all passing except the pre-existing CPU-only ROCm portability test.
- `git diff --check`: clean.
- Evidence artefacts are under `docs/continuous-knowledge-learning-effectiveness/evidence/`.
- Branch is uncommitted and undeployed; production remains read-only.

---

## Milestone 11 — sealed cohorts and existing-lineage baseline

### Implemented

- Built isolated public-domain experiment corpus and sealed prospective/retention cohorts.
- Prospective: 30 docs / 7,861 actual tokens / 61 blocks.
- Retention: 10 docs / 2,017 actual tokens / 15 blocks.
- Verified content-hash/source-URL leakage protection and cohort disjointness.
- Scored production lineage `v493`, `v495`, `v497`, `v499`, `v500` from an isolated read-only weight copy.

### Measured

- On sealed prospective knowledge, `v495` (+0.0188) and `v497` (+0.0193) were significantly worse than `v493`; `v500` was −0.0071 with a CI including zero.
- On the retention probe, `v499` was significantly worse than `v493` (+0.0320); `v500` was +0.0629 with a CI including zero.
- Existing working lineage therefore does not demonstrate cumulative improvement.

Evidence: `evidence/lineage-sealed-baseline-2026-11-04.json`.

---

## Milestone 12 — controlled curation/training comparison

### Implemented

- Built an isolated experiment harness for legacy, segmented and raw-text curation with the same random-init parent, sources, validation and sealed cohorts.
- Ran full two-epoch experiments and a two-seed equal-token control.

### Measured

- Same sources yield ~4.2× fresh tokens / ~4.3× blocks under segmented/raw-text versus legacy.
- Full two-epoch: prospective improvement legacy **1.635**, segmented **4.238**, raw-text **4.218** nats; no regressing prospective documents.
- Equal-token (two seeds): segmented beats legacy by **~0.083 nats** on prospective knowledge; raw-text by **~0.054 nats**. Legacy retains the retention probe better because it repeats those exact first-14k chars.
- This isolates a real data-quality effect beyond token volume.

Evidence: `evidence/curation-experiment-summary-2026-11-04.json`, `evidence/curation-experiment-equal-summary-2026-11-04.json`, `evidence/curation-experiment-equal2-summary-2026-11-04.json`.

---

## Milestone 13 — legacy replay recovery decision

### Measured

- 0 automatically safe full records under the conservative policy.
- 596 safe short-prose records / 17,573 estimated tokens are a policy candidate only.
- 1,893 records remain blocked by uncertain/unknown licences; 4,517 by quality/completeness.
- Recommendation: do not auto-enable the 596; require a controlled replay experiment.

Evidence: `evidence/retired-replay-audit-2026-11-04.json`.

---

## Milestone 14 — integrated correctness and migration rehearsal

### Verified

- Optimizer carry `v494 → v495`: groups `57 + 17`, decay `[0.01, 0.0]`, steps `68 → 70`, 148/148 moment tensors changed.
- Focused integrated suite: 43/43 passed (replay trim, crash recovery, validation packing, URL quality, segmentation, tokenizer measurement).
- Isolated migration rehearsal: backfill dry-run/apply, audit, rollback and config parsing all passed.

Evidence: `evidence/optimizer-integrated-verification-2026-11-04.json`, `evidence/integrated-correctness-tests-2026-11-04.log`, `evidence/deployment-rehearsal-2026-11-04.json`.

---

## Final milestone-2 recommendation

The data pipeline changes demonstrably increase useful trainable tokens and, under controlled conditions, produce more learning on genuinely unseen knowledge. The existing production working lineage does not demonstrate cumulative improvement. Deploy the release candidate only under the prepared procedure and start a new working lineage; do not claim cumulative learning until that new lineage improves on the sealed prospective and retention cohorts.

---

## Milestone 3 — controlled release and fresh-lineage trial

### Deployed

- Final deployed commit `c4fa712`; full backup and code backups recorded.
- Licence backfill applied to 25,887/25,888 records; no non-licence state changed.
- Effective config: segmented curation, cross-domain merge, source fallback, licence shadow, URL quality enforce, language prior reject, prefilter shadow, fragment corpus mode, corrected optimizer carry.
- Stable `v493` remained serving.

### Trial

- Fresh lineage reset to `v493`; runs `run-426` (v501), `run-428` (v503), `run-429` (v504).
- Optimizer carried correctly; weight decay `[0.01, 0.0]`; step counters 7→15→37→44.
- Real segmented/fallback curation processed production material.
- Replay trim remained defective: measured shares 40.8%, 27.8%, 44.8%.
- Sealed prospective/retention results: no checkpoint beat `v493`; `v504` regressed significantly and was rolled back to `v503`.
- Short-prose candidate experiment: treatment reduced prospective/validation improvement in both seeds; not recommended for general replay.

### Outcome

Operational deployment succeeded; cumulative learning was **not demonstrated**. Stable serving unchanged. See `MILESTONE-3-REPORT.md` for the full evidence and recommendation.

---

## Milestone 4 — reliable replay and demonstrated learning

- Implemented tokenizer-authoritative replay budgeting after validation partitioning, with a 2-point tolerance and fail-closed preflight check.
- Production runs measured **19.99%**, **19.78%** and **19.82%** replay at actual training consumption.
- Reset the working lineage to `v493`, then advanced `v493 → v505 → v506`.
- Unchanged stable gate promoted `v505` and `v506`; `v506` is now serving.
- Sealed prospective: `v505` −0.0098 nats, `v506` −0.0106 nats (CIs exclude zero).
- Sealed retention: `v506` −0.0231 nats (CI excludes zero).
- `v507` regressed sealed prospective/retention and was rolled back to `v506`.
- Node full suite after final code: **832 tests, 825 passed, 0 failed, 7 skipped**.
- Cumulative learning is now demonstrated, modestly but with statistical support.

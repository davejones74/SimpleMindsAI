# Continuous Knowledge and Learning Effectiveness — Read-only Assessment

**Date:** 2026-11-04  
**Repository:** `/home/dave/Repositories/SimpleMindsAI`  
**Assessed revision:** `ced98fd` (`master`)  
**Production source:** `/opt/simpleminds`  
**Status:** read-only assessment. No production, job, service, configuration, checkpoint pointer, article, training data, evaluation set or promotion threshold was changed. The working tree remained clean at `ced98fd`.

---

## 1. Verified current-state architecture and production assessment

### Production identity

| Item | Verified state |
|---|---|
| `master` HEAD | `ced98fd` — "Update observability and replay correction manifest" |
| Production source | `/opt/simpleminds/src` and `/opt/simpleminds/python/sma` are byte-identical to `master` |
| Deployment | backup `deploy-20261104T194155Z`; service restarted `2026-11-04 20:05:26` |
| Stable active | `v493` (`edf63f7283b3`), active since `2026-11-04T04:53:21Z` |
| Working | `v500` (`3529eea41e4a`), parent `v499`, run `run-425` |
| Working last-good | `v499` |
| Working drift | `+0.011532` nats vs stable; budget `0.10`; within budget |
| Learning job | `job-63`, continuous, running/harvesting |
| Training job | `job-64`, continuous, waiting `28/32 eligible articles` |
| Frozen eval | `eval-002`, unchanged, 60 docs / 48,110 tokens / 376 blocks |

### Lifecycle in master

The live path is:

`discovery → persistent frontier → fetch → language filter → extraction → teacher curator → ingest/dedup/language backstop → reviewRequested → deterministic gates → teacher review → REVIEWED → snapshot (fresh + replay + prospective validation) → document/source-disjoint partition → tokenizer preflight → train → stable gate + working guard → publish working / promote stable → consume or defer/replay-only/retire`

Key code points:

- Curator truncates each raw source to `rawText.slice(0, 14_000)` and lets the teacher return arbitrary-sized units: `src/services/ollama-client.js:129-146`.
- Every unit is ingested with `reviewRequested: true`, bypassing the configured sampled-review rate: `src/jobs/learning.js:79-105`.
- Replay is sized before partition, then corrected after validation assignment: `src/training/lifecycle.js:279-298`.
- Validation is prospective-only, source/document-disjoint, 32-block target: `src/dataset/partition.js:192-223`.
- Working guard is separate from the stable gate: `src/training/working-guard.js`.
- Stable promotion remains causal-LM loss on frozen `eval-002`; unchanged.

### Observability/replay correction: active, but not yet exercised

- The merged correction files match production exactly: `lifecycle.js`, `snapshot.js`, `validation-status.js`, `admin/knowledge-accumulation.js`, `admin/routes.js`, `brain/knowledge.js`, `exposure.js`.
- The live authenticated endpoint returns `sma/knowledge-accumulation-observability@1` with `groupEvaluation`, `drift`, `validation` and current job state.
- Therefore the **code and UI are active in production**.
- However, the replay correction has **not yet run in production**: the last training run (`run-425`) predates deployment, and `job-64` is still waiting. The live `corpus` view still shows `run-425`'s pre-correction replay share of **36.66%**. The first post-deploy run is the authoritative test.
- The live endpoint does **not** expose a `replayCorrection` field; that exists only in the exported evidence. It also reports validation `available: true` without an authoritative tokenizer block count.

### AdamW `weight_decay` discrepancy: a continuity defect, not intentional

`python/sma/train.py:629-635` builds the intended split:

- 57 matrix parameters → `weight_decay = cfg.weightDecay` (`0.01`)
- 17 vector parameters (RMSNorm) → `weight_decay = 0.0`

But the carry path at `python/sma/train.py:648-660` overwrites **every** group with `cfg.weightDecay`. The actual checkpoint evidence is decisive:

| Version | Group sizes | Group weight decays | AdamW steps |
|---|---:|---|---:|
| `v493` | `57 + 17` | `[0.01, 0.0]` | `7` |
| `v495` | `57 + 17` | `[0.01, 0.01]` | `15` |
| `v496…v500` | `57 + 17` | `[0.01, 0.01]` | continuous |

The defect was introduced by commit `13a0962` ("Add independent replay eligibility and durable working checkpoint"). The moments and step counters are continuous, so this is **not an optimizer reset**. It is a real hyperparameter-continuity defect: the 17 no-decay RMSNorm parameters started decaying from `v495` onward, inconsistent with `v493` and with the `resume` path (which preserves loaded group values). The existing test only checks that moments survive; it does not assert the group weight-decay split.

Impact is probably small per step but cumulative and unnecessary; it is not the primary cause of the evaluation plateau.

---

## 2. Quantified knowledge-to-trainability funnel

### Global funnel

| Stage | Count | Notes |
|---|---:|---|
| Frontier URLs tracked | **471,090** | 418,311 queued, 48,287 visited, 4,492 deferred |
| Unique raw sources curated | **5,257** | `raw-sources.ndjson` |
| Curated article units | **25,825** | ~4.9 units/source |
| Articles ever reviewed | **25,824** | 91,461 review records |
| Articles ever approved | **16,406** | 63.5% of articles |
| Currently `REVIEWED` | **7,517** | 29.1% |
| Ever consumed | **9,917** | 38.4%; est. 515,819 tokens |
| Replay pool | **7,866** | est. 481,088 tokens |
| **Current fresh trainable** | **28** | **0.11%**; actual 3,103 tokens |
| `RETIRED` | **10,252** | 39.7% |
| Approved but finally `RETIRED` | **8,737** | 33.8% of all material |
| Consumed + retired, not replayable | **7,006** | est. **320,619 tokens** |
| `REJECTED` | **8,050** | 31.2% |
| Pending / ingested | **5 / 1** | 6 recoverable |

### Where useful material is lost or delayed

1. **Discovery is dominated by low-value / multilingual URLs.** 418,311 queued URLs vs 48,287 visited; queued includes 1,581 Special pages, 803 File pages, 513 Category pages, 52 Template pages, and many non-English Wikipedias. `DISCOVERY_LANGUAGE_PRIOR=warn`, so these are fetched and only rejected later.
2. **Fetch losses.** Top frontier errors: 2,108 HTTP status, 1,343 robots-disallowed, 609 unsupported content type, 131 DNS, 115 network, 98 too large.
3. **Curator truncation and fragmentation.** Each source is truncated to 14,000 chars before curation. For the current 28 fresh trainable articles, the 10 underlying source pages contain **456,900 raw chars**; only about **117,300 chars (25.7%)** were visible to the curator. Curated text is **3,103 actual tokens** versus **113,337 actual tokens** in the full raw text: a **36.5×** gap before cleaning/quality filtering.
4. **Curation failures/timeouts.** Job logs repeatedly show `curate failed ... timeout`; on failure the source is not recorded as curated, so it can be fetched/curated again later.
5. **Review churn.** 91,461 reviews for 25,824 articles: **67.5% `uncertain`**, 21.6% approve, 10.9% reject. Maximum attempts observed: **267**. 8,721 retirements are recorded as `max-retries-exceeded`.
6. **Legacy retirement destroys replay eligibility.** The current code no longer retires on training rejection, but historical records remain: 7,383 consumed articles were later retired; only **377** were restored with explicit replay eligibility. **7,006 approved, consumed articles (est. 320,619 tokens) are currently excluded from replay** because legacy retirement is not replay-eligible without an explicit event.
7. **Licence is not resolved at ingest.** There is no licence field on `Article`/`ArticleInput`; licence logic exists only in `scripts/knowledge-pilot/classify-replay.mjs` and its host allowlist. Current proxy classification:

| Licence bucket | Articles | Est. tokens | Consumed | Fresh trainable |
|---|---:|---:|---:|---:|
| Safe allowlist | 2,765 | 73,884 | 1,967 | **0** |
| Uncertain (Wikipedia/arXiv/OpenStax etc.) | 8,017 | 393,907 | 3,872 | **20** |
| Unknown source family | 15,043 | 602,171 | 4,078 | **8** |

The current fresh delta is therefore entirely from licence-unresolved source families. The conservative replay policy also makes only **547** safe articles / **38,606** tokens replay-pool members, versus 1,957 uncertain / 143,060 and 5,362 unknown / 299,422.

8. **Current job delay is partly a policy choice.** `job-64` has `minEligible=32` while 28 articles are eligible. The code-level floor is lower; the job is deliberately waiting, not failing.

### Review outcomes

| Metric | Value |
|---|---:|
| Approve records | 19,752 (21.6%) |
| Uncertain records | 61,752 (67.5%) |
| Reject records | 9,957 (10.9%) |
| Applied records | 29,709 |
| Median ingest→last review | 0.13 h |
| p90 ingest→last review | 6.34 h |
| Recent day (2026-11-04) | 422 reviews: 239 approve, 155 reject, 28 uncertain; mean score 4.86 |

Recent review behaviour is materially healthier than the historical average (mean score historically 2.12), but the completeness gate remains in `shadow` mode, so very short fragments can still be approved.

### Tokenisation and unit size

| Metric | Value |
|---|---:|
| Curated text, median | **20 est. tokens** |
| p90 / p95 / p99 | 79 / 118 / 349 est. tokens |
| Under 128 est. tokens | **24,696 / 25,825 (95.6%)** |
| Total curated est. tokens | 1,069,962 |
| Current fresh trainable actual tokens | **3,103** |
| Current fresh trainable blocks if concatenated | 24 blocks |
| Current fresh docs ≥128 actual tokens | **2 / 28** |
| All `REVIEWED` actual tokens | 386,277 |
| All `REVIEWED` blocks if concatenated | 3,017 |
| All `REVIEWED` docs ≥128 tokens | 396 / 7,517 |

The corpus is large in aggregate but almost entirely composed of sub-block fragments. That is the root cause of both weak training updates and validation starvation.

---

## 3. Actual fresh/replay/validation proportions after partitioning

Production runs `run-420…run-425`, before the replay correction was deployed:

| Run | Fresh tokens | Replay tokens | Validation tokens | Measured replay share of training | Validation blocks | Shortfall vs 32 |
|---|---:|---:|---:|---:|---:|---:|
| `run-420` | 767 | 1,329 | 2,054 | **63.4%** | 16 | 16 |
| `run-421` | 2,054 | 1,180 | 183 | **36.5%** | 1 | 31 |
| `run-422` | 2,106 | 1,479 | 1,608 | **41.3%** | 12 | 20 |
| `run-423` | 1,658 | 1,074 | 269 | **39.3%** | 2 | 30 |
| `run-424` | 586 | 1,196 | 1,875 | **67.1%** | 14 | 18 |
| `run-425` | 1,909 | 1,105 | 212 | **36.7%** | 1 | 31 |
| **Total** | **9,080** | **7,363** | **6,201** | **44.8%** | — | — |

- Training-only split across these runs: **55.2% fresh / 44.8% replay**.
- Validation was **27.4%** of all presented tokens, but extremely variable per run: 5.4% to 51.3%.
- Pre-partition replay estimates were ~20%, but validation removal shrank the fresh denominator and inflated measured replay to 36.5–67.1%.
- The merged correction should trim replay against the final post-validation fresh stream. The frozen `run-425` simulation gives **19.65% actual replay** instead of 36.66%, removing 16 replay documents. No production run has yet exercised it.

---

## 4. Why prospective validation material is insufficient

Current live validation availability:

- Target: **32 blocks / 4,096 estimated tokens**
- Prospective clusters: **3**
- Validation articles: **10**
- Estimated tokens: **742**
- **Actual tokenizer tokens: 563**
- **Actual blocks: 4**
- **Documents ≥128 tokens: 0**

Earlier cohort: 3 articles / 131 estimated tokens / **97 actual tokens / 0 blocks**.

Causes:

1. **Fragment granularity.** Prospective clusters are built from curated units; almost all units are below 128 tokens, and a cluster rarely reaches even one block.
2. **Prospective supply is consumed permanently.** Once a cluster appears in a snapshot, it becomes historically exposed; it cannot be used as prospective validation again. New validation material must come from genuinely new sources/clusters.
3. **Acquisition produces too few new English long-form sources.** Recent harvest cycles yield 0–2 raw documents each, with many non-English/unchanged skips and curator timeouts.
4. **Node availability uses char/4 estimates, not tokenizer truth.** The current 742 estimate is 563 actual (~32% overestimate). The earlier 131 estimate was 97 actual (~35% overestimate). The UI can say "available" while the trainer can still fail the block floor.
5. **The configured floor is permissive.** `TRAIN_MIN_VALIDATION_TOKENS=0` and `TRAIN_MIN_VALIDATION_CLUSTERS=1` allow a valid-but-useless cohort; fail-closed only occurs when the trainer cannot form one block.

How to improve supply without weakening validation:

- Increase article/source token mass (curator length targets/merge, or a controlled `raw-text` corpus pilot). This alone could make current prospective clusters exceed 128 tokens.
- Accumulate a **prospective validation reserve** across cycles, source-disjoint and never trained, until it reaches 32 authoritative blocks; only then expose it to a run.
- Add an authoritative tokenizer block preflight to `validationAvailability`; "available" should mean `blockCount > 0`, not estimate > 0.
- Prioritise new English long-form sources with resolved licences at discovery time.
- Keep prospective-only, document/source-disjoint, min-block and no-historical-fallback rules unchanged.

---

## 5. Cumulative learning effectiveness baseline

### Stable frozen evaluation (`eval-002`)

Positive delta = candidate is worse than `v493`.

| Version | Frozen eval loss | Δ vs `v493` | Stable decision |
|---|---:|---:|---|
| `v493` | **7.8102399** | baseline | promoted (`run-418`) |
| `v495` | 7.8190387 | **+0.0088** | rejected (`run-420`) |
| `v496` | 7.8379552 | **+0.0277** | rejected (`run-421`) |
| `v497` | **7.8041891** | **−0.0061** | inconclusive (`run-422`) |
| `v498` | 7.8099541 | −0.0003 | inconclusive (`run-423`) |
| `v499` | 7.8125454 | +0.0023 | inconclusive (`run-424`) |
| `v500` | 7.8217722 | **+0.0115** | inconclusive (`run-425`) |

The best transient working checkpoint (`v497`) improved by 0.0061 nats, but its paired CI included zero. The current working checkpoint is **worse than the stable baseline by 0.0115 nats**. No stable promotion has occurred since `v493`; `run-420…run-425` produced zero stable promotions.

### Regression and cumulative drift

For `v500` vs `v493`, across the frozen eval's 60 source groups:

- **43/60 groups worse**
- **16/60 worse by >0.05 nats**
- **0/60 worse by >0.15 nats**
- mean group delta **+0.0139**, median **+0.0144**
- worst: `Internet` **+0.1243**, `Compiler` +0.0938, `Computer` +0.0820
- best: `Milky Way` **−0.1649**, `Black hole` −0.1253, `Big Bang` −0.0764

The working guard accepted all six advances because it allows up to 0.05 nats regression vs the working parent, no group over 0.15, and drift under 0.10. Current drift is +0.0115, so the guard is not near its backstop. The rollback anchor is `v499`, not the stable `v493`, so repeated small regressions can accumulate without returning to the stable baseline.

### What the baseline does *not* demonstrate

- **No unseen prospective benchmark.** The only prospective validation is the in-run cohort, which changes every run and is used for best-checkpoint selection.
- **Validation losses are not comparable across runs.** They range from 7.76 to 6.10 because the cohort composition changes dramatically; `v500`'s 5.99 validation loss coincides with a *worse* frozen eval loss. This is cohort shift, not cumulative learning.
- **`eval-002` is not "unseen".** It is 60 English Wikipedia documents. 11 of its 60 source URLs were also fetched/curated, and 8 of those have consumed training units. The exact-hash leak guard prevents identical text, but not source/topic overlap. It is a legitimate frozen gate, but it cannot be presented as unseen prospective knowledge.
- **No retention probe.** Replay is the only retention mechanism, and 7,006 consumed-retired articles are not replay-eligible. There is no fixed test of previously learned knowledge evaluated across working checkpoints.
- **Activity is not effect.** 9,917 consumed articles, 515,819 consumed estimated tokens, six working advances, and 52 total stable promotions across 492 model events do not establish cumulative learning. The frozen and prospective signals show no cumulative improvement.

### Proposed cumulative metrics

Keep the stable gate and `eval-002` unchanged. Add supplementary, non-promotion measurements:

1. **Knowledge yield funnel:** licence-resolved useful tokens per acquired source; accepted articles per 1,000 fetched docs; median/p90 tokens per unit; % clusters reaching one 128-token block.
2. **Material mix:** fresh/replay/validation token proportions after partition; unique training tokens; validation block shortfall; % fresh from safe/uncertain/unknown licence buckets.
3. **Fixed prospective benchmark:** a sealed, source-disjoint set never included in snapshots; evaluate parent and candidate before/after each cycle with paired source-group bootstrap. Report loss delta and CI.
4. **Retention probe:** a fixed set representing previously learned knowledge (or reserved source-disjoint portions of earlier sources) evaluated at each working checkpoint; report forgetting (loss increase) and retention ratio vs the checkpoint that first learned it.
5. **Regression/drift:** per-group deltas on the fixed benchmark; regressed-group share, worst group, cumulative drift vs stable, drift velocity per advancement, max drawdown, and rollback frequency.
6. **Generalisation gap:** training-corpus loss vs fixed prospective loss vs retention loss, tracked across cycles, to detect memorisation/overfitting.
7. **Learning efficiency:** Δprospective/retention loss per 1,000 licence-resolved useful tokens, per accepted article, and per GPU-hour.

Current baseline for these metrics: stable eval 7.8102; best working 7.8042; current working 7.8218; cumulative drift +0.0115; no fixed prospective or retention baseline exists yet.

---

## 6. Ranked bottlenecks

| Rank | Bottleneck | Evidence | Consequence |
|---:|---|---|---|
| **1** | **Unit granularity / curator truncation** | 95.6% of units <128 est. tokens; median 20; only 25.7% of current source chars visible to curator; curated vs raw text 3,103 vs 113,337 tokens (36.5×) | Tiny fresh deltas, weak updates, validation starvation |
| **2** | **Approved/consumed knowledge lost to retirement** | 8,737 approved→retired; 7,383 consumed→retired; only 377 restored; 7,006 not replayable (320,619 est. tokens) | No cumulative retention; replay cannot recover most past knowledge |
| **3** | **Licence unresolved at ingest** | No licence field; 8,017 uncertain + 15,043 unknown articles; 0 fresh trainable from safe allowlist | Cannot prove compliance or safely unlock the largest knowledge pool |
| **4** | **Acquisition source selection** | 418k queued, dominated by multilingual Wikimedia and low-yield domains; language prior only `warn`; 2,108 HTTP, 1,343 robots failures | Low useful-English-source yield; wasted fetch/curation and validation supply |
| **5** | **Review churn / no prefilter** | 91,461 reviews; 67.5% uncertain; max 267 attempts; 100% `reviewRequested`; completeness `shadow` | Teacher capacity wasted; useful fragments delayed/retired; high variance |
| **6** | **Validation supply and comparability** | 4 actual blocks vs 32 target; cohorts vary 1–16 blocks; estimates overstate actual tokens by ~30%; availability not authoritative | Training waits or selects on noisy cohorts; cannot measure cumulative learning |
| **7** | **Optimizer group weight decay defect** | `v493 [0.01,0.0]` → `v495+ [0.01,0.01]`; overwrite loop in carry path | Intended no-decay semantics lost; small but real cumulative drift, not a reset |
| **8** | **Measurement gap** | No fixed prospective/retention benchmark; frozen eval partly source-overlaps training; stable gate doubles as group guard | Activity is easily mistaken for learning; cannot prove cumulative effectiveness |

---

## 7. Prioritised implementation plan

No item changes the stable promotion gate, `eval-002`, `PROMOTE_*` thresholds, or the existing recovery/rollback protections. Items are ordered by expected value and dependency.

| Priority | Change | Expected benefit | Risk | Verification |
|---:|---|---|---|---|
| **P0** | **Cumulative measurement harness**: sealed prospective benchmark + fixed retention probe + per-cycle drift/efficiency report. Separate from promotion. | Makes every later change testable; distinguishes activity from learning. | Benchmark leakage if ever trained; design cost. | Fixed hashes; never in snapshots; paired CIs reproducible; baseline recorded before changes. |
| **P1** | **Increase unit/source token mass**: curator length targets and merge adjacent fragments; preserve full source; controlled `raw-text` corpus pilot. | Current fresh cohort could rise from 3,103 to ~100k tokens before cleaning; clusters cross 128 tokens; validation supply improves. | Distribution shift, boilerplate, source-overlap contamination. Run as isolated/shadow experiment first. | Token-length distribution, blocks/source, validation shortfall, review acceptance, frozen/prospective deltas. |
| **P2** | **Per-document licence resolution + replay recovery**: store licence id/decision/provenance at ingest; audit the 7,006 lost consumed-retired records; migrate only safely resolved ones. | Unlocks a defensible subset of 320,619 lost estimated tokens; makes safe 2,765-source pool usable; proves compliance. | Legal/attribution risk; wrong blanket migration. Audit first; uncertain stays unresolved. | Classification counts, zero non-compliant training, replay pool by licence bucket, retention probe improvement. |
| **P3** | **Discovery prioritisation**: reject declared non-English hosts at discovery; filter File/Category/Special/Template URLs; score domains by useful-doc yield; prefer English long-form permissive sources. | More useful English material per cycle; less fetch/curation waste; better prospective validation supply. | Over-filtering legitimate sources. Keep warn mode until calibrated; monitor fallback. | Raw docs/hour, English acceptance, useful tokens/source, validation clusters per cycle, failure rates. |
| **P4** | **Review efficiency**: deterministic length/completeness/quality prefilter before teacher; stop setting `reviewRequested` for every unit; calibrate then enforce completeness in shadow→enforce. | Cuts the 91k-review / 67.5%-uncertain churn; concentrates teacher time on trainable prose; fewer retirements. | Rejecting short-but-valid niche text. Calibrate on labelled sample; preserve manual override. | Reviews/article, uncertain %, approved→consumed rate, time-to-trainable, quality of accepted corpus. |
| **P5** | **Prospective validation reserve + authoritative preflight**: accumulate unexposed source-disjoint clusters until 32 tokenizer blocks; expose only at run time. | Reliable 32-block validation without weakening prospective/source-disjoint rules; fewer waits. | Training delay; stale reserve. Cap wait; keep reserve unexposed. | `blockCount=32`, shortfall=0, no validation in training, cohort hashes stable. |
| **P6** | **Fix AdamW carry semantics**: preserve the intended group split (or deliberately freeze an interim policy), add a regression test for group weight decay. | Restores intended optimizer semantics; removes a confounder from cumulative drift. | Changing mid-lineage is itself a discontinuity. Record it; run a controlled comparison. | `param_groups` after carry: `[0.01, 0.0]`; moments/steps continuous; next working run recorded. |
| **P7** | **Observability hardening**: expose `replayCorrection`, authoritative tokenizer block counts, licence bucket, retirement/replay loss, and funnel metrics in the live knowledge view. | Makes the correction and funnel visible; prevents "available" meaning only "estimated". | Low. | Endpoint/UI fields; alert when approved-consumed-retired > 0 and not replayable; no dispatch to promotion. |

### Recommended immediate sequence

1. **P0** measurement harness first, so P1/P2/P3 have a denominator.
2. **P1** controlled granularity/raw-text experiment on an isolated store, not production.
3. **P2** licence audit and safe replay recovery, because it can recover already-paid-for knowledge without new crawling.
4. **P3** acquisition prioritisation, to feed the next cycles.
5. **P4/P5** review and validation supply, once units are large enough to matter.
6. **P6/P7** correctness and observability fixes can proceed in parallel.

---

## 8. Bottom line

The highest-value work is **not more training activity**. The system has already acquired ~25.8k units and consumed ~9.9k, but current fresh trainable material is **28 units / ~3.1k actual tokens**, and 7,006 consumed approved units are no longer replayable. The largest gains are:

1. turning long fetched sources into long trainable units instead of truncating and fragmenting them;
2. resolving licences so approved material can be safely reused;
3. prioritising acquisition toward English long-form sources that yield prospective validation clusters;
4. measuring learning on fixed prospective and retention sets rather than equating tokens, loss, or working advancement with effectiveness.

The merged observability/replay correction is active in production, but its first real validation is still pending.

---

## Appendix: primary evidence paths

- `/var/lib/simpleminds/data/articles/{articles,article-events,reviews,consumption,raw-sources,training-contribution}.ndjson`
- `/var/lib/simpleminds/data/registry/{runs,run-events,model-events,evaluations}.ndjson`
- `/var/lib/simpleminds/data/registry/evaluations/run-42{0..5}_*.evidence.json`
- `/var/lib/simpleminds/data/snapshots/`
- `/var/lib/simpleminds/data/frontier/{frontier,domains}.ndjson`
- `/var/lib/simpleminds/store/{active,working,working-last-good}.json`
- `/var/lib/simpleminds/store/_runs/v49{3,5}.train-state.pt` through `v500.train-state.pt`
- `/var/lib/simpleminds/store/v500/tokenizer.json`
- `docs/knowledge-accumulation-observability-replay/`
- `docs/knowledge-accumulation-production-activation/`
- `scripts/knowledge-pilot/replay-licence-policy.json`
- Read-only replay audit output: `/tmp/opencode/replay-audit-20261104.json` (not part of the repository)

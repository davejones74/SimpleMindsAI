# Knowledge Pipeline Programme — Final Production Report

## Result

The production pipeline moved from a 4,808-token blocked batch to a normal, supervised promoted training run.

| Metric | Before | After |
|---|---:|---:|
| Fresh articles in training snapshot | 4 | 89 |
| Fresh tokens in training snapshot | 4,808 | 191,380 |
| Reviewed articles | 44,141 | 44,152 |
| Nominally trainable | ~751 | 756 at selection |
| Pass prose/content eligibility | 24 | 125 |
| Survive source/publisher caps | 9 selector / 4 snapshot | 89 snapshot |
| Distinct hosts in fresh batch | small | 31 |
| Distinct source IDs in fresh batch | small | 86 |
| Training state | waiting below 6,000 | run-767 promoted |
| Active model | v863 | v879 |
| Working model | v878 | v879 |
| Working last-good | v877 | v878 |

No threshold, architecture, optimiser, validation or promotion policy was changed. The 6,000-token floor and 4,000-token fallback prohibition remain intact.

## Training outcome — run-767

- Parent: v878
- Result: v879
- Dataset: `dataset-20261118-029-a8d3807b87d4.jsonl`
- Fresh/tokens: 89 / 191,380
- Validation rows: 12
- Trainer tokens seen: 191,488
- Steps: 374
- Validation loss: 6.4566 -> 6.4211
- Paired primary improvement: 0.0290 (95% CI 0.0076..0.0521)
- Broad evaluation: non-inferior, regression -0.0237 nats, margin 0.02
- Decision: promoted; active and working both v879; last-good v878.

## Priority 1 — selection reconciliation

Observed before the fix:

- Snapshot: 4 articles / 4,808 fresh tokens.
- Selector: 9 articles / 11,472 fresh tokens.
- The mismatch was not a single missing five-article set. Seven selector rows were absent from the snapshot and two snapshot rows were absent from the selector; only two rows were common. The stale snapshot was baked under different selection/cap ordering.

Investigations:

- The selector-only cohort contained Irish (`ga`), Mon (`mnw`), Scots (`sco`) and Simple English (`simple`) Wikipedia material, plus other pages outside the snapshot's cap order.
- The snapshot and selector both used the same store and validation bank but differed in validation-block reservation and cap ordering.
- At the next bake, after source-level prose grouping, the selector produced 90/186,784 while the snapshot produced 89/191,380; the residual difference was one article / 4,596 tokens.

Readiness semantics were also corrected:

- The dashboard previously treated the latest immutable snapshot as the next batch even after its articles had been consumed.
- It now treats a consumed snapshot as historical and reports the **current selector** as readiness.
- Current readiness: 46 fresh / 76,119 tokens, over the 6,000 floor.
- Last immutable snapshot is reported separately as historical: 89 / 191,380.
- Integrity warnings now reconcile with the pending/current batch instead of comparing a historical batch with a later store state.

Residual: the selector and lifecycle still differ by one article at bake time because validation-block reservation/cap selection is not yet literally one function. This is the remaining Priority 1 defect; it is not hidden and does not block the promoted run.

## Priority 2 — prose conversion

The low conversion was real but not mainly a domain problem. Sampling showed the dominant failure was extraction shape:

- A page arrives as many 10–60-word units. The 150-word prose gate judged each unit alone, so `Industrial Revolution`, `Cell (biology)`, `History of Scotland`, `Freedom`, `Spanish language`, `Napoleon`, `life` and similar coherent pages were rejected as `training-prose`.
- `CODE_MARKER` matched ordinary prose words such as `class`, `import`, and `from`, producing false `code-heavy` rejections.
- `fragmented-prose` punished citation markers and paragraph line breaks rather than poor prose.
- `technical-topic` rejected coherent scientific pages such as CUDA merely for technical vocabulary.
- Many genuinely short but complete articles fell below the old 150-word floor.

Changes made:

- Prose/content eligibility is now evaluated once per source page across its units, while the original unit IDs and provenance are retained.
- Code detection now requires line-leading code constructs, fenced code, code-like APIs or URLs instead of prose words.
- Fragmentation requires short lines and low words-per-sentence, not merely line breaks.
- Technical-topic rejection requires a documentation host/path or code markers.
- Complete prose floor is 100 words / 3 sentences, not an indiscriminate removal of quality checks.
- Commercial, retail, TTS, marketing, thin-content and technical-documentation checks remain.

Measured effect at selection: prose/content eligible rose from 24 to 125; cap-surviving fresh articles rose from 4/9 to 89, with 31 distinct hosts.

Known false-acceptance risk: web.archive.org supplied 22 rows in the promoted batch and Simple Wikipedia supplied 5. These passed the current prose/quality checks but should be watched in future evaluation; no blanket domain exclusion was introduced.

## Priority 3 — discovery

- Frontier: 557,317 total, 481,674 queued, 68,062 visited, 5,807 deferred, 1,750 failed.
- Discovery currently uses 84 seeds, 3,897 registry roots, root rotation window 25 and next cursor 225.
- Sitemap adapter found and enqueued 500 URLs from 9 fetched sitemaps; feed adapter had no candidates.
- New articles continued to arrive while training waited; the promoted snapshot contains 31 hosts and 86 source IDs.
- Remaining issue: discovery still produces a large archive.org/Wikipedia share and numerous small units. Source rotation exists, but publisher concentration and extraction quality need continued measurement rather than a blanket domain ban.

## Priority 4 — recovery

- Added an automatic, idempotent recovery loop in the server:
  - starts learning only when no learning job is active;
  - starts review only when no review job is active and pending review > 0;
  - respects the most recent explicit operator stop;
  - uses normal `startLearning`/`startReview` supervisor controls;
  - interval default 60s, configurable by `JOBS_AUTO_RECOVERY` and `JOBS_AUTO_RECOVERY_INTERVAL_MS`.
- Manual `POST /api/admin/knowledge-pipeline/recover` remains available.
- After the production restarts, learning job-105 remained running and review job-116 remained active/waiting; no duplicate jobs were created.
- Training completion did not stop acquisition or review.

## Verification

- Node tests: 957 tests, 950 passed, 7 skipped, 0 failed.
- Production training: run-767 promoted normally; no forced run or preflight bypass.
- Current active/working: v879; last-good: v878.
- Current readiness: 46 fresh / 76,119 tokens.
- Current last snapshot: 89 fresh / 191,380 tokens, marked historical because its articles were consumed.

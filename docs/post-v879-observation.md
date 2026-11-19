# Post-v879 Production Observation Report

Observation window: 2026-11-18 00:28–01:37 UTC (normal continuous operation).

## 1. Lineage verification

The premise in the request was already superseded by normal production activity:

| Pointer | Version | Meaning |
|---|---|---|
| Active | **v880** | newest promoted model from run-768 |
| Working | **v891** | latest trial candidate from the rejected run-779 |
| Working last-good | **v890** | rollback anchor immediately before v891 |
| Stable baseline | **v880** | active promoted baseline in the working pointer |

- v879 was active immediately after run-767, then v880 was promoted normally by run-768.
- v878 is no longer last-good because v879 and v880 were promoted and the working rollback anchor advanced normally.
- No pointer was reset or manually rewritten.
- Rejected candidates (v881–v891) did **not** become active. The stable active model stayed v880 throughout the rejection streak.

## 2. Normal training cycles

| Run | Fresh/replay/validation | Result | Paired outcome |
|---|---|---|---|
| run-767 | 89 / 0 / 12 | promoted v879 | +0.0290 (CI 0.0076..0.0521) |
| run-768 | 34 / 38 / 12 | promoted v880 | +0.0322 (CI 0.0244..0.0406) |
| run-769 | 9 / — / 12 | rejected | -0.0148 (CI -0.0184..-0.0113) |
| run-770 | 8 / — / 12 | rejected | -0.0160 |
| run-771 | 9 / — / 12 | rejected, deferred | -0.0217 |
| run-772 | 9 / — / 12 | rejected | -0.0131 |
| run-773 | 8 / — / 12 | rejected | -0.0091 |
| run-774 | 8 / — / 12 | rejected | -0.0181 |
| run-775 | ~8 / — / 12 | rejected | -0.0301 |
| run-776 | ~8 / — / 12 | rejected | -0.0340 |
| run-777 | ~8 / — / 12 | rejected | -0.0217 |
| run-778 | ~8 / — / 12 | rejected | regression |
| run-779 | ~8 / — / 12 | rejected | -0.0135 (CI -0.0220..-0.0053) |

Broad evaluation remained non-inferior on run-768 (-0.0291 nats, margin 0.02). All rejection decisions were caused by negative paired primary outcomes, not by a safeguard bypass.

## 3. Genuine operational fault found and fixed

Continuous training reached five consecutive rejections and surfaced `repeated-rejection`, but the old code reset the counter and immediately attempted another run against the same ready batch. This was observed as run-774 starting after the cap.

Fix deployed:

- After the rejection cap, training now remains **waiting** until `pendingReview > 0` or `trainable` increases.
- It polls with the normal supervisor interval; it does not hot-loop or duplicate jobs.
- The resilience test was updated to assert no additional train calls while waiting.
- Production confirmation: job-120 reached five rejections and remained `waiting / repeated-rejection` with no new run after 90 seconds.

No model or training hyperparameters were changed.

## 4. Readiness semantics

- Readiness uses the current selector, not a consumed historical snapshot.
- Historical snapshots are shown separately as `lastSnapshot` with `historical: true`.
- Current readiness: **18 fresh / 26,635 tokens**, above the 6,000 floor.
- Last historical snapshot: 7 fresh / 12,605 tokens.
- Integrity: `ok: true`, no selector/snapshot warning.
- The remaining original one-article v879 bake discrepancy is documented: 89/191,380 snapshot vs 90/186,784 selector, a 1-article/4,596-token difference. Root cause is lifecycle validation-block reservation (`config.trainValBlocks`) and cap ordering not being literally one shared function. It is not hidden and did not recur as a stale-readiness warning.

## 5. Acquisition, review and recovery

- Exactly one learning job (job-105), one review job (job-116), and one continuous training job (job-120).
- No duplicate jobs were created by automatic recovery or restart reconciliation.
- Operator stops remain respected; the historical operator-stopped jobs were not overridden.
- Learning continued while training waited.
- Review is idle at `waiting-for-review-material` because pending review is zero.
- Frontier remains intact: ~557,907 discovered, ~482,264 queued, 5,807 deferred, 1,750 failed; no reset or deletion.
- Discovery rotation and sitemap replenishment remain active; 500 sitemap URLs were enqueued from 9 sitemaps.

## 6. Diversity and rejection profile

- run-767: 89 fresh articles across 31 hosts and 86 source IDs.
- run-768: 34 fresh articles across 21 hosts; 3 archive.org rows and 1 Simple Wikipedia row.
- Later small batches were heavily en.wikipedia.org only (various 8–40-row snapshots). This is a concentration risk during rapid retry cycles.
- Current content-quality exclusions are dominated by `training-prose` (67), followed by TTS/commercial rules; no quality rule was weakened.
- Archive.org and Simple Wikipedia still pass the prose gate and therefore remain a false-acceptance risk to watch. No blanket domain exclusion was introduced.

## 7. Provenance and replay

- Run membership remains available:
  - run-767: 89 fresh / 12 validation; source `training-contribution`.
  - run-768: 34 fresh / 38 replay / 12 validation; source `training-contribution`.
- Article history remains available; e.g. `art_8758eb31-a45` records run-767 / v879 / promoted.
- Consumed articles retain `consumedRef` and content hashes.
- Replay eligibility remains derived from REVIEWED status/history; current replay-eligible queue is 21,269.
- Rejected batches are either deferred or consumed according to existing retry policy; no accumulated data or checkpoint lineage was deleted.

## Conclusion

The pipeline is now operating continuously: learning continues while training waits, review wakes when material exists, normal training promotes or rejects under the unchanged safeguards, and the active stable model remains v880 despite a rejection streak. The observed hot-loop after the rejection cap was a real operational fault and has been fixed and verified.

Tests: 957 tests, 950 passed, 7 skipped, 0 failed.

## Follow-up observation at 2026-11-18 21:35 UTC

The original v879 premise is now stale. Normal production promoted further:

- Active: **v920** (run-808, activated 2026-11-18T14:26:40Z).
- Working: **v920**.
- Working last-good: **v919**.
- v878 is no longer last-good; v879, v880 and v920 were promoted normally.

Current operational state:

- Learning job-105 is running.
- Review job-116 is waiting because pending review is zero.
- Training job-120 is waiting at **3 fresh / 3,342 tokens**, below the unchanged 6,000 floor.
- Exactly one job of each kind; no duplicates and no operator-stop override.

Readiness discrepancy remains material:

- Pending snapshot: 3 articles / 3,342 tokens.
- Current selector: 14 articles / 23,520 tokens.
- Only 2 articles are common.
- Integrity warning: selector 23,520 differs from pending snapshot 3,342.
- The 12 selector-only rows are largely older/non-English/backlog material, not the current pending batch. Readiness is therefore correctly reporting the pending snapshot as below the threshold, but the selector is not yet the same implementation.

Latest promoted run:

- run-808: 6 fresh / 12 validation; active v920.
- Fresh hosts: 3 web.archive.org, 2 en.wikipedia.org, 1 creativecommons.org.
- The batch contained two archive.org captures of the same globalchange.umich.edu lecture and a Creative Commons licence page. This is a genuine diversity/false-acceptance risk and should be addressed before treating archive.org as a reliable source.
- Paired primary improvement: 0.0152 (95% CI 0.0045..0.0287); broad non-inferior (-0.0111 nats, margin 0.02).

Provenance remains intact for run-808 (6 fresh / 12 validation), and the replay-eligible queue remains populated (~21,360). No data, frontier or checkpoint lineage was deleted.

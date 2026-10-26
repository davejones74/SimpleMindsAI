# Learning Stall Investigation

- Date: 2026-10-26
- Host: `dave-X1PRO`
- Repository HEAD: `89b5b9d73fdbd57f63fd8fa759108c5474ccf228`
- Production install: `/opt/simpleminds`
- Scope: read-only investigation; no production data, jobs, models, or configuration changed

## 1. Bottom line

There are **two separate problems**, and they are being conflated:

1. **Acquisition is hard-stopped by the admission cap.** The active epoch is
   `gateway-20261026-01`, cap **500**, and it is **500/500 used**. New articles
   cannot be admitted even though 167,201 frontier URLs are queued. This is the
   direct reason the total article count has stopped at **11,788**.
2. **The candidate models are genuinely regressing on the frozen evaluation
   set, because the training corpus is tiny and fragmentary.** This is not a
   stale baseline-cache bug and not primarily an evaluation-duration problem.
   Most reviewed articles are short fragments; the current training snapshot
   is 189 rows, median 123 characters, with 151 rows under 200 characters and
   139 rows failing the completeness signal. The evaluator is correctly
   detecting the resulting regression.

The review queue is **not** backed up: `PENDING_REVIEW` is **0**. The old plan's
"35 pending articles" are no longer pending. There are **34 trainable** articles
and job-33 waits at `34/40`.

## 2. Acquisition cap evidence

Live health:

```text
GET http://127.0.0.1:4000/health
{"ok":true,"uptime":58615,"articles":11788,
 "admission":{"epoch":"gateway-20261026-01","capLimit":500,"capUsed":500,"source":"pointer"}}
```

Admission startup/progress:

```text
2026-10-26 01:09:01  [admission] active epoch=gateway-20261026-01 cap=500 capUsed=0 source=pointer
2026-10-26 01:38:39  [admission] active epoch=gateway-20261026-01 cap=500 capUsed=300 source=pointer
now                   capUsed=500
```

Current learning job:

- `job-32` is the active continuous learning job.
- `job-27` and `job-29` were already **stopped by operator**.
- `job-32` reports, every cycle:
  - `rawDocs: 0`
  - `ingested: 0`
  - `admissionCapExhausted: true`
  - `admissionCapDeferred: 1`
  - `capEpoch: gateway-20261026-01`
  - `frontier.queued: 167201`
  - `frontier.visited: 12628`
  - `frontier.deferred: 1540`
  - `frontier.rejected: 0`

The cap was consumed very quickly: it was already at 300 by 01:38 and reached
500 shortly afterwards. A 24-hour run cannot acquire for 24 hours on a single
500-unit epoch.

### Important correction to the earlier plan

The current code no longer marks cap-rejected URLs terminally rejected. It calls
`frontier.deferCapRejected()` and leaves the URL queued for the next epoch. The
current frontier reports `rejected: 0`; the 2,880 cap-rejected entries seen in
the earlier `job-27` result are no longer present as rejected work.

However, `job-32` is still cycling once per minute and repeatedly claims the same
queued URL, defers it, and rewrites the entire 118 MB frontier:

- One URL (`https://de.wikipedia.org/wiki/Spezial:Linkliste/Quantencomputer`)
  has **904 cap-deferral entries**.
- Frontier file size: **117,897,680 bytes**.
- The file was rewritten again at 17:55:17, one minute after the previous cycle.
- `job-32` has reached cycle 910.

This is an ongoing I/O/SSD-write issue. Pausing `job-32` now is still the correct
immediate action, but for a different reason than the old plan assumed: not to
avoid permanent URL rejection, but to stop idle cap-deferral churn and frontier
rewrites until a rollover is ready.

## 3. Review / training-material state

Read-only store inspection:

| Metric | Value |
|---|---:|
| Total articles | 11,788 |
| Pending review | **0** |
| Reviewed | 6,172 |
| Rejected | 2,975 |
| Retired | 2,640 |
| Ingested | 1 |
| Quarantined | 0 |
| Trainable (reviewed + unconsumed) | **34** |
| Recoverable | 1 |
| Unique consumed | 7,076 |
| Total training appearances | 7,160 |
| Review records | 70,459 |

The 35 items that were previously in review cooldown have been processed. There
is no review backlog to force or wait for. The current training job waits because
34 < its configured `minEligible` of 40, not because review is stalled.

### Corpus quality

Reviewed articles (`REVIEWED` status):

- 6,172 total.
- **4,588 (74.3%) are under 200 characters.**
- **2,853 are under 100 characters.**
- Character lengths: min 11, p10 31, median 109, p90 344, max 12,008.

Current training snapshot `dataset-20261026-048` (run-221):

- 189 rows.
- Character lengths: min 18, p10 43, median **123**, p90 328, max 1,084.
- 151/189 rows under 200 characters.
- Completeness signal: **50 proceed, 90 quarantine, 49 reject**.
- Language signal: 28 English, 157 unknown, 4 non-English.
  ("Unknown" here mostly means too short for a confident language verdict; it
  is not a claim that all 157 are foreign.)

Concrete rows in the snapshot include:

- `Doing data science` (18 chars; title only)
- `The Problem with Quantum Computers` (34 chars; title only)
- `By Scott Pakin & Patrick Coles` (30 chars; author line)
- `We leverage third party services to both verify and deliver email.`
  (66 chars; boilerplate)
- A one-sentence Wikipedia fragment:
  `He later repudiated the philosophy he espoused in this book as fascistic...`
  (102 chars)
- A casino FAQ passage from `qualified.one` (207 chars)

The review history for the one-sentence fragment shows two `uncertain` verdicts
with completeness `quarantine`, followed by an `approve` at score 8. The
completeness gate is in **shadow** mode (`REVIEW_COMPLETENESS_MODE=shadow` in the
deployment template), so it records `quarantine` but does not stop the article
from being approved and trained on.

The casino FAQ shows two `uncertain` reviews at score 4, followed by an
`approve` at score 9. A single late approve is enough to make the article
trainable after the earlier uncertain attempts.

This is the most plausible explanation for "we found true articles but the model
still regresses": the crawler may fetch a real page, but the curated training
unit is often a title, author line, boilerplate, or one-sentence fragment.

## 4. Why the candidate models regress

The latest runs use a very small training corpus:

| Run | Train blocks | Train tokens | Steps | Effective epochs | Baseline loss | Candidate loss | Result |
|---|---:|---:|---:|---:|---:|---:|---|
| run-216 | 25 | 3,218 | 13 | 2.08 | 8.2576 | 8.2871 | rejected |
| run-217 | 25 | 3,245 | 13 | 2.08 | 8.2576 | 8.2865 | rejected |
| run-218 | 25 | 3,218 | 13 | 2.08 | 8.2576 | 8.2618 | inconclusive |
| run-219 | 25 | 3,245 | 13 | 2.08 | 8.2576 | 8.2759 | rejected |
| run-220 | 17 | 2,136 | 9 | 2.12 | 8.2576 | 8.3021 | rejected |
| run-221 | 14 | 1,803 | 7 | 2.00 | 8.2576 | 8.3140 | rejected |

The frozen evaluation set is `eval-002`:

- 60 documents, 376 blocks, 48,110 tokens.
- JSONL SHA-256 `dd64558c03352175edc098d319ec481e501baeaf8bba24b21f570bafeeb89598`.
- Manifest SHA-256 `de180e5cba4355bd4eae8b12234a139973f613f56759cfc30bba15f3e18d1f9a`.
- Paired source-group bootstrap; the regression runs have 95% CIs wholly below
  zero (for example run-221: point improvement -0.0578, CI -0.0655..-0.0502).

The training loss (`avgLoss` in the model record) is typically lower than the
evaluation loss—for example model-208: training 7.46, evaluation 8.29. That is
the signature of fitting a small/noisy training set while losing generalization
on the frozen evaluation set. The evaluator is behaving correctly.

### Is the evaluator the problem?

No evidence supports that as the primary cause:

- The baseline cache key now includes per-document mode, and the v199 entry has
  60 per-document rows with finite losses. It is not the stale aggregate entry
  that caused the earlier inconclusive results.
- Run-218 is already recorded as `inconclusive`; `RUN_OUTCOME.INCONCLUSIVE` and
  `resolveRunOutcome` are present, and run-events show the terminal status.
- The eval set is fixed and hashed; the leak guard is in the snapshot builder.
- The eval has 376 blocks / 48,110 tokens, far more than the ~1.8k–3.2k training
  tokens. A longer evaluation would reduce variance, but it would not turn a
  consistent -0.02 to -0.06 regression into an improvement.

Decoupling evaluation from training or running it over a longer period could be
useful for stability and for a less noisy promotion decision, but it is not the
explanation for the current regressions. Do not weaken the promotion gate or
extend evaluation just to make these candidates pass.

## 5. Status of the earlier recommended steps

1. **Stop continuous learning (job-27) before epoch reset.**  
   `job-27` is already stopped. `job-32` is the active learning job and should be
   paused now to stop the cap-deferral/frontier-rewrite loop. The current code
   defers rather than permanently rejecting URLs, so the original "irreversible
   rejection" risk no longer applies, but the I/O churn does.

2. **Roll the admission epoch or raise the cap.**  
   Not done. Current epoch `gateway-20261026-01` is 500/500. The sealed cap cannot
   be raised in place; use the existing explicit epoch rollover tool. Use a new
   epoch identifier (e.g. `gateway-20261026-02`), a backup root, and an
   operator-chosen cap. Do not enable automatic rollover.

3. **Invalidate the stale baseline cache.**  
   Already addressed in code and data. `baselineCacheKey` includes
   `per-document`; `cacheEntrySatisfiesEvidence` rejects aggregate-only entries
   in enforce mode. The v199 per-document entry has 60 rows and is usable.
   `eval-cache status` reports 19 stale aggregate-only entries for older
   versions; they are unreachable under the new key. The v199 dry-run prune
   removes **0** entries because v199 already has the required per-document
   evidence. No urgent cache deletion is needed.

4. **Fix run outcome reporting.**  
   Already addressed in the working tree and production. `INCONCLUSIVE` is in
   `RUN_OUTCOME`/`resolveRunOutcome`; run-218 is recorded as `inconclusive`;
   `completeRun`/`terminalRunStatus` persist it. The working tree still contains
   uncommitted lifecycle/test changes, but the production lifecycle hash matches
   the working tree.

5. **Force review or wait for cooldown for 35 pending articles.**  
   Stale. There are **0 pending** articles now. The 35 item count is gone. There
   are 34 trainable articles; job-33 waits at 34/40. Lowering `minEligible` to 34
   would allow a run, but that would train on the same small/fragmentary corpus
   and is unlikely to improve the result. Do not lower it merely to unblock a
   run; fix the data supply/quality first.

6. **Expect rejected rather than promoted; investigate fine-tune regression.**  
   Correct. The candidate losses are genuinely worse. The investigation above
   points to training-data quantity/quality, not evaluation.

## 6. Recommended fix sequence

### Immediate (operator action)

1. **Pause `job-32`** in the Observatory (`/api/admin/jobs/job-32/pause` or the
   UI). Keep `job-33` waiting/paused. This stops the 118 MB frontier rewrite and
   the 904-entry cap-deferral growth. Do not enable the perpetual timer.
2. **Back up admission state and roll to a new explicit epoch** using the
   existing CLI, run as `simpleminds`:

   ```bash
   sudo -u simpleminds env HOME=/var/lib/simpleminds \
     ADMISSION_DIR=/var/lib/simpleminds/data/gateway \
     FRONTIER_DIR=/var/lib/simpleminds/data/frontier \
     node /opt/simpleminds/src/cli/admission.js status

   sudo -u simpleminds env HOME=/var/lib/simpleminds \
     ADMISSION_DIR=/var/lib/simpleminds/data/gateway \
     FRONTIER_DIR=/var/lib/simpleminds/data/frontier \
     node /opt/simpleminds/src/cli/admission.js rollover \
       --next-epoch --cap <OPERATOR_CHOSEN_CAP> \
       --backup-root /var/lib/simpleminds/backups \
       --recover-cap-rejected
   ```

   Then verify `http://127.0.0.1:4000/health` shows the new epoch with
   `capUsed: 0`. The running service adopts the new pointer without a restart.
   `--cap` is an operator policy decision; the old 500 is already exhausted and
   is not sufficient for a 24-hour run at the observed rate.

3. **Resume learning only after the new epoch is confirmed.** Do not resume
   training until the data-quality work below is agreed.

### Before the next training runs

4. **Stop training on fragments.**
   - The completeness gate is currently shadow-only. After calibration on
     labelled fixtures, set `REVIEW_COMPLETENESS_MODE=enforce` or add an
     equivalent training-dataset completeness/length gate.
   - Apply the same gate to **fresh** reviewed rows at snapshot time. Today only
     replay rows are re-gated by `reuseEligible`; an old approved fragment can
     still enter as fresh material.
   - Audit/quarantine the 4,588 reviewed articles under 200 characters and the
     rows whose completeness signal is `quarantine`/`reject`. Use the existing
     quarantine reasons and preserve the audit trail; do not delete data.
   - Review the source/curation pipeline that produces title-only, author-line,
     and boilerplate rows from legitimate pages. The crawler finding is not
     enough if extraction/curation emits fragments.

5. **Do not lower `minEligible` to 30/34 just to force a run.** A 34-article
   corpus drawn from today's distribution would likely produce another
   regression. The correct sequence is more high-quality material first, then
   training.

6. **Keep the evaluation frozen and honest.** The current eval is adequate to
   detect these regressions. If desired, investigate a larger frozen held-out
   set or a separate scheduled evaluation for lower variance, but do not change
   the promotion threshold to make weak candidates pass. Do not interpret a
   lower training loss as improved generalization.

7. **Then investigate fine-tune dynamics.** Once the corpus is larger and
   cleaner, test controlled changes to learning rate, steps/epochs, replay share,
   and curriculum with the frozen evaluation. That is a separate experiment, not
   part of this investigation.

## 7. What is not the cause

- **Review backlog:** 0 pending; the queue is drained.
- **Stale v199 baseline cache:** v199 has 60 per-document rows and is usable;
  the key now distinguishes aggregate vs per-document; old aggregate entries are
  unreachable.
- **Missing run outcome:** run-218 is recorded inconclusive and the code has the
  INCONCLUSIVE outcome.
- **The chat student worker:** PID 1602595 is the long-lived `sma.student` chat
  backend child of the server, not an orphan training process. It is using ~100%
  of one CPU (51 threads, ~1.17 GB RSS), likely an OpenMP/PyTorch idle-spin or
  busy loop. It is worth tuning (`SMA_THREADS`, OMP wait policy) but it is not
  causing the cap exhaustion or the training regression. Do not kill it without
  confirming chat requirements.
- **A too-short evaluation:** the frozen eval has 48k tokens and the paired CIs
  are tight; longer evaluation cannot explain the consistent negative deltas.

## 8. Actions taken

- Read-only inspection of `/var/lib/simpleminds` data, registry, cache, frontier,
  logs, health, processes, and code.
- `eval-cache status` and a read-only `prune --dry-run` (no cache changes).
- No production service, job, data, model, frontier, admission state, or
  configuration was changed.
- No training, evaluation, promotion, deployment, commit, or push was performed.
- No external websites were contacted.

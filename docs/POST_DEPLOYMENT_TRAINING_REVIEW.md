# Post-deployment training review

This report reviews the first production training window after the data-aware
training rollout: `run-167` through `run-197`, 2026-10-21 00:39–17:54 UTC, plus
the live job state at 18:09 UTC. It records what changed, what the rollout
achieved, and why improvement stalled. It is deliberately evidence-first: every
number below comes from the live registry, article store, evaluation ledger, or
run manifests, not from a simulation.

The short version:

- The rollout was mechanically successful. The token floor, epoch budget,
  validation split, replay accounting, and commit-on-promotion path all operated
  as designed.
- The model improved by **0.281538 nats** from `v146` to `v176` (`8.561809 →
  8.280271`, about 3.29 %). All of that gain was recorded by `run-178`.
- After `v176`, **19 consecutive candidates were rejected**. Their mean delta was
  **−0.03425**; none beat the active baseline.
- The strongest explanation is **input quality**, not corpus size or the step
  budget. Of 1,312 fresh training articles, **49.3 % were under 100 characters**
  and **75.2 % were under 200 characters**. The critic approved all 1,312, and
  scored short fragments *higher* than long documents.
- A second, independent explanation is **promotion statistics**. Seven of the
  nine promotions were smaller than the conservative evaluation noise band
  (about 0.0379). The final promotion was **+0.00036**, while the training
  validation loss got worse. That promotion is not credible evidence of a real
  gain.
- A recovery defect also needs attention: rejected runs leave their manifests
  `consumed:false`, then the next run's recovery path consumes those articles.
  The documented deferral/retry loop therefore does not happen. The same recovery
  path emits a misleading "promotion completed on restart" event even when the
  service never restarted.

---

## Scope and method

- Production pointer at review time: `v176`, fingerprint `5160c3f50190`,
  activated 2026-10-21T08:44:47Z. Staged `v242.tmp` remains unpublished.
- Service: active, `NRestarts=0`; health verified after deployment; GraphQL and
  `/admin/` require the bearer token.
- Primary evidence:
  - `/var/lib/simpleminds/data/registry/runs.ndjson`
  - `/var/lib/simpleminds/data/registry/evaluations.ndjson`
  - `/var/lib/simpleminds/data/registry/snapshots.ndjson`
  - `/var/lib/simpleminds/data/registry/run-events.ndjson`
  - `/var/lib/simpleminds/data/registry/job-events.ndjson`
  - `/var/lib/simpleminds/data/snapshots/run-*-manifest.json`
  - `/var/lib/simpleminds/data/articles/{articles,reviews,consumption,article-events}.ndjson`
- Evaluation metric: causal-LM cross-entropy on the frozen 60-document
  `eval-002` set (376 blocks, 48,110 tokens). Lower is better. Improvement =
  baseline loss − candidate loss.
- The review is observational. There was no seed replication or counterfactual
  corpus during the window.

---

## What changed

### Training budget

`computeTrainingBudget()` now sizes a run from the actual number of training
blocks:

```text
steps = ceil(targetEpochs * trainBlockCount / effectiveBatchSize)
```

with `TRAIN_TARGET_EPOCHS=2` and the existing `TRAIN_MAX_STEPS=400` as a cap. The
legacy fixed `TRAIN_STEPS=60` is only a fallback when the block count is unknown.
The run record stores requested and effective steps, effective epochs, and
whether the cap applied.

### Minimum-data gate

`checkMinimumTrainingData()` requires at least `TRAIN_MIN_UNIQUE_TOKENS=1700`
training tokens. The count excludes validation. When token counts are
unavailable, the gate is not enforced, and that is recorded rather than guessed.

### Replay and validation split

Snapshots now carry explicit fresh, replay, and validation roles. The Python
packer builds validation blocks from role-tagged rows, not from training rows.
Replay is capped at 20 % by article count and validation defaults to 32 blocks.
The fallback path refuses to silently train on validation material if the corpus
is too small.

### Promotion safety and observability

The Python trainer stages candidates as `vNNN.tmp` and publishes only after a
passing gate. Rejected weights are discarded while provenance remains. Run
records now include corpus accounting, minimum-data status, budget status, and
validation-block accounting. Continuous jobs return a typed
`INSUFFICIENT_TRAINING_DATA` wait instead of crashing on an empty corpus.

### Deployment

The code was installed into `/opt/simpleminds`; the service was restarted; the
production env was installed with the user-supplied token outside the repo; the
temporary secret file was shredded. The full Node suite reported **529 passing,
7 skipped, 0 failing** tests. Python role-packing tests passed; the full Python
suite still hangs during tokenizer/model fetch.

### What did not change

The rollout did **not** add a semantic source-quality gate. It did not make the
critic reject fragments. It did not require a statistically meaningful
promotion delta. All three omissions matter below.

---

## Results

### Headline

| Metric | Value |
|---|---:|
| Completed runs reviewed | 31 (`run-167`–`run-197`) |
| Promotions | 9 |
| Rejections | 22 |
| Net improvement, `v146` → `v176` | **0.281538** |
| Relative improvement | **3.29 %** |
| Promotions after `run-178` | 0 |
| Rejections after `run-178` | **19** |
| Mean post-`v176` delta | **−0.03425** |
| Median post-`v176` delta | **−0.03124** |
| Post-`v176` delta range | −0.00937 to −0.07641 |

The nine promotions:

| Run | Parent → candidate | Baseline | Candidate | Delta |
|---|---|---:|---:|---:|
| 167 | v146 → v165 | 8.561809 | 8.426536 | +0.135273 |
| 169 | v165 → v166 | 8.426536 | 8.380641 | +0.045895 |
| 170 | v166 → v167 | 8.380641 | 8.373463 | +0.007178 |
| 171 | v167 → v168 | 8.373463 | 8.341178 | +0.032285 |
| 172 | v168 → v169 | 8.341178 | 8.332558 | +0.008620 |
| 173 | v169 → v170 | 8.332558 | 8.311141 | +0.021417 |
| 174 | v170 → v172 | 8.311141 | 8.297612 | +0.013529 |
| 176 | v172 → v174 | 8.297612 | 8.280629 | +0.016983 |
| 178 | v174 → v176 | 8.280629 | 8.280271 | **+0.000358** |

The first promotion is large and unambiguous. The later promotions shrink to
noise-scale differences. `run-169` is the only other promotion above the
conservative evaluation noise band; the remaining seven are below it.

### The plateau

After `run-178`, every candidate was worse than `v176`:

| Run | Delta | Fresh docs | Mean chars | Docs <100 chars | Train tokens | Steps |
|---|---:|---:|---:|---:|---:|---:|
| 179 | −0.0261 | 30 | 244 | 14 | 2,065 | 8 |
| 180 | −0.0094 | 39 | 177 | 18 | 1,868 | 7 |
| 181 | −0.0318 | 20 | 509 | 3 | 2,717 | 11 |
| 182 | −0.0374 | 36 | 183 | 15 | 1,805 | 7 |
| 183 | −0.0196 | 57 | 115 | 40 | 1,802 | 7 |
| 184 | −0.0425 | 21 | 304 | 11 | 1,757 | 7 |
| 185 | −0.0107 | 44 | 191 | 18 | 2,319 | 9 |
| 186 | −0.0664 | 67 | 151 | 24 | 2,594 | 10 |
| 187 | −0.0312 | 25 | 270 | 3 | 1,714 | 7 |
| 188 | −0.0331 | 48 | 171 | 29 | 2,197 | 9 |
| 189 | −0.0312 | 53 | 240 | 21 | 3,448 | 14 |
| 190 | −0.0216 | 27 | 362 | 2 | 2,657 | 11 |
| 191 | −0.0494 | 53 | 179 | 31 | 2,525 | 10 |
| 192 | −0.0459 | 46 | 147 | 25 | 1,902 | 8 |
| 193 | −0.0251 | **124** | **51** | **120** | 1,804 | 8 |
| 194 | −0.0764 | 57 | 230 | 29 | 3,477 | 14 |
| 195 | −0.0150 | 38 | 171 | 8 | 1,836 | 7 |
| 196 | −0.0541 | 48 | 171 | 24 | 2,248 | 9 |
| 197 | −0.0240 | 56 | 127 | 31 | 1,816 | 7 |

This is not a case of "not enough training". More tokens and more steps did not
help:

- `run-189` used 3,448 tokens and 14 steps and was rejected.
- `run-194` used 3,477 tokens and 14 steps and was the **worst** rejection
  (−0.0764).
- `run-193` supplied 124 fresh documents, but 120 were under 100 characters and
  the average was 51 characters.
- `run-170` and `run-171` were promoted on 2,052 and 1,854 training tokens
  respectively.

Across the 31 runs, fresh-document count correlated **negatively** with delta:
Pearson −0.297, Spearman −0.346. Training tokens had only a weak, unstable
association (Pearson +0.282, Spearman +0.065). Average document length had a
positive Pearson correlation (+0.540) but a weak rank correlation (+0.187),
consistent with a few long-document runs driving the linear statistic.

### The budget and validation machinery worked

| Check | Result |
|---|---|
| Minimum-data gate enforced and passing | 31 / 31 runs |
| Training tokens above floor | 1,700–3,868 |
| Validation blocks | 32 in every run |
| Validation shortfall | 0 in every run |
| Corpus split mode | `role-appended` in every run |
| Step cap hit | 0 runs |
| Requested steps | 7–15 |
| Effective epochs | 2.00–2.15 |
| Training blocks | 13–30 |
| Mean replay token share | 27.7 % |

So the new machinery is not failing. It is faithfully budgeting and splitting a
corpus that is frequently unsuitable for continued pretraining.

---

## Primary finding: the corpus is mostly fragments

Across the 31 runs there were **1,312 fresh articles**, all unique. The length
distribution is the central result:

| Length | Documents | Share |
|---|---:|---:|
| Under 50 chars | 329 | 25.1 % |
| Under 100 chars | 647 | **49.3 %** |
| Under 200 chars | 986 | **75.2 %** |
| Under 500 chars | 1,233 | 94.0 % |
| 500+ chars | 79 | 6.0 % |

Mean length was **197 characters**; median length was **101 characters**. All
lengths in this report are characters, not tokens.

Every one of the 1,312 was approved by the critic. The critic did not merely
tolerate fragments; it preferred them:

| Document length | Approvals | Mean score | Median score |
|---|---:|---:|---:|
| Under 100 chars | 647 | **8.37** | 9 |
| 100–199 chars | 339 | 8.22 | 8 |
| 200–499 chars | 247 | 8.07 | 8 |
| 500+ chars | 79 | **7.80** | 7.72 |

The approval verdict was `approve` for all 1,312. A 33-character title such as
`Neural Networks 1991: Vol 4 Iss 2` received a score of 8 with a rationale
claiming it was useful material about a significant period in the field. The
critic is inferring substance from metadata that is not present.

Representative corpora:

- `run-193` — 120 of 124 documents were under 100 characters. Examples:
  `6.831 User Interface Design and Implementation`,
  `6.837 Computer Graphics`, `6.851 Advanced Data Structures`. Average length:
  51 characters. Rejected.
- `run-194` — 57 documents, largely priceonomics article titles such as
  `The New Jersey Single Family Home Price Boom` and
  `Why Do People Get Payday Loans? Here’s How it Breaks Down By Income, Age and Location`.
  Rejected at −0.0764.
- `run-197` — 56 documents, largely OpenAlex citation titles such as
  `Molecular Cloning: A Laboratory Manual` and
  `The PRISMA 2020 statement: an updated guideline for reporting systematic reviews`.
  Rejected.
- `run-191` — mixed license boilerplate (`GNU Free Documentation License`
  fragments), event deadlines (`March 5, 2013 : registration deadline`), and
  isolated headings. Rejected.
- `run-186` — hybrid-intelligent-systems prose mixed with bibliography entries.
  Rejected at −0.0664.
- `run-169` — Nature reference-list fragments, but also longer material; it was
  promoted at +0.0459. This is the exception, not the pattern.

The harvested documents are often the citation/reference section, title list,
navigation text, or metadata block rather than the article body. The critic then
reads that fragment in isolation and interprets it as a complete training
document. The token floor cannot detect this: `run-193`'s 124 title/code fragments
supplied 1,804 training tokens but almost no learnable prose.

### What the correlations do and do not mean

The data are observational and confounded by time and source mix. The negative
association between document count and delta and the weak positive association
between length and delta are consistent with the fragment hypothesis, but they
do not prove it. The stronger evidence is the length distribution, the concrete
corpora above, and the critic's inverted length/score relationship.

---

## Secondary finding: the promotion gate accepts noise-scale gains

The evaluation reports a conservative 95 % band for a loss difference of
**±0.0379** (two independent estimates; `lossStdErr=0.01368` each). The promotion
gate deliberately ignores this band and accepts any positive delta.

Seven of the nine promotions are smaller than that band. The final promotion,
`run-178`, was **+0.000358**. Its training validation loss got **worse**, from
`10.049673` to `10.097767`, while the frozen eval improved by 0.00036. That is
not a credible basis for declaring `v176` better than `v174`; it is more
consistent with evaluation noise or a tiny distributional accident.

This matters for the interpretation of the whole window:

- The large early gain is real enough to take seriously, but the later
  "six-promotion streak" includes deltas of +0.0072, +0.0086, +0.0135, +0.0170,
  and +0.0004. Repeatedly selecting the positive side of small differences on a
  fixed 60-document evaluation set is a winner's-curse setup.
- Once the easy gain was captured, subsequent selected candidates were more
  likely to be noise-negative. Nineteen consecutive rejections are exactly what
  a plateau plus a zero-threshold gate looks like.
- `v176`'s edge over `v174` is 0.00036. If the active model is effectively
  equivalent to `v174`, the post-`v176` rejection streak is still a plateau, but
  the nominal baseline is slightly arbitrary.

This does not prove that all small promotions were noise. It does mean the
system should not treat them as established improvements without a paired
uncertainty estimate.

The gate also does not consult the in-training validation split. The split is
now correctly built and recorded, but it is diagnostic only. A candidate can
worsen validation and still be promoted on a frozen-eval improvement of 0.0004,
as `run-178` did.

---

## Secondary finding: rejected articles are consumed on the next run

The intended policy is explicit in `src/training/lifecycle.js`: rejection must
not consume articles; they should remain eligible for retry up to
`maxRejectedRetries`. The actual recovery path does something different.

On rejection, the manifest is written with `consumed:false` and deferral
metadata. At the start of the next run, `recoverPendingPromotions()` sees a
rejected manifest with `consumed:false`, calls `commitConsumption()` on its
snapshot article IDs, marks the manifest consumed, and emits:

```text
promotion completed on restart (pending manifest recovered)
```

For `run-179`:

- 30 fresh articles were deferred at 08:47:30Z with retry count 1.
- The next run recovered the rejected manifest at 08:48:30Z.
- Consumption records for those 30 articles were written under `run-179`.
- Those articles are now excluded from future snapshots by `isTrainable()`.

All 31 runs had disjoint fresh-article sets: **1,312 fresh articles, 1,312 unique
IDs, zero overlap**. The deferral/retry mechanism is therefore not operating in
production. The event is also misleading: the service did not restart
(`NRestarts=0`); recovery ran because the next run acquired the run lock. This
pattern produced 162 "on restart" events historically and all 19 post-`v176`
rejection events.

Consequences:

- Rejected material is never retrained with different companion data, despite
  the retry counters and documentation.
- The "max rejected retries" safeguard is inert.
- Event logs overstate restarts and make crash analysis harder.
- This does not explain the plateau by itself, and one-shot use of rejected
  fragments may even be preferable, but the implementation must match the stated
  policy.

---

## Limitations

- This is one 17.2-hour window with 31 runs, one frozen evaluation set, and no
  replicate training seeds. The correlation results are descriptive, not causal.
- The reported noise band is conservative and assumes independent estimates.
  A paired per-document bootstrap would give a tighter and more appropriate
  uncertainty estimate. Per-document losses were not retained, so that analysis
  could not be performed retroactively from the ledger.
- The `articles.ndjson` `status` field is the creation record, not the live
  status; live status is reconstructed from `article-events.ndjson`. The live
  status was not treated as a bug in this report.
- Direct 8-gram overlap between `eval-002` documents and snapshot articles was
  zero, so there is no evidence of verbatim evaluation leakage. Semantic overlap
  was not exhaustively tested.
- The full Python test suite still hangs during tokenizer/model fetch. The
  deployment and role-packing tests pass, but full Python regression coverage
  was not obtained.

---

## What this does not prove

- It does not prove that `TRAIN_TARGET_EPOCHS=2` or `TRAIN_MAX_STEPS=400` are
  wrong. No run hit the cap; the step budget was not the constraint.
- It does not prove that `TRAIN_MIN_UNIQUE_TOKENS=1700` is too low in general.
  Every run passed it, including runs made almost entirely of fragments. Token
  count is the wrong discriminator for this failure mode.
- It does not prove that `minEligible=15` caused the stall. The window produced
  31 runs, so article count was not the binding constraint for most of it; the
  job is blocked now because the review/curation pipeline has 148 pending items.
- It does not prove that a larger model or more training would not help. It
  shows that, with this corpus, more steps and more tokens did not help.

---

## Recommendations

### P0 — fix the input before changing the optimizer

1. **Add a deterministic pre-review quality gate.** Before the critic sees a
   document, reject obvious non-prose: titles/headings, citation lists,
   reference sections, navigation text, license boilerplate, and metadata
   blocks. At minimum use length plus sentence/stopword structure, not token
   count. The observed distribution (49.3 % under 100 characters) makes a
   length floor unavoidable; the exact threshold should be shadow-tested.
2. **Fix the critic rubric and prompt.** The critic approved every selected
   fresh document, including fragments, and scored short documents higher than
   long ones. Add explicit fragment examples as negative cases, require evidence
   of complete sentences and substantive content, and make approval fail closed
   on insufficient text.
3. **Audit extraction, not just discovery.** Several sources return the
   reference/citation section or page title rather than the article body. Fix
   the extractor/boilerplate removal for OpenAlex, Nature, priceonomics, course
   catalogs, and archived pages before ingesting more of them.
4. **Enforce language filtering consistently.** Replay included a Catalan
   Wikipedia article, and the curator log shows non-English sources being
   skipped only sometimes. Make the policy deterministic and record refusals.

### P0 — make promotion evidence credible

5. **Use a paired uncertainty estimate on the frozen evaluation set.** Retain
   per-document or per-block losses and require the lower bound of the paired
   delta to exceed zero, or at minimum require the delta to exceed a measured
   noise threshold. Do not promote on +0.0004.
6. **Do not use the in-training validation split as decoration.** Either make it
   a gate or explicitly document that it is diagnostic. A candidate that worsens
   validation while gaining 0.0004 on the frozen set should not become active.

### P1 — repair rejected-manifest recovery

7. **Decide and enforce one policy for rejected articles.** If rejection must
   not consume, the recovery path must not call `commitConsumption()` for a
   rejected manifest; close the manifest without consuming. If one-shot use is
   intended, remove the retry/deferral promise and rename the event. Add a
   regression test covering: reject → next run starts → fresh articles are still
   eligible (or explicitly consumed).
8. **Emit the recovery event only for real recovery.** A normal next-run lock
   acquisition is not a restart. The current note makes every rejection look like
   a crash.

### P2 — operations

9. **Keep `minEligible=15` and `TRAIN_MIN_UNIQUE_TOKENS=1700` for now.** Neither
   was the limiting factor in this window, and lowering `minEligible` to 12 would
   not fix fragment quality.
10. **Investigate the review backlog.** At 18:09 UTC, `job-26` was waiting with
    149 recoverable articles (148 pending review, 1 ingested) and zero trainable.
    `job-25` was still curating. Throughput and review quality need separate
    measurement.
11. **Continue the current jobs without manual production mutation.** The active
    model is `v176`; `v242.tmp` remains staged and unpublished.

---

## Bottom line

The rollout fixed the training mechanics. It did not fix the training material.
The model made a real early gain, then spent the rest of the window selecting
noise-scale improvements and rejecting candidates trained on titles, citations,
headings, and boilerplate. The next meaningful gain is more likely to come from
refusing bad documents before the critic and requiring credible promotion
evidence than from increasing steps, lowering the article threshold, or adding
more of the same corpus.

# Baseline — 2026-11-02/03

Captured read-only with:

```bash
node scripts/knowledge-pilot/collect-baseline.mjs \
  --out /home/dave/sma-experiments/knowledge-accumulation-pilot-20261102/baseline/baseline.json
```

The machine-readable report is [`baseline.json`](./baseline.json).

## Repository

| Item | Value |
|---|---|
| Branch | `knowledge-accumulation-pilot-20261102` |
| Base HEAD | `16a04c33e4f284ee6d1d9ca0dd56e2602f55531a` |
| Worktree | `/home/dave/Repositories/SimpleMindsAI` |
| Pilot storage | `/home/dave/sma-experiments/knowledge-accumulation-pilot-20261102/` |

## Production state at observation

| Measure | Value |
|---|---:|
| Articles | 25,438 |
| Accepted-ever (approved at least once) | 15,625 |
| Trainable now | 40 |
| Replay-eligible (current pool) | 7,275 |
| Replay-excluded (reviewed/retired/consumed) | 43 |
| Consumed unique | 9,686 |
| Consumed-and-retired | 7,383 |
| Retired replay-eligible | 0 |
| Reviews | 91,029 |
| Article events | 195,047 |
| Consumption rows | 9,917 |
| Contribution rows | 169 |
| Raw sources | 5,150 |

Frontier at observation:

| State | Count |
|---|---:|
| Unique URLs | 441,172 |
| Queued | 392,564 |
| Visited | 44,292 |
| Deferred | 4,315 |
| In-progress | 1 |

Registry at observation:

| Item | Value |
|---|---:|
| Run records (distinct ids) | 415 |
| Snapshot records | 5,918 |
| Evaluation records | 972 |
| Model records | 410 |
| Run-event rows | 2,381 |
| Model-event rows | 482 |

## Historical rejected-candidate evidence

From the prior lifecycle audit (same production ledgers; not reclassified by this pilot):

- 179 rejected runs have consumption records.
- 6,331 consumption appearances / 6,277 unique articles.
- 5,555 of those are currently `RETIRED`; only 696 are currently replayable.
- The old recovery defect that consumed rejected manifests is fixed in current HEAD and covered by `test/lifecycle-crash.test.js:125-156`; the historical ledger effects remain.

## Checkpoints and optimizer state

| Item | Value |
|---|---:|
| Active production version at observation | `v482` |
| Active artifact | `simpleminds-62m-20261018-0bb99dc9f16d` |
| Active weight fingerprint | `0bb99dc9f16d` |
| Allocated versions observed earlier | 473 |
| Committed versions observed earlier | 50 |
| Allocated-but-not-committed | 424 |
| Rejected provenance dirs observed earlier | 490 |
| Retained optimizer-state files observed earlier | 9 |
| Stale full `.tmp` checkpoints observed earlier | 4 |

## Training and evaluation configuration observed

| Setting | Value |
|---|---|
| `SNAPSHOT_LIMIT` | 256 |
| `SNAPSHOT_INCLUDE_CONSUMED` | false |
| `TRAIN_REPLAY_PERCENT` | 20 |
| `TRAIN_TARGET_EPOCHS` | 2 |
| `TRAIN_MAX_STEPS` | 400 |
| `TRAIN_MIN_STEPS` | 0 |
| `TRAIN_MIN_UNIQUE_TOKENS` | 1,700 |
| `TRAIN_VAL_BLOCKS` | 32 |
| `TRAIN_SEQ_LEN` | 128 |
| `PROMOTE_UNCERTAINTY_MODE` | enforce |
| `PROMOTE_MIN_GROUPS` | 20 |
| `PROMOTE_EVAL_MIN_BLOCKS` | 8 |
| Frozen evaluation set | `eval-002`, 60 documents, 48,110 tokens |

## Baseline limitations

1. **Production is live.** The active version moved from `v468` (earlier audit) to `v482` during observation; this was not caused by the pilot.
2. **Production `v482` weights were not readable** by the audit user (`model.safetensors` mode 600, owned by `simpleminds`). The pilot therefore used the accessible, real 62M `v389` parent from `/home/dave/sma-experiments/controlled-experiment-20261030T230000Z/parent-store/v389`. This is a genuine random-initialised 62M lineage, not a pretrained model.
3. **Gateway state could not be read** (`/var/lib/simpleminds/data/gateway` is not readable by the audit user). Gateway limits are recorded from `deploy/etc/x1pro.simpleminds.env`, not from live state.
4. **Contribution coverage is partial**; the ledger covers recent completed runs, not the full lifetime.
5. **Accepted-ever is a review-ledger proxy** (approved at least once); it is not a replacement for the new funnel instrumentation.

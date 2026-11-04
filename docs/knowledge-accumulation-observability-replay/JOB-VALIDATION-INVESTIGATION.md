# Training Inactivity and Validation Bottleneck Investigation

Evidence: [`evidence/validation-availability.json`](./evidence/validation-availability.json), [`evidence/knowledge-accumulation-observability.json`](./evidence/knowledge-accumulation-observability.json).

## Current state

| Item | State |
|---|---|
| Stable active | `v493` |
| Working | `v500` (parent `v499`) |
| Working last-good | `v499` |
| Working advances | 6 (`run-420…run-425`) |
| Latest stable decision | `run-425` inconclusive |
| Training job | `job-60`, waiting / `waiting-for-validation` |
| Learning job | `job-59`, running |

`job-60` has completed five runs in this job (`run-421…run-425`), most recently `run-425` at 15:48 UTC. It has been waiting since then, retrying every minute. This is a **wait**, not an active training session.

## Why the trainer is waiting

The Node partitioner can currently build a prospective validation partition:

```text
prospective clusters: 2
validation articles: 3
estimated validation tokens: 131
trainer block count: 0
```

The trainer reports `blockCount: 0` because the actual tokenizer total for those three articles is **97 tokens**:

| Validation article | Chars | Tokenizer tokens |
|---|---:|---:|
| `art_b344860f-dba` | 220 | 46 |
| `art_1379a44c-550` | 175 | 31 |
| `art_be372558-d16` | 128 | 20 |
| **Total** | **523** | **97** |

The validation packing requires one complete 128-token block. The current cohort is 31 tokenizer tokens short, so the trainer correctly refuses to fall back to tail splitting.

## How many new prospective clusters are required

- Minimum: **one prospective cluster with at least one complete 128-token block**.
- The current two prospective clusters collectively contain only 97 actual tokens; no single cluster can form the block.
- Safe trigger: one new unexposed document/cluster with **at least 128 actual tokenizer tokens**, or enough additional unexposed material in one prospective cluster to cross 128. A new document of 128+ tokens is the conservative requirement.
- Estimated token counts are not sufficient; the current endpoint estimated 131 tokens while the tokenizer produced 97. The trainer block count is authoritative.

## Is `job-59` producing material?

Yes, but not currently enough validation material:

- It is running and cycling (40 cycles observed).
- It has produced trainable material and prospective clusters; the working checkpoint advanced six times.
- The current pass has `rawDocs=0`, `ingested=0`, `reviewWaiting=true`, `reviewSkippedCooldown=4`, `noUsefulDocuments=true`.
- Frontier/acquisition is viable (`claimable` > 400k), so this is not source exhaustion; it is a slow/no-useful-document pass plus review cooldown.
- The current trainable count is 21; the latest current-store analysis still has only two prospective validation clusters.

There is no separate scheduling bottleneck found: `job-59` is running; `job-60` is polling; the one-shot/continuous job controls are functioning. The blocker is the fail-closed prospective validation block, not a stopped acquisition process.

## UI distinction

The existing Learning & Training panel displayed the training job's `waiting` text, but the durable job-history table labelled every non-terminal job `PENDING_REVIEW`, which is an article status, not a job status. That made waiting and running easy to confuse.

Changes in this branch:

- The job-history and control badges now show the actual job status (`running`, `waiting`, `paused`, `completed`, etc.) with status-appropriate colour classes.
- The new Brain knowledge panel explicitly separates:
  - **Node partition**: built/waiting;
  - **Trainer blocks**: authoritative `blockCount`;
  - **Lifecycle**: training job status/phase/waiting reason;
  - **Validation**: prospective clusters, articles, estimated tokens and required one-block floor.

Fail-closed prospective validation was not weakened.

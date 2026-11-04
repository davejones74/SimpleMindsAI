# Production Monitoring

Snapshot: `reports/monitoring.json` at 2026-11-04T09:23:58Z. Source of truth: `/var/lib/simpleminds/store`, `/var/lib/simpleminds/data/{articles,registry}`, and `/api/admin/jobs`.

## 1. Current production state

| Metric | Value |
|---|---|
| Service | `simpleminds.service` active |
| Stable active | `v493` / `edf63f7283b3` |
| Working | `v495` / `a05f5e1dec4e` |
| Working last-good | `v493` |
| Working advancement count (post-activation) | 1 (`run-420`) |
| Working rejection count (post-activation) | 0 |
| Stable promotions (post-activation) | 0 |
| Stable rejections (post-activation) | 1 (`run-420`) |
| Rollbacks | 0 |
| Recovery events | 0 |
| Optimizer continuity | `carried` from `v493`; 0 resets |
| Training job | `job-60` continuous, waiting for new prospective validation |
| Learning job | `job-59` continuous, harvesting |

## 2. Material and corpus accounting

| Category | Count / value |
|---|---:|
| Articles | 25,696 |
| Trainable (fresh) | 88 |
| Pending review | 9 |
| Reviewed | 7,440 |
| Rejected | 7,994 |
| Retired | 10,252 |
| Unresolved | 0 |
| Replay-eligible | 7,702 |
| Replay-excluded | 43 |
| Deferred fresh | 27 |
| Recoverable | 10 |
| Unique consumed | 9,753 |
| Total appearances | 9,984 |
| Consumed and retired | 7,383 |
| Retained for replay | 5,319 |

`reviewed`/`rejected`/`retired` include historical material. The migration added 377 explicit replay-eligibility events; the first run added 42 newly consumed records.

## 3. First-run corpus mix

| Stream | Documents | Tokens |
|---|---:|---:|
| Fresh | 42 | 767 |
| Replay | 31 | 1,329 |
| Validation | 75 | 2,054 |
| **Presented training** | — | **4,096** |
| **Measured replay share** | — | **63.4%** |

Configured replay share: `20%`. This is an open finding. The pre-partition estimate was 19.99%; validation partitioning reduced the fresh training stream after replay selection.

## 4. Guard and stable-gate observations

| Signal | Value |
|---|---|
| Working guard | `working-guard-v2` |
| Working regression | +0.0088 nats |
| Groups compared | 60 |
| Groups over 0.15 nats | 0 |
| Groups over 0.05 nats | 1 |
| Regressed-group share | 1.67% |
| Worst group | `en.wikipedia.org/wiki/Compiler` -0.0515 nats / 691 tokens |
| Stable candidate delta | -0.0088 nats |
| Stable paired CI | -0.0135..-0.0060 |
| Stable noise band | ±0.0379 |
| Stable decision | rejected |

The stable gate is unchanged and still governs `active.json`. The working guard accepted a cumulative update that was not stable enough to serve.

## 5. Storage and resources

| Metric | Value |
|---|---|
| Store size | 22.9 GB |
| Disk used / free | 321 GB / 1.59 TB (17%) |
| `v495` weights | 236 MB |
| `v495` optimizer state | 472 MB |
| Training wall time | 5.386 s |
| Training throughput | ~760 tokens/s |
| Peak RSS | 3.29 GB |
| CUDA/ROCm max allocated | 1.635 GB |
| Max reserved | 2.045 GB |

## 6. Distinguishing material states

- **Ingested:** written to the article ledger; not yet trainable.
- **Reviewed:** has a decisive review; may still be deferred, consumed, replay-only, or retired.
- **Consumed:** attached to a completed training batch; not fresh again.
- **Replayable:** explicit or legacy replay pool membership; may be consumed, retired, or replay-only.
- **Demonstrated improvement:** only a candidate accepted by the unchanged stable promotion gate. `run-420` did **not** demonstrate stable improvement; it demonstrated a working-checkpoint update.

## 7. Monitoring queries

- Pointers: `cat /var/lib/simpleminds/store/{active,working,working-last-good}.json`
- Jobs: `GET /api/admin/jobs/{jobId}` with the admin bearer token
- Eligibility: `GET /api/admin/training/eligibility?minEligible=1`
- Run evidence: `/var/lib/simpleminds/data/registry/runs.ndjson`, `run-events.ndjson`
- Store metrics: `/var/lib/simpleminds/data/articles/articles.ndjson` via `ArticleStore.getStats()`
- Disk: `df -h /`; store: `du -sh /var/lib/simpleminds/store`

## 8. Alerts worth keeping

- `job-60` remains waiting while `replayEligible` grows and `trainable` is non-zero: expected fail-closed validation, not data loss.
- Measured replay share above the configured target: investigate before further working advancement.
- Any `active.json` change without a stable `promoted` run: stop and investigate.
- Any working pointer change without a matching working guard record: stop and investigate.
- Any prune plan containing active, working, or last-good: stop and investigate.

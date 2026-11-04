# Knowledge Accumulation Observability and Replay Correction

**Status:** implementation and verification complete on a separate branch. No production deployment or production mutation was performed by this work package.

Branch: `knowledge-accumulation-observability-replay-20261104`  
Base: `8831006` (production activation branch)

## Findings

1. **AdamW continuity is real.** `v495`'s optimizer has all 74 parameter step counters at `15`, exactly eight steps after `v493`'s `7`; all 148 `exp_avg`/`exp_avg_sq` tensors changed; `v495` records eight completed training steps. A reset optimizer would have had step `8`, not `15`. The next run (`run-421`) selected `v495` and carried its optimizer state; the chain continued to `v496…v500`.
2. **Training is waiting, not silently stopped.** `job-60` is waiting because the current prospective validation cohort has 3 articles / 2 clusters / 131 estimated tokens but only **97 tokenizer tokens**; no cluster reaches the 128-token validation block floor. At least one prospective cluster must contribute one complete block; safe minimum is one new prospective document/cluster of at least 128 actual tokens.
3. **Replay mix was wrong after validation exclusion.** The old selector sized replay against the pre-validation fresh stream. `run-425` had a 20.04% pre-partition estimate but a **36.66%** measured final replay share. The correction trims replay against the final fresh training stream after validation exclusion; on the frozen `run-425` snapshot this produces **19.65% actual replay** instead of 36.66%, removing 16 replay documents.
4. **The new Brain view is pull-only.** `GET /api/admin/knowledge-accumulation` is a read-only snapshot; the UI uses one fetch and a manual Refresh button. It has no `EventSource` and no `setInterval`, so it cannot hold a long-lived SSE connection or block training.

## Navigation

- [`OPTIMIZER-CONTINUITY.md`](./OPTIMIZER-CONTINUITY.md)
- [`JOB-VALIDATION-INVESTIGATION.md`](./JOB-VALIDATION-INVESTIGATION.md)
- [`REPLAY-MIX-CORRECTION.md`](./REPLAY-MIX-CORRECTION.md)
- [`UI-OBSERVABILITY.md`](./UI-OBSERVABILITY.md)
- [`DEPLOYMENT-RECOMMENDATION.md`](./DEPLOYMENT-RECOMMENDATION.md)
- [`evidence/`](./evidence/)
- [`ui-evidence/knowledge-accumulation-view.png`](./ui-evidence/knowledge-accumulation-view.png)
- [`ui-evidence/knowledge-accumulation-preview.html`](./ui-evidence/knowledge-accumulation-preview.html)

## Test result

`node --test`: **795 tests, 788 passed, 0 failed, 7 skipped**.
Focused replay/observability: **18 passed**.

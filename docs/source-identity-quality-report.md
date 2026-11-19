# Source Identity, Quality and Acquisition Resilience

## 1. Canonical source identity

Added `src/dataset/source-identity.js`:

- Unwraps `web.archive.org/web/<timestamp>/<original>` and `/wayback/` captures.
- Derives a normalized canonical URL (lowercase host, no fragment, tracking params removed, trailing slash normalized).
- Derives the underlying publisher from the original URL, never the archive host.
- Keeps the exact fetched capture identity separately from the canonical source identity.
- Preserves `sourceUrl` and `fetchedUrl`; new records also carry `originalSourceUrl`, `canonicalSourceUrl`, and `sourcePublisher`.

Selection now groups candidate units by canonical source. When multiple captures of one canonical source are present in the same batch, only one capture contributes units; non-archive originals are preferred, then the longer capture. Other captures remain in the ledger and replay pool for future batches.

Snapshot rows now include `canonicalSourceUrl`/`originalSourceUrl` when they differ and use the underlying publisher for diversity reporting. Historical snapshots are not rewritten.

## 2. Non-substantive pages

Added original-URL-aware legal/admin path detection:

- `licenses`, `terms`, `privacy`, `copyright`, `legal`, `dmca`, `trademark`, `acceptable-use` paths and archive-wrapped equivalents are excluded as `legal-admin-page`.
- The rule is path-based and narrow; ordinary `/about` and educational pages are not blanket-excluded.
- Existing commercial/TTS/technical/reference and source-level prose rules remain.

Verified examples:

- `https://creativecommons.org/licenses/by/4.0/` -> `exclude`, `legal-admin-page`.
- The same page inside a Wayback capture -> `exclude`, `legal-admin-page`.
- `https://en.wikipedia.org/wiki/Cell_(biology)` -> `allow`.
- Full test suite: **961 tests, 954 passed, 7 skipped, 0 failed**.

## 3. Curation timeout root causes and retry

Production logs showed:

- `The operation was aborted due to timeout`
- `ollama /api/chat 500: prediction aborted, token repeat limit reached`

Previously each chunk was attempted once; on failure the error was counted and the source was not marked complete. Successful units from other chunks were retained in that cycle, but there was no chunk-local retry.

Added bounded retry:

- `CURATOR_CHUNK_RETRIES` default 2 (total 3 attempts).
- `CURATOR_CHUNK_RETRY_DELAY_MS` default 750 ms, capped exponential backoff.
- Retries only transient failures (timeout, network, socket, 429/5xx, repeat limit); deterministic errors are not retried.
- Only the failed chunk is retried; successful chunk results remain in the current source result.
- The source is still not marked complete when any chunk ultimately fails, so deduplication prevents successful chunks from being ingested twice on a later cycle.

Remaining limitation: successful chunk results are preserved per cycle but not cached durably across cycles. A later partial-source retry re-runs the teacher for successful chunks as well, though content-hash dedup prevents duplicate article records.

## 4. Production observations

Current lineage:

- Active: **v920**
- Working: **v926**
- Working last-good: **v923**

Training continues normally under selection-v2 and the existing safeguards. Recent fixed batches matched exactly:

- 6 / 11,989 tokens (snapshot = selector)
- 5 / 8,473 tokens
- 8 / 10,251 tokens
- 5 / 8,429 tokens
- 6 / 7,752 tokens

Integrity is `ok: true` when the pending snapshot is current. Training run-809 was inconclusive; later runs were rejected normally; no rejected candidate became active.

Current fresh pool: **6 articles / 7,752 tokens** (above 6,000). The latest small batch was entirely `en.wikipedia.org`, so replenishment exists but publisher/subject diversity remains weak. This is the primary remaining acquisition problem.

## 5. run-808 false-diversity findings

The old run-808 batch contained:

- 3 `web.archive.org` rows
- 2 `en.wikipedia.org` rows
- 1 `creativecommons.org` row
- Two archive captures of the same globalchange.umich.edu lecture
- One Creative Commons licence page

The licence page now fails `legal-admin-page`. Canonical grouping now prevents multiple captures of the same original from jointly entering a batch. No blanket archive.org exclusion was added; genuine archived educational content remains eligible.

## 6. Funnel / replenishment

Current approximate counts:

- Collected: 44,242
- Reviewed: 44,241
- Nominally trainable: 496
- Prose/content eligible at selection: 27
- Cap-eligible fresh: 6
- Fresh tokens: 7,752
- Replay eligible: 21,391
- Consumed: 19,060
- Frontier queued: ~482k; failed: ~1.75k; deferred: ~5.8k

Replenishment is occurring (multiple new batches and normal runs), but the current fresh pool is only just above the floor and the latest batch is enwiki-only. More discovery/curation work is needed for durable publisher diversity.

## 7. Verification and safeguards

- Deployment: `/opt/simpleminds`; backup `/opt/simpleminds/.deploy-backup/deploy-20261118T230331Z`.
- Selection implementation remains `training-selection-v2`.
- 6,000-token minimum and 4,000-token prohibition unchanged.
- Evaluation-leak guard remains active and applied before caps.
- Validation/promotion safeguards, architecture, optimizer and training hyperparameters unchanged.
- Active model pointer remains v920; working/last-good pointers advanced only through normal training.
- Frontier and accumulated article data were not reset or deleted.

## Remaining work

1. Durable chunk-result cache to make cross-cycle retries truly limited to failed chunks.
2. Publisher/subject diversity: current fresh batches are being dominated by one host.
3. Archive capture canonicalisation needs production evidence over more cycles, not only unit/manual checks.

# Fresh Knowledge Diversity and Sustainable Replenishment

## 1. Funnel diagnosis

Current production snapshot:

- Collected: 44,242
- Reviewed: 44,241
- Nominally trainable: 496
- Content eligible at selection: 27
- Collected fresh before caps: 25
- Source-cap exclusions: 1
- Publisher-cap exclusions: 18
- Cap-eligible fresh: 6
- Fresh tokens: 5,754
- Replay eligible: 21,398
- Consumed: 19,067

Loss path from the current eligible cohort:

`25 fresh candidates -> 1 source-cap exclusion + 18 publisher-cap exclusions -> 6 fresh articles -> 5,754 tokens`

The current 6-article batch is entirely `en.wikipedia.org`. The publisher cap is not creating other publishers; it is thinning a single-publisher pool. This is the central diversity problem.

Content-quality exclusions at the latest check:

- `training-prose`: 66
- `commercial-tts-path`: 95
- `known-tts-product`: 94
- `commercial-phrases`: 92
- `commercial-url-path`: 24
- `price-pattern`: 8
- `marketing-path`: 6
- `technical-host`: 4
- `retail-host-path`: 4

No blanket source exclusion was added.

## 2. Publisher/subject diversity

Latest fresh batches repeatedly collapsed to one publisher:

- 6 articles, all en.wikipedia.org
- 7 articles, all en.wikipedia.org
- 25-27 article candidate snapshots, all en.wikipedia.org

This is not caused by a lack of configured roots: 3,898 eligible domains and a rotating sitemap window are present. The immediate cause is frontier ordering / source distribution plus the training publisher cap thinning an already single-publisher cohort.

Implemented targeted fairness change:

- `Frontier.claimNext()` now prefers a different host from the previous broad claim.
- This is a fairness preference, not an exclusion; a single-host frontier still progresses.
- Focus-class claims retain priority.
- Unit test covers a two-host rotation and single-host fallback.

This change is deployed but not yet demonstrated over multiple production cycles.

## 3. Discovery / frontier measurements

- Frontier total: ~571k
- Queued: ~493k
- Visited: ~69.8k
- Failed: ~1.9k
- Deferred: ~5.9k
- Retry distribution: mostly unretried queued URLs; 5,878 at retry 1
- Root pool: 3,898; adapter window: 25; root cursor advanced to ~1,025
- Sitemap adapter previously found/enqueued 500 URLs from 9 fetched sitemaps
- Domain concentration is visible:
  - science.nasa.gov: ~153k discovered URLs, 959 fetches, 525 failures
  - www.nasa.gov: ~117k discovered, 149 fetched
  - scite.ai: ~7,890 discovered
  - www.wired.com: ~7,275 discovered, 67 fetched
- `science.nasa.gov` alone dominates both discovery volume and failure count.

## 4. Durable curation chunk cache

Implemented `src/services/curation-cache.js` and wired it into the learning cycle.

Cache key includes:

- canonical source identity
- source content hash
- chunk index
- exact chunk text hash and length
- chunk size configuration
- curation strategy
- teacher model
- mission-focus prompt hash
- cache version (`curation-chunk-cache-v1`)

Behaviour:

- Successful teacher results are appended durably to `data/curation-cache.ndjson`.
- A later cycle reuses only an exact matching source+chunk+configuration result.
- Failed/missing chunks are retried; successful chunks are reused.
- Cache entries survive process restarts (unit-verified by reopening the file).
- Source completion is still only recorded when every chunk resolved.
- Dedup still prevents duplicate article ingestion.
- Cache hit/miss/entry/write counters are logged and included in learning progress.

Production limitation: after restart and deployment, no new curation chunks had yet been processed, so the cache file has not yet accumulated production entries. Behaviour is unit-tested, not yet demonstrated over multiple teacher calls in production.

## 5. Canonical identity production measurement

Recent post-fix snapshots contain no archive captures; the new canonical fields are present on fresh rows. The older run-808 duplicate was the motivating case:

- Two archive captures of one globalchange.umich.edu lecture.
- One Creative Commons licence page.
- 3 archive-host rows from 2 underlying sources.

The canonical layer now unwraps archive URLs, attributes the original publisher, and chooses one capture per canonical source per batch. Historical snapshots remain unchanged. Production archive-capture measurements remain limited because current cycles are enwiki-only.

## 6. Fresh replenishment over observation

Observed normal batches after selection-v2:

- 6 / 11,989 tokens
- 5 / 8,473
- 8 / 10,251
- 5 / 8,429
- 6 / 7,752
- current 6 / 5,754 (below floor; training waiting)

Replenishment is not yet reliably above consumption: the latest pool is below 6,000 tokens and the training job is correctly waiting. Replay remains available but is not a substitute for fresh readiness.

## 7. Selection and model safeguards

- Active model: **v920**
- Working: **v926**
- Working last-good: **v923**
- `training-selection-v2` remains deployed.
- Evaluation-leak guard remains before diversity caps.
- 6,000-token minimum unchanged; 4,000 fallback not enabled.
- Validation, promotion, architecture, optimizer and training hyperparameters unchanged.
- Active pointers were not manually changed.
- Dataset/frontier were not reset or deleted.

## 8. Tests and deployment

- **963 tests, 956 passed, 7 skipped, 0 failed**
- Deployment backup: `/opt/simpleminds/.deploy-backup/deploy-20261118T231638Z`
- New tests cover source identity/unwrapping, legal/admin page rejection, curation cache exact-key and restart reuse, and frontier host fairness.

## Outstanding limitations

1. Production curation-cache reuse has not yet been exercised because no new curation chunks completed after deployment.
2. Publisher diversity remains poor; host-fair frontier claiming is deployed but needs multiple cycles of evidence.
3. Current fresh pool is below 6,000; training is correctly waiting.
4. Archive capture canonicalisation has unit evidence and one prior motivating production case, not yet new production captures.

## 9. Follow-up implementation (2026-11-18 23:35 UTC)

Approved targeted changes deployed:

- **Publisher identity**: registrable-domain identity (e.g. `science.nasa.gov` and `www.nasa.gov` -> `nasa.gov`) while preserving exact host. Used for frontier fairness, root rotation and diversity reporting.
- **Publisher-level root rotation**: multiple subdomains of one publisher share one adapter slot per cycle; other publishers remain in rotation. `rotatePublisherRoots` is unit-tested.
- **Sitemap budgets**: per-root and per-publisher candidate budgets (defaults 100/200) in addition to the global 500. Large single roots can no longer exhaust the whole adapter pass; their remaining URLs stay discoverable in later cycles.
- **Frontier fairness**: broad claims choose the least-claimed canonical publisher, with the previous publisher only as a tie-breaker. Focus-class priority and queued-before-retry-before-rediscovery ordering remain.
- **Diagnostics**: readiness now reports fresh publisher IDs/count and fresh subjects; exclusions expose source/publisher cap article IDs; frontier exposes publisher claim counts.
- **Curation cache**: production-safe guard added; only sources with a real content hash are cacheable/readable, so missing-hash sources cannot collide or reuse stale entries.

Current post-deployment state:

- Active: v920; working/last-good unchanged by this work.
- Latest pending snapshot: 6 / 5,754 tokens; below 6,000, training correctly waiting.
- Fresh publisher IDs: `wikipedia.org` (1 publisher); fresh subjects: 2.
- Cap exclusion IDs now visible: 18 publisher-cap, 1 source-cap.
- Integrity: OK.
- Frontier: ~494k queued, ~1,937 failed, ~5,897 deferred.
- Tests: **967 total, 960 passed, 7 skipped, 0 failed**.
- Deployment backup: `/opt/simpleminds/.deploy-backup/deploy-20261118T233540Z`.

No production cache entries have yet been created because no new curation chunk completed after cache deployment. Publisher diversity has not yet improved in production; the new sitemap/frontier fairness mechanisms need multiple cycles to shift the queue/fetch mix.

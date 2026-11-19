# Production Verification: Publisher Diversity and Fresh Replenishment

## Observation window

2026-11-18 23:35–23:42 UTC, immediately after the publisher-identity, sitemap-budget and frontier-fairness deployment.

Only normal production jobs were used. No training run was forced and no further restart was performed for measurement.

Lineage during observation:

- Active: **v920**
- Working: **v931**
- Working last-good: **v926**

## Measured state

| Metric | Value |
|---|---:|
| Pending fresh snapshot | 6 articles |
| Fresh tokens | 5,754 |
| Fresh-token minimum | 6,000 |
| Readiness | false; training waiting |
| Fresh publishers | 1 (`wikipedia.org`) |
| Fresh subjects | 2 |
| Frontier queued | 494,063 |
| Frontier visited | 69,828 |
| Frontier failed | 1,937 |
| Frontier deferred | 5,897 |
| Publisher claims since restart | 0 |
| Curation cache production entries | 0 |

Integrity: **ok: true**. Snapshot and selector both show 6 / 5,754.

The latest normal training job remained correctly blocked below 6,000 tokens.

## Front distribution

The frontier is still overwhelmingly sitemap-derived and concentrated:

- Total entries observed earlier: 571,632
- Sitemap provenance: 475,435
- Link extraction: 96,101
- Seed: 96
- Depth 0: 475,531; depth 2: 90,774; depth 1: 5,327

Largest hosts:

| Host | Total | Queued | Visited | Deferred |
|---|---:|---:|---:|---:|
| science.nasa.gov | 35,947 | 34,463 | 959 | 525 |
| www.nasa.gov | 18,522 | 18,358 | 149 | 15 |
| scite.ai | 7,889 | 7,879 | 0 | 10 |
| d-nb.info | 7,564 | 7,513 | 46 | 5 |
| www.wired.com | 7,258 | 7,187 | 67 | 4 |

NASA queues contain a mix of substantive mission/science articles and administrative/event/index pages. No bulk deletion or source blacklist was applied.

Top failure codes across the frontier:

- `FETCH_STATUS`: 3,064
- `robots-disallowed`: 1,506
- `non-content-extension`: 1,187
- `FETCH_BAD_CONTENT_TYPE`: 690
- `FETCH_NETWORK`: 188
- `FETCH_DNS`: 180
- `FETCH_TOO_LARGE`: 147
- `FETCH_TIMEOUT`: 36

Most are not transient and should not be retried more aggressively.

## Publisher and subject diversity

Current fresh batch:

- One canonical publisher: `wikipedia.org`.
- Two subjects.
- All fresh articles are English Wikipedia.

This is **not improved** relative to pre-deployment. The new publisher identity correctly collapses NASA subdomains and the sitemap budgets are deployed, but the current pending batch was produced before those changes had a chance to alter the fetch mix.

## Sitemap budgets and root rotation

Deployed:

- per-root sitemap candidate budget: 100
- per-publisher sitemap candidate budget: 200
- global sitemap candidate budget: 500
- publisher-aware root rotation

Production evidence during this window is insufficient:

- No new sitemap discovery cycle completed after deployment.
- Root cursor remained at 1,025.
- No new publisher distribution sample was produced.
- The current queue does not demonstrate whether the 100/200/500 budgets are effective or whether large roots are starved.

The implementation is unit-tested but not yet production-validated.

## Frontier fairness

Deployed:

- least-claimed canonical publisher selection
- publisher-level root rotation
- focus priority preserved
- queued-before-retry-before-rediscovery preserved

Production evidence:

- No fetch claims occurred after restart in the observation window.
- `publisherClaims` was empty.
- Therefore no claim-distribution before/after conclusion can be drawn yet.
- No starvation or focus-priority defect was observed because no claims occurred.

## Curation cache

- Production cache file was absent.
- No real curation chunk completed after deployment.
- No production hits, misses, writes or avoided teacher calls to report.
- Cache exact-key and restart behavior remain unit-tested only.

## Fresh replenishment

No complete post-deployment acquisition/curation/training cycle completed in the observation window. Therefore:

- New substantive articles/hour: not measurable yet.
- New eligible tokens/hour: not measurable yet.
- Net fresh growth/depletion: current net is still the existing 6 / 5,754; no new material entered.
- Training consumption: zero this window; training correctly waiting.
- Replay was not used to disguise the shortfall.

The current state does **not** demonstrate sustainable replenishment. It only demonstrates that the safeguards remain intact while supply is below the floor.

## Tests and deployment

- Tests: **967 total, 960 passed, 7 skipped, 0 failed**
- Deployment backup: `/opt/simpleminds/.deploy-backup/deploy-20261118T234136Z`
- Selection: `training-selection-v2` unchanged
- Active v920 preserved
- 6,000-token minimum and no-4,000 fallback preserved
- Evaluation, validation, promotion, architecture, optimizer and hyperparameters unchanged
- Corpus and frontier preserved

## Conclusion

Measured production evidence is currently insufficient to claim the new distribution changes work:

1. The pending batch is still single-publisher and below the token floor.
2. No post-deployment sitemap cycle or fetch-claim sample exists.
3. The curation cache has no production entries.
4. Training remained blocked, correctly.

No speculative fix was made in this observation phase. The next valid step is to let normal acquisition cycles populate the frontier and cache, then repeat the same measurements over multiple cycles without further restarts.

## Follow-up after bottleneck correction (2026-11-19 00:05–00:12 UTC)

### Root cause

The frontier was persisting the entire 415 MB NDJSON file on every claim, visit and enqueue. A probe against a copied frontier measured:

- `init`: ~2.1 s
- `claimNext` before fix: ~2.36–2.48 s per claim
- The live Node process stayed near 99% CPU while no harvest completed.

This was the acquisition bottleneck: fairness was not the only cost; full-state persistence after each claim dominated.

### Correction

Frontier hot-path mutations now append changed records to `frontier-delta.ndjson` instead of rewriting the full 415 MB frontier:

- claim
- enqueue
- mark visited
- mark failed
- admission/resolution record

The base frontier remains a checkpoint; delta records are replayed on startup and compacted by an explicit full `persist()`. No frontier records were deleted or reset.

Probe after fix:

- `claimNext`: ~0.53–0.58 s per claim
- 5 claims: ~2.7 s
- `markVisited`: ~0.54 s
- publisher claims rotated across `wikipedia.org`, `elmnet.ir`, `wiley.com`, `doi.org`, `sciencedirect.com`.

### Live production result after correction

The learning job began processing immediately after deployment:

- Harvest: **10 raw documents, 21 failures**
- 25 distinct publisher claims observed, each with one claim in the fairness sample:
  aloki.hu, archive.org, ashipunov.info, barrameda.com.ar, bn.gov.br, bne.es, bnf.fr, britannica.com, compulenta.ru, d-nb.info, doi.org, ecowiki.org.il, elmnet.ir, elpais.com, epa.gov, eso.org, glencoe.com, gov.hu, grani.ru, greenfacts.org, hamaarag.org.il, iop.org, ipmnet.ru, iwf.or.id, johnstonsarchive.net.
- New fresh readiness recovered from **6 / 5,754** to **9 / 9,097 tokens**.
- Fresh publishers increased from **1** to **2** (`eso.org`, `wikipedia.org`).
- Fresh subjects increased from **2** to **4**.
- Review job-116 moved from waiting to active review pass.
- Training remained normal; run-821 was inconclusive, so active v920 remained.
- Curation cache was created with **7 entries** and six distinct publishers; no cache hit/miss summary was available before the cycle completed.

This is the first direct production evidence that the pipeline can acquire and process fresh material again after the persistence correction.

The remaining publisher concentration is now downstream (language/quality/source yield), not an idle claim path.

### Remaining evidence gaps

- Curation-cache hit/miss/write counters still need a completed second cycle.
- Sitemap budget and publisher-root rotation need several full cycles to prove sustained distribution.
- Fresh pool is above threshold but only 2 publishers; sustainable diversity is not yet established.
- Training remains under unchanged safeguards; no forced run was used.

## End-to-end acquisition after persistence correction

The first active cycle after the incremental frontier delta fix produced real work:

- Frontier claims: 25 distinct publishers, each with one claim in the fairness sample.
- Harvest: 10 raw documents, 21 failures.
- Visited hosts included `eqworld.ipmnet.ru`, `elpais.com`, `solarviews.com`, `viaf.org`, `catalogue.bnf.fr`.
- Review job moved from waiting to active.
- Curation cache created 7 entries across 6 publishers.
- Fresh readiness recovered from **6 / 5,754** to **9 / 9,097 tokens**.
- Fresh publishers: **2** (`eso.org`, `wikipedia.org`).
- Fresh subjects: **4**.

A normal training run-822 then ran and was rejected:

- Paired improvement: -0.0088 (95% CI -0.0142..-0.0033).
- Active model remained **v920**.
- Fresh readiness immediately fell back to **7 / 5,536 tokens**, below 6,000; training is waiting again.

This proves the acquisition/curation path can produce fresh material again, but it does **not** prove sustainable replenishment: one normal run consumed the new supply and the pool fell below the floor. The remaining bottleneck is downstream supply volume and diversity, not an idle frontier.

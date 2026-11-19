# Fresh Readiness Reconciliation and Recovery

## Root cause

The authoritative training snapshot and the dashboard selector were not applying the same evaluation-leak guard.

The selector produced 14 fresh rows, but 11 of them overlap the frozen `eval-002` / `eval-broad-002` sets. The snapshot builder removed those overlaps later. Therefore the selector could truthfully report 23,520 tokens while the trainer had only 3,342 usable tokens.

A second, smaller discrepancy remained: one eval-safe Wikipedia article (`art_956c9e8c-110`) was omitted from the snapshot by source/publisher cap ordering, while one eval-safe article (`art_acd6450b-175`) was present in the snapshot but absent from the selector.

Applying the leak guard before diversity caps fixed both cases and freed cap capacity for the valid rows.

## Exact pre-fix reconciliation

Snapshot A (3 articles, 3,342 tokens):

| Article | Tokens | Host | Language | Eval-safe | Snapshot | Selector | Reason |
|---|---:|---|---|---|---|---|---|
| art_186e3992-9c7 | 218 | web.archive.org | unknown | yes | yes | yes | safe; in both |
| art_c4246eff-b7d | 1,405 | cs.wikipedia.org | cs | yes | yes | yes | safe; in both |
| art_acd6450b-175 | 1,719 | en.wikipedia.org | en | yes | yes | no | safe; omitted by cap ordering |

Selector B (14 articles, 23,520 tokens):

| Article | Tokens | Host | Language | Eval-safe | Snapshot | Selector | Reason |
|---|---:|---|---|---|---|---|---|
| art_956c9e8c-110 | 5,808 | en.wikipedia.org | en | yes | no | yes | safe; omitted from old snapshot by cap ordering |
| art_a7e3951d-426 | 309 | ga.wikipedia.org | ga | **no** | no | yes | eval n-gram overlap |
| art_288fc6be-2cf | 282 | polyarchy.org | unknown | **no** | no | yes | eval n-gram overlap |
| art_bb2de6bd-570 | 458 | mnw.wikipedia.org | mnw | **no** | no | yes | eval n-gram overlap |
| art_5d23ca70-1e3 | 1,231 | simple.wikipedia.org | en | **no** | no | yes | eval n-gram overlap |
| art_721a486b-799 | 994 | sco.wikipedia.org | sco | **no** | no | yes | eval n-gram overlap |
| art_7a4ac423-962 | 2,161 | simple.wikipedia.org | en | **no** | no | yes | eval n-gram overlap |
| art_5ea0bb82-170 | 340 | web.archive.org | en-GB | **no** | no | yes | eval n-gram overlap |
| art_832a0904-809 | 361 | www.mpg.de | en | **no** | no | yes | eval n-gram overlap |
| art_732833cd-fce | 510 | quantamagazine.org | en | **no** | no | yes | eval n-gram overlap |
| art_98e5c39e-23d | 1,444 | web.archive.org | unknown | **no** | no | yes | eval n-gram overlap |
| art_e981c6ec-863 | 7,999 | en.wikipedia.org | en | **no** | no | yes | eval n-gram overlap |

Common safe articles: `art_186e3992-9c7`, `art_c4246eff-b7d`.
Snapshot-only: `art_acd6450b-175`.
Selector-only: 11 evaluation-leak rows plus `art_956c9e8c-110`.

The leak guard reported 11 n-gram matches across the selector cohort. No exact or normalized-hash matches were needed to explain the discrepancy.

## Shared selection fix — `training-selection-v2`

- `collectRowsFromArticles` now accepts the evaluation guard and excludes leak-overlapping candidates before grouping, replay selection and diversity caps.
- Lifecycle passes its already-loaded guard into collection.
- The readiness pipeline loads the same `eval-002` and `eval-broad-002` sets, builds the same guard, and passes it into the same collector.
- Snapshot manifests now record `selectionVersion` and `selectionHash`.
- Readiness set comparison is order-independent; a stale training-preflight token value is no longer compared after a run is no longer waiting.

## After fix

The first post-fix batch reconciled exactly:

- Snapshot: 6 articles / 11,989 tokens.
- Selector: 6 articles / 11,989 tokens.
- IDs: `956c9e8c`, `186e3992`, `c4246eff`, `ef77c71d`, `41681ca0`, `acd6450b`.
- Run-809 then trained and evaluated normally; it was **inconclusive** (paired -0.0012, CI -0.0049..0.0028), so v920 remained active.

Subsequent normal cycles also matched:

- Snapshot and selector: 5 / 8,473 tokens.
- Snapshot and selector: 8 / 10,251 tokens.
- Integrity: `ok: true`.

No threshold, fallback, validation, promotion or model hyperparameter was changed.

## Remaining source-quality issue

run-808 was promoted from 6 fresh rows: 3 web.archive.org, 2 en.wikipedia.org, 1 creativecommons.org. Two archive captures represented the same underlying lecture, and one row was a licence page. This remains a content-identity/false-acceptance concern; archived material needs canonical-source deduplication before it can be treated as reliable diversity.

## Verification

- 957 tests: 950 passed, 7 skipped, 0 failed.
- Deployment: `/opt/simpleminds` updated with backup `/opt/simpleminds/.deploy-backup/deploy-20261118T225147Z`.
- Active model remains v920; working v920; last-good v919.
- Frontier, accumulated data and checkpoint lineage unchanged.

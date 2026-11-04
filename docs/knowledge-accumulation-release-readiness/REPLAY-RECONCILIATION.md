# Replay Migration Reconciliation

## 1. Production dry-run (read-only)

Command:

```bash
node scripts/knowledge-pilot/classify-replay.mjs \
  --store /var/lib/simpleminds/data/articles \
  --out .../reports/replay-migration-dry-run.json
```

No production apply was performed. The latest dry run scanned a live store that had grown slightly since the pilot audit:

| Classification | Count | Estimated tokens |
|---|---:|---:|
| Scanned | 25,438 | — |
| `ELIGIBLE` | 377 | 27,781 |
| `UNRESOLVED` | 3,875 | 354,034 |
| `INELIGIBLE` | 13,892 | 228,594 |
| `ALREADY_ELIGIBLE` | 7,103 | — |
| `NOT_TARGET` | 191 | — |

The 191 `NOT_TARGET` records are not retired; they are not part of the historical replay restoration target.

## 2. Unresolved breakdown

The migration now reports reason codes and source-domain aggregates:

| Unresolved reason | Count | Estimated tokens | Interpretation |
|---|---:|---:|---|
| `licence-uncertain` | 1,054 | 120,688 | Known mixed/variable families (Wikipedia, OpenStax, arXiv, etc.) requiring item-level licence review |
| `licence-unknown` | 1,312 | 149,869 | Source family not in the pilot licence policy; provenance/domain mapping required |
| `no-decisive-review` | 1,509 | 83,490 | No approve/reject decision in the review ledger; needs review evidence |
| **Total** | **3,875** | **354,034** | |

Top unresolved domains include `en.wikipedia.org` (670), `web.archive.org` (423), `simple.wikipedia.org` (149), `ckb.wikipedia.org` (96), `ca.wikipedia.org` (81), `arxiv.org` (75), `azb.wikipedia.org` (69), `el.wikipedia.org` (65), `esahubble.org` (65), `bg.wikipedia.org` (58).

This is consistent with the pilot: most unresolved material is licence/provenance uncertainty or missing decisive review, not a text-quality failure.

## 3. Classification logic review

The script checks, in order:

1. already in replay pool → `ALREADY_ELIGIBLE`;
2. `REJECTED` → ineligible;
3. `QUARANTINED`/quarantine flag → ineligible;
4. explicit `excludedReason` → ineligible;
5. not `RETIRED` → not targeted;
6. missing text / content-hash mismatch → ineligible;
7. no decisive review → unresolved;
8. last decisive review is reject → ineligible;
9. deterministic language/quality/completeness gate rejects → ineligible;
10. licence uncertain/unknown → unresolved;
11. licence safe + approved + valid text + quality pass → eligible.

It never broadens eligibility based on consumption, URL novelty, or source-family popularity. It never deletes or rewrites text, reviews, consumption or events.

## 4. Recommendations for the 3,875 unresolved records

Do not broaden the policy to increase the count.

1. **1,054 `licence-uncertain`** — resolve item-by-item. Prioritise Wikipedia/OpenStax/arXiv because they dominate. For CC BY-SA/NC material, record the actual licence and decide whether the intended model use is permitted. Keep them out until that is explicit.
2. **1,312 `licence-unknown`** — build a provenance/domain map and verify the source family. `web.archive.org` requires resolving the archived original URL and licence, not treating the archive host as the publisher. Unknown domains remain unresolved.
3. **1,509 `no-decisive-review`** — locate the review history or re-review under the current critic. If the critic is uncertain, classify `UNRESOLVED`, not `RETIRED`/rejected; do not admit on the assumption that the text is good.
4. **Re-run the dry run** after each batch, compare counts and token estimates, and require an explicit apply decision for the isolated copy before any production migration.

## 5. Safety

- Apply is refused against `/var/lib/simpleminds` and `/opt/simpleminds`.
- The apply path is idempotent and preserves consumption/review history.
- The migration report includes classification samples and reason/domain aggregates.
- No production migration is authorised by this package.

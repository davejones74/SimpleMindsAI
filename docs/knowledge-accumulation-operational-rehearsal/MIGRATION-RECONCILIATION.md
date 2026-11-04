# Replay Migration Rehearsal and Reconciliation

## 1. Method

1. Dry-run the migration against the read-only snapshot article store.
2. Copy only the article ledger to `migration-store/articles`.
3. Apply the migration to the copy (`--apply --confirm`).
4. Dry-run the copy again.
5. Compare before/apply/after counts and verify the snapshot itself is unchanged.

## 2. Exact reconciliation

Machine-readable: `migration-before.json`, `migration-apply.json`, `migration-after.json`, `migration-reconciliation.json`.

| Classification | Before | Applied | After |
|---|---:|---:|---:|
| Scanned | 25,570 | 25,570 | 25,570 |
| `ELIGIBLE` | 377 | 377 | 0 |
| Restored / newly replay-eligible | — | 377 | — |
| `ALREADY_ELIGIBLE` | 7,283 | 7,283 | 7,660 |
| `UNRESOLVED` | 3,875 | 3,875 | 3,875 |
| `INELIGIBLE` | 13,950 | 13,950 | 13,950 |
| `NOT_TARGET` | 85 | 85 | 85 |

The arithmetic is exact:

```text
7,283 already eligible
+   377 restored
= 7,660 already eligible after
```

Unresolved and ineligible counts are unchanged; no rejected, quarantined, uncertain-licence or invalid record was restored. Snapshot article files changed after rehearsal: **0**.

## 3. Unresolved reconciliation

| Reason | Count | Estimated tokens |
|---|---:|---:|
| `licence-uncertain` | 1,054 | 120,688 |
| `licence-unknown` | 1,312 | 149,869 |
| `no-decisive-review` | 1,509 | 83,490 |
| **Total** | **3,875** | **354,034** |

Top unresolved domains: `en.wikipedia.org` 670, `web.archive.org` 423, `simple.wikipedia.org` 149, `ckb.wikipedia.org` 96, `ca.wikipedia.org` 81, `arxiv.org` 75. The source-family concentration is consistent with the previous dry run.

## 4. Recommendation

- The 377 safe-family records are safe to restore on the snapshot and are the evidence that the migration is executable and idempotent.
- Do not broaden eligibility to reduce the 3,875. Resolve them progressively:
  1. item-level licence review for the 1,054 mixed-family records;
  2. provenance resolution for `web.archive.org` and unknown domains (1,312);
  3. retrieve/re-run review evidence for the 1,509 no-decision records.
- A production apply remains a separate authorisation. No production migration was applied.

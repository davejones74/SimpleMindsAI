# Independent Replay Eligibility and Historical Migration

## 1. Model

Replay eligibility is now a durable property independent of review status:

```text
reviewDisposition: APPROVED | REJECTED | UNRESOLVED | QUARANTINED | LEGACY_RETIRED
replayEligible: true | false
excludedReason: LICENCE | LANGUAGE | QUALITY | DUPLICATE | CORRUPTION | null
```

Implemented in `src/domain/article.js`:

- `isReplayEligible(article)` — text present, not rejected/quarantined/unresolved, no explicit exclusion, and either an explicit `replayEligible` value or the legacy `REVIEWED` fallback.
- `isReplayPool(article)` — eligible **and** (`consumed`, `replayOnly`, or explicitly eligible `RETIRED`). A fresh unconsumed `REVIEWED` article is eligible for a future replay but is not yet a reservoir row.
- `isReplayExcluded(article)` — explicit/inferred exclusion.

Durable events are appended, never rewritten:

```text
{ type: "replay-eligibility", articleId, eligible, reason, excludedReason, at }
```

`ArticleStore.setReplayEligibility()` is idempotent for the same value/reason. `retireArticle()` still records a retirement event, but no longer implies replay ineligibility once an explicit eligibility event exists.

`UNRESOLVED` was added to the status enum for records whose review/consumption evidence conflicts or is insufficient. It is retained, not trainable and not replayable until resolved. It is deliberately distinct from `REJECTED` (quality/licence verdict) and `RETIRED` (historical review terminal state).

## 2. Eligibility rules

An article may be replay-eligible only when:

1. source text is present and non-empty;
2. the content hash matches the stored text (migration integrity check);
3. the last decisive review is `approve`;
4. the deterministic language/quality/completeness gate does not reject;
5. the source family is on the conservative pilot licence allowlist;
6. it is not `REJECTED`, `QUARANTINED`, `UNRESOLVED`, or explicitly excluded.

A source family with uncertain or missing licence/provenance is classified `UNRESOLVED`, not eligible. The migration does **not** silently convert all retired records into replayable records.

## 3. Migration script

`scripts/knowledge-pilot/classify-replay.mjs`

- Default: **dry run**, read-only ArticleStore.
- `--apply` requires `--confirm` and refuses `/var/lib/simpleminds` or `/opt/simpleminds`.
- Writes a JSON report with counts, token estimates, samples and classification reasons.
- Never deletes text, reviews, consumption records or events.
- Idempotent: a second apply restores zero additional records.

Licence policy: `scripts/knowledge-pilot/replay-licence-policy.json` (conservative allowlist; uncertain families remain unresolved).

## 4. Production dry-run result

Command:

```bash
node scripts/knowledge-pilot/classify-replay.mjs \
  --store /var/lib/simpleminds/data/articles \
  --out .../reports/replay-migration-dry-run.json
```

Machine-readable report: [`replay-migration-dry-run.json`](./replay-migration-dry-run.json).

| Classification | Count | Estimated tokens (chars/4) |
|---|---:|---:|
| Scanned articles | 25,438 | — |
| `ELIGIBLE` | 377 | 27,781 |
| `UNRESOLVED` | 3,875 | 354,034 |
| `INELIGIBLE` | 13,890 | 228,594 |
| `ALREADY_ELIGIBLE` | 7,103 | — |
| `NOT_TARGET` (not retired) | 193 | — |

The 377 eligible records are primarily `science.nasa.gov`, NIST, PLOS/Frontiers and other safe-family documents with intact text and an approving review. The 3,875 unresolved records are dominated by Wikipedia/OpenStax/other families whose item-level licence or provenance requires review. Explicitly rejected, quarantined, corrupt, missing-text and quality-failing records remain ineligible.

**This is intentionally less than the 7,344 historically retired-after-consumption records.** Most of those records are either non-English/corrupt, explicitly rejected, missing evidence, or from a source family whose licence the conservative policy will not assume. The dry run is a safe classification, not a mass restoration.

## 5. Isolation and pilot apply

The persistent migration was **not** executed against production. The apply path was exercised only on an isolated temporary store in `test/replay-eligibility.test.js`:

- one safe, approved, consumed, retired record: restored;
- one explicitly rejected record: remains ineligible;
- one Wikipedia record with uncertain licence: remains unresolved;
- second apply: `restoredInApply = 0`;
- historical consumption/review events remain intact.

Pilot integration: four retired pilot articles were restored with explicit eligibility and appeared in the `run-2` snapshot's 13 replay rows alongside 9 consumed `REVIEWED` rows.

## 6. Remaining uncertainty

- The production dry run classifies licence by source family, not by a per-document licence field. The article schema does not yet store a licence id.
- Wikipedia/OpenStax/arXiv/OAPEN and mixed repositories need item-level licence resolution before they can move from `UNRESOLVED` to eligible.
- The migration report's token counts are character/4 estimates, not tokenizer measurements.
- A production migration must be separately authorised, run against a verified snapshot, and reviewed record-by-record for the unresolved classes.

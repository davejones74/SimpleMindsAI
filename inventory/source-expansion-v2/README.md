# Source Expansion Inventory v2

Inventory-development work package only. This directory does **not** authorise
bulk acquisition, crawling, training, evaluation, promotion, production writes,
or changes to the frozen v1 corpus.

## What is here

| File | Purpose |
|---|---|
| `source-specs.json` | Combined input spec generated from the versioned JS data modules. |
| `source-inventory.json` | Full inventory: licences, access rules, estimates, computed yields, v1 overlap, screening, exclusions and uncertainties. |
| `derived-metrics.json` | Capacity, planned draw, waterfall, licence breakdown, concentration, diversity and policy checks. |
| `composition-policy.json` | Pre-registered composition limits and target/headroom policy. |
| `licence-register.json` | Licence metadata and reuse conditions referenced by the inventory. |
| `exclusions.json` | Rejected/deferred candidates and reasons. |
| `candidate-urls.json` | Candidate-URL counts by source, publisher group, source family and subject, with URL-generation rules and example URLs. |
| `summary-report.md` | Executive summary and detailed evidence. |
| `manifest.json` | SHA-256 hashes for the inventory and supporting artifacts. |
| `data/` | Versioned source data modules used to build the inventory. |

## Build and validate

```bash
node scripts/build-source-inventory.mjs
node scripts/build-source-inventory.mjs --check
node --test test/source-inventory.test.js
```

The build has no network access. It reads the local data modules, validates
schema and policy invariants, computes capacity/novelty/diversity metrics, and
writes the JSON, report and manifest. `--check` re-hashes every artifact and
fails if the inventory no longer matches the manifest.

## Method summary

- **Unrestricted pool:** commercial-use allowed, non-share-alike,
  non-non-commercial, non-no-derivatives sources only. This pool alone must
  exceed the 7.75M novel-token target with headroom.
- **Share-alike pool:** CC BY-SA / GPL-style sources, reported separately and
  not counted toward the unrestricted target.
- **Non-commercial/restricted pool:** CC BY-NC / CC BY-NC-SA / CC BY-NC-ND
  sources, reported separately and not counted toward the unrestricted target.
- **Capacity** is gross tokens after fetch, quality, deduplication, v1-overlap
  and cross-source-overlap allowances, then multiplied by an explicit
  uncertainty factor. It is not a claim of measured yield.
- **Planned draw** is a capped subset of capacity chosen under publisher,
  publisher-group, source-family, subject, format and governance limits.
- **Novelty** is discounted for known frozen-v1 overlap and estimated
  cross-source duplication. New URLs or new publishers are not treated as
  novel by themselves.

## Important caveats

This is evidence collection, not legal clearance. Licence terms can change;
OpenStax moved its current library to CC BY-NC-SA in 2026. Re-verify every
licence immediately before acquisition. The next stage should be a separately
authorised, bounded acquisition pilot that measures actual yield, rejection,
deduplication, v1 overlap and robots/terms compliance.

# Read-Only Production Snapshot

## 1. Source and scope

Snapshot root:

```text
/home/dave/sma-experiments/knowledge-accumulation-operational-rehearsal-20261103/snapshot
```

Copied read-only from:

| Source | Included |
|---|---|
| `/var/lib/simpleminds/data/articles` | articles, reviews, events, consumption, raw sources, contributions |
| `/var/lib/simpleminds/data/registry` | runs, models, evaluations/evidence, snapshots, jobs and events |
| `/var/lib/simpleminds/data/evaluation` | frozen evaluation files/manifests |
| `/var/lib/simpleminds/data/snapshots` | snapshot/frozen corpus artifacts and run/recovery manifests |
| `/var/lib/simpleminds/data/plans` | plan artifacts |
| `/var/lib/simpleminds/store/active.json` | active pointer metadata |

Excluded: `/var/lib/simpleminds/data/frontier` (298 MB) because this rehearsal does not acquire or crawl. Production model weights for the current active version were not readable by the rehearsal user; training used the accessible real 62M `v389`/`v001` isolated lineage.

## 2. Snapshot manifest

`snapshot-manifest.json` records every file:

| Measure | Value |
|---|---:|
| Files | 19,022 |
| Bytes | 1,308,195,307 |
| Format | schema `sma/operational-rehearsal-snapshot@1` |
| Hash | SHA-256 per file |

The snapshot was copied while production was live. The ledgers are append-only, so the captured prefixes are valid; ArticleStore skips a corrupt partial tail. This is not a filesystem-consistent freeze of a live writer. No source write, migration or crawl occurred.

## 3. Snapshot baseline

Machine-readable: `snapshot-baseline.json`.

| Measure | Value |
|---|---:|
| Active version at snapshot | `v493` |
| Active artifact | `simpleminds-62m-20261018-edf63f7283b3` |
| Active weight fingerprint | `edf63f7283b3` |
| Articles | 25,570 |
| Trainable | 28 |
| Replay-eligible | 7,283 |
| Unique consumed | 9,711 |
| Consumed-and-retired | 7,383 |
| Retired replay-eligible | 0 |
| Registry run records | 418 |
| Snapshot records | 6,167 |
| Evaluation records | 978 |
| Model records | 413 |

## 4. Consistency checks

- The migration was applied only to a **copy** (`migration-store/articles`), not the snapshot.
- After the migration rehearsal, all snapshot `data/articles/*` hashes still match `snapshot-manifest.json`; source snapshot article files changed: **0**.
- The source production stores were opened read-only throughout.
- The snapshot active pointer is metadata only; the rehearsal did not use the unreadable `v493` weights.

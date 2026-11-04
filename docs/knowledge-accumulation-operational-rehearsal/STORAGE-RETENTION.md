# Storage Headroom and Retention

## 1. Disk headroom

```text
/dev/nvme0n1p2  1.9T  276G  1.5T  16% /
```

The rehearsal snapshot (1.3 GB), model/ledger backups, restore trees and multiple isolated stores fit with >1.4 TB free.

## 2. Measured storage

| Tree | Size |
|---|---:|
| Production snapshot | 1.3 GB |
| Model restore | 1.7 GB |
| Ledger restore | 1.3 GB |
| Normal process store (`proc-after-store`) | 1.7 GB |
| Rollback store | 1.7 GB |
| Interrupted process store | 977 MB |
| Disabled-working store | 2.4 GB |
| Pilot corpus stores | 1.4 MB each |

Per-checkpoint 62M measurements remain:

- weights: 247,367,192 bytes (~236 MiB);
- AdamW state: 494,800,839 bytes (~472 MiB).

Expected steady-state protected set (stable + working + last-good + recent optimizer window): roughly **3.0–3.5 GB**, excluding older audit-only version weights.

## 3. Retention under the three states

`retention-rollback.json` records dry-run prune plans.

| State | Active | Working | Last-good | Plan prune |
|---|---|---|---|---|
| Normal | `v389` | `v002` | `v001` | none; all three protected |
| Interrupted | `v389` | `v001` | `v389` | none; active/working protected |
| Rollback (working ← last-good) | `v389` | `v001` | `v001` | `v002` becomes eligible only by explicit plan; nothing deleted |

The rollback dry-run proposed `v002` for pruning because it is no longer referenced by a live pointer. It was not deleted. The operator must explicitly authorise any prune; historical audit version weights are a separate retention decision.

## 4. Safety conclusions

- `plan_prune` and `plan_prune_runs` protect active, working and last-good.
- Atomic pointer writes prevent a partial `working.json`/`last-good`/`active` after a killed writer.
- Interrupted `.tmp` candidates are identifiable by the missing `COMMITTED` marker and are not treated as live.
- Disk-pressure failures occur before deleting a live checkpoint; no broad automatic pruning is enabled.
- A production rollout should verify free space and take a model/ledger backup before enabling cumulative training.

# Checkpoint Retention and Storage Safety

## 1. Protected state

The following must never be pruned automatically:

- stable `active.json` version;
- `working.json` version;
- `working-last-good.json` version;
- any version referenced by a live run/resume lock;
- the `keep` most recent published versions (existing policy);
- operator-protected versions;
- audit manifests, provenance, train-state JSON, evaluation evidence and tombstones.

## 2. Code change

The existing `prune`/`prune-runs` path knew about `active` and the recent window, but not about the new working pointers. The release branch now auto-protects them:

- `python/sma/store.py:plan_prune` adds `working pointer` and `working last-good pointer` to the protected set.
- `python/sma/store.py:plan_prune_runs` keeps their optimizer-state pickles in `retained_set`.
- `test_retention.py` verifies both paths, including `keep=0`/`keep=1` cases and explicit `protect`.

A dry-run on the real pilot-default store:

```text
active v389, working v001, last-good v389
protect: active v389, working v001
prune: []
```

No automated broad pruning was added.

## 3. Interrupted temporary checkpoints

- A staged candidate is `vNNN.tmp` without `COMMITTED`; it is never a version.
- `sweep_stale_staging()` exists but is not automatically called. A production rollout should expose it as an explicit, dry-run-first maintenance action, not as an automatic training side effect.
- A killed process can leave a `.tmp` directory or a `_runs/<version>.train-state.pt` without a committed version. These are identifiable by the missing `COMMITTED` marker / orphan version name and must not be treated as live.
- The release crash tests prove a partial `.tmp` is not promoted or consumed.

## 4. Atomicity and disk pressure

`write_json()` is now atomic: temp file → fsync → `os.replace` → directory fsync. A killed or disk-full pointer write leaves the previous valid pointer or a clearly named `.writing.<pid>` temp, never a half-valid pointer.

Checkpoint staging uses `stage_dir`/`staging_dir`; an exception removes the private temp. A hard kill can leave the temp, but it is not committed and not referenced by a pointer. Disk pressure therefore fails the write/stage rather than deleting the live checkpoint. No recovery path deletes a checkpoint referenced by a live pointer.

## 5. Storage measurements

Measured release pilot artifacts:

| Artifact | Size |
|---|---:|
| Model weights per version | 247,367,192 bytes (~236 MiB) |
| AdamW optimizer state per version | 494,800,839 bytes (~472 MiB) |
| Patch-default working store (stable v389 + working v001 + optimizer) | ~977 MB |
| Pilot main store (v389 + v001 + v002 + optimizer states) | ~1.7 GB |
| Pilot corpus store | ~1.4 MB |

Expected steady-state 62M storage with the protected pointers and a five-version optimizer window:

```text
3 protected weight copies       ~ 742 MB
3 protected optimizer copies    ~ 1.48 GB (when all three exist)
2 additional recent optimizers  ~ 0.99 GB
tokenizer/records/audit         ~ 0.1 GB
------------------------------------------------
planning bound                  ~ 3.0–3.5 GB
```

This excludes older audit-only version weights retained by a separate policy. The machine has ample disk (≈1.5 TB free in the pilot environment), but a production rollout should verify free space before enabling consolidation.

## 6. Recommendation

- Keep the narrow auto-protection of working/last-good/active.
- Do not enable automatic `sweep_stale_staging` or broad version pruning as part of this release.
- Add a dry-run-first maintenance command for stale temp/orphan optimizer cleanup in a later package.
- Fail closed on a full disk; never delete a live pointer to recover space.

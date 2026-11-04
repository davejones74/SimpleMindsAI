# Production Rollout and Rollback Design

**Not executed.** This is a plan for a separately authorised controlled rollout.

## 1. Separate operational decisions

Do not bundle these:

| Decision | Change | Can be rolled back independently? |
|---|---|---|
| D1. Deploy code | Install release-readiness build | yes, previous build |
| D2. Apply replay migration | Write replay-eligibility events | yes, append a revocation/exclusion; never delete history |
| D3. Enable working-checkpoint training | Set `TRAIN_USE_WORKING_CHECKPOINT=true` | yes, set false and restore previous parent behaviour |
| D4. Start cumulative training | Create first working checkpoint / run training | yes, stop jobs; working pointer retained or removed deliberately |
| D5. Move stable active | Strict promotion only | yes, re-activate previous committed stable version |
| D6. Consolidation | Large scheduled run | yes, do not run; working/stable unchanged |

D1 can be deployed without D2/D3. D3 can be enabled without D4. D5 must only happen through the unchanged stable gate.

## 2. Pre-deployment

1. **Backup**: back up `active.json`, `working.json` (if present), `working-last-good.json`, the Python store metadata, article/review/consumption/event ledgers, registry run/evaluation/model ledgers and all manifests.
2. **Integrity**: re-hash the active checkpoint, weight fingerprint, tokenizer, frozen evaluation set and the backup. Verify `COMMITTED`.
3. **Active identity**: record active version, artifact name, weight fingerprint, activation timestamp and manifest hash.
4. **ArticleStore snapshot**: take a read-only consistent snapshot/copy for migration reconciliation. Do not run the migration on the live store during this step.
5. **Replay dry-run**: re-run `classify-replay.mjs` against the snapshot; reconcile counts and unresolved reasons with this report. No apply.
6. **Working bootstrap**: decide whether the first working checkpoint is bootstrapped from the current stable active (recommended) or a specific committed version. Do not move `active.json`.
7. **Storage headroom**: reserve at least the expected protected working/last-good storage (~2–3.5 GB for 62M) plus consolidation headroom; verify free space.
8. **Configuration verification**: verify `TRAIN_USE_WORKING_CHECKPOINT`, `TRAIN_CARRY_OPTIMIZER`, `WORKING_GUARD_*`, `TRAIN_MAX_STEPS`/snapshot limits, `SNAPSHOT_INCLUDE_CONSUMED`, replay fraction, and frozen eval identity. Do not change stable promotion thresholds.
9. **Feature flag**: keep working training disabled until D3 explicitly.

## 3. Deployment

1. Deploy the code (D1). A service restart is required for Node/Python changes; schedule it in an authorised maintenance boundary and preserve current jobs per existing policy.
2. Confirm the service starts, health is green, and no job auto-resumes unexpectedly.
3. Verify guard defaults are the intended `0.05 / 0.15 / 0.10` (or the approved values), and `active.json` still names the same stable version.
4. Optional D2: apply the replay migration to the **snapshot/isolated copy first**, inspect the diff, then apply the approved subset to production as a separate audited operation. Preserve every ledger.
5. D3: enable working-checkpoint training. On the first run, bootstrap working from stable (`stable-bootstrap-working`). Do not modify `active.json`.
6. Verify the first working checkpoint records parent, weights, optimizer mode, dataset hash, guard result and stable baseline. Confirm the stable pointer is unchanged.
7. D4: start bounded cumulative training only after D3 verification. Keep stable promotion in the same lifecycle; do not change its gate.
8. D6: schedule consolidation separately, with its own budget and rollback plan.

## 4. Rollback

### A. Disable working training

- Set `TRAIN_USE_WORKING_CHECKPOINT=false` (or remove the enablement) and restart in an authorised window.
- Training returns to the stable `active.json` parent; stable promotion is unchanged.
- Preserve `working.json` and `working-last-good.json`; do not delete them.

### B. Corrupt or unsafe working checkpoint

- Restore `working.json` from `working-last-good.json` (or the stable active version if no valid last-good).
- Do not delete committed versions; retain provenance.
- Re-run the working guard / integrity check before any further training.

### C. Replay migration rollback

- Append explicit `replay-eligibility: false`/exclusion events for the affected records; never delete historical review/consumption events.
- Re-run the dry run and reconcile the replay pool.

### D. Stable model rollback

- Use the existing stable activation mechanism to re-point `active.json` to the previous committed version.
- Do not modify weights, promotion evidence or historical manifests.

### E. Full disable

- Disable working training, stop new cumulative jobs, keep source ledgers and all checkpoints, and return to the prior stable parent behaviour.
- Do not prune working/last-good/stable during rollback.

## 5. Rollback invariants

- `active.json` remains the only serving pointer.
- Replay eligibility records are append-only and reversible.
- Article text/provenance/history is never deleted.
- Stable active checkpoint is preserved.
- A corrupt working pointer does not affect serving.
- Recovery artifacts required for a later restore are not pruned.
- Stable promotion thresholds and frozen eval are not changed during rollback.

## 6. Go/no-go

**Go for a separately authorised controlled rollout only if:**

- guard defaults are approved;
- ROCm full-suite completion or an explicit accepted limitation exists;
- migration reconciliation is signed off;
- storage headroom and backups are verified;
- working bootstrap and rollback drills pass on the isolated copy;
- D1–D6 are approved as separate steps.

**No-go if:** any production mutation is proposed as part of validation, or if working training would be enabled together with migration/activation without separate approval.

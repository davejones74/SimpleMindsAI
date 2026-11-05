# Migration and Deployment Procedure — Release Candidate

**Status:** prepared only. **Nothing in this document was executed against production.** Production remained read-only throughout the programme.

This procedure is for a separately authorised deployment of branch `programme/continuous-knowledge-learning-effectiveness-20261104`.

---

## 1. Preconditions

1. Review `IMPLEMENTATION-REPORT.md` and `PROGRAMME-JOURNAL.md`.
2. Confirm the operator accepts the behaviour changes:
   - full-source segmentation (`CURATOR_STRATEGY=segmented`);
   - low-value URL filtering (`DISCOVERY_URL_QUALITY=enforce`);
   - licence resolution in `shadow` mode (no ingress blocking);
   - review prefilter in `shadow` mode (no verdict change);
   - the AdamW no-decay group transition from `0.01` back to `0.0`.
3. Take a full production backup with the service stopped, following the existing operational procedure:
   - model store;
   - article/registry ledgers;
   - environment file;
   - active/working/last-good pointers.
4. Record the starting identities:
   - production source commit;
   - `active.json`, `working.json`, `working-last-good.json` hashes;
   - frozen `eval-002` hashes.

---

## 2. Configuration changes

Add or review these variables in `/etc/simpleminds/simpleminds.env`:

```text
CURATOR_STRATEGY=segmented
CURATOR_LEGACY_MAX_CHARS=14000
CURATOR_CHUNK_MAX_CHARS=12000
CURATOR_CHUNK_TARGET_CHARS=4000
CURATOR_CHUNK_MIN_CHARS=1000
CURATOR_MERGE_UNITS=true
CURATOR_MERGE_MIN_CHARS=800
CURATOR_MERGE_MAX_CHARS=6000

LICENCE_ENFORCEMENT=shadow

DISCOVERY_URL_QUALITY=enforce

REVIEW_PREFILTER_MODE=shadow
REVIEW_PREFILTER_MIN_CHARS=200
REVIEW_PREFILTER_MIN_WORDS=20

KNOWLEDGE_TOKENIZER_MEASUREMENT=false
```

Do **not** change `PROMOTE_*`, `EVAL_DATASET_ID`, frozen eval files, working-guard thresholds or checkpoint pointers as part of this deployment.

### Rollout recommendations

- Keep `LICENCE_ENFORCEMENT=shadow` until the backfill report has been reviewed and item-level licence policy is agreed.
- Keep `REVIEW_PREFILTER_MODE=shadow` until calibrated on a labelled sample; then enable `enforce`.
- Consider `KNOWLEDGE_TOKENIZER_MEASUREMENT=true` only if the admin host can tolerate the short Python process per pull.
- `CURATOR_STRATEGY=legacy` is the immediate rollback for teacher-cost or quality problems.
- `DISCOVERY_URL_QUALITY=shadow` or `off` is the rollback for over-filtering.

---

## 3. Deployment sequence (for later authorisation)

1. Deploy the branch source to `/opt/simpleminds` using the existing deploy script/path.
2. Install the reviewed environment file.
3. Restart the service.
4. Verify the knowledge observability endpoint returns:
   - `funnel`;
   - `licence`;
   - `learningEffectiveness`;
   - `schema: sma/knowledge-accumulation-observability@1`.
5. Verify the Brain knowledge view renders the new panels and has no `undefined`.
6. Confirm `active.json` is byte-identical to the pre-deploy hash.
7. Confirm no training job starts with an unexpected parent or pointer.

**Do not** auto-start a training run as part of deployment. Let the existing job policy wait for the configured eligibility threshold.

---

## 4. Licence backfill migration

The backfill writes append-only `licence` events. It never changes text, reviews, consumption, replay eligibility or pointers.

### 4.1 Dry run (read-only, safe)

```bash
node scripts/knowledge-pilot/backfill-licences.mjs \
  --store /var/lib/simpleminds/data/articles \
  --out /tmp/licence-backfill-dryrun.json
```

Recorded production dry-run result (2026-11-04):

| Status | Count |
|---|---:|
| safe / allow | 2,765 |
| uncertain / review | 8,025 |
| unknown / review | 15,058 |
| no source host | 1 |
| scanned | 25,849 |

### 4.2 Apply (requires separate authorisation)

```bash
node scripts/knowledge-pilot/backfill-licences.mjs \
  --store /var/lib/simpleminds/data/articles \
  --apply --confirm --allow-production \
  --out /tmp/licence-backfill-apply.json
```

The script refuses production without `--allow-production`, and refuses apply without `--confirm`.

### 4.3 Verify

- `getStats().byLicenceStatus` matches the dry-run totals.
- No article status, review, consumption or replay-eligibility count changed.
- A sample of articles reopens with the same licence after a service restart (events replay).

---

## 5. Retired replay audit and recovery

Run the read-only audit:

```bash
node scripts/knowledge-pilot/audit-retired-replay.mjs \
  --store /var/lib/simpleminds/data/articles \
  --out /tmp/retired-replay-audit.json
```

Recorded result: **0 automatically safe full records**, and **596 safe short-prose policy candidates** (17,573 estimated tokens) that fail only the completeness length heuristic. The 596 are licence-safe, language/quality-pass and approved, but are very small fragments (average ~29 estimated tokens).

Do **not** blanket-enable retired records. The 596 are a candidate for a separate controlled replay experiment, not an automatic migration. A future recovery also requires one of:

1. item-level licence resolution that moves safe records out of `uncertain`/`unknown`; or
2. a reviewed completeness-policy decision for short-but-valid material.

Any future apply must use the existing replay-eligibility migration path (`setReplayEligibility`), with a reviewed dry-run and an explicit per-class approval.

---

## 6. Sealed prospective and retention cohorts

Before claiming cumulative learning:

1. Create a prospective cohort from authorised, never-trained source material.
2. Create a retention probe representing previously learned knowledge.
3. Verify:
   - `sealed: true`, `neverTrain: true`;
   - no content-hash or source-URL overlap with training snapshots/consumption;
   - prospective and retention cohorts are disjoint from each other.
4. Score the stable and working checkpoints on both cohorts with paired source-group comparisons.
5. Store the manifests, hashes and results with the run/release evidence.

The framework is implemented in `src/training/sealed-cohort.js` and tested by `test/learning-effectiveness.test.js`. Populating the cohorts is an operator/data-authorisation step and is **not** included in this release candidate.

---

## 7. First post-deployment training run — verification checklist

| Check | Expected |
|---|---|
| Replay correction | Measured replay share is near the configured 20% target on the final post-validation stream, not the pre-partition estimate |
| Validation supply | Actual tokenizer blocks reported; shortfall is explicit; no historical validation substitution |
| Segmentation | Logs show `curated full source … chunks=N coverage=…`; source marked complete only when all chunks succeed |
| Licence | New articles carry `licence.status` and `licence.decision`; shadow mode does not skip |
| Optimizer | `param_groups` weight decay is `[0.01, 0.0]`; moments and step counters are continuous |
| Working guard | Decision and per-group evidence recorded |
| Stable gate | Unchanged; `eval-002` and thresholds untouched |
| Pointers | `active.json` unchanged unless the stable gate promotes |
| Recovery | A simulated crash boundary still recovers publish/activate/consume idempotently |

---

## 8. Rollback

1. Stop the service.
2. Restore the pre-deploy source and environment from the deployment backup.
3. Restore the model store and ledgers from the full backup if any migration was applied.
4. Restart the service.
5. Verify `active.json`, `working.json` and `working-last-good.json` match the pre-deploy hashes.
6. Re-run the knowledge endpoint and the frozen evaluation identity check.

The code changes do not rewrite existing checkpoints. The licence backfill is append-only; restoring the pre-migration ledgers is the clean rollback if the migration is rejected.

---

## 9. Explicit hold

No step in this document was executed against production. The branch is ready for review, not deployment.

---

## 10. Current recommendation

**Conditional go for a controlled release candidate; no-go for a cumulative-learning claim.**

- The implementation, isolated experiments, migration rehearsal and rollback rehearsal are complete.
- Deploy only under the procedure above, with licence/prefilter in `shadow` mode and segmentation enabled.
- Start a new working lineage from the stable checkpoint under the corrected optimiser.
- Do not claim cumulative learning until that new lineage improves on the sealed prospective and retention cohorts.
- Do not enable the 596 safe-short replay records without a separate controlled replay experiment.

---

## 11. Milestone 3 execution record (2026-11-05)

This procedure was executed under the Milestone 3 authorisation.

- Final deployed commit: `c4fa71261341a6d9cd82903f87ce88e19178b296`.
- Full backup: `/var/lib/simpleminds/backups/milestone3-20261104T223215Z` (`store-and-data.tar`, SHA-256 `04d278f7c06efa5118856270b036af52f2ecd886478779a7784be4cb02bb12f2`).
- Code backups: `deploy-20261104T223445Z`, `deploy-20261104T225948Z`, `deploy-20261104T232531Z`, `deploy-20261105T005952Z`.
- Licence backfill applied: 25,887/25,888 resolved; no non-licence state changed.
- Fresh working lineage: `v493 → v501 → v503`; `v504` rolled back to `v503`.
- Stable active remained `v493`.
- Original frontier preserved at `/var/lib/simpleminds/data/frontier`; the trial used `/var/lib/simpleminds/data/frontier-milestone3`.
- Sealed prospective/retention results did not demonstrate improvement; see `MILESTONE-3-REPORT.md`.
- Replay trim remains an open production defect (measured 27.8–44.8% vs 20% target).

---

## 12. Milestone 4 execution record (2026-11-05)

- Final deployed commit: `7662797` (`Enforce tokenizer-authoritative replay budget`).
- Code backup: `/opt/simpleminds/.deploy-backup/deploy-20261105T041252Z`.
- Environment SHA-256: `5f2b7dcd5bc645e6f91cfea9e67d82f44549f02bb11ec4d780308553faebfc26`.
- Working lineage reset to stable `v493`, then advanced `v493 → v505 → v506`; `v507` rolled back to `v506`.
- Unchanged stable gate promoted `v505` and `v506`; `v506` is now active.
- Replay composition measured at actual training consumption: 19.99%, 19.78%, 19.82%.
- Sealed prospective and retention improvements confirmed for `v505`/`v506`.
- Original frontier still preserved; English trial frontier remains in use.

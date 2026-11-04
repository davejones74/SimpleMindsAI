# Proposed Production Deployment

## Recommendation

Deploy this branch after review. It contains a replay-mix correction and an observability view; it does not change `active.json`, stable promotion thresholds, frozen evaluation, or acquisition policy.

Branch: `knowledge-accumulation-observability-replay-20261104`

Code/docs commit: recorded in the final branch manifest (`MANIFEST.json`).

## What is being proposed

1. Replay selection correction:
   - `src/dataset/snapshot.js` — `trimReplayToFreshTarget`.
   - `src/training/lifecycle.js` — applies the trim after validation exclusion and updates final corpus stats.
2. Observability:
   - `GET /api/admin/knowledge-accumulation`.
   - Brain header **Knowledge** panel; pull-only refresh.
   - `readPythonStore` exposes working/last-good and optimizer metadata.
3. Supporting read-only analysis:
   - `src/training/exposure.js`.
   - `src/training/validation-status.js`.
   - `scripts/knowledge-pilot/analyze-validation-availability.mjs`.
   - `scripts/knowledge-pilot/export-observability-snapshot.mjs`.

## Verification

- Full Node suite: **795 tests, 788 passed, 0 failed, 7 skipped**.
- Focused replay/observability: **18 passed**.
- Production telemetry export verified with read-only stores and a read-only registry.
- No production deployment, service restart, config change, migration, or pointer write was performed by this work package.

## Deployment notes

- Use the existing `deploy/deploy-x1pro-files.sh` deployment path.
- Take the normal pre-deploy code backup.
- Restart `simpleminds.service` in an authorised maintenance window.
- Do not modify `/etc/simpleminds/simpleminds.env` as part of this deployment.
- Do not change `active.json`, stable gate thresholds, `eval-002`, or acquisition policy.
- The next training run will still wait for a valid prospective validation block; that is expected and should not be bypassed.
- After deployment, verify the first corrected training run records a measured replay share at or below the configured target (allowing estimator/row-truncation undershoot), and confirm `active.json` remains governed by the unchanged stable gate.
- Review the optimizer parameter-group weight-decay caveat in `OPTIMIZER-CONTINUITY.md` separately; this branch does not change optimizer state.

## Expected production state at review

At the observed snapshot (2026-11-04T19:02Z):

- Stable active: `v493`
- Working: `v500`
- Last-good: `v499`
- Training: `job-60` waiting for a prospective validation block
- Learning: `job-59` running
- Replay mix on the latest run: measured `36.66%`; corrected simulation `19.65%` actual on the same frozen snapshot

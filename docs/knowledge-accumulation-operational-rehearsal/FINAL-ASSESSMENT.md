# Final Go/No-Go Assessment

## Recommendation

**READY FOR SEPARATELY AUTHORISED BOUNDED PILOT.**

The rehearsal completed the snapshot, migration, backup/restore, real 62M process-interruption recovery, disabled-working fallback, retention and ROCm checks without a blocking defect. Production was not activated.

## Evidence summary

| Check | Result |
|---|---|
| Read-only snapshot | 1.3 GB, 19,022 files, hashed |
| Migration before/after | 377 eligible → 0; 7,283 → 7,660 already eligible; unresolved/ineligible unchanged |
| Source snapshot integrity | 0 article files changed by migration rehearsal |
| Backup/restore | 36 model files + 19,022 ledger files, zero hash mismatches |
| Mid-training kill | no checkpoint, no consumption, active/working/last-good unchanged |
| Post-pointer/pre-consumption kill | recovery exactly once; active `v389` unchanged; working `v002`; weights + optimizer committed; 28/28 unique consumption pairs; second recovery no-op |
| Disabled working training | parent stable `v389`; working `v002` unchanged; history retained |
| Retention | active/working/last-good protected in normal, interrupted and rollback states |
| Disk | ~1.5 TB free |
| ROCm | full suite 260 passed, 19 skipped, 0 failed |

## Proposed bounded pilot

This is a proposal for separate authorisation, not an activation.

| Parameter | Proposal |
|---|---|
| Environment | Isolated production-adjacent store + isolated article/registry stores |
| Model lineage | Current stable 62M checkpoint as bootstrap; working pointer created from stable |
| Corpus | 100–150 accepted, licence-clean documents, approximately 300k–600k unique cleaned tokens |
| Replay | 35–50% of training tokens from accepted replay-eligible material; include a bounded number of replay-migrated records |
| Snapshot | Token-aware cap; start with `SNAPSHOT_LIMIT=128` and verify actual token composition |
| Training | LR `5e-5`, 2 epochs target, maximum 1,200 steps; document boundary separator |
| Validation | document/source-disjoint, prospective, frozen `eval-002` unchanged |
| Working guard | approved defaults `0.05 / 0.15 / 0.10 / 100 / 0.75 / 5` |
| Stable gate | unchanged; no threshold changes |
| Optimizer | carry from working when compatible; record `carried`/`reset-no-parent-state` |
| Working updates | maximum 3 consecutive working advancements before review |
| Stop conditions | working guard rejection, drift rollback, numerical guard, data-quality threshold, or any pointer/consumption inconsistency |
| Active pointer | must remain unchanged throughout the pilot |
| Production services | not reconfigured, restarted or repointed by this rehearsal |

## Required authorisation gates

1. Explicit authorisation for the bounded pilot and its isolated storage paths.
2. Backup of the selected stable/working/last-good/optimizer and ledger snapshot before the pilot.
3. Confirmation of storage headroom and retention policy.
4. Approval of the approved guard defaults and working-guard-v2 rules.
5. Confirmation that the frozen eval set and stable promotion thresholds remain unchanged.
6. Agreement that no production replay migration or active-pointer change occurs during the pilot.

## Residual risks

- The rehearsal corpus is small (~7.7k estimated tokens); the bounded pilot is the first real cumulative-learning test at a larger scale.
- Guard defaults are conservative and evidence-based but need real candidate acceptance data.
- The full-process crash test used a small bounded corpus; it validates orchestration/recovery but not long-run consolidation.
- Replay migration remains conservative: 3,875 unresolved records require item-level resolution.
- Working checkpoint storage grows with retained optimizer state; retention remains explicit.
- Any production deployment or migration is a separate decision and has not been authorised.

## Final statement

The implementation and isolated operational evidence support a separately authorised, bounded pilot. **Do not activate the pilot, apply the production migration, or change `active.json` under this work package.**

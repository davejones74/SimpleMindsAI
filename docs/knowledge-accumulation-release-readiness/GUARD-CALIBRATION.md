# Working Guard Calibration

## 1. Verified defaults and effective configuration

Code defaults (`src/config.js:456-463`):

| Setting | Default |
|---|---:|
| `WORKING_GUARD_MAX_REGRESSION_NATS` | 0.05 |
| `WORKING_GUARD_MAX_GROUP_REGRESSION_NATS` | 0.15 |
| `WORKING_GUARD_MAX_DRIFT_NATS` | **0.10** (release branch; pilot default was 0.25) |
| `WORKING_GUARD_MIN_GROUP_TOKENS` | 100 |
| `WORKING_GUARD_MAX_REGRESSED_GROUP_SHARE` | 0.75 |
| `WORKING_GUARD_MIN_GROUPS` | 5 |

Pilot runs recorded the widened values in every manifest:

```text
maxRegressionNats: 0.10
maxGroupRegressionNats: 0.20
maxDriftNats: 0.25
```

The release branch changed the implementation version to `working-guard-v2` and hardened it:

- a single group beyond `maxGroupRegressionNats` is now rejected (previously only a share was checked);
- broad regression is measured by the share of groups beyond the **per-run** `maxRegressionNats`, not merely groups beyond the individual catastrophic threshold;
- cumulative drift default is reduced from 0.25 to 0.10.

## 2. The discrepancy, resolved

| Candidate | Regression | Pilot guard (0.10/0.20/0.25) | Release defaults (0.05/0.15/0.10) |
|---|---:|---|---|
| `pilot-2` candidate `v002` | +0.0613 nats | accepted | **rejected** |
| `pilot-b-1` candidate `v001` | +0.0770 nats | accepted | **rejected** |
| Real release candidate `v001` | +0.0472 nats | (would accept) | **accepted** |
| `pilot-b-2` candidate `v002` | +0.3308 nats | rejected | rejected |

The pilot Scenario A was valid only under the widened pilot thresholds. Under the documented defaults, a `0.0613` global regression is rejected. This is the correct outcome: the candidate was a broad global regression, not evidence that the default guard is broken.

A real ROCm candidate at **+0.0472 nats** was accepted under the exact defaults (`pilot-default-1.json`). It advanced the working checkpoint `v389 → v001` while stable rejected it at −0.0459 (paired CI −0.0534..−0.0377). `active.json` stayed `v389`.

## 3. Historical calibration evidence

Read-only analysis of all paired baseline/candidate evidence in the production registry (`analyze-guard-calibration.mjs`):

| Measure | Value |
|---|---:|
| Runs with paired evidence | 83 |
| Promoted | 13 |
| Rejected | 59 |
| Inconclusive | 11 |
| Rejected accepted by release defaults | 53/59 |
| Rejected accepted by pilot-wide guard | 59/59 |
| Promoted accepted by both | 13/13 |

Rejected-run overall regression distribution:

| Quantile | Nats |
|---|---:|
| min | 0.0019 |
| p25 | 0.0133 |
| median | 0.0212 |
| p75 | 0.0282 |
| p90 | 0.0487 |
| max | 0.0852 |

Rejected-run worst-group regression distribution:

| Quantile | Nats |
|---|---:|
| min | −0.1546 |
| p25 | −0.0887 |
| median | −0.0742 |
| p75 | −0.0435 |
| p90 | −0.0284 |
| max | −0.0063 |

The defaults accept most historical rejected candidates at the overall level, but the hard group/broad-share rules stop the clearly broad or catastrophic ones. The 0.05 overall allowance sits just above the historical p90 (0.0487), so it is permissive enough for small updates without accepting the larger `0.06–0.09` regressions seen in the pilot.

## 4. Scenario tests

`test/working-guard-calibration.test.js`:

| Scenario | Result |
|---|---|
| 0.0613 regression | rejected by defaults; accepted by pilot-wide |
| 0.0472 regression | accepted by defaults |
| Successive +0.04 steps | accepted at drift 0.04, 0.08; rejected at 0.12 (drift cap 0.10) |
| Isolated group regression (+0.12 in one group, improvement elsewhere) | accepted |
| Catastrophic single group (+0.40) | rejected |
| Broad regression (80% of groups beyond tolerance) | rejected |

`test/working-checkpoint-lifecycle.test.js` additionally covers working acceptance, working rejection, drift rollback to last-known-good, and crash recovery.

## 5. Threshold recommendation

**Keep the release defaults:**

- `maxRegressionNats = 0.05`
- `maxGroupRegressionNats = 0.15`
- `maxDriftNats = 0.10`
- `minGroupTokens = 100`
- `maxRegressedGroupShare = 0.75`
- `minGroups = 5`

Rationale:

- `0.05` is evidence-based: historical rejected p90 is 0.0487, and a real candidate at 0.0472 passes. A 0.0613 candidate is above the observed useful band and is rejected.
- `0.15` still allows the real candidate's worst group (−0.1426) while rejecting any group beyond the historical range (−0.155 observed minimum; the hard rule blocks at 0.15).
- `0.10` drift allows two consecutive near-limit updates, then forces rollback/rejection. The pilot's 0.25 allowed substantially more cumulative degradation.
- Do **not** raise `maxRegressionNats` to 0.10 merely to make the original Scenario A pass. That scenario was a broad global regression; it is not evidence for a wider default.

**Further experiment needed:** a larger calibration run with the v2 defaults, measuring how many real stable-rejected candidates are accepted and whether any accepted working sequence later reaches stable promotion. Until that exists, the conservative defaults should remain.

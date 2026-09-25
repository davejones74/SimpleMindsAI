import { computeDecision } from "./eval-util.js";

/**
 * `npm run evaluate` — MEASURE, don't mutate (requirement #16 "evaluation" unit).
 * Re-runs the deterministic eval of the latest candidate vs the baseline on the
 * immutable eval set, prints the comparison and the rule's would-be verdict.
 * Model + run statuses are untouched.
 */
const { registry, baseline, candidate, baselineResult, candidateResult, decision, evalSet } =
  await computeDecision({ apply: false });

const L = [];
L.push(`EVALUATION ${candidateResult.evalRunId}`);
L.push(`  dataset         ${evalSet.datasetId} v-${evalSet.datasetVersion}  (n=${evalSet.size})`);
L.push(`  baseline        ${baseline.modelId}  ${(baselineResult.score100).toFixed(1)}`);
L.push(`  candidate       ${candidate.modelId}  ${(candidateResult.score100).toFixed(1)}`);
L.push(`  delta           ${decision.delta > 0 ? "+" : ""}${decision.delta.toFixed(2)}`);
L.push(`  rule would say  ${decision.decision === "promoted" ? "PROMOTED" : "REJECTED"}  (no status changed)`);
L.push(`  per-example     ${candidateResult.perExample.length} cases; evaluator v${candidateResult.evaluatorVersion}`);
console.log(L.join("\n"));

await registry.close();
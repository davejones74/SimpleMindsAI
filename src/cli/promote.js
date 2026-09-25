import { computeDecision } from "./eval-util.js";
import { renderRunReport } from "./report.js";

/**
 * `npm run promote` — the APPLY side of evaluate. Never auto-promotes: it runs
 * the same deterministic evaluation and only then flips the model status
 * (promoted/rejected) and closes the TrainingRun with the real delta.
 */
const { registry, candidate, baseline, baselineResult, candidateResult, decision, applied, evalSet } =
  await computeDecision({ apply: true });

console.log(`EVALUATION ${candidateResult.evalRunId}`);
console.log(`  baseline   ${baseline.modelId}  ${baselineResult.score100.toFixed(1)}`);
console.log(`  candidate  ${candidate.modelId}  ${candidateResult.score100.toFixed(1)}`);
console.log(`  delta      ${decision.delta > 0 ? "+" : ""}${decision.delta.toFixed(2)}`);
console.log(`  decision   ${applied === "promoted" ? "PROMOTED" : "REJECTED"}   -> status persisted`);

if (candidate.trainingRunId) {
  const run = registry.getRun(candidate.trainingRunId);
  if (run) console.log("\n" + renderRunReport(run, { registry }));
}
console.log(`  eval set   ${evalSet.datasetId} v-${evalSet.datasetVersion} (n=${evalSet.size})`);

await registry.close();
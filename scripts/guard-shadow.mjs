import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { compareGuardThresholds } from "../src/training/guard-shadow.js";

const dir = process.argv[2] ?? "data/snapshots";
const files = readdirSync(dir).filter((f) => /^run-.*-manifest\.json$/.test(f));
const records = [];
for (const file of files) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    if (manifest.workingGuard?.metrics) records.push({ runId: manifest.runId, workingGuard: manifest.workingGuard });
  } catch { /* skip unreadable manifest */ }
}
const out = compareGuardThresholds(records, [
  { maxRegressionNats: 0.02, maxDriftNats: 0.02, maxGroupRegressionNats: 0.15, maxRegressedGroupShare: 0.75 },
  { maxRegressionNats: 0.05, maxDriftNats: 0.05, maxGroupRegressionNats: 0.20, maxRegressedGroupShare: 0.75 },
]);
console.log(JSON.stringify({ dir, records: records.length, comparisons: out }, null, 2));

#!/usr/bin/env node
/** Deterministic crash-point child for working-checkpoint subprocess tests. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.env.CRASH_ROOT;
const point = process.env.CRASH_POINT;
if (!root || !point) throw new Error("CRASH_ROOT and CRASH_POINT are required");
const crash = () => process.kill(process.pid, "SIGKILL");
const json = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
};
const text = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value);
};
const tmp = path.join(root, "v201.tmp");
const commitCandidate = () => {
  text(path.join(root, "v201", "model.safetensors"), "weights");
  text(path.join(root, "v201", "COMMITTED"), "{}");
  text(path.join(root, "_runs", "v201.train-state.pt"), "optimizer");
};
const manifest = {
  runId: "run-crash",
  status: "rejected",
  decision: "rejected",
  consumed: false,
  published: true,
  workingAdvanced: true,
  workingVersion: "v201",
  workingLastGoodVersion: "v200",
  freshArticleIds: ["a1", "a2"],
  snapshotArticleIds: ["a1", "a2"],
  workingMeta: { guardDecision: "accepted" },
};

switch (point) {
  case "during-checkpoint":
    text(path.join(tmp, "model.safetensors.partial"), "partial");
    crash();
    break;
  case "after-weights":
    text(path.join(tmp, "model.safetensors"), "weights");
    crash();
    break;
  case "after-optimizer":
    text(path.join(tmp, "model.safetensors"), "weights");
    text(path.join(root, "_runs", "v201.train-state.pt"), "optimizer");
    crash();
    break;
  case "during-pointer": {
    // Simulate a killed writer before the atomic replace: the old pointer must
    // remain authoritative and the temp file must never be treated as valid.
    commitCandidate();
    text(path.join(root, ".working.json.writing.999"), '{"version":"v201"');
    crash();
    break;
  }
  case "after-pointer-before-consume":
    commitCandidate();
    json(path.join(root, "working.json"), { schema: "sma/working@1", version: "v201", lastGoodVersion: "v200" });
    json(path.join(root, "snapshots", "run-crash-manifest.json"), manifest);
    crash();
    break;
  case "during-consumption":
    commitCandidate();
    json(path.join(root, "working.json"), { schema: "sma/working@1", version: "v201", lastGoodVersion: "v200" });
    json(path.join(root, "snapshots", "run-crash-manifest.json"), manifest);
    text(path.join(root, "consumption.ndjson"), JSON.stringify({ articleId: "a1", runId: "run-crash", checkpointRole: "working", version: "v201" }) + "\n");
    crash();
    break;
  default:
    throw new Error(`unknown CRASH_POINT ${point}`);
}

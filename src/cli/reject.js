import { RegistryStore } from "../storage/registry-store.js";

/**
 * `npm run reject` — explicit force-reject of a candidate. Deterministic gate:
 * requires an existing evaluation record for the model (call `evaluate` first),
 * or accepts --model <id> to act on a specific candidate.
 */
const modelId = process.argv[2]?.replace(/^--model=/, "") ?? null;
const registry = await RegistryStore.open();
try {
  let target = modelId ? registry.getModel(modelId) : null;
  if (!target) {
    target = registry
      .listModels()
      .filter((m) => m.status === "candidate" && m.kind !== "base")
      .sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1))
      .at(-1);
  }
  if (!target) throw new Error("no candidate model to reject");
  await registry.modelEvent(target.modelId, { status: "rejected", note: "explicit CLI rejection" });
  console.log(`REJECTED ${target.modelId}`);
  console.log(`  previous status: ${target.status} | evaluationScore: ${target.evaluationScore ?? "—"}`);
} finally {
  await registry.close();
}
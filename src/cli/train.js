import { executeFullRun } from "../training/lifecycle.js";
import { RegistryStore } from "../storage/registry-store.js";
import { BufferStore } from "../storage/buffer-store.js";
import { stubTrainer } from "../training/trainer-interface.js";
import { defaultEvalSeed, renderRunReport } from "./report.js";

/**
 * `npm run train` — one full TrainingRun: snapshot → plan → baseline eval →
 * train (stub kernels) → candidate eval → promote/reject → persisted.
 * Reads the BufferStore directly (no GraphQL server required).
 */
const registry = await RegistryStore.open();
const store = await BufferStore.open();
try {
  const out = await executeFullRun({
    registry,
    deps: {
      store,
      trainer: stubTrainer(),
      markConsumed: (ids, runId) => store.markTrained(ids, runId),
      evalSeed: defaultEvalSeed,
    },
  });
  console.log(renderRunReport(out.run, { registry }));
} catch (err) {
  console.error(`train failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await store.close();
  await registry.close();
}
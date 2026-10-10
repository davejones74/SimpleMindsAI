import { executeFullRun } from "../training/lifecycle.js";
import { RegistryStore } from "../storage/registry-store.js";
import { ArticleStore } from "../storage/article-store.js";
import { selectTrainer } from "../training/trainer-interface.js";
import { defaultEvalSeed, renderRunReport } from "./report.js";

/**
 * `npm run train` — one full TrainingRun: snapshot → plan → baseline eval →
 * train (real Python causal-LM by default) → candidate eval → promote/reject →
 * persisted. Reads the ArticleStore directly (no GraphQL server required).
 *
 * TRAINER_KIND=stub selects the placeholder kernels explicitly; there is no
 * silent fallback — if Python is unavailable the run fails.
 */
const registry = await RegistryStore.open();
const store = await ArticleStore.open();
try {
  const out = await executeFullRun({
    registry,
    deps: {
      store,
      trainer: selectTrainer(),
      markConsumed: (ids, runId) => store.markConsumed(ids, { runId }),
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

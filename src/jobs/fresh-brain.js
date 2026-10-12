import path from "node:path";
import { runPython, resolveStoreRoot } from "../brain/python-cli.js";
import { config } from "../config.js";

/**
 * Create a genuinely fresh brain — a randomly-initialised architecture of the
 * configured size, with NO pretrained student weights.
 *
 * Python `init` fetches ONLY architecture config + tokenizer (recorded with its
 * source revision/hashes in the init-manifest), then goes offline and builds the
 * model from `torch.manual_seed`. It never loads pretrained weights (a structural
 * audit enforces this), so the random-init guarantee holds.
 *
 * IMPORTANT: unlike `initBrain` (which adopts/activates a baseline), a fresh
 * brain is created as an UNPROMOTED candidate and the active pointer is NOT
 * moved. It becomes usable only by being explicitly selected as a training
 * parent or activated by the operator.
 */
export async function createFreshBrain(ctx) {
  const { registry, bin = config.pythonBin ?? undefined, run = runPython, signal } = ctx;
  const onPhase = ctx.onPhase ?? (() => {});
  const onProgress = ctx.onProgress ?? (() => {});
  const log = ctx.log ?? (() => {});
  const store = config.pythonStore ?? undefined;
  const root = resolveStoreRoot(store);
  const engine = ctx.config ?? config.initConfig;
  const seed = Number.isFinite(ctx.seed) ? ctx.seed : 0;

  onPhase("init");
  log("out", `fresh brain: init --config ${engine} --seed ${seed}`);
  const out = await run(["init", "--config", engine, "--seed", String(seed)], {
    store,
    bin,
    timeoutMs: 30 * 60 * 1000,
    signal,
  });
  if (!out?.ok || !out.version) {
    throw new Error(`fresh-brain init failed: ${out?.error ?? "unknown"}`);
  }

  onPhase("verify");
  const status = await run(["status"], { store, bin, signal });
  const entry = (status.versions ?? []).find((v) => v.version === out.version);
  if (!entry?.committed) {
    throw new Error(`fresh brain ${out.version} is not committed; refusing to register it`);
  }
  const integrity = entry.artifactNameError
    ? `artifact name invalid: ${entry.artifactNameError}`
    : !entry.artifactName
      ? "no artifact name"
      : null;
  if (integrity) {
    throw new Error(`fresh brain ${out.version} failed integrity check: ${integrity}`);
  }
  onProgress({ version: out.version, phase: "verify" });

  let model = registry
    .listModels()
    .find((m) => m.kind === "python" && m.meta?.pythonVersion === out.version);
  if (!model) {
    model = await registry.registerModel({
      kind: "python",
      baseModel: config.baseModel,
      checkpointPath: path.join(root, out.version),
      meta: { pythonVersion: out.version, fresh: true, seed, adopted: false },
    });
  }
  // NOTE: deliberately NO modelEvent promotion and NO setActive call.
  log("out", `fresh brain ${out.version} committed and registered as candidate ${model.modelId} (NOT active)`);
  return {
    version: out.version,
    modelId: model.modelId,
    activated: false,
    seeded: seed,
    config: engine,
    checkpointPath: path.join(root, out.version),
  };
}

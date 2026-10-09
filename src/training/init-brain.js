import path from "node:path";
import { REPO_ROOT, runPython, resolveStoreRoot } from "../brain/python-cli.js";
import { config } from "../config.js";
import { RegistryStore } from "../storage/registry-store.js";

/**
 * Explicit baseline bootstrap (`npm run init:brain`).
 *
 * The lifecycle NEVER auto-initialises a brain. An empty store is a *decision*
 * for the operator, not a side effect of the first training run — otherwise a
 * mistyped store path silently forks a new lineage. This module owns that
 * decision and is deliberately fail-closed:
 *
 *   - an unreadable / misconfigured store is a hard error (never init over it);
 *   - committed checkpoints with a valid active pointer => already initialised;
 *   - committed checkpoints with a missing/corrupt active pointer => refuse,
 *     require `--adopt <version>`;
 *   - `--adopt` validates COMMITTED and artifact integrity before moving the
 *     pointer and reconciling the Node registry.
 */

function mirrorPath(models) {
  return path.isAbsolute(models) ? models : path.resolve(REPO_ROOT, models);
}

export function parseInitArgs(argv = []) {
  const opts = {
    adopt: null,
    config: config.initConfig,
    store: config.pythonStore ?? undefined,
    models: config.paths.models,
    sync: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--adopt") opts.adopt = argv[++i];
    else if (a.startsWith("--adopt=")) opts.adopt = a.slice("--adopt=".length);
    else if (a === "--config") opts.config = argv[++i];
    else if (a === "--store") opts.store = argv[++i];
    else if (a === "--models") opts.models = argv[++i];
    else if (a === "--no-sync") opts.sync = false;
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

async function inspect({ store, bin, run }) {
  try {
    return await run(["status"], { store, bin });
  } catch (err) {
    const root = store ?? resolveStoreRoot();
    throw new Error(
      `cannot read the Python store at ${root}: ${err.message}. ` +
        "Refusing to initialise over a store that cannot be inspected.",
    );
  }
}

async function activePointer({ store, bin, run }) {
  try {
    const out = await run(["active"], { store, bin });
    return out?.activeVersion ?? null;
  } catch {
    return null;
  }
}

function entryIntegrity(entry) {
  if (!entry?.manifest) return "no init-manifest present";
  if (entry.artifactNameError) return `artifact name invalid: ${entry.artifactNameError}`;
  if (!entry.artifactName) return "no artifact name";
  return null;
}

async function registerAdopted({ registry, version, root, note }) {
  let existing = registry
    .listModels()
    .find((m) => m.kind === "python" && m.meta?.pythonVersion === version);
  if (!existing) {
    existing = await registry.registerModel({
      kind: "python",
      baseModel: config.baseModel,
      checkpointPath: path.join(root, version),
      meta: { pythonVersion: version, adopted: true },
    });
  }
  await registry.modelEvent(existing.modelId, { status: "promoted", note });
  return existing;
}

async function activate({ version, opts, store, bin, mirror, run }) {
  await run(["active", "--set", version, "--models", mirror], { store, bin });
  if (opts.sync !== false) {
    await run(["active", "--sync", "--models", mirror], { store, bin }).catch(() => {});
  }
}

export async function initBrain(opts = {}, { run = runPython, registry = null, log = console } = {}) {
  const store = opts.store;
  const bin = config.pythonBin ?? undefined;
  const root = store ?? resolveStoreRoot();
  const mirror = mirrorPath(opts.models ?? config.paths.models);

  const owned = registry === null;
  const reg = registry ?? (await RegistryStore.open());
  try {
    const status = await inspect({ store, bin, run });
    const versions = status.versions ?? [];
    const committed = versions.filter((v) => v.committed);

    // ---- adopt an existing committed version --------------------------------
    if (opts.adopt) {
      const entry = versions.find((v) => v.version === opts.adopt);
      if (!entry) throw new Error(`--adopt ${opts.adopt}: no such version in ${root}`);
      if (!entry.committed) throw new Error(`--adopt ${opts.adopt}: version is not committed`);
      const integrity = entryIntegrity(entry);
      if (integrity) throw new Error(`--adopt ${opts.adopt}: ${integrity}`);

      await activate({ version: opts.adopt, opts, store, bin, mirror, run });
      const model = await registerAdopted({
        registry: reg,
        version: opts.adopt,
        root,
        note: `adopted committed ${opts.adopt} as the active baseline`,
      });
      log.log?.(`[init:brain] adopted ${opts.adopt} (committed) as active; registry model ${model.modelId}`);
      return { action: "adopt", version: opts.adopt, store: root, modelId: model.modelId };
    }

    // ---- refuse to touch a store that already has committed versions --------
    if (committed.length) {
      const activeVersion = await activePointer({ store, bin, run });
      if (activeVersion && committed.some((v) => v.version === activeVersion)) {
        throw new Error(
          `brain already initialised: active=${activeVersion} in ${root}. ` +
            "Refusing to init. Use `--adopt <version>` to change the active version.",
        );
      }
      throw new Error(
        `store ${root} has committed version(s) (${committed.map((v) => v.version).join(", ")}) ` +
          "but no valid active pointer. Refusing to overwrite committed checkpoints; " +
          "run with `--adopt <version>` to choose the baseline.",
      );
    }

    // ---- safe to initialise a fresh lineage ---------------------------------
    const engine = opts.config ?? config.initConfig;
    log.log?.(`[init:brain] no committed baseline in ${root}; initialising config=${engine}`);
    const out = await run(["init", "--config", engine], { store, bin, timeoutMs: 30 * 60 * 1000 });
    if (!out.ok || !out.version) throw new Error(`python init failed: ${out.error ?? "unknown"}`);

    const after = await inspect({ store, bin, run });
    const entry = (after.versions ?? []).find((v) => v.version === out.version);
    if (!entry?.committed) {
      throw new Error(`init produced ${out.version} but it is not committed; refusing to activate it`);
    }
    const integrity = entryIntegrity(entry);
    if (integrity) throw new Error(`init produced ${out.version} but integrity check failed: ${integrity}`);

    await activate({ version: out.version, opts, store, bin, mirror, run });
    const model = await registerAdopted({
      registry: reg,
      version: out.version,
      root,
      note: `initialised committed ${out.version} as the active baseline`,
    });
    log.log?.(`[init:brain] initialised ${out.version} (committed); registry model ${model.modelId}`);
    return { action: "init", version: out.version, store: root, modelId: model.modelId };
  } finally {
    if (owned) await reg.close();
  }
}

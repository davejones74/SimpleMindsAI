import path from "node:path";
import {
  PYTHON_DIR,
  REPO_ROOT,
  pythonEnv,
  resolvePythonBin,
  resolveStoreRoot,
  runJsonProcess,
} from "../brain/python-cli.js";

/**
 * `npm run blueprint` — explicit, one-shot structural export.
 *
 * The exporter is read-only against the brain store and writes exactly one
 * atomically replaced JSON file outside it. It never constructs a model, reads
 * tensor data, or touches a GPU.
 */
const DEFAULT_OUT = process.env.SMA_BLUEPRINT
  ? path.resolve(process.env.SMA_BLUEPRINT)
  : path.join(REPO_ROOT, "data", "visualisation", "brain-blueprint.json");
const userArgs = process.argv.slice(2);
const hasOut = userArgs.some((arg) => arg === "--out" || arg.startsWith("--out="));
const args = ["-m", "sma.blueprint", ...(hasOut ? [] : ["--out", DEFAULT_OUT]), ...userArgs];

if (userArgs.includes("--help") || userArgs.includes("-h")) {
  console.log(
    [
      "usage: npm run blueprint -- [--store <dir>] [--out <file>]",
      "",
      "  --store <dir>  brain store root (default: SMA_STORE or ~/.sma/store)",
      "  --out <file>   blueprint output (default: data/visualisation/brain-blueprint.json)",
      "",
      "The active version is read from $SMA_STORE/active.json. No model is loaded.",
    ].join("\n"),
  );
  process.exit(0);
}

try {
  const result = await runJsonProcess({
    bin: resolvePythonBin(),
    args,
    cwd: PYTHON_DIR,
    env: pythonEnv(resolveStoreRoot()),
    timeoutMs: 120_000,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} catch (err) {
  console.error(`[blueprint] ${err.message}`);
  process.exit(1);
}

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PYTHON_DIR, pythonEnv, resolvePythonBin } from "../brain/python-cli.js";

/**
 * Runtime identity for experiment reuse.
 *
 * Identity inputs invalidate a cached candidate when the numerical/runtime
 * environment changes materially: Python/PyTorch/tokenizer/transformers
 * versions, accelerator backend/architecture, Node version, Node lockfile and
 * Python requirement-file content.
 *
 * Informational metadata (device name, total memory, executable path) is
 * retained in provenance but is NOT part of the key, because it does not by
 * itself change the optimisation semantics.
 */
export const RUNTIME_FINGERPRINT_VERSION = "sma/runtime-fingerprint@1";

const LOCK_FILES = [
  "package.json",
  "package-lock.json",
  "python/requirements.txt",
  "python/requirements-cuda.txt",
  "python/requirements-rocm.txt",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashRuntimeFiles(root = process.cwd(), files = LOCK_FILES) {
  const entries = [];
  const hash = createHash("sha256");
  for (const rel of [...files].sort()) {
    const file = path.join(root, rel);
    if (!existsSync(file)) {
      entries.push({ path: rel, present: false, sha256: null });
      continue;
    }
    const content = readFileSync(file);
    const digest = sha256(content);
    entries.push({ path: rel, present: true, sha256: digest });
    hash.update(rel);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return { files: entries, digest: hash.digest("hex") };
}

const PYTHON_PROBE = `
import json, platform
out = {
  "python": platform.python_version(),
  "implementation": platform.python_implementation(),
  "executable": __import__("sys").executable,
}
for name in ["torch", "transformers", "tokenizers", "numpy", "safetensors", "accelerate", "huggingface_hub"]:
    try:
        module = __import__(name)
        out[name] = getattr(module, "__version__", None)
    except Exception:
        out[name] = None
try:
    from sma import portability
    out["platform"] = portability.platform_report(with_bf16=False)
except Exception as exc:
    out["platformError"] = str(exc)
print(json.dumps(out, sort_keys=True))
`;

export function probePythonRuntime({
  pythonBin = resolvePythonBin(),
  store = process.env.SMA_STORE ?? undefined,
  env = {},
  timeout = 30_000,
} = {}) {
  const raw = execFileSync(pythonBin, ["-c", PYTHON_PROBE], {
    cwd: PYTHON_DIR,
    env: pythonEnv(store, env),
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(raw);
}

export function computeRuntimeFingerprint({
  root = process.cwd(),
  pythonBin = resolvePythonBin(),
  store = process.env.SMA_STORE ?? undefined,
  nodeVersion = process.version,
  pythonProbe = null,
  lockFiles = LOCK_FILES,
} = {}) {
  const locks = hashRuntimeFiles(root, lockFiles);
  const probe = pythonProbe ?? probePythonRuntime({ pythonBin, store });
  const platform = probe.platform ?? {};
  const packages = {
    torch: probe.torch ?? null,
    transformers: probe.transformers ?? null,
    tokenizers: probe.tokenizers ?? null,
    numpy: probe.numpy ?? null,
    safetensors: probe.safetensors ?? null,
    accelerate: probe.accelerate ?? null,
    huggingfaceHub: probe.huggingface_hub ?? null,
  };
  const identity = {
    version: RUNTIME_FINGERPRINT_VERSION,
    node: {
      version: nodeVersion,
      lockFiles: locks.digest,
    },
    python: {
      version: probe.python ?? null,
      implementation: probe.implementation ?? null,
      packages,
      requirements: locks.digest,
      backend: platform.backend ?? null,
      buildBackend: platform.buildBackend ?? null,
      backendVersion: platform.backendVersion ?? null,
      archString: platform.archString ?? null,
    },
  };
  const metadata = {
    pythonExecutable: probe.executable ?? null,
    deviceName: platform.deviceName ?? null,
    totalMemoryBytes: platform.totalMemoryBytes ?? null,
    memorySharedWithHost: platform.memorySharedWithHost ?? null,
    platformError: probe.platformError ?? null,
  };
  return {
    identity,
    metadata,
    digest: sha256(stable(identity)),
  };
}

export { stable as stableRuntimeStringify, sha256 as runtimeSha256 };

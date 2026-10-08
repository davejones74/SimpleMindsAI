import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Thin Node bridge to the Python compute plane (`python -m sma.*`).
 *
 * Two rules from the README are enforced here:
 *   - stdout carries exactly one JSON object; a non-zero exit is a failure.
 *   - there is no fallback: a Python error surfaces to the caller.
 *
 * The interpreter is resolved once, in this order:
 *   1. SMA_PYTHON          (explicit override for tests / deploys)
 *   2. python/.venv        (this checkout's virtualenv)
 *   3. python3 / python    (whatever is on PATH)
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const PYTHON_DIR = path.join(REPO_ROOT, "python");

export function resolvePythonBin() {
  if (process.env.SMA_PYTHON) return process.env.SMA_PYTHON;
  const venv =
    process.platform === "win32"
      ? path.join(PYTHON_DIR, ".venv", "Scripts", "python.exe")
      : path.join(PYTHON_DIR, ".venv", "bin", "python");
  if (fs.existsSync(venv)) return venv;
  return process.platform === "win32" ? "python" : "python3";
}

export function resolveStoreRoot() {
  return process.env.SMA_STORE || path.join(os.homedir(), ".sma", "store");
}

export function pythonEnv(store = resolveStoreRoot(), extra = {}) {
  return {
    ...process.env,
    SMA_STORE: store,
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    ...extra,
  };
}

/**
 * Run one `sma.brain` subprocess and return the parsed JSON object.
 * Rejects on non-zero exit, timeout, or non-JSON stdout.
 */
export function runPython(args, {
  timeoutMs = 300_000,
  store = resolveStoreRoot(),
  bin = resolvePythonBin(),
  cwd = PYTHON_DIR,
  env = {},
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, ["-m", "sma.brain", ...args], {
        cwd,
        env: pythonEnv(store, env),
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`python timed out after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`python exited ${code}: ${stderr.trim().slice(-800) || "(no stderr)"}`));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        reject(new Error(`python did not emit a JSON object: ${stdout.trim().slice(0, 200)}`));
        return;
      }
      resolve({ ...parsed, stderr });
    });
  });
}

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killProcessTree } from "../jobs/process.js";
import { abortError } from "../jobs/cancel.js";

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

/** Parse the version naming `active.json`, or null when absent/unreadable. */
export function readActiveVersion(store = resolveStoreRoot()) {
  try {
    const active = JSON.parse(fs.readFileSync(path.join(store, "active.json"), "utf8"));
    return active?.version ?? null;
  } catch {
    return null;
  }
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
 * Spawn one child process and return the parsed JSON object it writes to
 * stdout. Rejects on non-zero exit, timeout, or non-JSON stdout.
 *
 * This is deliberately separate from `runPython` so the process contract
 * (spawn → stdout JSON → exit code) can be exercised with any executable —
 * `runPython` only adds the `-m sma.brain` framing and the store environment.
 */
export function runJsonProcess({
  bin,
  args,
  timeoutMs = 300_000,
  cwd = PYTHON_DIR,
  env = {},
  signal = null,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let child;
    try {
      child = spawn(bin, args, { cwd, env, windowsHide: true, detached: process.platform !== "win32" });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      fn(arg);
    };
    const timer = setTimeout(() => {
      // Timeout is a forced termination of the whole tree.
      settle(reject, new Error(`python timed out after ${timeoutMs}ms: ${args.join(" ")}`));
      killProcessTree(child);
    }, timeoutMs);
    const onAbort = () => {
      // Cancellation: kill the process tree, then surface an AbortError.
      settle(reject, abortError("python subprocess cancelled"));
      killProcessTree(child);
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => {
      settle(reject, err);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        settle(reject, new Error(`python exited ${code}: ${stderr.trim().slice(-800) || "(no stderr)"}`));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        settle(reject, new Error(`python did not emit a JSON object: ${stdout.trim().slice(0, 200)}`));
        return;
      }
      settle(resolve, { ...parsed, stderr });
    });
  });
}

/**
 * Run one `sma.brain` subprocess and return the parsed JSON object.
 * Rejects on non-zero exit, timeout, cancellation, or non-JSON stdout.
 */
export function runPython(args, {
  timeoutMs = 300_000,
  store = resolveStoreRoot(),
  bin = resolvePythonBin(),
  cwd = PYTHON_DIR,
  env = {},
  signal = null,
} = {}) {
  return runJsonProcess({
    bin,
    args: ["-m", "sma.brain", ...args],
    timeoutMs,
    cwd,
    env: pythonEnv(store, env),
    signal,
  });
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStoreRoot, runPython } from "../src/brain/python-cli.js";

/**
 * Shared prerequisites for tests that need the real Python compute plane.
 *
 * These tests are deliberately NOT mocked: they drive the same CLI and worker
 * the chat server does. When the interpreter or a populated store is missing
 * they skip, rather than passing on a simulation.
 */

export const REAL_STORE = resolveStoreRoot();

export function committedVersions(store = REAL_STORE) {
  if (!fs.existsSync(store)) return [];
  return fs
    .readdirSync(store)
    .filter((n) => /^v\d+$/.test(n) && fs.existsSync(path.join(store, n, "COMMITTED")))
    .sort();
}

let readyCache = null;
export async function pythonReady() {
  if (readyCache !== null) return readyCache;
  try {
    const out = await runPython(["status"], { timeoutMs: 120_000 });
    readyCache = out.ok === true || out.verb === "status";
  } catch {
    readyCache = false;
  }
  return readyCache;
}

/**
 * Copy committed versions into an isolated temp store so a test can move the
 * active pointer without touching the real deployment. Returns the temp root.
 */
export function makeIsolatedStore(versions = ["v001", "v002"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sma-test-store-"));
  const copied = [];
  for (const version of versions) {
    const src = path.join(REAL_STORE, version);
    if (!fs.existsSync(path.join(src, "COMMITTED"))) continue;
    fs.cpSync(src, path.join(dir, version), { recursive: true });
    copied.push(version);
  }
  return { dir, versions: copied, mirror: path.join(dir, "mirror") };
}

export function removeIsolatedStore(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

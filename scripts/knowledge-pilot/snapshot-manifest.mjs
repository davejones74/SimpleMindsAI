#!/usr/bin/env node
/** Hash an isolated rehearsal snapshot and write its manifest. */
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.argv[2];
const out = process.argv[3];
if (!root || !out) throw new Error("usage: snapshot-manifest.mjs <snapshot-root> <manifest.json>");
const sha256 = (file) => new Promise((resolve, reject) => {
  const h = createHash("sha256");
  const s = createReadStream(file);
  s.on("data", (c) => h.update(c));
  s.on("error", reject);
  s.on("end", () => resolve(h.digest("hex")));
});
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) walk(p);
    else if (name.isFile()) files.push(p);
  }
}
walk(root);
files.sort();
const entries = [];
let bytes = 0;
for (const file of files) {
  const st = statSync(file);
  bytes += st.size;
  entries.push({ path: path.relative(root, file), bytes: st.size, mtimeMs: st.mtimeMs, sha256: await sha256(file) });
}
const manifest = { schema: "sma/operational-rehearsal-snapshot@1", at: new Date().toISOString(), root, fileCount: entries.length, bytes, files: entries, note: "Read-only copy of production article/registry/evaluation/snapshot/plan data plus the active pointer. Source stores were not modified. Frontier data was excluded because this rehearsal does not acquire or crawl." };
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ out, fileCount: entries.length, bytes }));

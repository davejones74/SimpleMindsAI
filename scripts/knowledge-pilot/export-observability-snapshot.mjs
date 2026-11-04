#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { ArticleStore } from "../../src/storage/article-store.js";
import { RegistryStore } from "../../src/storage/registry-store.js";
import { buildKnowledgeAccumulation } from "../../src/admin/knowledge-accumulation.js";
import { config } from "../../src/config.js";

const outPath = process.argv[2] ?? null;
const store = await ArticleStore.open(undefined, { readOnly: true });
const registry = await RegistryStore.open(undefined, { readOnly: true });
let jobs = [];
try {
  const token = process.env.SIMPLEMINDS_AUTH_TOKEN;
  if (token) {
    const response = await fetch("http://127.0.0.1:4000/api/admin/jobs", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.ok) jobs = (await response.json()).jobs ?? [];
  }
  const snapshot = await buildKnowledgeAccumulation({
    store,
    registry,
    pythonStorePath: config.pythonStore,
    supervisor: { listJobs: () => jobs },
    config,
  });
  const bytes = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (outPath) await writeFile(outPath, bytes, "utf8");
  else process.stdout.write(bytes);
} finally {
  await store.close();
  await registry.close();
}

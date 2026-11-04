#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { ArticleStore } from "../../src/storage/article-store.js";
import { RegistryStore } from "../../src/storage/registry-store.js";
import { selectTrainer } from "../../src/training/trainer-interface.js";
import { executeFullRun } from "../../src/training/lifecycle.js";
import { defaultEvalSeed, renderRunReport } from "../../src/cli/report.js";

const outPath = process.argv[2] ?? null;
const store = await ArticleStore.open();
const registry = await RegistryStore.open();
try {
  const out = await executeFullRun({
    registry,
    deps: {
      store,
      trainer: selectTrainer(),
      markConsumed: (ids, runId, meta = {}) => store.markConsumed(ids, { runId, ...meta }),
      evalSeed: defaultEvalSeed,
    },
    options: { requireProspectiveValidation: false, allowHistoricalValidationBootstrap: true },
  });
  const report = {
    schema: "sma/activation-bootstrap-run@1",
    at: new Date().toISOString(),
    note: "One-off first activation run; historical validation allowed for this run only. Production config remains fail-closed prospective.",
    run: out.run,
    render: renderRunReport(out.run, { registry }),
  };
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  if (outPath) await writeFile(outPath, bytes, "utf8");
  else process.stdout.write(bytes);
} finally {
  await store.close();
  await registry.close();
}

import readline from "node:readline";
import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import { BufferStore } from "../storage/buffer-store.js";
import { RegistryStore } from "../storage/registry-store.js";
import { OllamaClient } from "../services/ollama-client.js";
import { RewardScorer } from "../reward/reward-scorer.js";
import { stubTrainer } from "../training/trainer-interface.js";
import { executeFullRun } from "../training/lifecycle.js";
import { defaultEvalSeed, renderRunReport } from "./report.js";

/**
 * `npm run perpetual` — the full autonomous cycle, server-free (requirement #14):
 *
 *   discover → curate → score → snapshot → plan → baseline-eval → train →
 *   candidate-eval → promote/reject → persist run → report → repeat.
 *
 * Everything talks to the BufferStore + RegistryStore files directly; All
 * Ollama calls are behind the fixture switch, so `OLLAMA_FIXTURE=true` makes the
 * whole loop run with zero VRAM for CI/smoke.
 */

async function rawDocs() {
  const file = "data/raw/sample.ndjson";
  if (!existsSync(file)) return [];
  const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  const out = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line).text); } catch {}
  }
  return out;
}

async function curateAndIngest(store, docs, ollama) {
  let prompts = 0;
  for (const doc of docs) {
    let pairs = [];
    try {
      pairs = await ollama.clean(doc);
    } catch (err) {
      console.warn(`[perpetual] clean failed: ${err.message.slice(0, 80)}`);
      continue;
    }
    for (const p of pairs) {
      const pr = await store.ingestPrompt({ text: p.prompt, domain: p.domain, source: "harness-sample", rawText: doc });
      if (pr.deduped) continue;
      await store.ingestCompletion({ promptId: pr.id, text: p.completion, model: ollama.model, origin: "curated" });
      prompts++;
    }
  }
  return prompts;
}

async function scoreUnscored(store, scorer) {
  let scored = 0;
  const { items } = store.promptsPage({ limit: 500, trained: false });
  for (const p of items) {
    if (p.rewardScore != null) continue;
    for (const c of p.completions) {
      if (c.rewardScore != null) continue;
      const r = await scorer.scoreOffline({ promptText: p.text, completionText: c.text });
      await store.scoreCompletion({
        completionId: c.id,
        score: r.score,
        rationale: r.rationale,
        criticModel: r.criticModel,
        criticVersion: r.criticVersion,
        rubricVersion: r.rubricVersion,
        guardrailResult: r.guardrailResult,
      });
      scored++;
    }
  }
  return scored;
}

const maxCycles = Math.max(1, Number(process.env.PERPETUAL_CYCLES ?? 1));
const idleMs = Number(process.env.PERPETUAL_IDLE_MS ?? 10_000);
const store = await BufferStore.open();
const registry = await RegistryStore.open();
const ollama = new OllamaClient();
const scorer = new RewardScorer({ ollama });

console.log(`[perpetual] cycles=${maxCycles} model=${ollama.model} fixture=${ollama.fixture}`);
for (let cycle = 1; cycle <= maxCycles; cycle++) {
  console.log(`\n── cycle ${cycle}/${maxCycles} ────────────────────────────────`);
  try {
    const docs = await rawDocs();
    if (process.env.PERPETUAL_DEBUG === "1") console.error(`[debug] rawDocs -> ${docs.length} docs, cwd=${process.cwd()}`);
    if (!docs.length) console.log("[perpetual] no raw docs — run `npm run crawl` first");
    const ingested = docs.length ? await curateAndIngest(store, docs, ollama) : 0;
    const scored = await scoreUnscored(store, scorer);
    console.log(`[perpetual] ingested=${ingested} scored=${scored} buffered=${store.getStats().totalPrompts}`);

    const stats0 = store.getStats();
    if (stats0.untrainedPrompts === 0) {
      console.log("[perpetual] nothing untrained to train on — waiting for data...");
      await new Promise((r) => setTimeout(r, Math.min(idleMs, 30_000)));
      continue;
    }

    const out = await executeFullRun({
      registry,
      deps: {
        store,
        trainer: stubTrainer(),
        markConsumed: (ids, runId) => store.markTrained(ids, runId),
        evalSeed: defaultEvalSeed,
      },
    });
    console.log(renderRunReport(out.run, { registry }));
    const stats = store.getStats();
    console.log(`[perpetual] buffer ${stats.trainedPrompts}/${stats.totalPrompts} trained | remaining ${stats.untrainedPrompts}`);
  } catch (err) {
    console.error(`[perpetual] cycle ${cycle} failed: ${err.message}`);
    if (process.env.PERPETUAL_STRICT === "1") { await store.close(); await registry.close(); process.exit(1); }
  }
}

await store.close();
await registry.close();
console.log("[perpetual] done.");
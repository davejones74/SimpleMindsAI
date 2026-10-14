import readline from "node:readline";
import { createReadStream, existsSync } from "node:fs";
import { ArticleStore } from "../storage/article-store.js";
import { RegistryStore } from "../storage/registry-store.js";
import { OllamaClient } from "../services/ollama-client.js";
import { ReviewScorer } from "../reward/reward-scorer.js";
import { selectTrainer } from "../training/trainer-interface.js";
import { executeFullRun } from "../training/lifecycle.js";
import { defaultEvalSeed, renderRunReport } from "./report.js";

/**
 * `npm run perpetual` — the full autonomous cycle, server-free (requirement #14):
 *
 *   discover → curate → review → snapshot → plan → baseline-eval → train →
 *   candidate-eval → promote/reject → persist run → report → repeat.
 *
 * Everything talks to the ArticleStore + RegistryStore files directly. All
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
    try {
      out.push(JSON.parse(line).text);
    } catch {
      /* skip */
    }
  }
  return out;
}

async function curateAndIngest(store, docs, ollama) {
  let articles = 0;
  for (const doc of docs) {
    let units = [];
    try {
      units = await ollama.clean(doc);
    } catch (err) {
      console.warn(`[perpetual] clean failed: ${err.message.slice(0, 80)}`);
      continue;
    }
    for (const u of units) {
      const text = u?.text ?? (u?.prompt ? `${u.prompt}\n\n${u.completion ?? ""}`.trim() : null);
      if (!text) continue;
      const rec = await store.ingestArticle({ text, domain: u.domain, source: "harness-sample", rawText: doc, model: ollama.model });
      if (rec.deduped) continue;
      articles++;
    }
  }
  return articles;
}

async function reviewPending(store, scorer) {
  let reviewed = 0;
  const { items } = store.reviewQueue({ limit: 500 });
  for (const a of items) {
    const r = await scorer.scoreOffline({ text: a.text, domain: a.domain });
    await store.recordReview({
      articleId: a.articleId,
      verdict: r.verdict,
      score: r.score,
      rationale: r.rationale,
      authority: "teacher",
      reviewerModel: r.criticModel,
      reviewerVersion: r.criticVersion,
      rubricVersion: r.rubricVersion,
      guardrailResult: r.guardrailResult,
      suggestedImportance: r.suggestedImportance,
      criticTemperature: r.criticTemperature,
      criticPromptVersion: r.criticPromptVersion,
      criticScoreMissing: r.criticScoreMissing,
      criticError: r.criticError,
    });
    reviewed++;
  }
  // Autonomous selection pass: queue any INGESTED article the policy selects.
  await store.selectForReview({ limit: 500 });
  return reviewed;
}

const maxCycles = Math.max(1, Number(process.env.PERPETUAL_CYCLES ?? 1));
const idleMs = Number(process.env.PERPETUAL_IDLE_MS ?? 10_000);
const store = await ArticleStore.open();
const registry = await RegistryStore.open();
const ollama = new OllamaClient();
const scorer = new ReviewScorer({ ollama });

console.log(`[perpetual] cycles=${maxCycles} model=${ollama.model} fixture=${ollama.fixture}`);
for (let cycle = 1; cycle <= maxCycles; cycle++) {
  console.log(`\n── cycle ${cycle}/${maxCycles} ────────────────────────────────`);
  try {
    const docs = await rawDocs();
    if (process.env.PERPETUAL_DEBUG === "1") console.error(`[debug] rawDocs -> ${docs.length} docs, cwd=${process.cwd()}`);
    if (!docs.length) console.log("[perpetual] no raw docs — run `npm run crawl` first");
    const ingested = docs.length ? await curateAndIngest(store, docs, ollama) : 0;
    const reviewed = await reviewPending(store, scorer);
    const stats0 = store.getStats();
    console.log(`[perpetual] ingested=${ingested} reviewed=${reviewed} trainable=${stats0.trainable}`);

    if (stats0.trainable === 0) {
      console.log("[perpetual] nothing reviewed+unconsumed to train on — waiting for data...");
      await new Promise((r) => setTimeout(r, Math.min(idleMs, 30_000)));
      continue;
    }

    const out = await executeFullRun({
      registry,
      deps: {
        store,
        trainer: selectTrainer(),
        markConsumed: (ids, runId) => store.markConsumed(ids, { runId }),
        evalSeed: defaultEvalSeed,
      },
    });
    console.log(renderRunReport(out.run, { registry }));
    const stats = store.getStats();
    console.log(`[perpetual] consumed ${stats.uniqueConsumed}/${stats.totalArticles} articles | trainable ${stats.trainable}`);
  } catch (err) {
    console.error(`[perpetual] cycle ${cycle} failed: ${err.message}`);
    if (process.env.PERPETUAL_STRICT === "1") {
      await store.close();
      await registry.close();
      process.exit(1);
    }
  }
}

await store.close();
await registry.close();
console.log("[perpetual] done.");

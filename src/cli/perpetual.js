import readline from "node:readline";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { ArticleStore } from "../storage/article-store.js";
import { RegistryStore } from "../storage/registry-store.js";
import { OllamaClient } from "../services/ollama-client.js";
import { ReviewScorer } from "../reward/reward-scorer.js";
import { selectTrainer } from "../training/trainer-interface.js";
import { executeFullRun } from "../training/lifecycle.js";
import { defaultEvalSeed, renderRunReport } from "./report.js";
import { reviewPendingArticles } from "../jobs/review-pass.js";
import { config } from "../config.js";

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
  const rawDir = config.paths.raw;
  const candidates = [
    path.join(rawDir, "corpus.jsonl"),
    path.join(rawDir, "sample.ndjson"),
    path.join(rawDir, "raw-sources.ndjson"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    const out = [];
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && rec.text !== undefined) {
          out.push(rec.text);
        } else if (rec && rec.fetchedContentHash) {
          // raw-sources.ndjson: record the source hash for provenance,
          // but do not treat it as curatable raw text; skip.
          continue;
        }
      } catch {
        /* skip */
      }
    }
    if (out.length > 0) return out;
  }
  return [];
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
  // Delegate to the ONE shared review pass. The perpetual CLI used to run its
  // OWN inline score loop that ignored the cooldown, attempt cap and retirement
  // rules — which is exactly how a 331-article backlog hot-looped a single
  // article 20+ times without ever leaving the queue. Centralising here is what
  // makes bounded review, the audit trail, and restart-safe counters apply to
  // the server-free loop too. The shared pass also performs the INGESTED ->
  // PENDING_REVIEW selection, so no separate selection call is needed.
  const result = await reviewPendingArticles(store, scorer, {
    config,
    log: (_level, message) => console.log(`[perpetual] ${message}`),
  });
  if (result.locked) console.log("[perpetual] another worker holds REVIEW.lock — skipping review this cycle");
  return result.reviewed;
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
    const ingested = docs.length ? await curateAndIngest(store, docs, ollama) : 0;
    // The shared review pass selects INGESTED articles the policy chooses and
    // then reviews the PENDING backlog under the bounded cooldown/attempt rules.
    const reviewed = await reviewPending(store, scorer);
    const stats0 = store.getStats();
    console.log(`[perpetual] ingested=${ingested} reviewed=${reviewed} trainable=${stats0.trainable}`);

    if (stats0.trainable === 0) {
      // Recovery-driven progress: report whether the pipeline can still recover
      // material (review/quarantine) or has genuinely run dry. Never replay the
      // corpus to manufacture progress.
      const recoverable = stats0.recoverable ?? 0;
      if (recoverable > 0) {
        console.log(
          `[perpetual] no eligible unconsumed material yet — ${recoverable} recoverable (${stats0.ingested ?? 0} ingested, ${stats0.pendingReview ?? 0} pending, ${stats0.quarantined ?? 0} quarantined); waiting...`,
        );
      } else {
        console.log("[perpetual] no eligible unconsumed material and nothing recoverable — waiting for acquisition/review...");
      }
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
    // A held RUN.lock is normal contention with the Observatory's training job,
    // not a failure: skip the cycle quietly instead of logging "cycle failed".
    if (err?.code === "RUN_LOCK_HELD") {
      console.log("[perpetual] another training run holds RUN.lock — skipping training this cycle");
      if (process.env.PERPETUAL_DEBUG === "1") console.error(`[debug] ${err.message}`);
      continue;
    }
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

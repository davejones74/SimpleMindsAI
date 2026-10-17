import { ArticleStore } from "../storage/article-store.js";
import { OllamaClient } from "../services/ollama-client.js";
import { ReviewScorer } from "../reward/reward-scorer.js";
import { reviewPendingArticles } from "../jobs/review-pass.js";
import { config } from "../config.js";

/**
 * `npm run review` — the server-free backlog drain (requirement: an explicit
 * drain lever that works without the admin API).
 *
 * It reviews the CURRENT pending queue under the SAME policy as the perpetual
 * learner: cooldowns and attempt caps are respected (not bypassed), articles
 * that exhaust their inconclusive attempts are retired with an auditable
 * transition, and the queue is paginated so more than the first page is
 * processed. Counts are reported per category so "0 reviewed, 300 cooling" is
 * never mistaken for success.
 *
 * It is safe to run repeatedly and safe to interrupt: every counter is derived
 * from the durable review history, so a re-run resumes from the same state.
 *
 *   --limit=N   cap the number of NEW reviews in this run (default: busy-queue cap)
 *   --select=0  do not first queue policy-selected INGESTED articles
 *   --force=ID  request a fresh human re-review of ID (repeatable; reopens a
 *               retired article and bypasses the cooldown) before draining
 */

function parseArgs(argv) {
  const out = {
    limit: Number(process.env.REVIEW_DRAIN_LIMIT ?? 0),
    select: process.env.REVIEW_DRAIN_SELECT !== "0",
    force: (process.env.REVIEW_FORCE ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "limit") out.limit = Number(value ?? 0) || 0;
    else if (key === "select") out.select = value !== "0";
    else if (key === "force" && value) out.force.push(value);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const store = await ArticleStore.open();
const ollama = new OllamaClient();
const scorer = new ReviewScorer({ ollama });

console.log(
  `[review] dir=${store.dir} model=${ollama.model} fixture=${ollama.fixture} ` +
    `cooldownMs=${config.review.cooldownMs} maxAttempts=${config.review.maxAttempts} limit=${args.limit || "none"}`,
);

try {
  for (const id of args.force) {
    try {
      await store.requestReview(id, { actor: "human", reason: "cli force re-review" });
      console.log(`[review] forced human re-review for ${id}`);
    } catch (err) {
      console.error(`[review] force failed for ${id}: ${err.message}`);
    }
  }

  const before = store.getStats();
  const result = await reviewPendingArticles(store, scorer, {
    config,
    limit: args.limit,
    select: args.select,
    log: (stream, text) => (stream === "err" ? console.error(`[review] ${text}`) : console.log(`[review] ${text}`)),
    onProgress: (p) => {
      if (p.reviewed % 25 === 0) console.log(`[review] reviewed=${p.reviewed} retired=${p.retired}`);
    },
  });

  console.log("\n── review drain summary ──────────────────────────────");
  console.log(`  pending before : ${result.pendingBefore} (of ${before.totalArticles} articles)`);
  console.log(`  selected       : ${result.selected}`);
  console.log(`  reviewed       : ${result.reviewed}`);
  console.log(`  retired        : ${result.retired}`);
  console.log(`  skipped (cool) : ${result.skippedCooldown}`);
  console.log(`  skipped (cap)  : ${result.skippedCap}`);
  console.log(`  skipped (tech) : ${result.skippedTechnicalCap}`);
  console.log(`  failed         : ${result.failed}`);
  console.log(`  pending after  : ${result.pendingAfter}`);
  if (result.locked) console.log(`  NOTE: another review worker holds REVIEW.lock — nothing done this run`);
  else if (result.reviewed === 0 && result.retired === 0 && result.pendingBefore > 0) {
    console.log(`  NOTE: no eligible reviews this pass — the backlog is cooling down or capped, not empty`);
  }
} finally {
  await store.close();
}

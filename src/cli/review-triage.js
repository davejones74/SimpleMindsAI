import { ArticleStore } from "../storage/article-store.js";
import { triagePendingArticles } from "../jobs/review-triage.js";

/**
 * `npm run review:triage` — deterministic, teacher-free backlog triage.
 *
 *   --limit=N   examine at most N pending articles
 *   --dry-run   report what would be rejected without writing reviews
 */
function parseArgs(argv) {
  const out = { limit: Number(process.env.REVIEW_TRIAGE_LIMIT ?? 0) || 0, dryRun: false };
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "limit") out.limit = Number(value ?? 0) || 0;
    else if (key === "dry-run") out.dryRun = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const store = await ArticleStore.open();
try {
  const before = store.getStats();
  console.log(`[triage] dir=${store.dir} pending=${before.pendingReview} limit=${args.limit || "none"} dryRun=${args.dryRun}`);
  const result = await triagePendingArticles(store, {
    limit: args.limit,
    dryRun: args.dryRun,
    log: (_stream, text) => console.log(`[triage] ${text}`),
  });
  const after = store.getStats();
  console.log("\n── review triage summary ─────────────────────────────");
  console.log(`  examined       : ${result.examined}`);
  console.log(`  rejected       : ${result.rejected}`);
  console.log(`  kept           : ${result.kept}`);
  console.log(`  by gate        : ${JSON.stringify(result.byGate)}`);
  console.log(`  pending before : ${before.pendingReview}`);
  console.log(`  pending after  : ${after.pendingReview}`);
  if (result.dryRun) console.log("  dry run        : no reviews were written");
} finally {
  await store.close();
}

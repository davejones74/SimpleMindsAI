import { config as defaultConfig } from "../config.js";
import { throwIfAborted } from "./cancel.js";
import { acquireReviewLock } from "./review-lock.js";

/**
 * The ONE teacher-review pass shared by the learning job, the perpetual CLI and
 * the explicit backlog drain. Centralising it is what makes the resilience
 * rules apply everywhere instead of in one call site:
 *
 *   - Bounded attempts: after `review.maxAttempts` INCONCLUSIVE teacher verdicts
 *     an article is deliberately RETIRED (auditable), not re-scored forever.
 *   - Cooldown: an attempted article is not re-attempted until `cooldownMs`
 *     elapses, so the 300+ article backlog cannot hot-loop.
 *   - Technical failures (critic unreachable / invalid response) have their own
 *     bounded allowance and never count as an inconclusive verdict.
 *   - Per-article isolation: one article's failure is recorded and skipped; it
 *     never aborts the pass or falsely reports success for the others.
 *   - Cross-process coordination via REVIEW.lock, so duplicates cannot be
 *     scored twice at once.
 *
 * All counters are derived from the durable review history, so an interrupted
 * drain resumes from the same state on the next run.
 */

const EMPTY = {
  locked: false,
  selected: 0,
  reviewed: 0,
  retired: 0,
  failed: 0,
  skippedCooldown: 0,
  skippedCap: 0,
  skippedTechnicalCap: 0,
  pendingBefore: 0,
  pendingAfter: 0,
  eligibleRemaining: 0,
};

function isRetirable(summary) {
  return Boolean(summary && summary.pending && summary.capReached);
}

export async function reviewPendingArticles(store, scorer, opts = {}) {
  const cfg = opts.config ?? defaultConfig;
  const review = cfg.review ?? {};
  const log = opts.log ?? (() => {});
  const onProgress = opts.onProgress ?? (() => {});
  const signal = opts.signal;
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? 200, 1000));
  const maxReview = opts.limit && opts.limit > 0 ? opts.limit : Number.POSITIVE_INFINITY;
  const policyOpts = {
    cooldownMs: Number(review.cooldownMs) || 0,
    maxAttempts: Number(review.maxAttempts) || 0,
    maxTechnicalAttempts: Number(review.maxTechnicalAttempts) || 0,
  };

  // Real stores back the lock with a directory; an in-memory/partial store has
  // no shared location to coordinate through (and nothing to race), so it runs
  // without a lock rather than failing on a missing path.
  const lockDir = typeof store.dir === "string" && store.dir ? store.dir : null;
  const lock = lockDir ? acquireReviewLock(lockDir, { staleMs: Number(review.lockStaleMs) || 600_000 }) : { token: null, release() {} };
  if (!lock) {
    return { ...EMPTY, locked: true, reason: "review-lock-held" };
  }

  const counters = { ...EMPTY, locked: false };
  counters.pendingBefore = store.getStats().pendingReview;
  try {
    if (opts.select !== false) {
      try {
        const ids = await store.selectForReview({ limit: opts.selectLimit ?? 2000 });
        counters.selected = ids.length;
      } catch (err) {
        log("err", `review selection failed: ${err.message}`);
      }
    }

    const retire = async (articleId, summary) => {
      const reason = `review: ${summary.inconclusiveAttempts} inconclusive teacher attempt(s) (maxAttempts=${policyOpts.maxAttempts})`;
      try {
        await store.retireArticle(articleId, { reason, attempts: summary.inconclusiveAttempts });
        counters.retired++;
        log("out", `retired ${articleId} after ${summary.inconclusiveAttempts} inconclusive review(s)`);
      } catch (err) {
        counters.failed++;
        log("err", `retire failed for ${articleId}: ${err.message}`);
      }
    };

    let after = null;
    for (;;) {
      throwIfAborted(signal);
      if (counters.reviewed >= maxReview) break;
      const { items, nextCursor } = store.reviewQueue({ after, limit: pageSize });
      if (!items.length) break;
      for (const article of items) {
        throwIfAborted(signal);
        if (counters.reviewed >= maxReview) break;
        const before = store.reviewAttempts(article.articleId, policyOpts);
        if (isRetirable(before)) {
          await retire(article.articleId, before);
          continue;
        }
        if (before && !before.eligible) {
          if (before.inCooldown) counters.skippedCooldown++;
          else if (before.technicalCapReached) counters.skippedTechnicalCap++;
          else counters.skippedCap++;
          continue;
        }

        let r;
        try {
          r = await scorer.scoreOffline({ text: article.text, domain: article.domain });
        } catch (err) {
          counters.failed++;
          log("err", `review failed for ${article.articleId}: ${err.message}`);
          continue;
        }

        try {
          await store.recordReview({
            articleId: article.articleId,
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
        } catch (err) {
          // The article was not durably reviewed; do not count it and never
          // pretend it succeeded. The next run re-attempts it.
          counters.failed++;
          log("err", `review record failed for ${article.articleId}: ${err.message}`);
          continue;
        }
        counters.reviewed++;
        onProgress({ phase: "review", reviewed: counters.reviewed, retired: counters.retired });

        const post = store.reviewAttempts(article.articleId, policyOpts);
        if (isRetirable(post)) await retire(article.articleId, post);
      }
      if (!nextCursor || nextCursor === after) break;
      after = nextCursor;
    }
  } finally {
    lock.release();
  }

  counters.pendingAfter = store.getStats().pendingReview;
  counters.eligibleRemaining = counters.skippedCooldown + counters.skippedTechnicalCap + counters.skippedCap;
  // A pass is "waiting" (not stalled) when it made no progress only because the
  // backlog is cooling down or another worker holds the review lock.
  counters.waiting = counters.reviewed === 0 && counters.retired === 0 && counters.skippedCooldown > 0;
  return counters;
}

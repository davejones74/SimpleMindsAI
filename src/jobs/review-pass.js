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

/**
 * Decide whether a pending article has exhausted its bounded review allowance.
 * BOTH allowances are terminal: repeatedly failing to judge a text (unreadable
 * critic) is as much a reason to stop as repeatedly failing to decide it. The
 * cause is returned so the retirement is auditable and the two are never
 * conflated in the ledger.
 */
function retirementCause(summary) {
  if (!summary || !summary.pending) return null;
  if (summary.capReached) return { kind: "inconclusive", attempts: summary.inconclusiveAttempts };
  if (summary.technicalCapReached) return { kind: "technical", attempts: summary.technicalAttempts };
  return null;
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

    const retire = async (articleId, cause) => {
      const reason =
        cause.kind === "technical"
          ? `review: ${cause.attempts} technical critic failure(s) (maxTechnicalAttempts=${policyOpts.maxTechnicalAttempts})`
          : `review: ${cause.attempts} inconclusive teacher attempt(s) (maxAttempts=${policyOpts.maxAttempts})`;
      try {
        await store.retireArticle(articleId, { reason, attempts: cause.attempts });
        counters.retired++;
        log("out", `retired ${articleId} after ${cause.attempts} ${cause.kind} review(s)`);
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
        const beforeCause = retirementCause(before);
        if (beforeCause) {
          await retire(article.articleId, beforeCause);
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
          // The critic faulted without returning a record (e.g. an unexpected
          // transport error from a scorer that does not self-classify). Record
          // it as a TECHNICAL failure so it consumes the bounded technical
          // allowance and can eventually retire — never an unbounded retry and
          // never miscounted as an inconclusive teacher verdict.
          try {
            await store.recordReview({
              articleId: article.articleId,
              verdict: "uncertain",
              score: null,
              rationale: `[critic error: ${err.message.slice(0, 80)}]`,
              authority: "teacher",
              criticScoreMissing: true,
              criticError: `critic unavailable: ${err.message.slice(0, 80)}`,
            });
            counters.failed++;
            log("err", `review failed (recorded technical) for ${article.articleId}: ${err.message}`);
            const postThrow = store.reviewAttempts(article.articleId, policyOpts);
            const cause = retirementCause(postThrow);
            if (cause) await retire(article.articleId, cause);
          } catch (recErr) {
            counters.failed++;
            log("err", `review failed and could not be recorded for ${article.articleId}: ${recErr.message}`);
          }
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
        const cause = retirementCause(post);
        if (cause) await retire(article.articleId, cause);
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

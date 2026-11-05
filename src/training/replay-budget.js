/**
 * Tokenizer-authoritative replay budgeting.
 *
 * Character/4 estimates are adequate for choosing candidates, but they are not
 * the training denominator. The final replay share must be measured with the
 * student tokenizer on the exact rows the trainer will consume, after validation
 * partitioning and snapshot packing.
 */

export function replayBudget({ freshTokens, replayPercent = 20, tolerancePoints = 2 } = {}) {
  const pct = Math.max(0, Math.min(100, Number(replayPercent) || 0));
  const tolerance = Math.max(0, Number(tolerancePoints) || 0);
  const target = pct >= 100 ? Number.POSITIVE_INFINITY : (Number(freshTokens) * pct) / (100 - pct);
  const upperPct = Math.min(100, pct + tolerance);
  const upper = upperPct >= 100 ? Number.POSITIVE_INFINITY : (Number(freshTokens) * upperPct) / (100 - upperPct);
  return { percent: pct, tolerancePoints: tolerance, targetTokens: target, upperTokens: upper };
}

/**
 * Keep replay rows in deterministic order until their ACTUAL token mass fits the
 * target. The first row that would exceed the target is skipped; later smaller
 * rows may still fit. This avoids both silent over-budget training and dropping
 * all replay merely because one row is large.
 */
export function selectReplayWithinBudget({ replayRows = [], tokenById = new Map(), freshTokens = 0, replayPercent = 20 } = {}) {
  const budget = replayBudget({ freshTokens, replayPercent });
  const kept = [];
  let replayTokens = 0;
  for (const row of replayRows) {
    const tokens = Number(tokenById.get(row.articleId) ?? tokenById.get(row.itemId) ?? 0);
    if (!Number.isFinite(tokens) || tokens <= 0) continue;
    if (replayTokens + tokens > budget.targetTokens) continue;
    kept.push(row);
    replayTokens += tokens;
  }
  const total = Number(freshTokens) + replayTokens;
  return {
    ...budget,
    keptRows: kept,
    removedRows: replayRows.length - kept.length,
    freshTokens: Number(freshTokens),
    replayTokens,
    totalTokens: total,
    replayShare: total ? replayTokens / total : 0,
    withinTarget: replayTokens <= budget.targetTokens + 1e-9,
  };
}

export function replayShareWithinTolerance({ freshTokens, replayTokens, replayPercent = 20, tolerancePoints = 2 } = {}) {
  const budget = replayBudget({ freshTokens, replayPercent, tolerancePoints });
  const total = Number(freshTokens) + Number(replayTokens);
  const share = total ? Number(replayTokens) / total : 0;
  return {
    ...budget,
    share,
    withinTolerance: Number(replayTokens) <= budget.upperTokens + 1e-9,
  };
}

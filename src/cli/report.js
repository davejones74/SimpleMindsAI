/**
 * Shared CLI pieces: eval-set seeding and the human-readable TRAINING RUN block
 * (requirement #15). The seed is only used the FIRST time — the file is then
 * frozen and every later run/evaluate reads it, so numbers stay comparable.
 */
export function defaultEvalSeed() {
  return [
    { prompt: "When was the first practical atmospheric steam engine built?", completion: "Thomas Newcomen built the first practical atmospheric engine in 1712." },
    { prompt: "What does photosynthesis convert light energy into?", completion: "Photosynthesis converts light energy into chemical energy." },
    { prompt: "Who added a separate condenser to the steam engine?", completion: "James Watt added a separate condenser in 1769." },
    { prompt: "What does chlorophyll absorb in chloroplasts?", completion: "Chlorophyll absorbs red and blue light." },
    { prompt: "What does the Calvin cycle fix into glucose?", completion: "The Calvin cycle fixes carbon dioxide into glucose." },
  ].map((r, i) => ({ promptId: `ev_seed_${i + 1}`, ...r, domain: "science" }));
}

export function renderRunReport(run, { registry = null } = {}) {
  const L = [];
  const push = (k, v) => L.push(`  ${String(k).padEnd(14)} ${v}`);
  L.push(`TRAINING RUN ${run.runId}`);
  L.push(`  status        ${run.status}  (${run.promotionStatus ?? "n/a"})`);
  push("dataset", `${run.datasetId} v-${(run.datasetVersion ?? "?").slice(0, 12)}  ${run.recordCount ?? "?"} records`);
  push("baseModel", run.baseModel);
  push("resultModel", run.resultModelId ?? "—");
  push("critic", `${run.criticModel}  ${run.criticVersion}/${run.rubricVersion}`);
  push("curriculum", `${run.curriculumVersion}  ${(run.curriculum ?? []).map((c) => `${c.category}:${c.targetExamples}`).join(" ")}`);
  push("trainer", `${run.trainerKind ?? "?"} v${run.trainerVersion ?? "?"}`);

  const evalCell = (er) => {
    if (!er) return "—";
    if (er.loss != null) {
      const se = er.lossStdErr != null ? ` ±${er.lossStdErr.toFixed(4)}` : "";
      return `loss ${er.loss.toFixed(2)}${se} (${er.version ?? "?"})`;
    }
    const score = er.score100 ?? er.score;
    return score == null ? "—" : `${er.evalRunId ?? "?"}  ${score.toFixed(1)}`;
  };
  const base = run.baselineEvaluation;
  const trained = run.trainedEvaluation;
  push("baseline", evalCell(base));
  push("trained", evalCell(trained));
  push("delta", run.evaluationDelta == null ? "—" : `${run.evaluationDelta > 0 ? "+" : ""}${run.evaluationDelta.toFixed(2)}`);
  if (run.promotionNoiseBand != null) {
    push("noise ±95%", run.promotionNoiseBand.toFixed(4) + (Math.abs(run.evaluationDelta ?? 0) < run.promotionNoiseBand ? "  (delta within noise)" : ""));
  }
  L.push(`  decision      ${run.promotionStatus === "promoted" ? "PROMOTED" : run.promotionStatus === "rejected" ? "REJECTED" : run.promotionStatus}`);

  const notes = run.trainerNotes;
  if (notes) {
    const bits = [];
    if (notes.articlesConsumed) bits.push(`articles-consumed ${notes.articlesConsumed}`);
    if (notes.alreadyConsumedSkipped) bits.push(`already-consumed-skipped ${notes.alreadyConsumedSkipped}`);
    if (notes.leakExcluded) bits.push(`leak-excluded ${notes.leakExcluded}`);
    if (bits.length) push("guards", bits.join(", "));
    if (notes.checkpointPath) push("checkpoint", notes.checkpointPath);
  }

  if (registry) {
    const evals = registry.listEvaluations();
    const detail = (er) => {
      const rec = er && evals.find((e) => e.evalRunId === er.evalRunId);
      return rec ? ` (n=${rec.perExample?.length ?? "?"})` : "";
    };
    L.push(`  eval detail${detail(base)}${detail(trained)}`);
  }
  L.push("──".repeat(24));
  return L.join("\n");
}
import { existsSync } from "node:fs";
import { config } from "../config.js";
import { loadEvaluationSet } from "../dataset/evaluation-set.js";
import { evaluateVersionLoss, pairedSourceGroupBootstrap } from "../training/loss-evaluator.js";
import { evaluateMissionTasks, compareMissionTasks } from "../dataset/mission-eval.js";
import { makeStudentCompletor, makeStudentScorer, openStudentWorker } from "../training/student-completion.js";

function parseArgs() {
  const out = { versions: [], datasetId: config.missionEval.datasetId, taskDatasetId: config.missionEval.taskDatasetId, suite: "loss", maxNewTokens: 32 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--version") out.versions.push(argv[++i]);
    else if (a === "--versions") out.versions.push(...String(argv[++i] ?? "").split(",").map((v) => v.trim()).filter(Boolean));
    else if (a === "--dataset") out.datasetId = argv[++i];
    else if (a === "--task-dataset") out.taskDatasetId = argv[++i];
    else if (a === "--suite") out.suite = argv[++i];
    else if (a === "--max-new-tokens") out.maxNewTokens = Math.max(1, Number(argv[++i]) || 32);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const opts = parseArgs();
if (opts.help || !opts.versions.length) {
  console.log("Usage: node src/cli/mission-eval.js --versions v749,v787 [--suite loss|tasks|both] [--dataset eval-language-001] [--task-dataset eval-language-tasks-001] [--max-new-tokens 32]");
  process.exit(opts.help ? 0 : 1);
}
if (!["loss", "tasks", "both"].includes(opts.suite)) {
  console.error("suite must be loss, tasks or both");
  process.exit(2);
}

if (opts.suite === "loss" || opts.suite === "both") {
  const evalSet = await loadEvaluationSet({ datasetId: opts.datasetId, dir: config.paths.evaluation });
  if (!evalSet.items.length) {
    console.error(`mission text-loss set '${opts.datasetId}' is empty or missing`);
    process.exit(1);
  }
  const lossResults = [];
  for (const version of opts.versions) {
    const result = await evaluateVersionLoss({
      version,
      evalSetFile: evalSet.file,
      store: config.pythonStore,
      bin: config.pythonBin,
      device: config.studentDevice,
      perDocument: true,
    });
    lossResults.push({ version, result });
    console.log(JSON.stringify({
      suite: "loss",
      version,
      datasetId: evalSet.datasetId,
      datasetVersion: evalSet.datasetVersion,
      loss: result.loss,
      tokensSeen: result.tokensSeen,
      documentCount: result.documentCount,
      ok: result.ok,
      error: result.error,
    }, null, 2));
    if (!result.ok) process.exitCode = 1;
  }
  if (lossResults.length >= 2) {
    const baseline = lossResults[0];
    for (const candidate of lossResults.slice(1)) {
      console.log(JSON.stringify({
        suite: "loss-comparison",
        baselineVersion: baseline.version,
        candidateVersion: candidate.version,
        improvement: Number.isFinite(baseline.result.loss) && Number.isFinite(candidate.result.loss)
          ? baseline.result.loss - candidate.result.loss
          : null,
        paired: pairedSourceGroupBootstrap(baseline.result, candidate.result),
      }, null, 2));
    }
  }
}

if (opts.suite === "tasks" || opts.suite === "both") {
  const evalSet = await loadEvaluationSet({ datasetId: opts.taskDatasetId, dir: config.paths.evaluation });
  if (!evalSet.items.length) {
    console.error(`mission task set '${opts.taskDatasetId}' is empty or missing`);
    process.exit(1);
  }
  const worker = await openStudentWorker();
  const results = [];
  try {
    for (const version of opts.versions) {
      const complete = makeStudentCompletor({ worker, version, maxNewTokens: opts.maxNewTokens, seed: 0 });
      const scoreContinuation = makeStudentScorer({ worker, version });
      const result = await evaluateMissionTasks({ evalSet, complete, scoreContinuation });
      results.push({ version, ...result });
      console.log(JSON.stringify({
        suite: "tasks",
        version,
        datasetId: result.datasetId,
        datasetVersion: result.datasetVersion,
        total: result.total,
        successes: result.successes,
        accuracy: result.accuracy,
        ciLow: result.ciLow,
        ciHigh: result.ciHigh,
        answerKeyHash: result.answerKeyHash,
        perTask: result.perTask,
      }, null, 2));
    }
  } finally {
    await worker.shutdown();
  }
  if (results.length >= 2) {
    const baseline = results[0];
    for (const candidate of results.slice(1)) {
      console.log(JSON.stringify({
        suite: "task-comparison",
        baselineVersion: baseline.version,
        candidateVersion: candidate.version,
        ...compareMissionTasks(baseline, candidate),
      }, null, 2));
    }
  }
}

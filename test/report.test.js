import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRunReport } from "../src/cli/report.js";

const baseRun = (over = {}) => ({
  runId: "run-1",
  status: "completed",
  promotionStatus: "promoted",
  datasetId: "ds-abc",
  datasetVersion: "abcdef123456",
  recordCount: 6,
  baseModel: "mock-base",
  resultModelId: "model-1",
  criticModel: "mock-critic",
  criticVersion: "1.0",
  rubricVersion: "2.0",
  curriculumVersion: "3.0",
  curriculum: [{ category: "factcheck", targetExamples: 2 }],
  trainerKind: "python",
  trainerVersion: "4.0",
  baselineEvaluation: null,
  trainedEvaluation: null,
  evaluationDelta: null,
  ...over,
});

test("renderRunReport renders python-mode (loss) evaluations without crashing", () => {
  const run = baseRun({
    baselineEvaluation: { loss: 11.82, datasetHash: "h1", version: "v001" },
    trainedEvaluation: { loss: 11.56, datasetHash: "h1", version: "v003" },
    evaluationDelta: 0.26,
  });
  const text = renderRunReport(run);
  assert.match(text, /baseline\s+loss 11\.82 \(v001\)/);
  assert.match(text, /trained\s+loss 11\.56 \(v003\)/);
  assert.match(text, /delta\s+\+0\.26/);
  assert.match(text, /decision\s+PROMOTED/);
});

test("renderRunReport renders score-mode evaluations for non-python trainers", () => {
  const run = baseRun({
    baselineEvaluation: { evalRunId: "ev-1", score: 50, score100: 51 },
    trainedEvaluation: { evalRunId: "ev-2", score: 60, score100: 62 },
    evaluationDelta: 11,
  });
  const text = renderRunReport(run);
  assert.match(text, /baseline\s+ev-1\s+51\.0/);
  assert.match(text, /trained\s+ev-2\s+62\.0/);
  assert.match(text, /delta\s+\+11\.00/);
});

test("renderRunReport shows em-dashes when evaluations are absent", () => {
  const text = renderRunReport(baseRun());
  assert.match(text, /baseline\s+—/);
  assert.match(text, /trained\s+—/);
  assert.match(text, /delta\s+—/);
});
#!/usr/bin/env python3
"""Modify lifecycle.js to add manifest persistence and recovery functions."""

import re

filepath = r"E:\Development\Repositories\SimpleMindsAI\src\training\lifecycle.js"

with open(filepath, "r", encoding="utf-8") as f:
    content = f.read()

# Find the position after the hash function and before executeFullRun
# Strategy: find "export async function executeFullRun(" and insert before it
# the manifest functions, after the hash function section.

insert_text = '''\nfunction computeFileHash(filePath) {
  return createHash("sha256")
    .update(readFileSync(filePath, "utf8"), "utf8")
    .digest("hex");
}

/** Persist the run manifest as JSON for crash recovery and audit. */
async function persistManifest(manifestPath, manifest) {
  import_path = "import { mkdir, writeFile } from \"node:fs/promises\";"
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

/** Read the run manifest if it exists; return null when absent. */
async function readManifest(manifestPath) {
  try {
    const raw = await readFile(manifestPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Recovery: attempt to finalize a run that crashed mid-stream. */
async function recoverFromManifest(
  registry,
  runId,
  manifest,
  snapshot,
  commitConsumption,
  setActive,
  trainingResult,
  pythonMode,
  worker,
  options,
  logger
) {
  if (
    manifest.status === "evaluated" &&
    manifest.consumed === false &&
    manifest.decision !== null
  ) {
    try {
      await commitConsumption(
        snapshot.manifest.articleIds ?? snapshot.rows.map((r) => r.articleId),
        runId
      );
      manifest.consumed = true;
      await persistManifest(manifestPath, manifest);
    } catch (err) {
      logger.error && logger.error(
        "[lifecycle] recovery consume failed: " + err.message
      );
    }
    if (manifest.decision === "promoted") {
      if (pythonMode) {
        await setActive(trainingResult.version, {
          store: config.pythonStore ?? undefined,
          bin: config.pythonBin ?? undefined,
          models: options.paths?.models ?? config.paths.models,
        });
        if (worker) await worker.reload();
      }
      await registry.modelEvent(
        null,
        {
          status: "promoted",
          evaluationScore: manifest.candidateLoss,
          note: "recovered: promotion decision " + manifest.decision,
        }
      );
    } else if (manifest.decision === "rejected") {
      await registry.modelEvent(
        null,
        {
          status: "rejected",
          evaluationScore: manifest.candidateLoss,
          note: "recovered: rejection decision " + manifest.decision,
        }
      );
    }
    await registry.completeRun(runId, {
      status: manifest.decision,
      promotionStatus: manifest.decision,
      resultModelId: manifest.resultModelId,
      examplesProcessed: manifest.examplesProcessed,
      examplesSkipped: manifest.examplesSkipped ?? 0,
      baselineEvaluation: manifest.baselineEvaluation,
      trainedEvaluation: manifest.trainedEvaluation,
      evaluationDelta: manifest.evaluationDelta,
      activatedVersion: manifest.activatedVersion,
      runLinkage: manifest.runLinkage,
      trainerNotes: manifest.trainerNotes,
    });
    logger.log && logger.log(
      "[lifecycle] run " + runId + " recovered from manifest (status=" + manifest.decision + ")"
    );
  }
}

/** Update the run manifest with current state. */
async function updateManifest(manifestPath, manifest, fields) {
  const updated = { ...manifest, ...fields };
  await persistManifest(manifestPath, updated);
  return updated;
}

'''

# Find the position of "export async function executeFullRun("
execute_idx = content.find("export async function executeFullRun(")
if execute_idx == -1:
    print("ERROR: Could not find executeFullRun")
    exit(1)

# Insert the manifest functions before executeFullRun
new_content = content[:execute_idx] + insert_text + content[execute_idx:]

with open(filepath, "w", encoding="utf-8") as f:
    f.write(new_content)

print("Successfully inserted manifest functions into lifecycle.js")
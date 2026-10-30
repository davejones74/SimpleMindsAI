import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Deterministic candidate identity.
 *
 * The identity is the set of inputs that can change what a candidate is:
 * parent weights, corpus, evaluation set, tokenizer, training configuration,
 * split policy, training seed, and the actual trainer source. The key is a
 * canonical hash of those inputs, not a hand-maintained version label.
 *
 * Source fingerprint scope is deliberately narrow: the Node training/dataset/
 * storage code plus the Python trainer package. Tests, generated files,
 * __pycache__, virtualenvs, node_modules and runtime data are excluded.
 */
export const CANDIDATE_IDENTITY_SCHEMA = "sma/candidate-identity@1";
export const TRAINER_FINGERPRINT_VERSION = "sma/trainer-fingerprint@1";

export const TRAINER_FINGERPRINT_COMPONENTS = Object.freeze([
  "src/training",
  "src/dataset",
  "src/domain",
  "src/storage",
  "src/brain",
  "src/config.js",
  "scripts/run-staged-production-candidate.mjs",
  "python/sma",
  "package.json",
]);

const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".py", ".json"]);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function hashFile(file) {
  return sha256(readFileSync(file));
}

function listSourceFiles(root, component, out) {
  const absolute = path.join(root, component);
  if (!existsSync(absolute)) return;
  const stat = statSync(absolute);
  if (stat.isFile()) {
    out.push(component);
    return;
  }
  if (!stat.isDirectory()) return;
  const entries = readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === "__pycache__" || entry.name === ".venv" || entry.name === "node_modules") continue;
    const rel = path.join(component, entry.name);
    const abs = path.join(root, rel);
    const st = statSync(abs);
    if (st.isDirectory()) listSourceFiles(root, rel, out);
    else if (st.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(rel);
  }
}

/**
 * Hash the actual bytes of the trainer/source components.
 * @returns {{version, algorithm, components, files, fileCount, digest}}
 */
export function computeTrainerFingerprint(root = process.cwd()) {
  const files = [];
  for (const component of TRAINER_FINGERPRINT_COMPONENTS) listSourceFiles(root, component, files);
  const unique = [...new Set(files)].sort();
  const hash = createHash("sha256");
  for (const rel of unique) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(path.join(root, rel)));
    hash.update("\0");
  }
  return {
    version: TRAINER_FINGERPRINT_VERSION,
    algorithm: "sha256",
    components: [...TRAINER_FINGERPRINT_COMPONENTS],
    files: unique,
    fileCount: unique.length,
    digest: hash.digest("hex"),
  };
}

/**
 * Fingerprint the parent's persisted weights from its init manifest. Uses the
 * post-training tensor hashes (the actual checkpoint bytes), never a version
 * label. Fails closed when the manifest has no tensor hashes.
 */
export function computeParentWeightFingerprint(storeRoot, version) {
  const manifestFile = path.join(storeRoot, version, "init-manifest.json");
  if (!existsSync(manifestFile)) {
    throw new Error(`parent ${version} has no init-manifest.json at ${manifestFile}`);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const tensors = manifest?.tensorHashesAfterTraining?.tensors ?? manifest?.tensors ?? null;
  if (!tensors || typeof tensors !== "object" || !Object.keys(tensors).length) {
    throw new Error(`parent ${version} init-manifest records no tensor hashes`);
  }
  const entries = Object.keys(tensors)
    .sort()
    .map((name) => {
      const value = tensors[name];
      return [name, value?.dtype ?? null, value?.sha256 ?? value];
    });
  return sha256(stableStringify({ version, tensorCount: entries.length, entries }));
}

function readJsonIfPresent(file) {
  try {
    return file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
}

/**
 * Build the complete, deterministic candidate identity and key.
 *
 * Training config is included verbatim (stable-sorted by the canonicalisation)
 * so any hyperparameter, budget or split-policy change invalidates the key.
 */
export function buildCandidateIdentity({
  root = process.cwd(),
  parentVersion,
  storeRoot,
  corpusFingerprint,
  corpusSnapshotFingerprint = null,
  evaluationFile,
  evaluationManifestFile = null,
  tokenizerFile,
  trainingConfig = {},
  seed = 0,
  splitPolicy = {},
  trainerFingerprint = null,
  environmentFingerprint = null,
} = {}) {
  if (!parentVersion) throw new Error("candidate identity requires parentVersion");
  if (!storeRoot) throw new Error("candidate identity requires storeRoot");
  if (!corpusFingerprint) throw new Error("candidate identity requires corpusFingerprint");
  if (!evaluationFile) throw new Error("candidate identity requires evaluationFile");
  if (!tokenizerFile) throw new Error("candidate identity requires tokenizerFile");

  const parentWeightFingerprint = computeParentWeightFingerprint(storeRoot, parentVersion);
  const evaluationManifest = readJsonIfPresent(evaluationManifestFile);
  const trainer = trainerFingerprint ?? computeTrainerFingerprint(root);
  const evaluationFingerprint = hashFile(evaluationFile);
  const tokenizerFingerprint = hashFile(tokenizerFile);
  const evaluationManifestFingerprint = evaluationManifestFile && existsSync(evaluationManifestFile)
    ? hashFile(evaluationManifestFile)
    : null;
  const runtimeIdentity = environmentFingerprint?.identity ?? {
    version: "sma/runtime-fingerprint@1",
    status: "unavailable",
  };
  const runtimeMetadata = environmentFingerprint?.metadata ?? null;

  const identity = {
    schema: CANDIDATE_IDENTITY_SCHEMA,
    parent: {
      version: parentVersion,
      weightFingerprint: parentWeightFingerprint,
    },
    corpus: {
      fingerprint: corpusFingerprint,
      snapshotFingerprint: corpusSnapshotFingerprint,
    },
    evaluation: {
      fileFingerprint: evaluationFingerprint,
      manifestFingerprint: evaluationManifestFingerprint,
      datasetVersion: evaluationManifest?.datasetVersion ?? null,
    },
    tokenizer: {
      fingerprint: tokenizerFingerprint,
    },
    training: {
      config: trainingConfig,
      seed: Number(seed) || 0,
    },
    split: {
      policyVersion: splitPolicy.policyVersion ?? null,
      clusterVersion: splitPolicy.clusterVersion ?? null,
      seed: splitPolicy.seed ?? null,
    },
    trainer: {
      version: trainer.version ?? null,
      fingerprint: trainer.digest ?? null,
      fileCount: trainer.fileCount ?? null,
    },
    runtime: runtimeIdentity,
  };

  return {
    ...identity,
    candidateKey: sha256(stableStringify(identity)),
    runtimeMetadata,
  };
}

export { stableStringify, sha256 };

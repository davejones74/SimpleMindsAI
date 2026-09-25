/**
 * Central config: everything tunable as env with a sane default.
 * Versions here are the *provenance spine* — a TrainingRun records exactly which
 * critic, rubric, curriculum and trainer produced it. Bump these when you change
 * any of those implementations, and historical runs stay explainable.
 */

const env = (name, dflt) => {
  const v = process.env[name];
  return v === undefined || v === "" ? dflt : v;
};
const num = (name, dflt) => Number(env(name, dflt));
const bool = (name, dflt) => /^(1|true|yes)$/i.test(env(name, String(dflt)));

export const config = {
  paths: {
    buffer: env("BUFFER_DIR", "data/buffer"),
    registry: env("REGISTRY_DIR", "data/registry"),
    snapshots: env("SNAPSHOT_DIR", "data/snapshots"),
    evaluation: env("EVALUATION_DIR", "data/evaluation"),
    plans: env("PLAN_DIR", "data/plans"),
    models: env("MODEL_DIR", "data/models"),
  },

  graphqlUrl: env("GRAPHQL_URL", "http://localhost:4000/graphql"),
  ollamaEndpoint: env("OLLAMA_ENDPOINT", "http://localhost:11434"),
  // NOTE: on consumer rigs `:latest` is a 4-7GB distill, not the 671B MoE.
  ollamaModel: env("OLLAMA_MODEL", "deepseek-r1:latest"),
  ollamaFixture: bool("OLLAMA_FIXTURE", false),

  // ---- Provenance versions (bump on behaviour change) ----
  criticModel: env("CRITIC_MODEL", "deepseek-r1:latest"),
  criticVersion: env("CRITIC_VERSION", "critic-v1"),
  rubricVersion: env("RUBRIC_VERSION", "rubric-v1"),
  curriculumVersion: env("CURRICULUM_VERSION", "curriculum-v1"),
  trainerVersion: env("TRAINER_VERSION", "stub-v1"),
  evaluatorVersion: env("EVALUATOR_VERSION", "eval-v1"),
  baseModel: env("BASE_MODEL", "deepseek-r1:latest"),
  trainerKind: env("TRAINER_KIND", "stub"), // stub | (future) onnx | python | ...

  // ---- Reward ----
  minReward: num("MIN_REWARD", 6), // below this, unscored/weak examples are skipped
  criticTemperature: num("CRITIC_TEMPERATURE", 0.1),

  // ---- Synthetic feedback ----
  syntheticFeedback: bool("SYNTHETIC_FEEDBACK", false),
  syntheticMinScore: num("SYNTHETIC_MIN_SCORE", 8), // high-confidence branch
  maxSyntheticShare: num("MAX_SYNTHETIC_SHARE", 0.20), // 0..1 of a dataset/run

  // ---- Curriculum ----
  allowedCategories: env("ALLOWED_CATEGORIES", "reasoning,coding,general,science,history,howto,fiction,factcheck").split(","),
  curriculumMaxSyntheticShare: num("CURRICULUM_MAX_SYNTHETIC_SHARE", 0.20),

  // ---- Evaluation ----
  evalDatasetId: env("EVAL_DATASET_ID", "eval-001"),
  promoteMinDelta: num("PROMOTE_MIN_DELTA", 0), // delta >= this => promote (0 = no regression allowed)
  promoteMinScore: num("PROMOTE_MIN_SCORE", 0), // absolute floor for a candidate to be promotable

  // ---- Training run ----
  batchSize: num("BATCH_SIZE", 64),
  snapshotLimit: num("SNAPSHOT_LIMIT", 256),
  workers: num("WORKERS", 2),
  runLockStaleMs: num("RUN_LOCK_STALE_MS", 10 * 60 * 1000),
};
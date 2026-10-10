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
    buffer: env("BUFFER_DIR", "data/buffer"), // legacy pair-buffer (read-only detection)
    articles: env("ARTICLE_DIR", env("BUFFER_DIR", "data/articles")),
    registry: env("REGISTRY_DIR", "data/registry"),
    snapshots: env("SNAPSHOT_DIR", "data/snapshots"),
    evaluation: env("EVALUATION_DIR", "data/evaluation"),
    plans: env("PLAN_DIR", "data/plans"),
    models: env("MODEL_DIR", "data/models"),
    governance: env("GOVERNANCE_DIR", env("REGISTRY_DIR", "data/registry")),
    raw: env("RAW_DIR", "data/raw"),
  },

  // ---- Server bind (admin portal is mounted on the existing server) ----
  host: env("API_HOST", "127.0.0.1"),
  port: num("API_PORT", 4000),

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
  trainerKind: env("TRAINER_KIND", "python"), // python (default) | stub (explicit)
  pythonTrainerVersion: env("PYTHON_TRAINER_VERSION", "python-v1"),

  // ---- Reward (teacher review signal; NEVER part of the training loss) ----
  minReward: num("MIN_REWARD", 6), // below this, teacher approval is not sufficient
  criticTemperature: num("CRITIC_TEMPERATURE", 0.1),

  // ---- Review policy (autonomous selection + teacher/human transitions) ----
  review: {
    sampleRate: num("REVIEW_SAMPLE_RATE", 0.1), // deterministic sample of reviewed-in articles
    minScore: num("REVIEW_MIN_SCORE", 6), // teacher approve needs score >= this
    uncertainScore: num("REVIEW_UNCERTAIN_SCORE", 3), // score <= this => uncertain
    missionRelevanceThreshold: num("REVIEW_MISSION_RELEVANCE", 0.6),
    uncertaintyThreshold: num("REVIEW_UNCERTAINTY", 0.5),
    salt: env("REVIEW_SALT", "sma/review@1"),
  },

  // ---- Review cycles (every N consumed articles; a checkpoint, not a cap) ----
  reviewInterval: num("REVIEW_INTERVAL", 1000),

  // ---- Synthetic feedback ----
  syntheticFeedback: bool("SYNTHETIC_FEEDBACK", false),
  syntheticMinScore: num("SYNTHETIC_MIN_SCORE", 8), // high-confidence branch
  maxSyntheticShare: num("MAX_SYNTHETIC_SHARE", 0.20), // 0..1 of a dataset/run

  // ---- Curriculum ----
  allowedCategories: env("ALLOWED_CATEGORIES", "reasoning,coding,general,science,history,howto,fiction,factcheck").split(","),
  curriculumMaxSyntheticShare: num("CURRICULUM_MAX_SYNTHETIC_SHARE", 0.20),

  // ---- Python compute plane (the student worker and loss evaluation) ----
  pythonBin: env("SMA_PYTHON", null), // null => resolvePythonBin() picks the venv / PATH
  pythonStore: env("SMA_STORE", null), // null => ~/.sma/store
  studentDevice: env("SMA_DEVICE", "auto"), // auto | cpu | cuda

  // ---- Evaluation ----
  evalDatasetId: env("EVAL_DATASET_ID", "eval-001"),
  promoteMinDelta: num("PROMOTE_MIN_DELTA", 0), // legacy token-F1 delta (supplementary only)
  promoteMinScore: num("PROMOTE_MIN_SCORE", 0), // legacy token-F1 floor (supplementary only)

  // ---- Loss-based promotion gate (authoritative for the real brain) ----
  // improvement = parentLoss - candidateLoss; promote iff improvement >= delta
  // and candidateLoss <= maxLoss and both losses are finite.
  promoteMinLossDelta: num("PROMOTE_MIN_LOSS_DELTA", 0),
  promoteMaxLoss: num("PROMOTE_MAX_LOSS", Number.POSITIVE_INFINITY),
  promoteRequireFinite: bool("PROMOTE_REQUIRE_FINITE", true),
  promoteEvalSeqLen: num("PROMOTE_EVAL_SEQ_LEN", 32),
  promoteEvalMicroBatch: num("PROMOTE_EVAL_MICRO_BATCH", 2),
  promoteEvalSet: env("PROMOTE_EVAL_SET", null), // frozen eval-set .jsonl path (required to compare)

  // ---- Trends & Metrics (Observatory) — deterministic, threshold-based ----
  // Classification is a pure function of finite validation observations; the
  // thresholds below are recorded with every verdict so the answer is
  // reproducible, never a model's guess.
  trend: {
    minPoints: num("TREND_MIN_POINTS", 3), // < this many finite points => insufficient_evidence
    // Relative validation-loss drop first->last to call a run "improving".
    improveDrop: num("TREND_IMPROVE_DROP", 0.01),
    // Relative rise first->last to call a run "worsening" (wins over plateau).
    worsenRise: num("TREND_WORSEN_RISE", 0.05),
    // Recent-window validation rise from the best-so-far, while training loss
    // is still improving, to flag "potentially overfitting".
    overfitValRise: num("TREND_OVERFIT_VAL_RISE", 0.02),
  },

  // ---- Training run ----
  batchSize: num("BATCH_SIZE", 64),
  snapshotLimit: num("SNAPSHOT_LIMIT", 256),
  workers: num("WORKERS", 2),
  runLockStaleMs: num("RUN_LOCK_STALE_MS", 10 * 60 * 1000),

  // ---- Python trainer hyperparameters (passed to `sma.brain train`) ----
  // `--lr` has no default in Python on purpose; sourcing it from config keeps
  // the value explicit and auditable in the Node provenance spine.
  trainLearningRate: num("TRAIN_LR", 1e-4),
  trainSteps: num("TRAIN_STEPS", 60),
  trainSeqLen: num("TRAIN_SEQ_LEN", 128),
  trainMicroBatch: num("TRAIN_MICRO_BATCH", 2),
  trainGradAccum: num("TRAIN_GRAD_ACCUM", 2),
  trainWarmup: num("TRAIN_WARMUP", 10),
  trainValBlocks: num("TRAIN_VAL_BLOCKS", 2),
  trainComputeDtype: env("TRAIN_COMPUTE_DTYPE", "bfloat16"), // bfloat16 | float32
  // Periodic held-out validation loss during training (record validation loss
  // every N steps so a validation *curve* exists for the Observatory). 0 keeps
  // the legacy two-point behaviour and Trends & Metrics reports "insufficient
  // evidence" for such runs rather than guessing.
  trainEvalEvery: num("TRAIN_EVAL_EVERY", 10),
  trainTimeoutMs: num("TRAIN_TIMEOUT_MS", 60 * 60 * 1000),
  initConfig: env("INIT_CONFIG", "small"), // sma.brain init --config

  // ---- Harvest / crawl (configured-source fetching ONLY; no web discovery) ----
  // CRAWL_MODE=real fetches ONLY the URLs in CRAWL_URLS (bounded, robots-aware).
  // There is NO search-engine/discovery mode — the system never invents sources.
  crawlMode: env("CRAWL_MODE", "fixture"), // fixture | real
  crawlUrls: env("CRAWL_URLS", "").split(",").map((s) => s.trim()).filter(Boolean),
  crawlAllowPrivate: bool("CRAWL_ALLOW_PRIVATE", false), // SSRF guard off-switch (tests use loopback)
  crawlTimeoutMs: num("CRAWL_TIMEOUT_MS", 15000),
  crawlMaxBytes: num("CRAWL_MAX_BYTES", 2_000_000),
  crawlMaxRedirects: num("CRAWL_MAX_REDIRECTS", 5),
  crawlRespectRobots: bool("CRAWL_RESPECT_ROBOTS", true),
  crawlUserAgent: env("CRAWL_USER_AGENT", "SimpleMindsAI/0.2 (+https://github.com/davejones74/SimpleMindsAI)"),
};
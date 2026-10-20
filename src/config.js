/**
 * Central config: everything tunable as env with a sane default.
 * Versions here are the *provenance spine* — a TrainingRun records exactly which
 * critic, rubric, curriculum and trainer produced it. Bump these when you change
 * any of those implementations, and historical runs stay explainable.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BLUEPRINT_PATH = path.join(REPO_ROOT, "data", "visualisation", "brain-blueprint.json");

const env = (name, dflt) => {
  const v = process.env[name];
  return v === undefined || v === "" ? dflt : v;
};
const num = (name, dflt) => Number(env(name, dflt));
const bool = (name, dflt) => /^(1|true|yes)$/i.test(env(name, String(dflt)));

/**
 * Parse a JSON-object env var (e.g. {"format":"json"}). Malformed JSON yields
 * `dflt` rather than crashing startup, but a value that parses to a non-object
 * throws so a mistyped env is caught loudly.
 */
function jsonEnv(name, dflt = {}) {
  const raw = env(name, "");
  if (!raw) return dflt;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return dflt;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * Validate a 0..1 confidence value. Throws on out-of-range or non-finite input
 * so a malformed env var can never silently disable or over-enable a filter.
 */
function confidence(name, dflt) {
  const raw = env(name, dflt);
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    throw new Error(`${name} must be a number between 0 and 1, got ${JSON.stringify(raw)}`);
  }
  return v;
}

/** Validate a string enum. Throws on a value outside the allowed set. */
function oneOf(name, dflt, allowed) {
  const v = env(name, dflt);
  if (!allowed.includes(v)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}, got ${JSON.stringify(v)}`);
  }
  return v;
}

/**
 * Load a local `.env` file so the documented, gitignored configuration actually
 * applies without a shell export. Real environment variables always WIN: a line
 * is only applied when the variable is not already set, so `OLLAMA_MODEL=... npm
 * start` still overrides the file. Path defaults to `./.env`, overridable with
 * `SMA_ENV_FILE`. Skipped under the Node test runner (and when `SMA_SKIP_ENV_FILE`
 * is set) so the suite sees the same deterministic defaults as a bare checkout.
 */
function loadDotEnv() {
  if (process.env.SMA_SKIP_ENV_FILE || process.env.NODE_TEST_CONTEXT) return;
  const file = process.env.SMA_ENV_FILE ?? path.join(process.cwd(), ".env");
  if (!existsSync(file)) return;
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return; // an unreadable .env must never take the server down
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue; // real environment wins
    let val = m[2];
    // Inline comments: a `#` that starts the value, or is preceded by
    // whitespace, starts a comment — so `SMA_DEVICE=auto   # auto | cpu | cuda`
    // loads `auto` and `CRAWL_URLS=   # ...` loads `` (empty). The leading-match
    // case matters because the regex above has already consumed the whitespace
    // after `=`, so the `#` arrives at position 0 with nothing preceding it.
    // A `#` glued to a non-empty value (`PASSWORD=abc#def`) is data, and a
    // quoted value keeps everything up to its closing quote.
    const comment = /(^|\s)#/.exec(val);
    if (comment && val[0] !== '"' && val[0] !== "'") val = val.slice(0, comment.index);
    val = val.trim();
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}
loadDotEnv();

/**
 * Allow-listed extra workspaces for the Observatory. The `development` store is
 * always implicit (the live, writable store the server booted with). Entries
 * here let an operator inspect another store — e.g. a completed trial — through
 * the SAME domain/storage services, WITHOUT changing which store the server
 * writes to. Provided as JSON via `SMA_WORKSPACES`, or a path via
 * `SMA_WORKSPACES_FILE`. If neither is set, a local `./workspaces.json` in the
 * working directory is picked up automatically (so `npm start` needs no env var).
 *
 * Each entry: `{ id, label?, kind?, pythonStore, articles, registry,
 * governance?, snapshots?, models?, evaluation?, raw? }`. Anything that is not
 * `kind: "development"` is inspection-only (read-only) by construction, so a
 * trial workspace can never receive a mutation.
 */
function parseWorkspaces() {
  // Precedence: SMA_WORKSPACES (inline JSON) > SMA_WORKSPACES_FILE (path) > an
  // auto-discovered ./workspaces.json in the cwd. The last one means a plain
  // `npm start` picks up a local allow-list with no env var; no file => none.
  const raw = env("SMA_WORKSPACES", null);
  const localFile = path.join(process.cwd(), "workspaces.json");
  const file = env("SMA_WORKSPACES_FILE", null) ?? (existsSync(localFile) ? localFile : null);
  let parsed = [];
  try {
    if (raw) parsed = JSON.parse(raw);
    else if (file) parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`invalid workspace configuration: ${err.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("SMA_WORKSPACES must be a JSON array of workspace objects");
  return parsed.map((w) => {
    if (!w || typeof w !== "object" || !w.id) throw new Error("each workspace requires an id");
    const kind = w.kind === "development" ? "development" : "inspection";
    const registry = w.registry ?? w.registryDir ?? null;
    return {
      id: String(w.id),
      label: String(w.label ?? w.id),
      kind,
      readOnly: kind !== "development",
      paths: {
        pythonStore: w.pythonStore ?? w.store ?? null,
        articles: w.articles ?? w.articleDir ?? null,
        registry,
        governance: w.governance ?? w.governanceDir ?? registry,
        snapshots: w.snapshots ?? w.snapshotDir ?? null,
        models: w.models ?? w.modelDir ?? null,
        evaluation: w.evaluation ?? w.evaluationDir ?? null,
        raw: w.raw ?? w.rawDir ?? null,
      },
    };
  });
}

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
    chat: env("CHAT_DIR", "data/chat"), // durable conversation log (NDJSON)
    frontier: env("FRONTIER_DIR", "data/frontier"), // persistent URL frontier (discovery state)
    blueprint: env("SMA_BLUEPRINT", null)
      ? path.resolve(REPO_ROOT, env("SMA_BLUEPRINT", null))
      : BLUEPRINT_PATH,
  },

  // ---- Server bind (admin portal is mounted on the existing server) ----
  host: env("API_HOST", "127.0.0.1"),
  port: num("API_PORT", 4000),

  // Access token for the data plane (CompanionAI-style). Unset/blank disables
  // auth entirely (dev + tests); set it in production to gate /graphql, /admin
  // and the REST surface behind a login page / Bearer header.
  authToken: env("SIMPLEMINDS_AUTH_TOKEN", null),

  graphqlUrl: env("GRAPHQL_URL", "http://localhost:4000/graphql"),
  ollamaEndpoint: env("OLLAMA_ENDPOINT", "http://localhost:11434"),
  ollamaFixture: bool("OLLAMA_FIXTURE", false),
  // Teacher model identifier — used by OllamaClient for ALL chat/completions
  // (curator, critic, planner). Set via OLLAMA_MODEL env var.
  // NOTE: on consumer rigs `:latest` is a 4-7GB distill, not the 671B MoE.
  ollamaModel: env("OLLAMA_MODEL", "deepseek-r1:latest"),

  // Critic model identifier — when set, overrides the teacher model
  // used specifically for critic scoring in ReviewScorer. When not set,
  // falls back to OLLAMA_MODEL for complete backward compatibility.
  // Set via CRITIC_MODEL env var; records its value in review provenance.
  criticModel: env("CRITIC_MODEL", null),

  // Critic prompt version — a provenance stamp for the CRITIC_PROMPT text in
  // `src/reward/reward-scorer.js`. The critic's temperature, model and rubric
  // version are recorded with every review; the prompt itself has no content
  // hash, so this operator-managed string is the durable link between a review
  // and the wording that produced it. Bump it when the prompt changes.
  criticPromptVersion: env("CRITIC_PROMPT_VERSION", "critic-prompt-v1"),

  // When critModel is explicitly null, the effective model used by the
  // critic is OLLAMA_MODEL. When set, it overrides the model for critic
  // scoring only; the teacher (curator/planner) still uses OLLAMA_MODEL.
  // This separation enables operators to use different models for review
  // versus curation without changing the primary model configuration.
  //
  // DEPRECATED: Previously `criticModel` defaulted to `"deepseek-r1:latest"`
  // and was never actually read to override the Ollama client model.
  // It now correctly controls the ReviewScorer's model selection.
  ollamaModelDigest: env("OLLAMA_MODEL_DIGEST", null),
  ollamaReadinessTimeoutMs: num("OLLAMA_READINESS_TIMEOUT_MS", 5000),

  // ---- Provenance versions (bump on behaviour change) ----
  trainerKind: env("TRAINER_KIND", "python"), // python (default) | stub (explicit)
  rubricVersion: env("RUBRIC_VERSION", "rubric-v1"),
  criticVersion: env("CRITIC_VERSION", "critic-v1"),
  curriculumVersion: env("CURRICULUM_VERSION", "curriculum-v1"),
  trainerVersion: env("TRAINER_VERSION", "stub-v1"),
  evaluatorVersion: env("EVALUATOR_VERSION", "eval-v1"),
  pythonTrainerVersion: env("PYTHON_TRAINER_VERSION", "python-v1"),

  // ---- Reward (teacher review signal; NEVER part of the training loss) ----
  minReward: num("MIN_REWARD", 6), // below this, teacher approval is not sufficient
  criticTemperature: num("CRITIC_TEMPERATURE", 0.1),
  // Hard cap on tokens the critic may generate. deepseek-r1 counts hidden
  // chain-of-thought against num_predict, so an UNCAPPED critic can loop until
  // the server returns "token repeat limit reached" and the review is lost.
  // This reaches the actual Ollama request (num_predict). 0 disables the cap.
  criticMaxTokens: num("CRITIC_MAX_TOKENS", 512),
  // Bounded retry for a TRANSIENT critic failure (timeout/network/5xx). Bounded
  // timeout is the OllamaClient's own request timeout; this is the attempt count.
  criticMaxAttempts: num("CRITIC_MAX_ATTEMPTS", 2),
  // Repeat penalty applied on the retry that follows a degenerate/repetitive
  // critic response (1.0 = off).
  criticRepeatPenalty: num("CRITIC_REPEAT_PENALTY", 1.3),

  // ---- Review policy (autonomous selection + teacher/human transitions) ----
  review: {
    sampleRate: num("REVIEW_SAMPLE_RATE", 0.1), // deterministic sample of reviewed-in articles
    minScore: num("REVIEW_MIN_SCORE", 6), // teacher approve needs score >= this
    rejectScore: num("REVIEW_REJECT_SCORE", 0), // critic score <= this => terminal reject
    missionRelevanceThreshold: num("REVIEW_MISSION_RELEVANCE", 0.6),
    uncertaintyThreshold: num("REVIEW_UNCERTAINTY", 0.5),
    salt: env("REVIEW_SALT", "sma/review@1"),
    // Bounded autonomous re-review. An INCONCLUSIVE teacher verdict (uncertain,
    // or an approve below the score gate) leaves the article PENDING_REVIEW; it
    // is retried only after `cooldownMs`, and after `maxAttempts` inconclusive
    // attempts it is deliberately RETIRED (an auditable terminal transition).
    // Technical critic failures have their own allowance and never count here.
    cooldownMs: num("REVIEW_COOLDOWN_MS", 21_600_000), // 6h between attempts
    maxAttempts: num("REVIEW_MAX_ATTEMPTS", 3), // inconclusive attempts before retire
    maxTechnicalAttempts: num("REVIEW_MAX_TECHNICAL_ATTEMPTS", 5), // transient critic failures
    // A shared REVIEW.lock serialises teacher review across processes (the
    // perpetual CLI, a learning job, and an explicit drain) so two workers
    // cannot review the same backlog simultaneously.
    lockStaleMs: num("REVIEW_LOCK_STALE_MS", 10 * 60 * 1000),
    // Deterministic review-time gates, run BEFORE the language-blind critic.
    //   gatesEnabled : master switch for both gates (default true).
    //   gateLanguage : reuse the language filter as a review-time DECISION.
    //   gateQuality  : reject encoding corruption / degenerate repetition.
    // Mission relevance is deliberately NOT a gate — it is advisory only and
    // must never reject an otherwise valid article (see domain/review-gates.js).
    gatesEnabled: bool("REVIEW_GATES_ENABLED", true),
    gateLanguage: bool("REVIEW_GATE_LANGUAGE", true),
    gateQuality: bool("REVIEW_GATE_QUALITY", true),
    // Fraction of characters that may be encoding-corruption indicators before
    // the text is judged mojibake, and the minimum unique-bigram ratio for text
    // to be considered non-degenerate. Heuristic starting values, not guarantees.
    qualityMaxMojibakeRatio: num("REVIEW_QUALITY_MAX_MOJIBAKE_RATIO", 0.02),
    qualityMinBigramRatio: num("REVIEW_QUALITY_MIN_BIGRAM_RATIO", 0.15),
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
  // Pin the student worker's CPU thread count (OMP/MKL/OpenBLAS/VecLib/NumExpr).
  // 0 (default) => PyTorch's own default (24 intra-op + 24 inter-op on a 24-thread
  // box, which oversubscribes). Set to the physical core count to reduce thread
  // thrash during train/eval.
  studentThreads: num("SMA_THREADS", 0),

  // ---- Evaluation ----
  // The bundled default baseline is `eval-002` (a broad, domain-stratified
  // English Wikipedia corpus committed under data/evaluation/). `eval-001` is
  // the legacy 5-row seed: it is retained for backward compatibility but loss
  // measured on it is dominated by sampling noise (~3 blocks) and must not gate
  // promotion.
  evalDatasetId: env("EVAL_DATASET_ID", "eval-002"),
  // Advisory floors on a frozen evaluation set. A set smaller than the operator
  // expects is recorded and surfaced as a `warnings` entry on the run record and
  // in the Observatory, but promotion is never blocked — the causal-LM loss gate
  // remains the only promotion gate. `documents` counts rows; `tokens` uses a
  // ~4-chars/token estimate (the authoritative count is the trainer's
  // `tokensSeen`). 0 disables a floor.
  evalMinDocuments: num("EVAL_MIN_DOCUMENTS", 0),
  evalMinTokens: num("EVAL_MIN_TOKENS", 0),
  // Assumed per-token cross-entropy standard deviation, used ONLY to print an
  // ESTIMATED standard error of the mean loss (sigma / sqrt(tokensSeen)) and a
  // 95% noise band next to each loss. It never affects the promotion decision;
  // it exists so an operator can see when a loss difference is inside the noise.
  evalLossTokenStd: num("EVAL_LOSS_TOKEN_STD", 3.0),
  promoteMinDelta: num("PROMOTE_MIN_DELTA", 0), // legacy token-F1 delta (supplementary only)
  promoteMinScore: num("PROMOTE_MIN_SCORE", 0), // legacy token-F1 floor (supplementary only)

  // ---- Loss-based promotion gate (authoritative for the real brain) ----
  // improvement = parentLoss - candidateLoss; promote iff improvement >= delta
  // and candidateLoss <= maxLoss and both losses are finite.
  promoteMinLossDelta: num("PROMOTE_MIN_LOSS_DELTA", 0),
  promoteMaxLoss: num("PROMOTE_MAX_LOSS", Number.POSITIVE_INFINITY),
  promoteRequireFinite: bool("PROMOTE_REQUIRE_FINITE", true),
  // Evaluation sequence length, pinned to the training context so the eval
  // measures the same per-token objective the model is optimised on. Changing
  // this changes the metric signature and therefore starts a new, incomparable
  // promotion ladder (the gate refuses cross-signature comparisons).
  promoteEvalSeqLen: num("PROMOTE_EVAL_SEQ_LEN", 128),
  promoteEvalMicroBatch: num("PROMOTE_EVAL_MICRO_BATCH", 2),
  promoteEvalSet: env("PROMOTE_EVAL_SET", null), // frozen eval-set .jsonl path (required to compare)
  // Fitness floor for the promotion gate. A loss measured on a set too small to
  // form more than a block or two is dominated by sampling noise, so a
  // "promotion" on it is a coin flip, not evidence. When a measured evaluation
  // reports its size (blockCount/tokensSeen), the gate REQUIRES at least this
  // many blocks (and tokens, if configured) and otherwise refuses to compare
  // (not_evaluated) rather than promote or reject on noise. The bundled
  // `eval-002` (~459 blocks) passes; the legacy 5-row `eval-001` (1 block) is
  // refused. Records with no size metadata (legacy/unit) are unaffected.
  promoteEvalMinBlocks: num("PROMOTE_EVAL_MIN_BLOCKS", 8),
  promoteEvalMinTokens: num("PROMOTE_EVAL_MIN_TOKENS", 0), // 0 disables the token floor
  // Hard deadline for ONE version loss evaluation (parent OR candidate). Unlike
  // training (TRAIN_TIMEOUT_MS), this was previously fixed at 600s and could be
  // exceeded on slow hardware (e.g. fp32 eval + --verify-weights on an iGPU),
  // failing the gate closed (not_evaluated). Configurable so an operator can
  // match it to the box's throughput.
  promoteEvalTimeoutMs: num("PROMOTE_EVAL_TIMEOUT_MS", 600_000),

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
  // Snapshot corpus policy. false (default, proven): a snapshot contains only
  // REVIEWED-and-unconsumed articles, i.e. the DELTA produced since the last
  // run. true: the snapshot also backfills already-consumed REVIEWED articles
  // up to `snapshotLimit`, so the trainer keeps seeing the accumulated corpus
  // instead of a tiny handful of new rows. Consumption stays pure bookkeeping
  // (see `freshArticleIds` in the manifest); the leak guard and hash-sealing
  // are unchanged.
  snapshotIncludeConsumed: bool("SNAPSHOT_INCLUDE_CONSUMED", false),
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

  // ---- Harvest / crawl ----
  // CRAWL_MODE=real fetches the persistent frontier (bounded, robots-aware),
  // seeded from CRAWL_URLS and expanded by the discovery adapters below.
  // CRAWL_URLS is now OPTIONAL bootstrap input, not a required boundary: when it
  // is empty the frontier is NOT cleared — discovery bootstraps from eligible
  // registered domains and the configured adapters (sitemap / feed / search).
  crawlMode: env("CRAWL_MODE", "fixture"), // fixture | real
  crawlUrls: env("CRAWL_URLS", "").split(",").map((s) => s.trim()).filter(Boolean),
  crawlAllowPrivate: bool("CRAWL_ALLOW_PRIVATE", false), // SSRF guard off-switch (tests use loopback)
  crawlTimeoutMs: num("CRAWL_TIMEOUT_MS", 15000),
  crawlMaxBytes: num("CRAWL_MAX_BYTES", 2_000_000),
  crawlMaxRedirects: num("CRAWL_MAX_REDIRECTS", 5),
  crawlRespectRobots: bool("CRAWL_RESPECT_ROBOTS", true),
  crawlUserAgent: env("CRAWL_USER_AGENT", "SimpleMindsAI/0.2 (+https://github.com/davejones74/SimpleMindsAI)"),
  // HTML extraction strategy for fetched pages.
  //   legacy      : the original dependency-free tag-stripper (default; no new deps)
  //   readability : @mozilla/readability over jsdom (Apache-2.0 / MIT), which
  //                 isolates the main article and drops nav/footer boilerplate.
  // Reversible: readability falls back to legacy on any load/parse failure, and
  // unset reverts to legacy exactly.
  extractionMode: oneOf("EXTRACTION_MODE", "legacy", ["legacy", "readability"]),

  // ---- Phase 3: bounded crawling discovery ----
  // Domain allow-list: comma-separated; empty defaults to CRAWL_URLS hosts only.
  // Expanding requires explicit operator configuration via env var.
  crawlAllowedDomains: env("CRAWL_ALLOWED_DOMAINS", "").split(",").map((s) => s.trim()).filter(Boolean),
  // Max depth: seeds depth=0, each discovered link adds 1
  crawlMaxDepth: num("CRAWL_MAX_DEPTH", "2"),
  // Pages per acquisition cycle (bounded run, not cumulative budget)
  crawlPagesPerCycle: num("CRAWL_PAGES_PER_CYCLE", "50"),
  // Total page budget across all cycles; 0 = unlimited cumulative
  crawlTotalBudget: num("CRAWL_TOTAL_BUDGET", "0"),
  // Per-host concurrency: max simultaneous in-flight fetches per host
  crawlHostConcurrency: num("CRAWL_HOST_CONCURRENCY", "2"),
  // Min time between refetches same host (ms); works with concurrency so concurrency=2
  // cannot unintentionally bypass cooldown
  crawlCooldownMs: num("CRAWL_COOLDOWN_MS", "30000"),
  // Retry limit per URL before deferral
  crawlRetryLimit: num("CRAWL_RETRY_LIMIT", "2"),

  // ---- Rediscovery & retry scheduling (resilient acquisition) ----
  // Re-crawl VISITED URLs once their rediscovery TTL elapses so a drained
  // frontier does not permanently stop acquisition. Enabled by default (7 days);
  // set REDISCOVERY_ENABLED=false to disable. Conditional HTTP (ETag /
  // Last-Modified) is sent on every fetch so an unchanged page returns 304 and
  // never produces a duplicate article.
  rediscoveryEnabled: bool("REDISCOVERY_ENABLED", true),
  rediscoveryTtlMs: num("REDISCOVERY_TTL_MS", 7 * 24 * 60 * 60 * 1000),
  // Independent exponential backoff for failed URLs (base * 2^(retries-1),
  // capped). A failed URL is retried on its own schedule and never blocks the
  // queued new work.
  frontierRetryBackoffBaseMs: num("FRONTIER_RETRY_BACKOFF_BASE_MS", 60 * 1000),
  frontierRetryBackoffMaxMs: num("FRONTIER_RETRY_BACKOFF_MAX_MS", 60 * 60 * 1000),

  // ---- Discovery policy (bounded, configurable link-following) ----
  // CRAWL_URLS are BOOTSTRAP seeds, not a permanent boundary: the app may follow
  // useful references and explore adjacent sources. Expansion is explicit and
  // policy-checked — it is never indiscriminate.
  //   seeds-only : only hosts of CRAWL_URLS may be fetched (most conservative)
  //   allowlist  : seed hosts + CRAWL_ALLOWED_DOMAINS may be fetched
  //   open       : any host except CRAWL_DENIED_DOMAINS may be fetched
  // Safety checks (scheme, private-address SSRF guard, robots, byte/redirect
  // limits, budgets, cooldown, per-host concurrency) apply in every mode.
  crawlDiscoveryPolicy: env("CRAWL_DISCOVERY_POLICY", "seeds-only"),
  // Discovery-time language prior (P4). A candidate URL whose HOST declares a
  // non-English language (e.g. ca.wikipedia.org) is classified up front.
  //   off    : never consider the declared language at discovery
  //   warn   : DEFAULT — enqueue but count (visible in discovery reports)
  //   reject : refuse to enqueue foreign-language-host candidates
  // Advisory/optional: the ingest-time language filter (above) still inspects the
  // actual document text and remains the authoritative, independent backstop.
  discoveryLanguagePrior: oneOf("DISCOVERY_LANGUAGE_PRIOR", "warn", ["off", "warn", "reject"]),
  // Always-prohibited destinations (comma-separated suffixes), any mode.
  crawlDeniedDomains: env("CRAWL_DENIED_DOMAINS", "").split(",").map((s) => s.trim()).filter(Boolean),
  // Cap links enqueued from a single fetched page (prevents link-farm blowups).
  crawlMaxLinksPerPage: num("CRAWL_MAX_LINKS_PER_PAGE", "50"),

  // ---- Genuine autonomous document discovery (source-backed adapters) ----
  // Adapters propose candidate URLs into the SAME persistent frontier; the
  // DiscoveryService is the only writer and applies the discovery policy and
  // the domain registry (blocked domains, etc.) to every candidate. Adapters
  // never bypass a fetch-time safety check.
  //   sitemap : robots.txt Sitemap: directives + /sitemap.xml, bounded indexes
  //   feed    : RSS/Atom feeds advertised by roots (or listed explicitly)
  //   search  : an INDEPENDENT provider — reports `unavailable` unless configured
  crawlDiscoveryAdapters: env("CRAWL_DISCOVERY_ADAPTERS", "sitemap,feed").split(",").map((s) => s.trim()).filter(Boolean),
  // Optional extra bootstrap seed URLs used only when CRAWL_URLS is empty. These
  // are a convenience, never mandatory — discovery works from the registry or an
  // independent adapter without them.
  crawlDiscoverySeeds: env("CRAWL_DISCOVERY_SEEDS", "").split(",").map((s) => s.trim()).filter(Boolean),
  // Built-in bootstrap FALLBACK: the seed set used ONLY when nothing else yields a
  // root (no CRAWL_URLS, no CRAWL_DISCOVERY_SEEDS and an empty domain registry). A
  // brand-new install therefore makes its first crawl with zero configuration
  // instead of reporting `no-source-configured`. Stable, English, robots-friendly
  // encyclopedic pages that give the sitemap/feed adapters something to expand
  // from. Set CRAWL_DISCOVERY_DEFAULT_SEEDS= (empty) to disable the fallback and
  // return to strict operator-provided sourcing.
  crawlDiscoveryDefaultSeeds: env(
    "CRAWL_DISCOVERY_DEFAULT_SEEDS",
    "https://en.wikipedia.org/wiki/Steam_engine,https://en.wikipedia.org/wiki/James_Watt,https://en.wikipedia.org/wiki/Recursion,https://en.wikipedia.org/wiki/Photosynthesis",
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Extra feed URLs to poll directly, in addition to feeds auto-detected on roots.
  crawlDiscoveryFeeds: env("CRAWL_DISCOVERY_FEEDS", "").split(",").map((s) => s.trim()).filter(Boolean),
  // Bounds so a discovery pass stays cheap and testable.
  crawlDiscoveryMaxRoots: num("CRAWL_DISCOVERY_MAX_ROOTS", 25),
  crawlDiscoveryMaxCandidates: num("CRAWL_DISCOVERY_MAX_CANDIDATES", 500),
  crawlDiscoveryMaxSitemaps: num("CRAWL_DISCOVERY_MAX_SITEMAPS", 50),
  crawlDiscoverySitemapMaxDepth: num("CRAWL_DISCOVERY_SITEMAP_MAX_DEPTH", 3),
  // Optional independent search provider. Unset => the search adapter reports
  // `unavailable` and produces nothing; it never pretends to be operational and
  // never silently requires paid credentials.
  crawlSearchProvider: env("CRAWL_SEARCH_PROVIDER", null),
  crawlSearchEndpoint: env("CRAWL_SEARCH_ENDPOINT", null),
  // Optional fallback search endpoints (comma-separated), tried in order after the
  // primary when a query fails — multi-provider resilience. A single SearXNG
  // instance can be listed here too (e.g. a local + a remote mirror).
  crawlSearchFallbackEndpoints: env("CRAWL_SEARCH_FALLBACK_ENDPOINTS", "").split(",").map((s) => s.trim()).filter(Boolean),
  // Bounded retry per request before failing over to the next endpoint.
  crawlSearchMaxRetries: num("CRAWL_SEARCH_MAX_RETRIES", 1),
  crawlSearchRetryDelayMs: num("CRAWL_SEARCH_RETRY_DELAY_MS", 500),
  crawlSearchQueryParam: env("CRAWL_SEARCH_QUERY_PARAM", "q"),
  crawlSearchQueries: env("CRAWL_SEARCH_QUERIES", "").split(",").map((s) => s.trim()).filter(Boolean),
  // Extra query params merged into every search request, as a JSON object.
  // For SearXNG: {"format":"json","safesearch":"1","language":"en"} — `format=json`
  // is required for the JSON API, and `language=en` biases results to English.
  crawlSearchExtraParams: jsonEnv("CRAWL_SEARCH_EXTRA_PARAMS", {}),

  // ---- Mission-driven acquisition (P4) ----
  // Deterministic templates first: when enabled, the active mission statement(s)
  // are turned into bounded search queries by src/discovery/mission-queries.js
  // (no LLM) and appended to any configured CRAWL_SEARCH_QUERIES. Derived queries
  // are only candidates — they pass the discovery policy and the domain registry
  // exactly like every other adapter candidate, and the search adapter still
  // reports `unavailable` without a configured provider. OFF by default.
  missionQueriesEnabled: bool("MISSION_QUERIES_ENABLED", false),
  missionQueryMax: num("MISSION_QUERY_MAX", 8),
  // Advisory mission relevance (P4): compute a lexical overlap score between an
  // ingested article and the active mission(s) and persist it as an advisory
  // field. NEVER a rejection rule — a low score only deprives the article of a
  // positive review-selection hint. OFF by default.
  missionRelevanceEnabled: bool("MISSION_RELEVANCE_ENABLED", false),
  // Corpus keyphrase queries (P4 keyphrase generator): mine the REVIEWED corpus
  // for recurring multi-word phrases (src/discovery/keyphrases.js) and append
  // them as additional search queries. Advisory only — same policy/registry path
  // as every other adapter candidate. OFF by default.
  corpusQueriesEnabled: bool("CORPUS_QUERIES_ENABLED", false),
  corpusQueryMax: num("CORPUS_QUERY_MAX", 20),
  corpusQueryMinFreq: num("CORPUS_QUERY_MIN_FREQ", 2),

  // ---- Language filter (deterministic, ON by default) ----
  // A document-level English-language gate. This is NOT a domain blacklist and
  // NOT an English-only domain allowlist: an English article on any domain is
  // accepted, and a foreign-language article is excluded regardless of domain.
  // The detector is deterministic and dependency-free (src/domain/language.js).
  //
  //   enabled       : master switch. Default true. Set LANGUAGE_FILTER_ENABLED=0
  //                   to disable entirely (detector never runs).
  //   shadow        : run the detector, report would-be exclusions in telemetry,
  //                   but do NOT change ingestion behaviour. Evaluation mode.
  //   minConfidence : heuristic starting value, NOT a calibrated accuracy
  //                   guarantee. See src/domain/language.js for the algorithm.
  //   unknownPolicy : what to do with text the detector cannot classify.
  //                   "allow" = pass through (conservative; default).
  //                   "reject" = exclude.
  // A source that declares a non-English language (`<html lang>` or a
  // multilingual host such as `ca.wikipedia.org`) is decisive unless the body
  // text is confidently English.
  languageFilter: {
    enabled: bool("LANGUAGE_FILTER_ENABLED", true),
    shadow: bool("LANGUAGE_FILTER_SHADOW", false),
    minConfidence: confidence("LANGUAGE_FILTER_MIN_CONFIDENCE", 0.8),
    unknownPolicy: oneOf("LANGUAGE_FILTER_UNKNOWN_POLICY", "allow", ["allow", "reject"]),
  },

  // ---- Observatory workspaces (allow-listed; `development` is implicit) ----
  // Extra, inspection-only stores the portal may display (e.g. a completed
  // trial). The live development store is always present and is the default.
  workspaces: parseWorkspaces(),

  // ---- Managed lifecycle jobs (learning / training / fresh-brain) ----
  // The JobSupervisor owns long-running work triggered from the Observatory.
  // Jobs are foreground-observable, cooperatively cancellable, and never
  // auto-resume after a restart (a stranded job is reported, not silently
  // continued). Defaults are deliberately modest so a UI click cannot launch an
  // unbounded GPU run by accident.
  jobs: {
    // How often a continuous job re-checks for eligible material / new work.
    pollIntervalMs: num("JOBS_POLL_INTERVAL_MS", 60_000),
    // Cooperative-cancel window before the child process tree is force-killed.
    stopGraceMs: num("JOB_STOP_GRACE_MS", 15_000),
    // Runtime safety bound for ANY managed job (ms; 0 = unbounded). A continuous
    // job that reaches it stops with outcome `max-runtime` instead of running
    // forever, so an operator can see the bound was the reason and restart.
    maxRuntimeMs: num("JOBS_MAX_RUNTIME_MS", 0),
    learning: {
      // Bounded learning stops once this many *trainable* articles exist, or
      // when the configured sources are exhausted (reported honestly either way).
      targetArticles: num("LEARNING_TARGET_ARTICLES", 100),
      // Safety cap on raw documents processed per bounded run (0 = no cap).
      maxRawDocs: num("LEARNING_MAX_RAW_DOCS", 0),
      // Continuous learning: after this many consecutive cycles that acquire
      // nothing new (ingested=deduped=0 and trainable unchanged), stop with
      // outcome `no-progress` instead of polling forever. 0 disables the guard.
      noProgressCycles: num("LEARNING_NO_PROGRESS_CYCLES", 5),
      // Acquisition waiting / backoff. When a continuous job has no claimable or
      // retryable frontier work and no immediately viable provider, it persists a
      // non-terminal WAITING state with `nextAttemptAt` (authoritative) and backs
      // off exponentially up to `waitBackoffMaxMs`, with jitter, instead of
      // declaring `sources-exhausted`. The persisted deadline is recovered on
      // restart; the in-memory timer is only an optimisation.
      waitBackoffBaseMs: num("LEARNING_WAIT_BACKOFF_BASE_MS", 60_000),
      waitBackoffMaxMs: num("LEARNING_WAIT_BACKOFF_MAX_MS", 3_600_000),
    },
    training: {
      // A one-shot run refuses to start below this many eligible articles
      // (reviewed + unconsumed); continuous runs wait for them instead.
      minEligible: num("TRAIN_MIN_ELIGIBLE", 1),
      // Continuous training is perpetual, so a rejection streak is a visible
      // signal, never a terminal stop: after this many consecutive runs that are
      // NOT promoted (rejected or not_evaluated), the supervisor logs the
      // `repeated-rejection` phase and resets the counter, then keeps waiting for
      // genuinely new material. Rejected runs consume their batch, so new cycles
      // never retrain the same corpus. 0 disables the surface/warn guard.
      maxConsecutiveRejections: num("TRAIN_MAX_CONSECUTIVE_REJECTIONS", 5),
      // Maximum number of deferral retries for a rejected batch before articles
      // are transitioned to the explicit `retired` state. Default 2: after two
      // unsuccessful attempts the batch is retired and excluded from future
      // selection, preserving fresh material for subsequent cycles.
      maxRejectedRetries: num("TRAIN_MAX_REJECTED_RETRIES", 2),
    },
  },
};
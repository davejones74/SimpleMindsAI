import express from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import { config } from "./config.js";
import { ArticleStore } from "./storage/article-store.js";
import { RegistryStore } from "./storage/registry-store.js";
import { GovernanceStore } from "./admin/governance-store.js";
import { attachAdmin } from "./admin/routes.js";
import { changeFeed } from "./admin/change-feed.js";
import { createChatService } from "./chat/chat-service.js";
import { ConversationStore } from "./chat/conversation-store.js";
import { JobSupervisor } from "./jobs/supervisor.js";
import { Frontier } from "./frontier.js";
import { DiscoveryService } from "./discovery/discovery-service.js";
import { AdmissionPolicyManager } from "./gateway/admission-policy.js";
import { AcquisitionGateway } from "./gateway/acquisition-gateway.js";
import { createDomainRegistry } from "./storage/domain-registry.js";
import { resolvers } from "./graphql/resolvers.js";
import { sha256, createAuthRouter, createAuthGate } from "./auth/simple-auth.js";

/**
 * Boot: GraphQL article ledger + durable registry + the admin portal, all on
 * ONE server (the portal is not a separate microservice). Bind is 127.0.0.1 by
 * default; set API_HOST=0.0.0.0 to expose it deliberately.
 *
 * The GraphQL surface is the ONLY way subsystems talk to the ledger — that keeps
 * the transient/durable boundary explicit. The admin REST/SSE surface is the
 * human observability layer over the same validated Node services.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const typeDefs = readFileSync(path.join(__dirname, "graphql", "schema.graphql"), "utf8");

const domainRegistry = createDomainRegistry({ dir: config.paths.frontier });
await domainRegistry.init();

const store = await ArticleStore.open(config.paths.articles, { domainRegistry });
const registry = await RegistryStore.open(config.paths.registry);
const governance = await GovernanceStore.open(config.paths.governance);
const conversations = await ConversationStore.open(path.join(config.paths.chat, "conversations.ndjson"));
const chat = createChatService({
  store,
  conversations,
  pythonStorePath: config.pythonStore ?? null,
});
await chat.start();

const server = new ApolloServer({ typeDefs, resolvers });
await server.start();

const app = express();
app.use(express.json({ limit: "25mb" }));

// CompanionAI-style token auth. Off unless SIMPLEMINDS_AUTH_TOKEN is set, so dev
// and tests are unaffected. The auth endpoints are mounted under /api/admin
// (which nginx already routes here) and BEFORE the gate so sign-in is reachable;
// the gate then protects everything else. Internal subsystems that call
// fetch(GRAPHQL_URL) send the same token via authHeaders().
if (config.authToken) {
  const expected = sha256(config.authToken);
  app.use("/api/admin", createAuthRouter(expected));
  app.use(createAuthGate(expected));
}

app.use("/graphql", expressMiddleware(server, { context: async () => ({ store, registry, governance, changeFeed }) }));

let admissionManager = null;
app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    articles: store.getStats().totalArticles,
    admission: admissionManager ? admissionManager.status() : null,
  }),
);
app.get("/api/stats", (_req, res) => res.json(store.getStats()));
app.post("/api/ingest", async (req, res) => {
  // curl -X POST localhost:4000/api/ingest -H "content-type: application/json" -d "{\"text\":\"...\",\"domain\":\"howto\"}"
  try {
    const r = await store.ingestArticle(req.body ?? {});
    changeFeed.emit("article.ingested", { articleId: r.articleId, deduped: r.deduped });
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Acquisition discovery: a persistent URL frontier seeded from CRAWL_URLS,
// expanded by policy-approved links. The learning job follows it instead of a
// static URL list, so cycles keep finding new material. Only wired in real mode;
// fixture mode keeps the deterministic built-in documents.
const frontier = new Frontier({ dir: config.paths.frontier });
  // Active mission statements (primary + secondary) feed deterministic query
  // derivation when MISSION_QUERIES_ENABLED. Read defensively: on a virgin store
  // the missions may not be seeded yet, in which case derived queries are simply
  // absent — never an error.
  const activeMissionTexts = ["primary", "secondary"]
    .map((kind) => {
      try {
        const versions = governance.list("missions").filter((m) => m.kind === kind);
        return versions.length ? versions[versions.length - 1].text : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  // Advisory mission relevance: feed the active mission(s) to the store so
  // ingested articles get a lexical relevance score when MISSION_RELEVANCE_ENABLED.
  store.setMissionContext({ missionTexts: activeMissionTexts });
  // Reviewed corpus → keyphrase queries (CORPUS_QUERIES_ENABLED). A bounded sweep
  // of REVIEWED articles; empty on a fresh store, so derivation just yields none.
  const reviewedCorpusTexts = [];
  {
    let after = null;
    for (let page = 0; page < 50; page++) {
      const p = store.articlesPage({ after, status: "REVIEWED", limit: 200 });
      for (const a of p.items) if (a.text) reviewedCorpusTexts.push(a.text);
      if (!p.nextCursor) break;
      after = p.nextCursor;
    }
  }
  let admissionStore = null;
  let admissionGateway = null;
  if (config.crawlMode === "real") {
    admissionManager = await AdmissionPolicyManager.open({
      dir: config.paths.admission,
      config: {
        capLimit: config.admissionCapLimit,
        capEpoch: config.admissionCapEpoch,
        ackRequired: config.admissionAckRequired,
        protocolVersion: config.admissionProtocolVersion,
      },
      logger: console,
    });
    admissionStore = admissionManager.store;
    admissionGateway = new AcquisitionGateway({ store: admissionStore, epochManager: admissionManager });
    console.log(
      `[admission] source=${admissionManager.source} policy=${admissionManager.policyId ?? "legacy"} epoch=${admissionManager.epoch ?? "none"} cap=${admissionManager.capLimit ?? "?"} capUsed=${admissionManager.capUsage()}`,
    );
  }
  const discovery =
    config.crawlMode === "real"
      ? new DiscoveryService({
          frontier,
          missionTexts: activeMissionTexts,
          corpusTexts: reviewedCorpusTexts,
          admissionGateway,
        })
      : null;

  const supervisor = new JobSupervisor({
    store,
    registry,
    governance,
    changeFeed,
    pythonStorePath: config.pythonStore ?? null,
    pythonBin: config.pythonBin ?? undefined,
    discovery,
    domainRegistry,
  });
  await supervisor.init({ reconcile: true });

attachAdmin({
  app,
  store,
  registry,
  governance,
  chat,
  conversations,
  workspaces: config.workspaces,
  pythonStorePath: config.pythonStore,
  supervisor,
  domainRegistry,
  frontier,
});

const httpServer = app.listen(config.port, config.host, () =>
  console.log(`GraphQL -> http://${config.host}:${config.port}/graphql   portal -> http://${config.host}:${config.port}/admin`),
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await supervisor.close().catch(() => {});
    admissionManager?.close?.();
    httpServer.close(() => process.exit(0));
  });
}

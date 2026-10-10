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
import { resolvers } from "./graphql/resolvers.js";

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

const store = await ArticleStore.open(config.paths.articles);
const registry = await RegistryStore.open(config.paths.registry);
const governance = await GovernanceStore.open(config.paths.governance);
const chat = createChatService({ store });
await chat.start();

const server = new ApolloServer({ typeDefs, resolvers });
await server.start();

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use("/graphql", expressMiddleware(server, { context: async () => ({ store, registry, governance, changeFeed }) }));

app.get("/health", (_req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()), articles: store.getStats().totalArticles }));
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

attachAdmin({ app, store, registry, governance, chat });

app.listen(config.port, config.host, () =>
  console.log(`GraphQL -> http://${config.host}:${config.port}/graphql   portal -> http://${config.host}:${config.port}/admin`),
);

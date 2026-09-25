import express from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import { BufferStore } from "./storage/buffer-store.js";
import { RegistryStore } from "./storage/registry-store.js";
import { resolvers } from "./graphql/resolvers.js";

/**
 * Boot: GraphQL buffer endpoint + durable registry + REST convenience hooks.
 *
 * The GraphQL surface is the ONLY way subsystems talk to the buffer — that
 * keeps the transient/conveyor-belt boundary explicit and makes "swap the
 * backend later" a one-file change (see BufferStore). The RegistryStore is the
 * append-only durable side (snapshots/models/runs/evaluations); write access is
 * read-through the same endpoint, but the lifecycle owns the state machine.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.API_PORT ?? 4000);
const typeDefs = readFileSync(path.join(__dirname, "graphql", "schema.graphql"), "utf8");

const store = await BufferStore.open();
const registry = await RegistryStore.open();

const server = new ApolloServer({ typeDefs, resolvers });
await server.start();

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use("/graphql", expressMiddleware(server, { context: async () => ({ store, registry }) }));

app.get("/health", (_req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()), buffer: store.getStats().totalPrompts }));
app.get("/api/stats", (_req, res) => res.json(store.getStats()));
app.post("/api/ingest", async (req, res) => {
  // REST shunt so curl-able ingestion of a single raw prompt is trivial:
  //   curl -X POST localhost:4000/api/ingest -H "content-type: application/json" -d "{\"text\":\"what is x?\",\"domain\":\"howto\"}"
  try {
    const r = await store.ingestPrompt(req.body);
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(port, () => console.log(`GraphQL buffer -> http://localhost:${port}/graphql`));
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArticleStore } from "../storage/article-store.js";
import { createChatService } from "./chat-service.js";

/**
 * Standalone chat server (Subsystem C) — lets a human talk to the current brain.
 *
 * The portal serves the same chat through the main server; this standalone entry
 * is retained for convenience. Both delegate to the shared chat service, so the
 * capture loop (high-scoring replies become synthetic articles) lives in exactly
 * one place.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.CHAT_PORT ?? 8787);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const store = await ArticleStore.open();
const chat = createChatService({ store });
await chat.start();

app.post("/api/chat", async (req, res) => {
  const message = String(req.body?.message ?? "").trim();
  if (!message) return res.status(400).json({ error: "message required" });
  try {
    res.json(await chat.respond(message));
  } catch (err) {
    res.status(chat.isUnavailable(err) ? 503 : 502).json({ error: err.message, mode: chat.brain.mode });
  }
});

app.get("/api/identity", (_req, res) => res.json(chat.identity()));

app.listen(port, () =>
  console.log(`chat UI -> http://localhost:${port}  (brain mode: ${chat.brain.mode}, version: ${chat.brain.version ?? "none"})`),
);

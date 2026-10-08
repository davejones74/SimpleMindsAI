import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BufferStore } from "../storage/buffer-store.js";
import { chatBrain } from "../brain/brain.js";
import { maybeCaptureSynthetic } from "./synthetic-feedback.js";

/**
 * Chat server (Subsystem C) — lets a human talk to the current brain.
 *
 * The UI asks the brain; if enabled, a reply that scores high enough under the
 * critic is captured back into the buffer as a SYNTHETIC training example
 * (origin: "synthetic", model recorded). That closed loop is the whole
 * experiment — the chat window is literally the human touchpoint in it. The
 * capture is fire-and-forget: a critic hiccup must never break the chat.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.CHAT_PORT ?? 8787);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const store = await BufferStore.open();

// Start the resident student worker and load the active committed brain. If no
// version is active yet, the worker has nothing to load and chat answers 503.
try {
  await chatBrain.start();
} catch (err) {
  console.error(`[brain] student worker unavailable at boot: ${err.message}`);
}

app.post("/api/chat", async (req, res) => {
  const message = String(req.body?.message ?? "").trim();
  if (!message) return res.status(400).json({ error: "message required" });
  try {
    const out = await chatBrain.respond(message);
    maybeCaptureSynthetic({
      promptText: message,
      replyText: out.reply,
      model: out.version ?? "student",
      store,
    })
      .then((r) => {
        if (r?.captured) console.log(`[synthetic] captured ${r.completionId} (score ${r.score.toFixed(1)})`);
      })
      .catch((err) => console.error(`[synthetic] capture failed: ${err.message}`));
    res.json({ ...out, message });
  } catch (err) {
    const unavailable = !chatBrain.worker.available || /unavailable/.test(err.message);
    res.status(unavailable ? 503 : 502).json({ error: err.message, mode: chatBrain.mode });
  }
});

app.get("/api/identity", (_req, res) => {
  res.json({
    mode: chatBrain.mode,
    version: chatBrain.version,
    artifactName: chatBrain.artifactName,
    available: chatBrain.worker.available,
  });
});

app.listen(port, () =>
  console.log(`chat UI -> http://localhost:${port}  (brain mode: ${chatBrain.mode}, version: ${chatBrain.version ?? "none"})`)
);
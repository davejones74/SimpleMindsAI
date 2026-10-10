import { chatBrain } from "../brain/brain.js";
import { maybeCaptureSynthetic } from "./synthetic-feedback.js";

/**
 * Chat domain service — the ONE implementation of "ask the brain".
 *
 * Both the standalone chat server (`npm run chat`, port 8787) and the admin
 * portal (mounted on the main server) call this, so there is a single chat
 * implementation and a single capture path. There is deliberately NO teacher
 * fallback: if no committed student version is active the worker is unavailable
 * and the caller surfaces that honestly.
 */
export function createChatService({ store, brain = chatBrain, logger = console } = {}) {
  return {
    brain,
    store,

    async start() {
      try {
        await brain.start();
      } catch (err) {
        logger.error?.(`[brain] student worker unavailable at boot: ${err.message}`);
      }
    },

    identity() {
      return {
        mode: brain.mode,
        version: brain.version,
        artifactName: brain.artifactName,
        available: brain.worker?.available ?? false,
      };
    },

    /** @returns {Promise<{reply, version, mode, message, captured?}>} */
    async respond(message) {
      const out = await brain.respond(message);
      maybeCaptureSynthetic({
        promptText: message,
        replyText: out.reply,
        model: out.version ?? "student",
        store,
      })
        .then((r) => {
          if (r?.captured) logger.log?.(`[synthetic] captured ${r.articleId} (score ${r.score.toFixed(1)})`);
        })
        .catch((err) => logger.error?.(`[synthetic] capture failed: ${err.message}`));
      return { ...out, message };
    },

    isUnavailable(err) {
      return !(brain.worker?.available ?? false) || /unavailable/.test(String(err?.message));
    },
  };
}

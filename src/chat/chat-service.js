import { chatBrain } from "../brain/brain.js";
import { isCommittedVersion } from "../brain/python-cli.js";
import { maybeCaptureSynthetic } from "./synthetic-feedback.js";

/**
 * Chat domain service — the ONE implementation of "ask the brain".
 *
 * Both the standalone chat server (`npm run chat`, port 8787) and the admin
 * portal (mounted on the main server) call this, so there is a single chat
 * implementation and a single capture path. There is deliberately NO teacher
 * fallback: if no committed student version is active (or the requested version
 * cannot be served) the caller surfaces that honestly.
 *
 * Version awareness:
 *   - `respond(message, { version })` serves that EXACT committed checkpoint,
 *     loaded and integrity-verified by the Python worker. The active pointer is
 *     neither read nor moved on this path.
 *   - A conversation pins the version it was created with; every reply in it
 *     uses that recorded version even after the global selector changes. A
 *     changed selector opens a NEW conversation rather than switching model
 *     mid-conversation.
 *   - A requested version that is not committed is an explicit error; it is
 *     never silently swapped for the active checkpoint.
 */
export function createChatService({
  store,
  brain = chatBrain,
  conversations = null,
  pythonStorePath = null,
  logger = console,
} = {}) {
  const storeRoot = pythonStorePath ?? brain?.worker?.store ?? null;

  /** Fail closed on a version this store does not actually have committed. */
  function assertCommitted(version) {
    if (!version) return;
    if (!storeRoot) return; // no path to validate against; the worker decides
    if (!isCommittedVersion(storeRoot, version)) {
      throw new Error(`model version '${version}' is not a committed version of this store`);
    }
  }

  return {
    brain,
    store,
    conversations,

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

    async createConversation({ version = null, workspace = null } = {}) {
      if (!conversations) throw new Error("conversations are not available in this deployment");
      assertCommitted(version);
      return conversations.createConversation({ version, workspace });
    },

    listConversations({ workspace } = {}) {
      return conversations ? conversations.listConversations({ workspace }) : [];
    },

    getConversation(id) {
      return conversations ? conversations.getConversation(id) : null;
    },

    /** @returns {Promise<{reply, version, mode, message, conversationId, captured?}>} */
    async respond(message, { version = null, conversationId = null } = {}) {
      let effective = version;
      let conversation = null;
      if (conversationId) {
        conversation = conversations?.getConversation(conversationId) ?? null;
        if (!conversation) throw new Error(`unknown conversation ${conversationId}`);
        // The conversation's RECORDED version wins over any supplied selector:
        // a changed global selector must never switch a live conversation.
        effective = conversation.version ?? null;
        await conversations.appendMessage(conversationId, { role: "user", text: message });
      }
      assertCommitted(effective);

      const out = await brain.respond(message, effective ? { version: effective } : {});

      if (conversation) {
        await conversations.appendMessage(conversationId, {
          role: "brain",
          text: out.reply,
          version: out.version,
          artifactName: out.artifactName,
          integrity: out.integrity,
          latencyMs: out.latencyMs,
        });
      }

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

      return { ...out, message, conversationId: conversationId ?? null };
    },

    isUnavailable(err) {
      return !(brain.worker?.available ?? false) || /unavailable/.test(String(err?.message));
    },
  };
}

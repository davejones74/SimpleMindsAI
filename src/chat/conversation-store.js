import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Durable, append-only conversation log.
 *
 * A conversation exists to PIN a chat to one student checkpoint version: the
 * version is chosen when the conversation is created and every later reply uses
 * that recorded version, even after the global model-version selector (or the
 * active pointer) moves. Changing versions must open a NEW conversation; an
 * existing one never silently switches model half-way through.
 *
 * The log is two record kinds in one NDJSON file:
 *   { type: "conversation", conversationId, workspace, version, createdAt }
 *   { type: "message", conversationId, messageId, role, text, version, ... }
 *
 * Folding the lines reconstructs each conversation. A record without a
 * `version` (an older conversation) is reported with `version: null` and shown
 * as "unknown" — the version is never invented.
 */

const EMPTY = Object.freeze({ conversationId: null, version: null, messages: [] });

export class ConversationStore {
  constructor({ file, readOnly = false } = {}) {
    this.file = file;
    this.readOnly = readOnly;
    this.conversations = new Map(); // id -> { conversationId, workspace, version, createdAt, messages: [] }
    this._writeChain = Promise.resolve();
  }

  static async open(file, { readOnly = false } = {}) {
    const store = new ConversationStore({ file, readOnly });
    await store._load();
    return store;
  }

  async _load() {
    let raw = "";
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return; // absent log is a normal first-run condition
    }
    this.conversations.clear();
    for (const line of raw.split("\n")) {
      const text = line.trim();
      if (!text) continue;
      let rec;
      try {
        rec = JSON.parse(text);
      } catch {
        continue; // tolerate a torn trailing line; never crash on read
      }
      this._apply(rec);
    }
  }

  _apply(rec) {
    if (rec.type === "conversation") {
      this.conversations.set(rec.conversationId, {
        conversationId: rec.conversationId,
        workspace: rec.workspace ?? null,
        version: rec.version ?? null,
        createdAt: rec.createdAt ?? null,
        messages: [],
      });
      return;
    }
    if (rec.type === "message") {
      const c = this.conversations.get(rec.conversationId);
      if (!c) return;
      c.messages.push({
        messageId: rec.messageId,
        role: rec.role,
        text: rec.text,
        version: rec.version ?? null,
        artifactName: rec.artifactName ?? null,
        integrity: rec.integrity ?? null,
        latencyMs: rec.latencyMs ?? null,
        error: rec.error ?? null,
        at: rec.at ?? null,
      });
    }
  }

  #assertWritable() {
    if (this.readOnly) throw new Error("conversation store is read-only");
  }

  _persist(rec) {
    this._writeChain = this._writeChain
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true });
        await appendFile(this.file, `${JSON.stringify(rec)}\n`, "utf8");
      })
      .catch(() => {});
    return this._writeChain;
  }

  async createConversation({ workspace = null, version = null } = {}) {
    this.#assertWritable();
    const conversationId = randomUUID();
    const rec = {
      type: "conversation",
      conversationId,
      workspace,
      version: version ?? null,
      createdAt: new Date().toISOString(),
    };
    this._apply(rec);
    await this._persist(rec);
    return this.getConversation(conversationId);
  }

  async appendMessage(conversationId, message) {
    this.#assertWritable();
    if (!this.conversations.has(conversationId)) throw new Error(`unknown conversation ${conversationId}`);
    const rec = {
      type: "message",
      conversationId,
      messageId: randomUUID(),
      role: message.role,
      text: String(message.text ?? ""),
      version: message.version ?? null,
      artifactName: message.artifactName ?? null,
      integrity: message.integrity ?? null,
      latencyMs: message.latencyMs ?? null,
      error: message.error ?? null,
      at: new Date().toISOString(),
    };
    this._apply(rec);
    await this._persist(rec);
    return this.getConversation(conversationId);
  }

  getConversation(id) {
    const c = this.conversations.get(id);
    if (!c) return null;
    return { ...c, messages: c.messages.map((m) => ({ ...m })) };
  }

  /** Newest first. Optionally scoped to one workspace. */
  listConversations({ workspace = undefined } = {}) {
    return [...this.conversations.values()]
      .filter((c) => workspace === undefined || c.workspace === workspace)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((c) => ({
        conversationId: c.conversationId,
        workspace: c.workspace,
        version: c.version,
        createdAt: c.createdAt,
        messageCount: c.messages.length,
      }));
  }

  async close() {
    await this._writeChain.catch(() => {});
  }
}

export { EMPTY as EMPTY_CONVERSATION };

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const PUBLIC = path.join(REPO, "src", "admin", "public");

/**
 * The portal is a dependency-free browser module. A syntax error in it is
 * invisible to `node --test` and to the Node source trees: the module simply
 * never runs, `main.innerHTML` keeps its `Loading…` placeholder and the operator
 * gets a blank dashboard with no console explanation. Parse every public asset
 * so a typo in app.js fails the suite instead of the running portal.
 */
test("portal public assets are parseable modules", async () => {
  const app = await readFile(path.join(PUBLIC, "app.js"), "utf8");
  new vm.Script(app, { filename: "app.js" });
});

test("portal serves the chat conversation controls", async () => {
  const html = await readFile(path.join(PUBLIC, "index.html"), "utf8");
  const app = await readFile(path.join(PUBLIC, "app.js"), "utf8");

  // The version selector that scopes every version-aware screen.
  assert.ok(html.includes('id="modelVersion"'), "model version selector missing");
  assert.ok(html.includes('data-tab="chat"'), "chat tab missing");
  assert.ok(html.includes('data-tab="control"'), "learning & training tab missing");

  // Conversation pinning: a new conversation, and the pinned version shown.
  assert.ok(app.includes("chatNewBtn"), "new-conversation control missing");
  assert.ok(app.includes("currentConversationId"), "conversation state missing");
  assert.ok(app.includes("currentConvVersion"), "pinned conversation version missing");

  // Send the conversationId/reply version back to the backend.
  assert.ok(app.includes("conversationId"), "send does not pin the conversation");
  assert.ok(app.includes("/chat"), "chat endpoint missing");
});

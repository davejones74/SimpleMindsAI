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
  assert.ok(app.includes("currentConversationVersion") || app.includes("currentConvVersion"), "pinned conversation version missing");

  // Send the conversationId/reply version back to the backend.
  assert.ok(app.includes("conversationId"), "send does not pin the conversation");
  assert.ok(app.includes("/chat"), "chat endpoint missing");
});

/**
 * Training History and Trends each stack several wide tables. A ten-column table
 * inside a half-width grid cell starves the free-text column to a single
 * character, and `overflow-wrap: anywhere` then renders every character on its
 * own line — the "Reason" column appears vertical and unreadable. Both sections
 * are therefore tabbed, so a table always gets the full width it needs.
 */
test("training history and trends are tabbed so wide tables get full width", async () => {
  const app = await readFile(path.join(PUBLIC, "app.js"), "utf8");
  const css = await readFile(path.join(PUBLIC, "styles.css"), "utf8");

  // Sub-tab plumbing for both sections.
  for (const stateKey of ["historyTab", "trendsTab"]) {
    assert.ok(app.includes(stateKey), `${stateKey} state missing`);
  }
  assert.ok(app.includes("function subtabs("), "sub-tab renderer missing");
  assert.ok(app.includes("function bindSubtabs("), "sub-tab binding missing");
  assert.ok(app.includes('subtabs("historyTab"'), "training history has no sub-tabs");
  assert.ok(app.includes('subtabs("trendsTab"'), "trends has no sub-tabs");
  // The sub-tabs must not share the top-level nav's `data-tab` attribute, or the
  // binder would reach into the main nav's buttons.
  assert.ok(app.includes('data-subtab="'), "sub-tabs do not use their own attribute");
  assert.ok(!/button\[data-tab\]/.test(app), "sub-tab binder still selects the main nav attribute");

  // The training-runs table must no longer sit inside a half-width `.cols` grid.
  const renderHistory = app.slice(app.indexOf("function runsPanel("), app.indexOf("function modelsPanel("));
  assert.ok(!renderHistory.includes('class="cols"'), "runs table is still inside a half-width grid cell");
  assert.ok(renderHistory.includes('class="reason"'), "runs table has no reason column");

  // Each panel is rendered only for its own tab.
  assert.ok(app.includes('${tab === "runs" ? runsPanel(r) : ""}'), "runs panel is not gated by its tab");
  assert.ok(app.includes('${tab === "eval" ? evalSetPanel(h.evaluationSet) : ""}'), "eval panel is not gated by its tab");

  // A free-text column needs a width floor, or the auto layout still starves it.
  assert.ok(/td\.reason[^{]*\{[^}]*min-width/.test(css.replace(/\n/g, " ")), "reason column has no min-width floor");
  assert.ok(/nav\.subtabs/.test(css), "sub-tab styles missing");
});

test("a missing loss is never coerced to zero in the trends graph", async () => {
  const metrics = await readFile(path.join(REPO, "src", "admin", "metrics.js"), "utf8");
  // The coercion guard has to come BEFORE Number(): Number(null) === 0, so the
  // obvious implementation silently turns "no recorded loss" into "loss 0".
  const guard = metrics.indexOf("function finiteOrNull(");
  assert.ok(guard > -1, "finiteOrNull missing");
  const body = metrics.slice(guard, metrics.indexOf("function firstFinite("));
  assert.ok(body.includes("value === null"), "finiteOrNull does not reject null before coercion");
  assert.ok(body.includes("Number(value)"), "finiteOrNull does not coerce after the guard");
});

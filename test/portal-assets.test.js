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
  // ...and the page must be wide enough for a ten-column table at that floor.
  const mainWidth = css.match(/main\s*\{[^}]*max-width:\s*(\d+)px/);
  assert.ok(mainWidth, "main has no max-width");
  assert.ok(Number(mainWidth[1]) >= 1500, `main max-width is only ${mainWidth[1]}px; a 10-column table cannot fit`);
  // The reason column must also wrap, so a long note cannot push the table out.
  const reasonCss = css.match(/td\.reason[^{]*\{([^}]*)\}/);
  assert.ok(reasonCss[1].includes("overflow-wrap"), "reason column does not wrap");
  // And a table that still overflows scrolls inside the panel rather than
  // widening the page and pushing the free-text column off-screen.
  assert.ok(/\.panel\s*\{[^}]*overflow-x:\s*auto/.test(css.replace(/\n/g, " ")), "panel does not contain a wide table");
});

test("the best-checkpoint card renders one checkpoint, not a per-corpus list", async () => {
  const app = await readFile(path.join(PUBLIC, "app.js"), "utf8");
  const routes = await readFile(path.join(REPO, "src", "admin", "routes.js"), "utf8");
  const metrics = await readFile(path.join(REPO, "src", "admin", "metrics.js"), "utf8");

  // `bestCheckpoint` is a per-dataset-hash summary, so on a store where every
  // version trained on its own corpus it returns every version. A card labelled
  // "Best checkpoint" must not render that.
  assert.ok(metrics.includes("export function bestCheckpointForHash("), "no single-lineage best helper");
  assert.ok(routes.includes("bestInLineage:"), "route does not expose bestInLineage");
  assert.ok(app.includes("m.bestInLineage"), "the card does not read bestInLineage");

  // The card's value must be DERIVED from bestInLineage, and there must be no
  // fallback to the per-hash list.
  assert.ok(
    /const best = m\.bestInLineage/.test(app),
    "the card's `best` is not derived from bestInLineage",
  );
  assert.ok(!/best\s*=\s*\(m\.best/.test(app), "the card still falls back to the per-corpus list");
});

/**
 * The Articles tab lists newest-first, filters domains through a fixed set of
 * choices, and shows when each article was curated. These are source-level
 * assertions for the same reason as the parse check above: the portal is a
 * dependency-free module with no DOM harness, so a mistake here would only
 * surface in a running browser.
 */
test("articles tab lists newest-first, filters domains by selection, and shows curation time", async () => {
  const app = await readFile(path.join(PUBLIC, "app.js"), "utf8");

  // Newest-first: the portal pins the descending order.
  assert.ok(app.includes('q.set("order", "desc")'), "articles load is not newest-first");

  // Domain is a fixed set drawn from the overview, not a free-text box.
  assert.ok(/<select data-filter="domain">/.test(app), "domain filter is not a select");
  assert.ok(!/<input type="text" data-filter="domain"/.test(app), "domain filter is still free text");
  assert.ok(app.includes("articles?.byDomain"), "domain options are not sourced from the overview");

  // "Curated at" sits between Trainable and Consumed in the article table.
  const table = app.slice(app.indexOf("function articleTable()"), app.indexOf("function wireArticles()"));
  assert.ok(
    /<th>Trainable<\/th><th>Curated at<\/th><th>Consumed<\/th>/.test(table),
    "curated-at column is missing or misplaced",
  );
  assert.ok(table.includes("when(x.createdAt)"), "curated-at cell does not render createdAt");
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

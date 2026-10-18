import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Public-path enforcement tests.
 *
 * The language filter is only meaningful if it is enforced at the EDGES a
 * caller actually uses — `POST /api/ingest` and the GraphQL `ingestArticle`
 * mutation — not merely inside the crawler or the detector helper. These tests
 * boot the real server (src/server.js) against a throwaway data directory and
 * drive it over HTTP, so a future refactor that opens the store without the
 * configured filter, or drops the backstop, fails here.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ENGLISH =
  "The steam engine converted thermal energy into mechanical work, and it did so " +
  "because pressure was allowed to act on a piston inside a cylinder. When the valve " +
  "opened, steam that had been heated in the boiler pushed the piston, and the motion " +
  "was then transferred to a wheel through a connecting rod. Engineers of the era were " +
  "concerned that the apparatus would waste fuel, but the improvements that followed " +
  "were remarkable.";

const FRENCH =
  "Le moteur à vapeur transformait l'énergie thermique en énergie mécanique, et il le " +
  "faisait parce que la pression était appliquée sur un piston à l'intérieur d'un " +
  "cylindre. Quand la valve s'ouvrait, la vapeur qui avait été chauffée dans la chaudière " +
  "poussait le piston, et le mouvement était ensuite transmis à une roue par une bielle.";

const CATALAN_SHORT_QA = "Qués el premi Nobel de Literatura de 1986?\n\nWole Soyinka";

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, ms = 25000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become healthy within ${ms}ms`);
}

async function post(base, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function graphql(base, input) {
  const res = await fetch(`${base}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query:
        "mutation ($input: ArticleInput!) { ingestArticle(input: $input) { articleId status } }",
      variables: { input },
    }),
  });
  return res.json();
}

let child;
let base;

before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sma-lang-enforce-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    API_HOST: "127.0.0.1",
    API_PORT: String(port),
    CRAWL_MODE: "fixture",
    SMA_STORE: path.join(dir, "python-store"),
    ARTICLE_DIR: path.join(dir, "articles"),
    REGISTRY_DIR: path.join(dir, "registry"),
    GOVERNANCE_DIR: path.join(dir, "registry"),
    SNAPSHOT_DIR: path.join(dir, "snapshots"),
    EVALUATION_DIR: path.join(dir, "evaluation"),
    MODEL_DIR: path.join(dir, "models"),
    CHAT_DIR: path.join(dir, "chat"),
    FRONTIER_DIR: path.join(dir, "frontier"),
    // Explicitly ON, and NOT shadow: this is the shipping default we rely on.
    LANGUAGE_FILTER_ENABLED: "true",
    LANGUAGE_FILTER_SHADOW: "false",
  };
  child = spawn(process.execPath, ["src/server.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await waitForHealth(base);
});

after(() => {
  child?.kill("SIGKILL");
});

test("POST /api/ingest rejects confident non-English text", async () => {
  const r = await post(base, "/api/ingest", { text: FRENCH, domain: "general" });
  assert.equal(r.status, 200);
  assert.equal(r.body.skipped, true, JSON.stringify(r.body));
  assert.equal(r.body.reason, "non-english");
  assert.equal(r.body.articleId, undefined);
});

test("POST /api/ingest accepts English text", async () => {
  const r = await post(base, "/api/ingest", { text: ENGLISH, domain: "general" });
  assert.equal(r.status, 200);
  assert.ok(r.body.articleId, JSON.stringify(r.body));
});

test("POST /api/ingest honours a declared non-English source URL for short text", async () => {
  // The curated body is short and would otherwise be 'unknown' (fail-open), but
  // the source host declares Catalan, so it must be refused.
  const r = await post(base, "/api/ingest", {
    text: CATALAN_SHORT_QA,
    domain: "literatura",
    sourceUrl: "https://ca.wikipedia.org/wiki/1986",
  });
  assert.equal(r.body.skipped, true, JSON.stringify(r.body));
  assert.equal(r.body.reason, "non-english");
});

test("POST /api/ingest accepts the English variant of the same multilingual source", async () => {
  const r = await post(base, "/api/ingest", {
    text: ENGLISH,
    domain: "literatura",
    sourceUrl: "https://en.wikipedia.org/wiki/1986",
  });
  assert.ok(r.body.articleId, JSON.stringify(r.body));
});

test("POST /api/ingest fails open for genuinely ambiguous text (documented unknown policy)", async () => {
  const r = await post(base, "/api/ingest", { text: "404 — not found. 12345 ???", domain: "general" });
  assert.ok(r.body.articleId, `ambiguous text must pass under fail-open, got ${JSON.stringify(r.body)}`);
});

test("GraphQL ingestArticle rejects non-English text", async () => {
  const res = await graphql(base, { text: FRENCH, domain: "general" });
  assert.equal(res.errors, undefined, JSON.stringify(res.errors));
  assert.equal(res.data.ingestArticle, null, JSON.stringify(res.data));
});

test("GraphQL ingestArticle accepts English text", async () => {
  const res = await graphql(base, { text: ENGLISH, domain: "general" });
  assert.equal(res.errors, undefined, JSON.stringify(res.errors));
  assert.ok(res.data.ingestArticle?.articleId, JSON.stringify(res.data));
});

test("GraphQL ingestArticle honours a declared non-English htmlLang", async () => {
  const res = await graphql(base, { text: CATALAN_SHORT_QA, domain: "literatura", htmlLang: "ca" });
  assert.equal(res.data.ingestArticle, null, JSON.stringify(res.data));
});

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Token auth for the data plane, modelled on CompanionAI's AuthFilter
 * (CompanionAI/src/main/java/.../AuthFilter.java).
 *
 * - The expected token is stored as its SHA-256 hex digest; the raw token is
 *   never held in memory after boot.
 * - Browsers sign in once at POST <base>/auth, which sets an HttpOnly cookie.
 * - API / CLI / internal subsystems send `Authorization: Bearer <token>`.
 * - Unauthenticated HTML requests get a login page; everything else gets 401.
 *
 * Two deliberate deviations from CompanionAI, both to keep SimpleMindsAI working:
 *   1. CompanionAI treats ANY `Authorization: Bearer ` prefix as authenticated
 *      (it never checks the value). Here the bearer value is hashed and compared,
 *      so a stray header is not a free pass.
 *   2. `/health` is exempt, so liveness probes and the ops checklist work without
 *      a credential.
 */

const COOKIE = "simpleminds_auth";
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 7;

export const sha256 = (s) =>
  createHash("sha256").update(String(s), "utf8").digest("hex");

const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

/** Header internal subsystems (curator/planner/scorer) add to their GraphQL calls. */
export function authHeaders() {
  const token = process.env.SIMPLEMINDS_AUTH_TOKEN;
  return token ? { authorization: `Bearer ${token}` } : {};
}

// No cookie-parser dependency: parse the raw header so this stays dependency-free.
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[k] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

function authenticated(req, expectedHash) {
  const cookies = parseCookies(req.headers.cookie);
  if (safeEqual(cookies[COOKIE] ?? "", expectedHash)) return true;

  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return false;
  return safeEqual(sha256(header.slice("Bearer ".length)), expectedHash);
}

const wantsHtml = (req) =>
  String(req.headers.accept ?? "").toLowerCase().includes("text/html");

function loginPage(next) {
  const nextAttr = String(next ?? "/admin/").replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SimpleMindsAI - Sign in</title>
<style>
  :root { --primary: #2f6f4f; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif; background:#eef1f6; color:#1f2733; }
  .card { background:#fff; padding:36px; border-radius:16px; box-shadow:0 8px 30px rgba(0,0,0,.12); width:340px; }
  h1 { margin:0 0 6px; font-size:20px; }
  p { margin:0 0 20px; color:#6b7686; font-size:13.5px; }
  input { width:100%; padding:12px; font-size:15px; border:1px solid #dce1ea; border-radius:10px; margin-bottom:14px; }
  input:focus { outline:2px solid var(--primary); border-color:transparent; }
  button { width:100%; padding:12px; font-size:15px; background:var(--primary); color:#fff;
           border:0; border-radius:10px; cursor:pointer; }
  button:hover { filter:brightness(1.08); }
  .err { color:#c62828; font-size:13px; min-height:18px; margin-top:10px; }
</style>
</head>
<body>
<div class="card">
  <h1>SimpleMindsAI</h1>
  <p>Enter the access token to continue.</p>
  <input type="password" id="token" placeholder="Access token" autofocus>
  <button id="go">Sign in</button>
  <div class="err" id="err"></div>
</div>
<script>
  const inputEl = document.getElementById('token');
  const errEl = document.getElementById('err');
  const next = ${JSON.stringify(nextAttr)};
  async function signIn() {
    errEl.textContent = '';
    const token = inputEl.value.trim();
    if (!token) { errEl.textContent = 'Enter a token.'; return; }
    try {
      const res = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || 'Failed');
      window.location.href = next;
    } catch (e) { errEl.textContent = e.message; }
  }
  document.getElementById('go').addEventListener('click', signIn);
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });
</script>
</body>
</html>`;
}

/**
 * The sign-in / sign-out endpoints. Mount BEFORE the gate and under the path
 * nginx already routes to this app (`/api/admin/`), so the browser's login POST
 * never lands on CompanionAI's own `/api/auth`.
 */
export function createAuthRouter(expectedHash) {
  return function authEndpoints(req, res, next) {
    const url = req.path; // relative to the mount point

    if (url === "/auth/logout") {
      res.clearCookie(COOKIE, { path: "/" });
      return res.json({ ok: true });
    }

    if (url === "/auth") {
      if (req.method !== "POST") return res.status(405).json({ ok: false, message: "POST only." });
      const candidate = req.body?.token ?? "";
      if (safeEqual(sha256(candidate), expectedHash)) {
        res.cookie(COOKIE, expectedHash, {
          httpOnly: true,
          sameSite: "lax",
          secure: req.secure || req.headers["x-forwarded-proto"] === "https",
          path: "/",
          maxAge: COOKIE_MAX_AGE_S * 1000,
        });
        return res.json({ ok: true });
      }
      return res.status(401).json({ ok: false, message: "Incorrect token." });
    }

    return next();
  };
}

/** The gate: everything is protected except the auth endpoints and `/health`. */
export function createAuthGate(expectedHash) {
  return function authGate(req, res, next) {
    if (req.path === "/health") return next();
    if (authenticated(req, expectedHash)) return next();

    if (wantsHtml(req)) {
      res.set("Cache-Control", "no-store");
      return res.type("html").send(loginPage(req.originalUrl));
    }
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  };
}

// Probe the running observatory: fetches exactly the resources the browser
// fetches on boot, in order, and reports where the load stalls.
// Usage: node scripts/probe-portal.cjs  [base url defaults to http://127.0.0.1:4000]
const http = require("http");

const BASE = process.env.PROBE_BASE || "http://127.0.0.1:4000";
const PATHS = [
  "/admin/",
  "/admin/index.html",
  "/admin/app.js",
  "/admin/styles.css",
  "/api/admin/workspaces",
  "/api/admin/overview?workspace=development",
  "/api/admin/brain/versions?workspace=development",
  "/api/admin/chat/identity?workspace=development",
];

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
  });
}

async function main() {
  let bad = 0;
  for (const p of PATHS) {
    try {
      const res = await get(BASE + p);
      const stillPlaceholder = p.indexOf("/admin/") !== -1 && res.body.indexOf(">Loading<") !== -1;
      if (res.status !== 200 || stillPlaceholder) bad++;
      const flag = stillPlaceholder ? "   <-- STILL THE 'Loading…' PLACEHOLDER" : "";
      console.log(`${res.status}  ${p}  len=${res.body.length}${flag}`);
    } catch (e) {
      bad++;
      console.log(`ERR  ${p}  :: ${e.message}`);
    }
  }
  console.log(bad === 0 ? "\nPROBE OK" : `\nPROBE FAILURES: ${bad}`);
  process.exit(bad === 0 ? 0 : 1);
}

main();

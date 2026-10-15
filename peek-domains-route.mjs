import fs from "node:fs";
const p = "E:/Development/Repositories/SimpleMindsAI/src/admin/routes.js";
const c = fs.readFileSync(p, "utf8");
const hits = [...c.matchAll(/router\.(get|post|patch|delete)\("\/domains[^"]*"/g)];
console.log("domains route registrations:", hits.length);
for (const h of hits) {
  const line = c.slice(0, h.index).split("\n").length;
  console.log(`  ${h[0]}  @ line ${line}`);
  console.log("   " + JSON.stringify(c.slice(h.index, h.index + 260)));
}
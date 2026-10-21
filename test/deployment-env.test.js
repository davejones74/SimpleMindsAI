import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseEnv(raw) {
  const out = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const raw0 = m[2];
    const value = (raw0.search(/\s#/) !== -1 && raw0[0] !== '"' && raw0[0] !== "'" ? raw0.slice(0, raw0.search(/\s#/)) : raw0).trim();
    out.set(m[1], value);
  }
  return out;
}

const TRAINING_POLICY = {
  SNAPSHOT_INCLUDE_CONSUMED: "false",
  TRAIN_REPLAY_PERCENT: "20",
  TRAIN_TARGET_EPOCHS: "2",
  TRAIN_MAX_STEPS: "400",
  TRAIN_STEPS: "60",
  TRAIN_MIN_UNIQUE_TOKENS: "1700",
  TRAIN_VAL_BLOCKS: "32",
};

test("X1 Pro deployment env pins the approved training policy explicitly", async () => {
  const env = parseEnv(await readFile(path.join(REPO, "deploy/etc/x1pro.simpleminds.env"), "utf8"));
  for (const [key, value] of Object.entries(TRAINING_POLICY)) {
    assert.equal(env.get(key), value, `${key} must be pinned in the deployment env`);
  }
});

test(".env.example and the X1 Pro env agree on training-policy values", async () => {
  const example = parseEnv(await readFile(path.join(REPO, ".env.example"), "utf8"));
  const deploy = parseEnv(await readFile(path.join(REPO, "deploy/etc/x1pro.simpleminds.env"), "utf8"));
  for (const [key] of Object.entries(TRAINING_POLICY)) {
    assert.equal(example.get(key), deploy.get(key), `${key} drifted between .env.example and deploy env`);
  }
});

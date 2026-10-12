import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The `.env` file is an operator-facing document whose documented style is
 * `KEY=value   # comment` (see `.env.example`). `loadDotEnv` must honour that.
 * When it did not, the comment text was glued onto every commented value and
 * travelled straight into the compute plane's CLI:
 *   `--device "auto   # auto | cpu | cuda"`,
 *   `--compute-dtype "bfloat16   # bfloat16 | float32..."`,
 *   `--eval-every NaN`.
 * Those are silent: nothing throws in Node, only the Python child rejects.
 */
test("dotenv: inline comments are stripped, a glued '#' is data", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sma-env-"));
  const file = path.join(dir, ".env");
  await writeFile(
    file,
    [
      "# a full-line comment is ignored",
      "DEVICE=auto   # auto | cpu | cuda",
      "DTYPE=bfloat16   # bfloat16 | float32; use float32 on CPU",
      "NUMBER=10            # record every N steps",
      "GLUED=pwd#42            # no space before '#' => data",
      'QUOTED="a # b"',
      "QUOTED2='x # y'",
      "PLAIN=value",
    ].join("\n"),
    "utf8"
  );
  try {
    const configUrl = pathToFileURL(path.join(REPO, "src", "config.js")).href;
    const { stdout } = await run(
      process.execPath,
      [
        "-e",
        `import(${JSON.stringify(configUrl)}).then(m=>console.log(JSON.stringify({` +
        "device:process.env.DEVICE,dtype:process.env.DTYPE,number:process.env.NUMBER," +
        "glued:process.env.GLUED,quoted:process.env.QUOTED,quoted2:process.env.QUOTED2," +
        "plain:process.env.PLAIN,cfgDevice:m.config.studentDevice," +
        "cfgEvalEvery:m.config.trainEvalEvery})))",
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          SMA_ENV_FILE: file,
          PLAIN: "from-environment", // a real env var must still win
          // loadDotEnv() deliberately skips under the test runner; the child is
          // NOT the test runner, so clear the guards that would disable it.
          NODE_TEST_CONTEXT: undefined,
          SMA_SKIP_ENV_FILE: undefined,
        },
      }
    );
    const got = JSON.parse(stdout.trim().split("\n").pop());
    assert.equal(got.device, "auto");
    assert.equal(got.dtype, "bfloat16");
    assert.equal(got.number, "10");
    assert.equal(got.glued, "pwd#42", "a '#' glued to the value is data, not a comment");
    assert.equal(got.quoted, "a # b", "quoted values keep their contents");
    assert.equal(got.quoted2, "x # y");
    assert.equal(got.plain, "from-environment", "real environment wins over the file");
    assert.equal(got.cfgDevice, "auto");
    assert.equal(got.cfgEvalEvery, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dotenv: .env.example values carry no leftover comment text", async () => {
  const raw = await readFile(path.join(REPO, ".env.example"), "utf8");
  const checked = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const raw0 = m[2];
    const value = (raw0.search(/\s#/) !== -1 && raw0[0] !== '"' && raw0[0] !== "'" ? raw0.slice(0, raw0.search(/\s#/)) : raw0).trim();
    checked.push([m[1], value]);
  }
  assert.ok(checked.length > 10, "expected the .env.example to define a real set of keys");
  for (const [key, value] of checked) {
    assert.ok(!/\s#/.test(value), `${key}=${JSON.stringify(value)} still contains comment text`);
  }
});

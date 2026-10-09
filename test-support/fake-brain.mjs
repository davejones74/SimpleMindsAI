// A tiny stand-in for `python -m sma.brain` used by the always-on subprocess
// contract test. It is driven through the real `runJsonProcess` spawn path
// (bin = process.execPath) so the test needs no Python interpreter.
const verb = process.argv[2];
const emit = (payload, code = 0) => {
  process.stdout.write(JSON.stringify(payload));
  process.exit(code);
};

switch (verb) {
  case "status":
    emit({ ok: true, verb: "status", versions: [{ version: "v001", committed: true }] });
    break;
  case "boom":
    process.stderr.write("boom happened\n");
    emit({ ok: false, verb: "boom", error: "exploded" }, 3);
    break;
  case "garbage":
    process.stdout.write("this is not json");
    process.exit(0);
    break;
  case "sleep":
    setTimeout(() => emit({ ok: true, verb: "sleep" }), 5000);
    break;
  default:
    emit({ ok: true, verb: verb ?? null });
}

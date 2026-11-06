import { appendFileSync, closeSync, createReadStream, existsSync, openSync, readSync, statSync } from "node:fs";
import readline from "node:readline";

/**
 * Tolerant NDJSON support for append-only stores.
 *
 * Production has observed torn writes containing NUL padding and occasionally
 * an invalid line. Those lines are historical evidence and must never be
 * rewritten, but they must also not prevent valid records after them from
 * loading. This reader skips only the unparseable line and reports diagnostics.
 */

export function parseNdjsonLine(raw) {
  const text = String(raw).replace(/\r$/, "");
  if (!text.trim()) return { ok: false, empty: true, reason: "empty" };

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // A torn write can be valid JSON wrapped in NUL padding. Trim NUL bytes at
    // the edges only; never alter the on-disk record.
    const trimmed = text.replace(/^\u0000+/, "").replace(/\u0000+$/, "");
    if (trimmed && trimmed !== text) {
      try {
        return { ok: true, value: JSON.parse(trimmed), repaired: true };
      } catch {
        // fall through
      }
    }
    return { ok: false, reason: "invalid-json" };
  }
}

export async function readNdjsonFile(file) {
  const records = [];
  const errors = [];
  if (!existsSync(file)) return { records, errors };

  let line = 0;
  const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const raw of rl) {
    line += 1;
    const parsed = parseNdjsonLine(raw);
    if (parsed.ok) {
      records.push(parsed.value);
      continue;
    }
    if (parsed.empty) continue;
    errors.push({
      line,
      bytes: Buffer.byteLength(raw),
      reason: parsed.reason,
      nulBytes: (raw.match(/\u0000/g) ?? []).length,
    });
  }
  return { records, errors };
}

/**
 * If the existing file does not end in a newline (for example after a torn
 * write), add one before opening an append stream. This prevents a new record
 * from being concatenated onto the corrupt tail while preserving every
 * historical byte.
 */
export function ensureAppendBoundary(file) {
  if (!existsSync(file)) return false;
  const { size } = statSync(file);
  if (size === 0) return false;
  const fd = openSync(file, "r");
  const last = Buffer.alloc(1);
  try {
    readSync(fd, last, 0, 1, size - 1);
  } finally {
    closeSync(fd);
  }
  if (last[0] === 0x0a) return false;
  appendFileSync(file, "\n");
  return true;
}

#!/usr/bin/env python3
"""Modify lifecycle.js: add computeFileHash + manifest functions after imports."""

filepath = r"E:\Development\Repositories\SimpleMindsAI\src\training\lifecycle.js"

with open(filepath, "r", encoding="utf-8") as f:
    lines = f.readlines()

# Find the insertion point: after line 11 (0-indexed: 11) which is
# "import { modelHandle } from \"./model-handle.js\";"
# and before line 12 (0-indexed: 12) which is blank, then line 13 is the doc comment.

# The import lines are 0-indexed: 0-11 are imports, 12 is blank, 13 is doc comment
# I want to insert after line 12 (the blank line), i.e., at index 13

# Verify
print(f"Total lines: {len(lines)}")
for i in range(10, 15):
    print(f"Line {i+1}: {repr(lines[i])}")

# Insert after line 12 (index 12, the blank line)
# The new content: computeFileHash function + manifest functions + blank line before doc comment

compute_hash = '''function computeFileHash(filePath) {
  return createHash("sha256")
    .update(readFileSync(filePath, "utf8"), "utf8")
    .digest("hex");
}

'''

manifest_funcs = '''

/** Persist the run manifest as JSON for crash recovery and audit. */
async function persistManifest(manifestPath, manifest) {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

/** Read the run manifest if it exists; return null when absent. */
async function readManifest(manifestPath) {
  try {
    const raw = await readFile(manifestPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Update the run manifest with current state. */
async function updateManifest(manifestPath, manifest, fields) {
  const updated = { ...manifest, ...fields };
  await persistManifest(manifestPath, updated);
  return updated;
}

'''

# Insert after line 12 (index 12), which is the blank line between imports and doc comment
# Insert at index 13 (after the blank line, before the doc comment)
insert_index = 13

new_lines = lines[:insert_index] + [compute_hash, manifest_funcs] + lines[insert_index:]

with open(filepath, "w", encoding="utf-8") as f:
    f.writelines(new_lines)

print("Successfully modified lifecycle.js")
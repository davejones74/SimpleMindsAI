#!/usr/bin/env python3
"""Modify lifecycle.js: add computeFileHash + manifest functions after the doc comment."""

filepath = r"E:\Development\Repositories\SimpleMindsAI\src\training\lifecycle.js"

with open(filepath, "r", encoding="utf-8") as f:
    lines = f.readlines()

# Find the position after the doc comment (after the line with "*/")
# In the original file, the doc comment ends at line 58 with "*/"
# export async function executeFullRun starts at line 59

# Find the index of the "*/" line that closes the doc comment
close_doc_idx = None
for i, line in enumerate(lines):
    if "*/" in line:
        close_doc_idx = i
        break

if close_doc_idx is None:
    print("ERROR: Could not find closing */ of doc comment")
    exit(1)

# Insert after the "*/" line (i.e., at index close_doc_idx + 1)
# The content to insert: computeFileHash function, then manifest functions

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

# Insert after the closing */ of the doc comment
insert_index = close_doc_idx + 1

new_lines = lines[:insert_index] + [compute_hash, manifest_funcs] + lines[insert_index:]

with open(filepath, "w", encoding="utf-8") as f:
    f.writelines(new_lines)

print(f"Successfully modified lifecycle.js (inserted after line {close_doc_idx + 1})")
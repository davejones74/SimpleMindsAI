#!/usr/bin/env python3
"""Modify lifecycle.js to add manifest persistence/recovery functions."""

import sys

filepath = r"E:\Development\Repositories\SimpleMindsAI\src\training\lifecycle.js"

with open(filepath, "r", encoding="utf-8") as f:
    content = f.read()

# Find the position of the computeFileHash function end and doc comment
# We'll insert after the computeFileHash function (after line 17's closing })

# Find "*/" that closes the computeFileHash JSDoc comment
# Actually, computeFileHash doesn't have a JSDoc comment before it in the current file
# Let me find the position after line 20 (the closing brace of computeFileHash)

# Strategy: find the line "}" that closes computeFileHash and insert after it
# The computeFileHash function ends at line 20 in the current file (0-indexed: 19)

# Let me find the position of the closing brace of computeFileHash
# Actually, let me just find where "async function computeFileHash" is and insert after its closing brace

compute_hash_pos = content.find("async function computeFileHash(filePath)")
if compute_hash_pos == -1:
    print("ERROR: Could not find computeFileHash")
    sys.exit(1)

# Find the closing brace of computeFileHash - it's on the line with just "}"
# After the return statement
search_from = compute_hash_pos
close_pos = content.find("}\n", search_from)
if close_pos == -1:
    print("ERROR: Could not find closing brace of computeFileHash")
    sys.exit(1)

# The insert position is after the closing brace and the newline
insert_pos = close_pos + 1

# The manifest functions to insert
manifest_funcs ='''/

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

new_content = content[:insert_pos] + manifest_funcs + content[insert_pos:]

with open(filepath, "w", encoding="utf-8") as f:
    f.write(new_content)

print("Successfully inserted manifest functions into lifecycle.js")
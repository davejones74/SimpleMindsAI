"""
Version store: atomic commit, durable state, heartbeat.

A brain version is a directory that becomes visible only once it is complete.
The write sequence is deliberately the same shape as Node's `RUN.lock`
discipline — build somewhere private, make it durable, then publish:

    v002.tmp/  ->  fsync  ->  os.replace  ->  v002/  ->  write COMMITTED

A crash at any point leaves an orphan `.tmp` directory and a still-valid
previous version. There is no window in which `v002/` exists but is
incomplete, so a reader can treat "directory exists" as a cheap check and
"COMMITTED exists" as the real one.

`COMMITTED` is written last, after the weights and state are durable. Node
must not record a model in the registry until it sees that marker.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, Optional

COMMITTED_MARKER = "COMMITTED"
TMP_SUFFIX = ".tmp"


# --------------------------------------------------------------- durability
#
# Windows notes, learned the hard way:
#   - os.fsync() on a read-only handle returns EBADF. Handles must be opened
#     for writing, so `fsync_file` opens r+b rather than rb.
#   - os.open() on a directory raises PermissionError; there is no POSIX-style
#     directory fsync on Windows at all.
# NTFS still orders metadata through `os.replace`, which is an atomic rename,
# so a lost directory-entry fsync is far less dangerous here than the same
# omission on ext4. We report what was actually synced rather than pretending.


def _durable_sync(handle, label: str) -> bool:
    try:
        os.fsync(handle)
        return True
    except OSError as exc:
        if os.name == "nt" and exc.errno in (9, 13, 22):  # EBADF, EACCES, EINVAL
            return False
        raise


def fsync_file(path: Path) -> bool:
    """Flush a file's contents to stable storage. Returns whether it synced."""
    try:
        with open(path, "r+b") as fh:
            return _durable_sync(fh.fileno(), str(path))
    except PermissionError:
        # read-only file (possible on a restored backup) — nothing to flush
        return False


def fsync_dir(path: Path) -> bool:
    """Flush a directory entry. Unsupported on Windows; returns False there."""
    if os.name == "nt":
        return False
    fd = os.open(path, os.O_RDONLY)
    try:
        return _durable_sync(fd, str(path))
    finally:
        os.close(fd)


# ----------------------------------------------------------------- versions


def version_path(root: Path, version: str) -> Path:
    return Path(root) / version


def next_version(root: Path) -> str:
    """Lowest unused vNNN. Version lineage is append-only: a rejected version
    is retained and the next child continues from the last *promoted* one, so
    versions are never reused or rewritten."""
    root = Path(root)
    if not root.exists():
        return "v001"
    used = {
        int(p.name[1:])
        for p in root.iterdir()
        if p.is_dir()
        and p.name.startswith("v")
        and p.name[1:].isdigit()
        and not p.name.endswith(TMP_SUFFIX)
    }
    return f"v{max(used) + 1 if used else 1:03d}"


def is_committed(path: Path) -> bool:
    return (Path(path) / COMMITTED_MARKER).exists()


def list_versions(root: Path) -> list:
    root = Path(root)
    if not root.exists():
        return []
    return sorted(
        p.name
        for p in root.iterdir()
        if p.is_dir() and p.name.startswith("v") and p.name[1:].isdigit()
    )


@contextmanager
def staging_dir(root: Path, version: str) -> Iterator[Path]:
    """Yield a private `.tmp` directory; publish it on clean exit.

    On exception the staging directory is removed, so a failed build leaves no
    debris. A killed process may leave one behind; `sweep_stale_staging`
    cleans those up.
    """
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    final = root / version
    if final.exists():
        raise FileExistsError(f"{final} already exists; versions are immutable")
    tmp = root / f"{version}{TMP_SUFFIX}"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)
    try:
        yield tmp
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    # publish: fsync contents, then swap the directory into place
    for child in sorted(tmp.iterdir()):
        if child.is_file():
            fsync_file(child)
    fsync_dir(tmp)
    os.replace(tmp, final)
    fsync_dir(root)


def commit_marker(path: Path, payload: Optional[Dict[str, Any]] = None) -> None:
    """Publish a version. Call only after every other artifact is durable."""
    path = Path(path)
    body = {"version": path.name, "committedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if payload:
        body.update(payload)
    tmp = path / f".{COMMITTED_MARKER}.writing"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(body, fh, indent=2, sort_keys=True)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path / COMMITTED_MARKER)
    fsync_dir(path)


def sweep_stale_staging(root: Path, older_than_s: float = 7 * 24 * 3600) -> list:
    """Remove `.tmp` directories abandoned by a killed process."""
    root = Path(root)
    if not root.exists():
        return []
    removed = []
    now = time.time()
    for p in root.iterdir():
        if p.is_dir() and p.name.endswith(TMP_SUFFIX):
            if now - p.stat().st_mtime > older_than_s:
                shutil.rmtree(p, ignore_errors=True)
                removed.append(p.name)
    return removed


# ----------------------------------------------------------------- JSON I/O


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, sort_keys=True, default=str)
        fh.flush()
        os.fsync(fh.fileno())


def read_json(path: Path) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


# ------------------------------------------------------- publication naming
#
# The canonical identity of a brain version is its vNNN directory, and that
# stays authoritative. This is a second, *derived* name for the one case a
# vNNN cannot serve: publishing a weight file to somebody who has no checkout.
# A release asset needs a name a stranger can verify on its own, and "v002"
# does not say which weights it is.
#
#     simpleminds-<size>-<YYYYMMDD>-<hash12>
#
# The 12-hex suffix is not decoration, it is the reason the name is worth
# having: a downloader recomputes it from the weights, and a mismatch fails
# loudly. That is what makes it a content address rather than a label.
#
# It deliberately does not name the architecture. "smollm3-..." would put a
# third party's model in the headline of work whose entire claim is that no
# pretrained weights were used -- the name would contradict the invariant it
# is supposed to advertise. The architecture is recorded honestly in
# config.json, provenance.json and architectureReferenceRepo instead, which is
# where lineage belongs. Branding the artifact with someone else's model would
# be the exact misreading the proof obligations exist to prevent.


def size_label(parameter_count: int) -> str:
    """61_839_744 -> "62m". Rounded, because a size tag is a label."""
    n = int(parameter_count)
    if n < 1_000_000_000:
        return f"{round(n / 1_000_000)}m"
    return f"{round(n / 1_000_000_000)}b"


def _tensor_hash_map(manifest: Dict[str, Any]) -> Dict[str, str]:
    """Normalize the two shapes this manifest field has taken.

    `tensors` is a flat name -> digest map. `tensorHashesAfterTraining` is
    nested, carrying `aliasedTensors` beside it. An untrained version has
    only the former; a trained version has both. The *trained* hashes win,
    because they describe the bytes actually in the weight file, and a
    release asset contains those.

    The asymmetry is a wart in the schema, not an intentional distinction,
    and it should be flattened before Phase 2 -- two shapes for one field
    is one more thing a consumer has to know.
    """
    for key in ("tensorHashesAfterTraining", "tensors"):
        block = manifest.get(key)
        if not isinstance(block, dict) or not block:
            continue
        inner = block.get("tensors")
        if isinstance(inner, dict) and inner:
            return inner
        if key == "tensors":
            return block
    return {}


def weight_fingerprint(manifest: Dict[str, Any]) -> str:
    """SHA-256 over the recorded tensor hashes, as 12 hex characters.

    Hashes the `name -> digest` pairs rather than the bare digests, and the
    distinction is load-bearing here: 76 tensor entries in this model yield
    only 59 distinct digests, because the 17 RMSNorm weights all initialize
    to 1.0 and the 2 RoPE buffers are a closed form of head_dim and
    rope_theta. Given repeated digests, a digest-only hash cannot tell a
    correct manifest from one that assigned every value to the wrong tensor.
    Binding the name in means it can.
    """
    tensors = _tensor_hash_map(manifest)
    if not tensors:
        raise ValueError("manifest records no tensor hashes; cannot name the artifact")
    canonical = "".join(f"{name}={tensors[name]}\n" for name in sorted(tensors))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]


def artifact_name(manifest: Dict[str, Any]) -> str:
    """Content-addressed publication name for one committed version.

    Derived entirely from the manifest, so it is reproducible from the
    committed metadata alone. The date is the version's `createdAt`, never
    today: a name that depended on when it was asked for would not be a
    content address.
    """
    created = str(manifest.get("createdAt") or "")
    stamp = created[:10].replace("-", "")
    if len(stamp) != 8 or not stamp.isdigit():
        raise ValueError(f"manifest createdAt is not ISO-8601: {created!r}")
    params = (manifest.get("sizes") or {}).get("parametersUniqueByStorage")
    if not params:
        raise ValueError("manifest records no parameter count; cannot name the artifact")
    return f"simpleminds-{size_label(params)}-{stamp}-{weight_fingerprint(manifest)}"


def artifact_name_for_version(root: Path, version: str) -> str:
    return artifact_name(read_json(Path(root) / version / "init-manifest.json"))


# ---------------------------------------------------------------- heartbeat


class Heartbeat:
    """Proves a long run is alive.

    Necessary because `registry-store.recoverStaleRuns` marks any run older
    than `runLockStaleMs` (default 10 minutes) as failed. A 3B training run
    takes days, so time-since-start is the wrong liveness signal — the Python
    worker must write a heartbeat and staleness must be measured against it.
    """

    def __init__(self, path: Path, interval_s: float = 30.0):
        self.path = Path(path)
        self.interval_s = interval_s
        self._last = 0.0

    def beat(self, force: bool = False, **extra: Any) -> None:
        now = time.time()
        if not force and (now - self._last) < self.interval_s:
            return
        self._last = now
        payload = {"at": now, "iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))}
        payload.update(extra)
        write_json(self.path, payload)

    @staticmethod
    def age_s(path: Path) -> float:
        try:
            return time.time() - Path(path).stat().st_mtime
        except FileNotFoundError:
            return float("inf")

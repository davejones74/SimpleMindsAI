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

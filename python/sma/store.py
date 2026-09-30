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

# The auditable record of a version: small text, safe in git, worthless without
# the weights it describes. An explicit allowlist rather than an exclusion rule,
# so a file added later is neither silently committed nor silently dropped.
RECORD_FILES = (
    "init-manifest.json",
    "provenance.json",
    "train-state.json",
    "parameter-diff.json",
    "config.json",
    "generation_config.json",
    COMMITTED_MARKER,
)

# A "record" bigger than this is a mistake worth failing on. The real ones are
# 1 KB - 100 KB. If this ever trips, something binary leaked into the allowlist.
RECORD_MAX_BYTES = 1 << 20

# The tokenizer is deliberately NOT mirrored per version. It is byte-identical
# across every version of a lineage -- 17.2 MB each time would be pure
# duplication in git history for a file that never changes.


# ------------------------------------------------------------- store root
#
# The store lives OUTSIDE the working tree, always. Two reasons, both learned
# the hard way:
#
#   - A directory named "scratch" is a promise that someone will delete it. The
#     append-only model lineage is the one thing that must not be disposable,
#     and a checkout that gets re-cloned or a deploy that gets re-provisioned
#     will happily wipe it.
#   - On a server the repo is often read-only, ephemeral, or on a different host
#     than the weights. Coupling them makes the weights a deployment artifact.
#
# SMA_STORE is the single knob. Default is per-user and outside any repo, so a
# fresh clone never silently adopts a different lineage than the one in use.


def store_root(explicit: Optional[Path] = None) -> Path:
    """Resolve the canonical store location: argument, then env, then default."""
    if explicit:
        return Path(explicit)
    env = os.environ.get("SMA_STORE")
    if env:
        return Path(env)
    return Path.home() / ".sma" / "store"


# ---------------------------------------------------------- the git mirror
#
# Git tracks a *copy* of the small text of each version; the store keeps the
# authoritative whole. ~150 KB duplicated per version buys two things that
# cannot be had otherwise:
#
#   - Version directories stay whole, so atomic commit still means all-or-nothing.
#     Splitting the record from the weights would reintroduce exactly the torn
#     state that staging_dir and COMMITTED exist to prevent.
#   - The history of how every brain was made is reviewable in a diff, without
#     a 247 MB binary in every version of the repository.
#
# The mirror is verified against the store on every write, so it cannot drift
# into being a second, unverified source of truth.



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


# ----------------------------------------------------------------- loading
#
# ONE rule for every consumer: weights are loaded from the immutable version
# directory, never from an export. Chat, eval, generate and the Node worker all
# go through `resolve_version_dir`.
#
# This is a structural decision, not a preference. An export is a *copy* made
# for distribution, so serving from it would create a second 247 MB copy of
# the same weights and a permanent obligation to prove the two agree. The
# version directory is the canonical, hash-verified artifact; the export exists
# only to get bytes to a machine that has no repository.


def resolve_version_dir(root: Path, version: str) -> Path:
    """The single path every consumer loads weights from."""
    path = Path(root) / version
    if not path.is_dir():
        raise FileNotFoundError(f"no such version: {path}")
    if not is_committed(path):
        raise ValueError(
            f"{version} is not committed ({COMMITTED_MARKER} missing); "
            "refusing to load a possibly incomplete checkpoint"
        )
    return path


def weight_files(path: Path) -> list:
    """The safetensors weight file(s): one, or many if sharded."""
    found = sorted(Path(path).glob("*.safetensors"))
    if not found:
        raise FileNotFoundError(f"{path} contains no .safetensors weight file")
    return found


def file_sha256(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


# ----------------------------------------------------------------- export
#
# The artifact name becomes a *directory* name rather than a file prefix, so
# the export is still an ordinary transformers checkpoint that
# `from_pretrained` accepts unchanged. Renaming model.safetensors to
# `simpleminds-...safetensors` would have made the content address and the
# loader mutually exclusive.
#
# Serving does not use this. See `resolve_version_dir`.


def export_version(root: Path, version: str, out_dir: Path) -> Dict[str, Any]:
    """Copy one committed version to a content-addressed export directory.

    Refuses to overwrite. A content-addressed name that already exists should
    already be byte-identical, so clobbering it would mean something upstream
    is wrong -- and silently replacing a distributed artifact is exactly the
    failure this whole naming scheme exists to make impossible.
    """
    src = resolve_version_dir(root, version)
    manifest = read_json(src / "init-manifest.json")
    name = artifact_name(manifest)

    dest = Path(out_dir) / name
    if dest.exists():
        raise FileExistsError(
            f"{dest} already exists. The name is content-addressed, so an existing "
            f"export is already byte-identical; refusing rather than overwriting."
        )

    tmp = Path(str(dest) + TMP_SUFFIX)
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)

    try:
        for child in sorted(src.iterdir()):
            if child.is_file():
                shutil.copy2(child, tmp / child.name)

        # The copy must still hash to the name it is filed under. A truncated
        # or altered copy is caught here rather than by whoever downloads it.
        copied = read_json(tmp / "init-manifest.json")
        recomputed = artifact_name(copied)
        if recomputed != name:
            raise ValueError(f"exported copy hashes to {recomputed}, expected {name}")

        sums = [
            f"{file_sha256(child)}  {child.name}"
            for child in sorted(tmp.iterdir())
            if child.is_file()
        ]
        (tmp / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")

        # Written after SHA256SUMS and therefore absent from it, on purpose:
        # it carries an export timestamp, so including it would make the sums
        # file differ between two exports of identical bytes.
        write_json(
            tmp / "EXPORT.json",
            {
                "schema": "sma/export@1",
                "artifactName": name,
                "sourceVersion": version,
                "sourcePath": str(src),
                "exportedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "weightFingerprint": weight_fingerprint(manifest),
                "parameterCount": (manifest.get("sizes") or {}).get("parametersUniqueByStorage"),
                "files": sorted(p.name for p in tmp.iterdir() if p.is_file()),
            },
        )

        for child in sorted(tmp.iterdir()):
            if child.is_file():
                fsync_file(child)
        fsync_dir(tmp)
        os.replace(tmp, dest)
        fsync_dir(Path(out_dir))
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise

    return {
        "artifactName": name,
        "path": str(dest),
        "sourceVersion": version,
        "files": sorted(p.name for p in dest.iterdir() if p.is_file()),
        "bytes": sum(p.stat().st_size for p in dest.iterdir() if p.is_file()),
    }


def verify_export(path: Path) -> Dict[str, Any]:
    """Re-check an export's SHA256SUMS. This is what a downloader runs."""
    path = Path(path)
    sums_path = path / "SHA256SUMS"
    if not sums_path.is_file():
        raise FileNotFoundError(f"{sums_path} missing; not an export, or an incomplete one")

    checked, bad = [], []
    for line in sums_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        expected, _, filename = line.partition("  ")
        target = path / filename
        if not target.is_file():
            bad.append({"file": filename, "reason": "missing"})
            continue
        actual = file_sha256(target)
        if actual != expected:
            bad.append({"file": filename, "reason": "hash mismatch", "expected": expected, "actual": actual})
        else:
            checked.append(filename)

    return {"path": str(path), "verified": checked, "failed": bad, "ok": not bad}


# ------------------------------------------------------------ record mirror


def mirror_record(root: Path, version: str, repo_models: Path) -> Dict[str, Any]:
    """Copy a version's small text into the git-tracked mirror, verified.

    The mirror is a convenience for review, not a second source of truth. Every
    file is hashed on the way across and re-checked after the write, so it
    cannot quietly diverge from the store it describes.
    """
    src = resolve_version_dir(root, version)
    dest = Path(repo_models) / version

    expected: Dict[str, str] = {}
    for name in RECORD_FILES:
        candidate = src / name
        if not candidate.is_file():
            continue
        size = candidate.stat().st_size
        if size > RECORD_MAX_BYTES:
            raise ValueError(
                f"{name} is {size:,} bytes, over the {RECORD_MAX_BYTES:,} record cap; "
                "something binary has leaked into the record allowlist"
            )
        expected[name] = file_sha256(candidate)

    if "init-manifest.json" not in expected:
        raise FileNotFoundError(f"{version} has no init-manifest.json; refusing to mirror")

    dest.mkdir(parents=True, exist_ok=True)
    for name, digest in expected.items():
        target = dest / name
        tmp = target.with_name(f".{name}.writing")
        shutil.copy2(src / name, tmp)
        if file_sha256(tmp) != digest:
            tmp.unlink(missing_ok=True)
            raise ValueError(f"{name} changed during the copy; mirror not written")
        os.replace(tmp, target)

    for name, digest in expected.items():
        if file_sha256(dest / name) != digest:
            raise ValueError(f"mirror verification failed for {name}")

    return {"version": version, "path": str(dest), "files": sorted(expected), "bytes": sum(
        (dest / n).stat().st_size for n in expected
    )}


def verify_mirror(root: Path, repo_models: Path) -> Dict[str, Any]:
    """Check every git-tracked record against the store it claims to describe.

    Symmetric on purpose. Checking only what the store happens to hold would
    let the mirror accumulate invented content and still report clean, which
    makes it a second, unverified source of truth -- precisely the failure this
    mirror exists to avoid.
    """
    repo_models = Path(repo_models)
    results, drifted = [], []
    for version in list_versions(root):
        src = Path(root) / version
        dest = repo_models / version
        if not dest.is_dir():
            continue

        for name in RECORD_FILES:
            a, b = src / name, dest / name
            if not a.is_file() and not b.is_file():
                continue
            if a.is_file() and not b.is_file():
                drifted.append({"version": version, "file": name, "reason": "missing from mirror"})
            elif b.is_file() and not a.is_file():
                drifted.append({"version": version, "file": name, "reason": "not in store"})
            elif file_sha256(a) != file_sha256(b):
                drifted.append({"version": version, "file": name, "reason": "differs from store"})

        # Anything else in the mirror is unrequested content. A weight file
        # copied here by accident, or a hand-written claim, must not pass as
        # if it were part of the reviewed record.
        for stray in sorted(p for p in dest.iterdir() if p.is_file()):
            if stray.name in RECORD_FILES:
                continue
            drifted.append({"version": version, "file": stray.name, "reason": "not a record file"})

        results.append(version)

    return {"store": str(root), "mirror": str(repo_models), "checked": results, "drifted": drifted, "ok": not drifted}


# ------------------------------------------------------- deployment pointer
#
# `active` is the one deliberately MUTABLE name in the system, and it exists
# only for deployment: "which brain is the server serving right now."
#
# It is kept strictly separate from identity. `vNNN` and the content address
# never move; `active` moves, and records what it moved to and when. It must
# never appear in a manifest, because a manifest that says "I am active" is a
# manifest that can lie -- activity is a property of a deployment, not of a
# weight file.


def active_pointer_path(root: Path) -> Path:
    return Path(root) / "active.json"


def set_active(root: Path, version: str) -> Dict[str, Any]:
    path = resolve_version_dir(root, version)
    manifest = read_json(path / "init-manifest.json")
    payload = {
        "schema": "sma/active@1",
        "version": version,
        "artifactName": artifact_name(manifest),
        "weightFingerprint": weight_fingerprint(manifest),
        "activatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    write_json(active_pointer_path(root), payload)
    return payload


def active_version(root: Path) -> Optional[str]:
    """The version a server should serve, or None if nothing is activated."""
    path = active_pointer_path(root)
    if not path.is_file():
        return None
    try:
        return read_json(path).get("version")
    except (json.JSONDecodeError, OSError):
        return None


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


# ------------------------------------------------------------------ run lock
#
# "Is a run already writing this version's state?" has to be answerable before
# a resume is allowed, because two processes resuming the same committed
# boundary would interleave optimizer moments and RNG state into one corrupt
# pickle. This is a different guarantee from `Heartbeat`: a heartbeat proves a
# long run is *alive*, this proves *exclusive* ownership.
#
# `O_CREAT | O_EXCL` is atomic -- exactly one process creates the file, every
# other gets EEXIST -- so the lock is a filesystem primitive, not a
# best-effort flag. A killed process leaves the lock behind, so a lock older
# than RUN_LOCK_STALE_S is treated as abandoned and taken over, using the same
# clock as the heartbeat. A crash therefore self-heals instead of wedging the
# lineage forever.
#
# The stale window is deliberately long (a day). A 3B run legitimately holds
# this lock for days, so a short window would let a second process steal it out
# from under a live run. The trade-off is that a *crashed* run blocks a resume
# for up to that window; the lock is cheap to clear by hand and is never the
# only thing standing between two runs.

RUN_LOCK_STALE_S = 24 * 60 * 60


def run_lock_path(root: Path, version: str) -> Path:
    return Path(root) / "_runs" / f"{version}.lock"


def run_lock_active(root: Path, version: str, stale_s: float = RUN_LOCK_STALE_S) -> bool:
    """True if a live (non-stale) run currently owns this version's state.

    The "no active conflicting run" check for the cross-vendor resume
    preflight. An absent lock, or one abandoned past the stale window, counts
    as inactive.
    """
    path = run_lock_path(root, version)
    if not path.exists():
        return False
    return Heartbeat.age_s(path) <= stale_s


@contextmanager
def run_lock(
    root: Path, version: str, stale_s: float = RUN_LOCK_STALE_S
) -> Iterator[Path]:
    """Exclusively own a version's run state for the duration of the block.

    Yields the lock path. The lock is removed on clean exit and on exception
    (so a failed run does not wedge the version). A lock that is already held
    by a live run raises, because silently sharing optimizer state is exactly
    the corruption this exists to prevent.
    """
    path = run_lock_path(root, version)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "pid": os.getpid(),
        "version": version,
        "at": time.time(),
        "iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    def _acquire() -> None:
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if run_lock_active(root, version, stale_s):
                raise RuntimeError(
                    f"another run already holds {path}; refusing to start a "
                    f"second run against {version}"
                )
            # Abandoned by a killed process: clear and retake.
            path.unlink(missing_ok=True)
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
            fh.flush()
            os.fsync(fh.fileno())

    _acquire()
    try:
        yield path
    finally:
        path.unlink(missing_ok=True)

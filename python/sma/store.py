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
#
# Numbering carries two guarantees, both durable:
#
#   MONOTONIC. A version number is a logical clock over ATTEMPTS, not over
#   published versions. Every allocation is appended to `_allocations.ndjson`
#   before a single weight is written, so a rejected candidate burns its number
#   for good and the published lineage keeps the gaps where attempts happened.
#   A count that only advanced on success would report a dense, unbroken history
#   and quietly hide how many attempts the failures took.
#
#   COLLISION-SAFE. A number is claimed by a committed version, by a live
#   staging directory, OR by an allocation record — so two runs cannot allocate
#   the same name, and a crashed process's in-flight number is not handed to the
#   next run. A crash therefore leaves a gap, which `sweep_stale_staging` can
#   recover and which is honest until it does.
#
# Retaining/pruning whole versions is a separate policy: see the retention
# section further down.


def version_path(root: Path, version: str) -> Path:
    return Path(root) / version


ALLOCATIONS_NAME = "_allocations.ndjson"


def allocations_path(root: Path) -> Path:
    return Path(root) / ALLOCATIONS_NAME


def allocated_versions(root: Path) -> set:
    """Every version number ever handed out, committed or not."""
    root = Path(root)
    path = allocations_path(root)
    if not path.is_file():
        return set()
    out = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.add(json.loads(line).get("version"))
        except json.JSONDecodeError:
            continue
    return {v for v in out if isinstance(v, str) and v[1:].isdigit()}


def _claimed_numbers(root: Path) -> set:
    """Numbers that must not be handed out again.

    Committed versions and live staging directories are read from the
    filesystem; the allocation log supplies the third claim, for numbers whose
    attempt ended in rejection without ever creating a directory a reader could
    see. Without it a rejected candidate's number returns to the pool and the
    published lineage loses the gap that records the attempt.
    """
    root = Path(root)
    claimed = set()
    if root.exists():
        for p in root.iterdir():
            if not p.is_dir() or not p.name.startswith("v"):
                continue
            digits = p.name[1:]
            if digits.endswith(TMP_SUFFIX):
                digits = digits[: -len(TMP_SUFFIX)]
            if digits.isdigit():
                claimed.add(int(digits))
    return claimed | {int(v[1:]) for v in allocated_versions(root)}


def next_version(root: Path) -> str:
    """Lowest unclaimed vNNN.

    Monotonic by construction: the scan includes the durable allocation log, so
    the counter can only move forward. See the numbering note above for why a
    rejected candidate burns its number instead of returning it.
    """
    claimed = _claimed_numbers(Path(root))
    n = 1
    while n in claimed:
        n += 1
    return f"v{n:03d}"


def allocate_version(root: Path, *, run_id: Optional[str] = None) -> str:
    """Claim the next version number DURABLY, before anything is built.

    Recording the allocation before the first weight is written is what makes
    numbering correct across crashes: a process that dies immediately after this
    call still leaves its number claimed, so the next run cannot collide with it.
    """
    root = Path(root)
    version = next_version(root)
    record = {
        "version": version,
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if run_id:
        record["runId"] = run_id
    path = allocations_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, sort_keys=True) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    return version


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


def staging_version_path(root: Path, version: str) -> Path:
    """The private, not-yet-published directory for a candidate version.

    A staged candidate is a full checkpoint directory that Node can evaluate but
    that is NOT a version: it carries no `COMMITTED` marker, `list_versions`
    skips it (the `.tmp` suffix is not a `vNNN` name), and it can be discarded
    without a trace. It is promoted into `vNNN/` only on a real promotion.
    """
    return Path(root) / f"{version}{TMP_SUFFIX}"


def is_staged(root: Path, version: str) -> bool:
    return staging_version_path(root, version).is_dir()


def _fsync_tree(tmp: Path) -> None:
    for child in sorted(tmp.iterdir()):
        if child.is_file():
            fsync_file(child)
    fsync_dir(tmp)


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
    _fsync_tree(tmp)
    os.replace(tmp, final)
    fsync_dir(root)


@contextmanager
def stage_dir(root: Path, version: str) -> Iterator[Path]:
    """Yield a private `.tmp` directory and LEAVE it in place on clean exit.

    This is the commit-on-promotion half of `staging_dir`: the fully built
    checkpoint is durable (`fsync`ed) but stays unpublished. The caller then
    either `publish_staged` it into `vNNN/` or `discard_staged` it. A crash
    mid-build removes the debris on the way out; a killed process is cleaned by
    `sweep_stale_staging`.

    Publication is deliberately a separate step: evaluation must be able to
    read the candidate before it becomes a version, and a rejected candidate
    must never appear in the published lineage.
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
    _fsync_tree(tmp)


def publish_staged(root: Path, version: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Atomically promote a staged candidate into an immutable `vNNN/` version.

    Idempotent by design, because the only safe crash-recovery strategy is to
    retry the commit: if `vNNN` is already committed this is a no-op that reports
    `alreadyCommitted`. The resume pickle (which describes a *run*, not a
    version, and must not ship in the published record) is moved out of the
    version directory to `_runs/` before the swap.
    """
    root = Path(root)
    final = root / version
    tmp = staging_version_path(root, version)

    if is_committed(final):
        return {"version": version, "published": True, "alreadyCommitted": True}
    if not tmp.is_dir():
        raise FileNotFoundError(f"no staged candidate at {tmp}; cannot publish {version}")
    if final.exists():
        raise FileExistsError(
            f"{final} exists but is not committed; refusing to publish over it"
        )

    # Optimizer moments are ~8x the fp32 weights and are a run artifact, not part
    # of the immutable version: move them beside the other resume states.
    resume = tmp / f"{version}.train-state.pt"
    if resume.is_file():
        runs_dir = root / "_runs"
        runs_dir.mkdir(parents=True, exist_ok=True)
        os.replace(resume, runs_dir / f"{version}.train-state.pt")

    _fsync_tree(tmp)
    os.replace(tmp, final)
    fsync_dir(root)
    commit_marker(final, payload)
    return {"version": version, "published": True, "alreadyCommitted": False}


def discard_staged(
    root: Path, version: str, record_dir: Optional[Path] = None
) -> Dict[str, Any]:
    """Delete a staged candidate, optionally keeping its small audit record.

    The weights are useless once a run is rejected (they lost the promotion
    gate), but the *provenance* is not: the manifest, the training state, the
    parameter diff and the config are how a rejection stays explainable. Those
    small files are copied to `record_dir` before the checkpoint is removed.
    """
    root = Path(root)
    tmp = staging_version_path(root, version)
    if not tmp.is_dir():
        return {"version": version, "discarded": False, "recordPath": None}

    record_path: Optional[str] = None
    if record_dir is not None:
        dest = Path(record_dir)
        dest.mkdir(parents=True, exist_ok=True)
        for name in RECORD_FILES:
            src = tmp / name
            if src.is_file():
                shutil.copy2(src, dest / name)
        # A small, explicit marker so a retained record is never mistaken for a
        # published version directory.
        write_json(dest / "DISCARDED.json", {"version": version, "discardedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        record_path = str(dest)

    shutil.rmtree(tmp, ignore_errors=True)
    return {"version": version, "discarded": True, "recordPath": record_path}


# ---------------------------------------------------------------- retention
#
# Retention is a policy, not a side effect. Training and promotion never prune
# anything: the lineage is append-only and immutable for as long as a version
# exists, and the ONLY thing that removes a published version is this explicit
# command. Because it is the one destructive operation in the store, it is:
#
#   - DRY-RUN BY DEFAULT. Nothing is deleted without a separate confirm flag.
#   - TOMBSTONED. Every removal writes a durable record of what was removed and
#     its digests, so a version that was deliberately pruned is
#     distinguishable from one that vanished without explanation. That is what
#     lets the git mirror keep all historical text while the store keeps only
#     the newest weights.
#   - REFUSING. The active version, operator-protected versions and retained
#     audit records are never deleted.
#   - IDEMPOTENT. The plan is recomputed from live state on every call, so an
#     interrupted prune is finished by running it again rather than guessed at.
#
# Retained: the active version (always, even outside the window) plus the `keep`
# most recent published versions, plus anything explicitly protected.
#
# Version NUMBERING (monotonic, gap-preserving) is a separate concern, defined
# with `next_version`/`allocate_version` in the versions section above.


PRUNE_DEFAULT_KEEP = 5
# Resume-state pickles (~0.5 GB each) accumulate one per committed version and
# are the dominant disk consumer after publishing. `prune-runs` is a SEPARATE,
# narrower operation than `prune`: it never deletes a published version, only
# the optimizer-moment pickles, and keeps the most recent versions resumable.
RUNS_PRUNE_DEFAULT_KEEP = 2
PRUNED_DIR_NAME = "_pruned"
PRUNE_LOG_NAME = "_prune-log.ndjson"
RUNS_PRUNE_LOG_NAME = "_prune-runs-log.ndjson"
RUNS_DIR_NAME = "_runs"


def _dir_bytes(path: Path) -> int:
    total = 0
    for entry in Path(path).rglob("*"):
        try:
            if entry.is_file():
                total += entry.stat().st_size
        except OSError:
            continue
    return total


def pruned_dir(root: Path) -> Path:
    return Path(root) / PRUNED_DIR_NAME


def prune_log_path(root: Path) -> Path:
    return Path(root) / PRUNE_LOG_NAME


def tombstone_path(root: Path, version: str) -> Path:
    return pruned_dir(root) / f"{version}.json"


def pruned_versions(root: Path) -> Dict[str, Dict[str, Any]]:
    """Every version that was deliberately pruned, keyed by version name.

    A tombstone is the difference between "the weights were removed on purpose
    and the record was kept" and "the weights are gone and nobody knows why".
    """
    root = Path(root)
    out: Dict[str, Dict[str, Any]] = {}
    directory = pruned_dir(root)
    if not directory.is_dir():
        return out
    for entry in sorted(directory.glob("v*.json")):
        try:
            record = read_json(entry)
        except (json.JSONDecodeError, OSError):
            continue
        version = record.get("version")
        if version:
            out[version] = record
    return out


def resume_state_path(root: Path, version: str) -> Path:
    return Path(root) / RUNS_DIR_NAME / f"{version}.train-state.pt"


def is_resumable(root: Path, version: str) -> bool:
    """True when this version can still continue a run.

    Both halves are needed: the readable JSON carries the config/dataset identity
    the guard checks, the pickle carries the optimizer moments. Neither alone can
    resume, and silently resuming without the moments would restart AdamW's
    accumulators from zero.
    """
    root = Path(root)
    return (
        (root / version / "train-state.json").is_file()
        and resume_state_path(root, version).is_file()
    )


def resume_capability(root: Path, version: str) -> Optional[Dict[str, Any]]:
    """Where a version's resumable state lives, or None if it has none."""
    if not is_resumable(root, version):
        return None
    return {
        "version": version,
        "stateJson": str(root / version / "train-state.json"),
        "pickle": str(resume_state_path(root, version)),
        "pickleBytes": resume_state_path(root, version).stat().st_size,
    }


def plan_prune(
    root: Path,
    keep: int = PRUNE_DEFAULT_KEEP,
    *,
    active: Optional[str] = None,
    protect: Sequence[str] = (),
) -> Dict[str, Any]:
    """Compute a pruning plan WITHOUT touching anything.

    Planning is deliberately separate from deleting: the report an operator
    reviews is the same object the deleter executes, so a confirmation cannot
    drift from what was proposed.
    """
    root = Path(root)
    if keep < 0:
        raise ValueError(f"keep must be >= 0, got {keep}")

    committed = [v for v in list_versions(root) if is_committed(root / v)]
    tombstones = pruned_versions(root)

    protected: list[Dict[str, Any]] = []
    protected_names: set[str] = set()

    def _protect(version: str, reason: str) -> None:
        if version and version in committed:
            if version not in protected_names:
                protected_names.add(version)
                protected.append({"version": version, "reason": reason})

    # The active brain is never deletable, even when it falls outside the window.
    if active:
        _protect(active, "active pointer")
        if active not in committed:
            protected.append({
                "version": active,
                "reason": "active version is not committed in this store",
                "invalid": True,
            })
    for version in protect or ():
        _protect(version, "operator-protected")

    window = committed[-keep:] if keep > 0 else []
    for version in window:
        _protect(version, f"one of the {keep} most recent published versions")

    prune: list[Dict[str, Any]] = []
    resume_lost: list[Dict[str, Any]] = []
    for version in committed:
        if version in protected_names:
            continue
        resume = resume_capability(root, version)
        entry = {
            "version": version,
            "bytes": _dir_bytes(root / version),
            "reason": "older than the retained window",
        }
        if resume:
            entry["bytes"] += resume["pickleBytes"]
            entry["resumeCapability"] = True
            resume_lost.append(resume)
        else:
            entry["resumeCapability"] = False
        prune.append(entry)

    # Informational, not a conflict: a retained version's PARENT going away only
    # breaks `diff`/`eval` against that ancestor, never training or serving.
    parent_of_retained = [
        {"retained": v, "lostParent": (read_json(root / v / "init-manifest.json") or {}).get("parentVersion")}
        for v in window
        if (read_json(root / v / "init-manifest.json") or {}).get("parentVersion") in {p["version"] for p in prune}
    ]

    return {
        "store": str(root),
        "keep": keep,
        "activeVersion": active,
        "published": committed,
        "retained": committed[-max(keep, 0):] if keep > 0 else [],
        "protected": protected,
        "prune": prune,
        "pruneCount": len(prune),
        "freedBytes": sum(p["bytes"] for p in prune),
        "resumeLost": resume_lost,
        "resumeLostCount": len(resume_lost),
        "resumeRetained": [
            resume_capability(root, v) for v in window if is_resumable(root, v)
        ],
        "parentOfRetainedLost": parent_of_retained,
        "tombstonesAlready": sorted(tombstones),
        "uncommittedVersions": [v for v in list_versions(root) if not is_committed(root / v)],
    }


def _write_tombstone(root: Path, version: str, reason: str) -> Dict[str, Any]:
    """Durably record that a version's weights were removed on purpose.

    Written BEFORE the directory is deleted, and it carries a digest of every
    record file, so a later `verify_mirror` can prove the retained git mirror
    still describes exactly what was pruned.
    """
    root = Path(root)
    src = root / version
    files: Dict[str, Any] = {}
    for name in RECORD_FILES:
        candidate = src / name
        if candidate.is_file():
            files[name] = {
                "sha256": file_sha256(candidate),
                "bytes": candidate.stat().st_size,
            }
    manifest = {}
    if (src / "init-manifest.json").is_file():
        try:
            manifest = read_json(src / "init-manifest.json")
        except (json.JSONDecodeError, OSError):
            manifest = {}
    # A tombstone is a PROVENANCE record, so an unnameable manifest must not
    # abort the deletion half-way through the prune set.
    try:
        artifact = artifact_name(manifest) if manifest else None
    except ValueError:
        artifact = None
    record = {
        "schema": "sma/pruned@1",
        "version": version,
        "prunedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "reason": reason,
        "weightBytes": _dir_bytes(src),
        "recordFiles": files,
        "artifactId": artifact,
        "parentVersion": manifest.get("parentVersion"),
        "createdAt": manifest.get("createdAt"),
        "mirror": "retained in git",
    }
    write_json(tombstone_path(root, version), record)
    return record


def prune_versions(
    root: Path,
    keep: int = PRUNE_DEFAULT_KEEP,
    *,
    active: Optional[str] = None,
    protect: Sequence[str] = (),
    confirm: bool = False,
    allow_resume_loss: bool = False,
) -> Dict[str, Any]:
    """Delete published versions outside the retained window.

    DRY RUN unless `confirm` is True. Re-running after an interruption is safe
    because the plan is recomputed from live state each time: whatever already
    went is simply not in the plan any more.
    """
    root = Path(root)
    plan = plan_prune(root, keep, active=active, protect=protect)

    if not confirm:
        plan["executed"] = False
        plan["dryRun"] = True
        plan["reason"] = "dry run: pass --confirm to delete; nothing was removed"
        return plan

    if plan["pruneCount"] == 0:
        plan.update({
            "executed": True,
            "dryRun": False,
            "removed": [],
            "removedCount": 0,
            "freedBytes": 0,
            "reason": "nothing to prune",
        })
        return plan

    if plan["resumeLostCount"] and not allow_resume_loss:
        plan["executed"] = False
        plan["dryRun"] = False
        plan["refused"] = True
        plan["removed"] = []
        plan["reason"] = (
            f"{plan['resumeLostCount']} version(s) in the prune set are still resumable "
            f"({', '.join(sorted(r['version'] for r in plan['resumeLost']))}); "
            "pass --allow-resume-loss to confirm that this resume capability is discarded"
        )
        return plan

    removed: list[Dict[str, Any]] = []
    for entry in plan["prune"]:
        version = entry["version"]
        version_dir = root / version
        if not version_dir.is_dir():
            # Already gone: an interrupted earlier pass, or a concurrent prune.
            continue
        if is_committed(version_dir) is False:
            continue
        # Tombstone first: if the process dies mid-delete, the tombstone is what
        # distinguishes "pruned on purpose" from "vanished".
        record = _write_tombstone(root, version, entry["reason"])
        weight_bytes = record["weightBytes"]
        shutil.rmtree(version_dir, ignore_errors=True)
        pickle = resume_state_path(root, version)
        pickle_bytes = 0
        if pickle.is_file():
            try:
                pickle_bytes = pickle.stat().st_size
            except OSError:
                pickle_bytes = 0
            pickle.unlink(missing_ok=True)
        removed.append({
            "version": version,
            "weightBytes": weight_bytes,
            "resumePickleBytes": pickle_bytes,
            "bytes": weight_bytes + pickle_bytes,
            "recordFiles": sorted(record["recordFiles"]),
        })

    outcome = {
        "schema": "sma/pruned@1",
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "keep": keep,
        "activeVersion": active,
        "protected": [p["version"] for p in plan["protected"]],
        "removed": removed,
        "removedCount": len(removed),
        "freedBytes": sum(r["bytes"] for r in removed),
        "allowResumeLoss": allow_resume_loss,
    }
    # Durable, append-only: the pruning decision and its outcome are part of the
    # audit trail, not a console line that scrolls away.
    log = prune_log_path(root)
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(outcome, sort_keys=True, default=str) + "\n")
        fh.flush()
        os.fsync(fh.fileno())

    plan["executed"] = True
    plan["dryRun"] = False
    plan["removed"] = removed
    plan["removedCount"] = len(removed)
    plan["freedBytes"] = sum(r["bytes"] for r in removed)
    return plan


def runs_prune_log_path(root: Path) -> Path:
    return Path(root) / RUNS_PRUNE_LOG_NAME


def plan_prune_runs(
    root: Path,
    keep: int = RUNS_PRUNE_DEFAULT_KEEP,
    *,
    active: Optional[str] = None,
    protect: Sequence[str] = (),
) -> Dict[str, Any]:
    """Compute a resume-state pruning plan WITHOUT touching anything.

    The `_runs/` directory holds one `<version>.train-state.pt` pickle per
    version — the optimizer moments that make a paused training resumable. After
    a version is committed and a newer one exists, that pickle is dead weight
    (hundreds of MB each). This plan keeps the `keep` most recent committed
    versions (plus the active version and operator-protected ones) resumable and
    proposes the rest for deletion. Only `*.train-state.pt` files are ever in
    scope; published version directories are never touched.
    """
    root = Path(root)
    if keep < 0:
        raise ValueError(f"keep must be >= 0, got {keep}")

    committed = [v for v in list_versions(root) if is_committed(root / v)]
    retained = committed[-keep:] if keep > 0 else []
    retained_set = set(retained)
    if active:
        retained_set.add(active)
    for version in protect or ():
        retained_set.add(version)

    runs_dir = root / RUNS_DIR_NAME
    candidates: list[Dict[str, Any]] = []
    if runs_dir.is_dir():
        for path in sorted(runs_dir.glob("*.train-state.pt")):
            version = path.name[: -len(".train-state.pt")]
            try:
                size = path.stat().st_size
            except OSError:
                size = 0
            if version in retained_set:
                continue
            if version in committed:
                reason = "resume state for a version outside the retained window"
            else:
                reason = "orphan resume state (no committed version in this store)"
            candidates.append({
                "version": version,
                "file": str(path),
                "name": path.name,
                "bytes": size,
                "reason": reason,
            })

    return {
        "store": str(root),
        "keep": keep,
        "activeVersion": active,
        "published": committed,
        "retained": retained,
        "protected": sorted(p for p in retained_set if p not in committed),
        "prune": candidates,
        "pruneCount": len(candidates),
        "freedBytes": sum(c["bytes"] for c in candidates),
    }


def prune_runs(
    root: Path,
    keep: int = RUNS_PRUNE_DEFAULT_KEEP,
    *,
    active: Optional[str] = None,
    protect: Sequence[str] = (),
    confirm: bool = False,
) -> Dict[str, Any]:
    """Delete stale resume-state pickles. DRY RUN unless `confirm` is True.

    Never deletes a published version or any record/weight file — only the
    `_runs/*.train-state.pt` optimizer-moment blobs that are no longer needed to
    resume. Re-running is safe: the plan is recomputed from live state.
    """
    root = Path(root)
    plan = plan_prune_runs(root, keep, active=active, protect=protect)

    if not confirm:
        plan["executed"] = False
        plan["dryRun"] = True
        plan["reason"] = "dry run: pass --confirm to delete; nothing was removed"
        return plan

    removed: list[Dict[str, Any]] = []
    for entry in plan["prune"]:
        path = Path(entry["file"])
        if not path.is_file():
            continue
        try:
            size = path.stat().st_size
        except OSError:
            size = entry["bytes"]
        path.unlink(missing_ok=True)
        removed.append({**entry, "bytes": size})

    outcome = {
        "schema": "sma/pruned-runs@1",
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "keep": keep,
        "activeVersion": active,
        "removed": removed,
        "removedCount": len(removed),
        "freedBytes": sum(r["bytes"] for r in removed),
    }
    log = runs_prune_log_path(root)
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(outcome, sort_keys=True, default=str) + "\n")
        fh.flush()
        os.fsync(fh.fileno())

    plan["executed"] = True
    plan["dryRun"] = False
    plan["removed"] = removed
    plan["removedCount"] = len(removed)
    plan["freedBytes"] = sum(r["bytes"] for r in removed)
    return plan


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


def verify_mirror(
    root: Path,
    repo_models: Path,
    *,
    check_history: bool = True,
) -> Dict[str, Any]:
    """Check every git-tracked record against the store it claims to describe.

    Symmetric on purpose, in both directions:
      - a record file the store has and the mirror does not is drift;
      - a mirror directory with NO store version behind it is also checked,
        because otherwise the mirror could accumulate invented content and still
        report clean -- precisely the failure this mirror exists to avoid.

    A mirror directory whose version was deliberately pruned is NOT drift: the
    store keeps only the newest weights while the mirror keeps ALL historical
    text, so the version is reported under `retainedHistory` and its digests are
    re-checked against its prune tombstone. Missing with a tombstone is a policy
    outcome; missing without one is an unexplained disappearance and stays drift.

    `check_history=False` reverts to checking only live versions, for callers
    that want the cost of a full scan avoided and will accept the asymmetry.
    """
    root = Path(root)
    repo_models = Path(repo_models)
    tombstones = pruned_versions(root) if check_history else {}

    results, drifted, retained_history = [], [], []

    def _check_files(version: str, src: Path, dest: Path) -> None:
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

    def _check_stray(version: str, dest: Path) -> None:
        # Anything else in the mirror is unrequested content. A weight file
        # copied here by accident, or a hand-written claim, must not pass as
        # if it were part of the reviewed record.
        for stray in sorted(p for p in dest.iterdir() if p.is_file()):
            if stray.name in RECORD_FILES:
                continue
            drifted.append({"version": version, "file": stray.name, "reason": "not a record file"})

    for version in list_versions(root):
        src = Path(root) / version
        dest = repo_models / version
        if not dest.is_dir():
            continue
        _check_files(version, src, dest)
        _check_stray(version, dest)
        results.append(version)

    if check_history:
        live = set(list_versions(root))
        mirror_dirs = sorted(p for p in repo_models.iterdir() if p.is_dir()) if repo_models.is_dir() else []
        for dest in mirror_dirs:
            version = dest.name
            if version in live:
                continue
            tombstone = tombstones.get(version)
            # The tombstone's digests are the store's own record of what it held,
            # so the retained history can still be proven byte-for-byte.
            if tombstone:
                for name, recorded in sorted((tombstone.get("recordFiles") or {}).items()):
                    mirrored = dest / name
                    if not mirrored.is_file():
                        drifted.append({"version": version, "file": name, "reason": "pruned version's record missing from mirror"})
                    elif file_sha256(mirrored) != recorded.get("sha256"):
                        drifted.append({"version": version, "file": name, "reason": "mirror no longer matches the pruned record"})
                _check_stray(version, dest)
                retained_history.append({
                    "version": version,
                    "prunedAt": tombstone.get("prunedAt"),
                    "reason": tombstone.get("reason"),
                    "recordFiles": sorted(tombstone.get("recordFiles") or {}),
                })
            elif dest.name.startswith("v") and dest.name[1:].isdigit():
                drifted.append({"version": version, "file": None, "reason": "mirror directory has no store version and no prune tombstone"})

    return {
        "store": str(root),
        "mirror": str(repo_models),
        "checked": results,
        "drifted": drifted,
        "retainedHistory": retained_history,
        "prunedCount": len(retained_history),
        "ok": not drifted,
    }


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

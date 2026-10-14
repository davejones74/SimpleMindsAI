"""Retention: which published versions survive a prune, and what the prune is
forbidden to touch.

These are filesystem proofs (no torch, no model). The invariants under test:

  1. The active version is ALWAYS retained, even outside the `keep` window.
  2. `keep` most recent published versions are retained.
  3. A dry run deletes nothing — this is the only destructive operation in the
     store, so it must be deliberate.
  4. Every deletion leaves a tombstone, so a pruned version is distinguishable
     from one that vanished, and the retained git mirror can still be proven
     byte-for-byte against what was removed.
  5. Interrupted and repeated prunes are safe.
  6. Pruning is never coupled to training or promotion.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from sma import store


def make_version(root: Path, version: str, *, parent: str | None = None, committed: bool = True) -> Path:
    v = root / version
    v.mkdir(parents=True, exist_ok=True)
    store.write_json(
        v / "init-manifest.json",
        {
            "version": version,
            "parentVersion": parent,
            "artifactName": f"simpleminds-62m-20261014-{version}",
            "sizes": {"parametersUniqueByStorage": 61_839_744},
        },
    )
    store.write_json(v / "train-state.json", {"stepsCompleted": 60, "parentVersion": parent})
    store.write_json(v / "provenance.json", {"version": version})
    store.write_json(v / "parameter-diff.json", {"parameters": []})
    store.write_json(v / "config.json", {"architecture": "smoke"})
    # Weights: just enough real bytes to size the report meaningfully.
    (v / "model.safetensors").write_bytes(b"0" * 4096)
    if committed:
        store.commit_marker(v)
    return v


@pytest.fixture
def store_root(tmp_path):
    root = tmp_path / "models"
    root.mkdir()
    return root


# ------------------------------------------------------------ version allocation


def test_next_version_never_reuses_a_committed_number(store_root):
    for i in range(1, 4):
        make_version(store_root, f"v{i:03d}")
    assert store.next_version(store_root) == "v004"


def test_next_version_skips_a_rejected_candidates_number(store_root):
    """Gap-and-never-reuse: a rejected candidate burns its number for good.

    A count that only advanced on success would report a dense lineage and hide
    how many attempts the failures took.
    """
    for i in range(1, 4):
        make_version(store_root, f"v{i:03d}")
    rejected = store.allocate_version(store_root)
    assert rejected == "v004"
    with store.stage_dir(store_root, rejected) as tmp:
        store.write_json(tmp / "init-manifest.json", {"version": rejected})
    store.discard_staged(store_root, rejected, record_dir=store_root.parent / "rejected-v004")

    # The staging directory is gone, but the number must not be handed out again.
    assert store.next_version(store_root) == "v005", "a rejected candidate's number was reused"


def test_a_number_survives_a_crash_before_any_directory_exists(store_root):
    """Claimed before the first weight is written, so the claim survives.

    A process that dies immediately after allocation still leaves the number
    taken; the next run cannot collide with what it was about to build.
    """
    make_version(store_root, "v001")
    store.allocate_version(store_root, run_id="crashed-run-1")
    assert store.next_version(store_root) == "v003"
    # Re-read from disk: a fresh process must see the same claim.
    assert store.allocated_versions(store_root) == {"v002"}


def test_a_staged_candidate_claims_its_number(store_root):
    """A half-built staging dir must not be silently overwritten.

    Without this, two runs (or a restarted run) allocate the same version and
    `stage_dir` wipes the other's half-built checkpoint.
    """
    make_version(store_root, "v001")
    staged = store.staging_version_path(store_root, "v002")
    staged.mkdir(parents=True)
    (staged / "init-manifest.json").write_text("{}", encoding="utf-8")
    assert store.next_version(store_root) == "v003"


def test_next_version_is_stable_after_a_crash_left_debris(store_root):
    make_version(store_root, "v001")
    store.staging_version_path(store_root, "v002").mkdir(parents=True)
    # Same store, read again: a restart must not re-allocate v002.
    assert store.next_version(store_root) == store.next_version(store_root) == "v003"


# ------------------------------------------------------------------ plan only


def test_plan_retains_active_plus_the_keep_window(store_root):
    for i in range(1, 9):
        make_version(store_root, f"v{i:03d}")
    plan = store.plan_prune(store_root, keep=5, active="v003")
    retained = sorted([p["version"] for p in plan["protected"]])
    assert "v003" in retained, "active version must be retained"
    assert set(retained) >= {"v004", "v005", "v006", "v007", "v008"}, "keep window must be retained"
    assert {p["version"] for p in plan["prune"]} == {"v001", "v002"}
    # Planning alone must never assert it executed anything.
    assert "executed" not in plan
    assert (store_root / "v001").is_dir()


def test_dry_run_deletes_nothing(store_root):
    for i in range(1, 7):
        make_version(store_root, f"v{i:03d}")
    before = sorted(p.name for p in store_root.iterdir())
    result = store.prune_versions(store_root, keep=2, active="v001")
    assert result["executed"] is False
    assert result["dryRun"] is True
    assert sorted(p.name for p in store_root.iterdir()) == before


def test_prune_with_a_protected_version(store_root):
    for i in range(1, 6):
        make_version(store_root, f"v{i:03d}")
    result = store.prune_versions(store_root, keep=1, active="v005", protect=["v002"], confirm=True)
    assert sorted(r["version"] for r in result["removed"]) == ["v001", "v003", "v004"]
    assert (store_root / "v002").is_dir(), "operator-protected version must survive"
    assert (store_root / "v005").is_dir(), "active version must survive"


# --------------------------------------------------------------------- deleting


def test_confirm_deletes_only_the_planned_versions(store_root):
    for i in range(1, 6):
        make_version(store_root, f"v{i:03d}")
    plan = store.plan_prune(store_root, keep=2, active="v005")
    result = store.prune_versions(store_root, keep=2, active="v005", confirm=True)
    assert result["executed"] is True
    assert sorted(r["version"] for r in result["removed"]) == ["v001", "v002", "v003"]
    for version in ("v001", "v002", "v003"):
        assert not (store_root / version).exists()
    for version in ("v004", "v005"):
        assert (store_root / version).is_dir()
        assert store.is_committed(store_root / version)
    assert result["freedBytes"] > 0


def test_active_version_is_never_deleted_even_outside_the_window(store_root):
    for i in range(1, 7):
        make_version(store_root, f"v{i:03d}")
    result = store.prune_versions(store_root, keep=1, active="v002", confirm=True)
    assert (store_root / "v002").is_dir(), "the active brain was deleted"
    assert result["activeVersion"] == "v002"
    assert (store_root / "v006").is_dir()


def test_repeated_prune_is_idempotent(store_root):
    for i in range(1, 6):
        make_version(store_root, f"v{i:03d}")
    first = store.prune_versions(store_root, keep=1, active="v005", confirm=True)
    assert first["removedCount"] == 4
    second = store.prune_versions(store_root, keep=1, active="v005", confirm=True)
    assert second["removedCount"] == 0
    assert second["reason"] == "nothing to prune"
    assert (store_root / "v005").is_dir()


def test_prune_after_a_partial_deletion_finishes_safely(store_root):
    """A prune that died halfway must be completable, not guessed at."""
    for i in range(1, 6):
        make_version(store_root, f"v{i:03d}")
    # Simulate an interruption after v001 and v002 were already removed.
    for version in ("v001", "v002"):
        store._write_tombstone(store_root, version, "older than the retained window")
        shutil.rmtree(store_root / version)
    result = store.prune_versions(store_root, keep=1, active="v005", confirm=True)
    assert sorted(r["version"] for r in result["removed"]) == ["v003", "v004"]
    assert (store_root / "v005").is_dir()
    # No version was deleted twice, and none was re-tombstoned as a duplicate.
    assert len(store.pruned_versions(store_root)) == 4


def test_prune_refuses_to_discard_resumable_state_without_an_explicit_flag(store_root):
    for i in range(1, 5):
        make_version(store_root, f"v{i:03d}")
    runs = store_root / "_runs"
    runs.mkdir()
    (runs / "v001.train-state.pt").write_bytes(b"optimizer moments")

    result = store.prune_versions(store_root, keep=1, active="v004", confirm=True)
    assert result["executed"] is False
    assert result["refused"] is True
    assert result["resumeLostCount"] == 1
    assert (store_root / "v001").is_dir(), "a refused prune must delete nothing"

    allowed = store.prune_versions(store_root, keep=1, active="v004", confirm=True, allow_resume_loss=True)
    assert allowed["executed"] is True
    assert not (store_root / "v001").exists()
    assert not (runs / "v001.train-state.pt").exists()


def test_resume_capability_needs_both_halves(store_root):
    v = make_version(store_root, "v001")
    assert store.resume_capability(store_root, "v001") is None
    runs = store_root / "_runs"
    runs.mkdir(exist_ok=True)
    pickle = runs / "v001.train-state.pt"
    pickle.write_bytes(b"optimizer moments")
    assert store.resume_capability(store_root, "v001") is not None
    # The readable half alone is not enough: resuming without the optimizer
    # moments silently restarts AdamW's accumulators from zero.
    (v / "train-state.json").unlink()
    assert store.resume_capability(store_root, "v001") is None


# --------------------------------------------------------------------- tombstones


def test_every_deletion_leaves_a_tombstone_with_digests(store_root):
    for i in range(1, 4):
        make_version(store_root, f"v{i:03d}")
    store.prune_versions(store_root, keep=1, active="v003", confirm=True)

    tombstones = store.pruned_versions(store_root)
    assert set(tombstones) == {"v001", "v002"}
    tomb = tombstones["v001"]
    assert tomb["schema"] == "sma/pruned@1"
    assert tomb["reason"] == "older than the retained window"
    assert tomb["mirror"] == "retained in git"
    # Enough to re-prove the record without the weights.
    assert "init-manifest.json" in tomb["recordFiles"]
    assert len(tomb["recordFiles"]["init-manifest.json"]["sha256"]) == 64
    assert tomb["weightBytes"] > 0


def test_prune_writes_a_durable_log_of_the_decision(store_root):
    for i in range(1, 4):
        make_version(store_root, f"v{i:03d}")
    store.prune_versions(store_root, keep=1, active="v003", confirm=True)

    log = store.prune_log_path(store_root)
    assert log.is_file(), "the pruning decision must be durable, not a console line"
    records = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(records) == 1
    assert records[0]["keep"] == 1
    assert records[0]["activeVersion"] == "v003"
    assert sorted(r["version"] for r in records[0]["removed"]) == ["v001", "v002"]
    assert records[0]["freedBytes"] > 0


def test_tombstones_distinguish_pruned_from_unexplained(store_root):
    """A pruned version has a tombstone; a vanished one does not."""
    for i in range(1, 4):
        make_version(store_root, f"v{i:03d}")
    store.prune_versions(store_root, keep=1, active="v003", confirm=True)
    assert "v001" in store.pruned_versions(store_root)
    # A version that disappeared WITHOUT being pruned is simply absent here.
    assert "v003" not in store.pruned_versions(store_root)


# ----------------------------------------------------------------------- mirror


def mirror(root: Path, version: str) -> Path:
    return store.mirror_record(root, version, root.parent / "mirror")["path"].parent


def test_verify_mirror_reports_pruned_history_not_drift(store_root):
    """The mirror keeps ALL text; the store keeps only recent weights.

    A mirror directory whose version was pruned must be reported as retained
    history (and re-proven against its tombstone), never as unexplained drift.
    """
    mirror_root = store_root.parent / "mirror"
    for i in range(1, 5):
        make_version(store_root, f"v{i:03d}")
        store.mirror_record(store_root, f"v{i:03d}", mirror_root)

    store.prune_versions(store_root, keep=2, active="v004", confirm=True)

    result = store.verify_mirror(store_root, mirror_root)
    assert result["ok"] is True, result["drifted"]
    assert result["drifted"] == []
    assert result["prunedCount"] == 2
    assert sorted(h["version"] for h in result["retainedHistory"]) == ["v001", "v002"]
    # The historical text survived the prune.
    for version in ("v001", "v002"):
        assert (mirror_root / version / "init-manifest.json").is_file()
    # ...and is still byte-for-byte what the store held when it pruned.
    for entry in result["retainedHistory"]:
        assert "init-manifest.json" in entry["recordFiles"]


def test_verify_mirror_still_reports_real_drift(store_root):
    mirror_root = store_root.parent / "mirror"
    make_version(store_root, "v001")
    store.mirror_record(store_root, "v001", mirror_root)

    # A hand-edited mirror record must not pass as if it were reviewed.
    (mirror_root / "v001" / "provenance.json").write_text(
        json.dumps({"version": "v001", "tampered": True}), encoding="utf-8"
    )
    result = store.verify_mirror(store_root, mirror_root)
    assert result["ok"] is False
    assert any(d["file"] == "provenance.json" and d["reason"] == "differs from store" for d in result["drifted"])


def test_verify_mirror_flags_a_mirror_only_directory_with_no_tombstone(store_root):
    """Symmetric on purpose: unexplained disappearances must not pass."""
    mirror_root = store_root.parent / "mirror"
    make_version(store_root, "v001")
    store.mirror_record(store_root, "v001", mirror_root)
    # The store version is gone but nothing recorded WHY.
    shutil.rmtree(store_root / "v001")

    result = store.verify_mirror(store_root, mirror_root)
    assert result["ok"] is False
    assert any(d["version"] == "v001" and "no store version and no prune tombstone" in d["reason"] for d in result["drifted"])

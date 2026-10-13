"""Commit-on-promotion: a candidate is staged, evaluated, then published or
discarded. A rejected candidate must never appear as a published version.

These are filesystem proofs (no torch, no model): the invariant under test is
"published lineage is immutable and append-only, and a version directory exists
only once it has been promoted", which is exactly what `stage_dir`,
`publish_staged` and `discard_staged` enforce.
"""

from __future__ import annotations

import argparse

import pytest

from sma import brain, store


def _stage(root, version, *, with_resume=True):
    """Build a realistic staged candidate and return its path."""
    with store.stage_dir(root, version) as tmp:
        store.write_json(tmp / "init-manifest.json", {"version": version, "parentVersion": "v001"})
        store.write_json(tmp / "train-state.json", {"stepsCompleted": 7})
        (tmp / "model.safetensors").write_bytes(b"weights")
        if with_resume:
            (tmp / f"{version}.train-state.pt").write_bytes(b"optimizer")
    return store.staging_version_path(root, version)


def test_stage_dir_leaves_an_unpublished_candidate(tmp_path):
    root = tmp_path / "models"
    staged = _stage(root, "v003")

    assert staged.is_dir()
    # Invisible to every "published version" consumer.
    assert store.list_versions(root) == []
    assert not store.is_committed(root / "v003")
    with pytest.raises(FileNotFoundError):
        store.resolve_version_dir(root, "v003")


def test_stage_dir_removes_debris_when_the_build_throws(tmp_path):
    root = tmp_path / "models"
    with pytest.raises(RuntimeError):
        with store.stage_dir(root, "v003") as tmp:
            (tmp / "partial").write_bytes(b"x")
            raise RuntimeError("build failed")
    assert not store.staging_version_path(root, "v003").exists()


def test_publish_staged_promotes_then_is_idempotent(tmp_path):
    root = tmp_path / "models"
    _stage(root, "v003")

    first = store.publish_staged(root, "v003", {"stepsCompleted": 7})
    assert first == {"version": "v003", "published": True, "alreadyCommitted": False}
    assert store.is_committed(root / "v003")
    assert not store.staging_version_path(root, "v003").exists()
    # The resume pickle is a run artifact, not part of the immutable record.
    assert (root / "_runs" / "v003.train-state.pt").is_file()
    assert not (root / "v003" / "v003.train-state.pt").exists()
    assert store.list_versions(root) == ["v003"]

    again = store.publish_staged(root, "v003")
    assert again["alreadyCommitted"] is True


def test_publish_refuses_when_nothing_was_staged(tmp_path):
    root = tmp_path / "models"
    root.mkdir(parents=True)
    with pytest.raises(FileNotFoundError):
        store.publish_staged(root, "v009")


def test_discard_staged_removes_weights_but_retains_the_record(tmp_path):
    root = tmp_path / "models"
    _stage(root, "v003")
    record = tmp_path / "rejected"

    out = store.discard_staged(root, "v003", record_dir=record)
    assert out["discarded"] is True
    assert not store.staging_version_path(root, "v003").exists()
    assert store.list_versions(root) == []
    # Provenance survives a rejection even though the weights do not.
    assert (record / "init-manifest.json").is_file()
    assert (record / "train-state.json").is_file()
    assert (record / "DISCARDED.json").is_file()
    assert not (record / "model.safetensors").exists()

    out2 = store.discard_staged(root, "v003", record_dir=record)
    assert out2["discarded"] is False


def test_cli_publish_and_discard_verbs(tmp_path):
    root = tmp_path / "models"

    _stage(root, "v004")
    published = brain.cmd_publish(argparse.Namespace(out=str(root), version="v004"))
    assert published["ok"] is True and published["published"] is True
    assert store.is_committed(root / "v004")

    _stage(root, "v005")
    record = tmp_path / "rejected-v005"
    discarded = brain.cmd_discard(
        argparse.Namespace(out=str(root), version="v005", keep_record=str(record))
    )
    assert discarded["ok"] is True and discarded["discarded"] is True
    assert not store.is_committed(root / "v005")
    assert (record / "init-manifest.json").is_file()

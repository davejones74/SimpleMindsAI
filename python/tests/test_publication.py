"""Publication naming: `simpleminds-<size>-<date>-<hash12>`.

These tests exist because the name is a *claim*. A downloader is supposed to
recompute the 12-hex suffix from the weights and fail loudly on a mismatch,
which only means anything if the name is genuinely a function of content and
genuinely stable otherwise. A name that drifts, or that is insensitive to a
changed tensor, is worse than no name at all: it looks like verification and
is not.
"""

from __future__ import annotations

import copy
import os
from pathlib import Path

import pytest

from sma import store


def _manifest(**overrides):
    """A minimal manifest shaped like a real one, without building a model."""
    base = {
        "version": "v002",
        "createdAt": "2026-09-25T22:41:29Z",
        "sizes": {"parametersUniqueByStorage": 61_839_744},
        "tensors": {"model.norm.weight": "a" * 64, "model.embed_tokens.weight": "b" * 64},
    }
    base.update(overrides)
    return base


# ------------------------------------------------------------------ size tag


@pytest.mark.parametrize(
    ("count", "expected"),
    [
        (61_839_744, "62m"),
        (3_075_098_624, "3b"),
        (999_999_999, "1000m"),  # boundary: stays on the millions side
        (1_000_000_000, "1b"),
    ],
)
def test_size_label(count, expected):
    assert store.size_label(count) == expected


# ---------------------------------------------------------------- the name


def test_artifact_name_is_the_agreed_shape():
    name = store.artifact_name(_manifest())
    assert name == "simpleminds-62m-20260925-" + name.rsplit("-", 1)[1]
    assert name.startswith("simpleminds-62m-20260925-")
    assert len(name.rsplit("-", 1)[1]) == 12


def test_artifact_name_does_not_credit_a_third_party_model():
    """The name is this project's work, not SmolLM3's.

    A name carrying someone else's model would contradict the invariant it is
    meant to advertise: the whole claim is that no pretrained weights were
    used, so borrowing another model's name invites exactly the reading the
    proof obligations exist to prevent. The architecture is still recorded
    honestly in the manifest -- just not in the artifact's headline.
    """
    manifest = _manifest(
        architectureReferenceRepo="HuggingFaceTB/SmolLM3-3B-Base",
        architecture="SmolLM3ForCausalLM",
    )
    name = store.artifact_name(manifest).lower()
    assert "smol" not in name
    assert "llama" not in name
    assert "simpleminds" in name


def test_artifact_name_is_deterministic():
    manifest = _manifest()
    assert store.artifact_name(manifest) == store.artifact_name(copy.deepcopy(manifest))


def test_artifact_name_uses_the_versions_own_date_not_todays():
    """A name that depended on when it was asked for would not be a content address."""
    manifest = _manifest(createdAt="2020-01-02T03:04:05Z")
    assert "20200102" in store.artifact_name(manifest)


# -------------------------------------------------------- content sensitivity


def test_fingerprint_changes_when_a_tensor_changes():
    a = store.artifact_name(_manifest())
    mutated = _manifest(tensors={"model.norm.weight": "c" * 64, "model.embed_tokens.weight": "b" * 64})
    assert store.artifact_name(mutated) != a


def test_fingerprint_binds_the_tensor_name_not_just_the_digest():
    """Swapping two names' digests leaves the digest multiset identical.

    This model records 76 tensors but only 59 distinct digests -- the 17
    RMSNorm weights all hold the same value. Where digests repeat, a
    hash over bare digests cannot tell a correct manifest from one that
    assigned every value to the wrong tensor, so the name has to be hashed
    over the pairs.
    """
    import hashlib

    tensors = {"model.norm.weight": "a" * 64, "model.embed_tokens.weight": "b" * 64}
    swapped = {
        "model.norm.weight": tensors["model.embed_tokens.weight"],
        "model.embed_tokens.weight": tensors["model.norm.weight"],
    }

    # The premise: a digest-only hash genuinely cannot see the difference.
    digest_only = lambda m: hashlib.sha256(  # noqa: E731
        "".join(sorted(m.values())).encode()
    ).hexdigest()
    assert digest_only(tensors) == digest_only(swapped)

    # The name, built over pairs, can.
    assert store.artifact_name(_manifest(tensors=tensors)) != store.artifact_name(
        _manifest(tensors=swapped)
    )


def test_trained_hashes_win_over_init_hashes():
    """A trained version's asset contains post-training bytes, not init bytes."""
    trained_hashes = {"model.norm.weight": "z" * 64, "model.embed_tokens.weight": "y" * 64}
    trained = _manifest(
        tensors={"model.norm.weight": "a" * 64, "model.embed_tokens.weight": "b" * 64},
        tensorHashesAfterTraining={"aliasedTensors": ["lm_head.weight"], "tensors": trained_hashes},
    )
    named_after_init = store.artifact_name(_manifest(tensors=dict(trained["tensors"])))
    named_after_training = store.artifact_name(trained)

    assert named_after_training != named_after_init
    assert named_after_training == store.artifact_name(_manifest(tensors=dict(trained_hashes)))


def test_untrained_and_trained_versions_get_different_names():
    """Same date and size, different weights, so they must not collide."""
    init = _manifest(version="v001", tensors={"model.norm.weight": "a" * 64})
    trained = _manifest(
        version="v002",
        tensors={"model.norm.weight": "a" * 64},
        tensorHashesAfterTraining={"aliasedTensors": [], "tensors": {"model.norm.weight": "b" * 64}},
    )
    assert store.artifact_name(init) != store.artifact_name(trained)


# -------------------------------------------------------------- refusals


def test_manifest_without_tensor_hashes_is_refused():
    with pytest.raises(ValueError, match="no tensor hashes"):
        store.artifact_name({"createdAt": "2026-09-25T00:00:00Z", "sizes": {"parametersUniqueByStorage": 1}})


def test_manifest_without_a_parameter_count_is_refused():
    with pytest.raises(ValueError, match="parameter count"):
        store.artifact_name({"createdAt": "2026-09-25T00:00:00Z", "tensors": {"a": "b" * 64}})


def test_manifest_without_an_iso_date_is_refused():
    """A guessed date is worse than no name: it would look verifiable."""
    with pytest.raises(ValueError, match="ISO-8601"):
        store.artifact_name(_manifest(createdAt="last tuesday"))


def test_name_is_readable_from_a_committed_version(tmp_root):
    manifest = _manifest()
    version = tmp_root / "v002"
    version.mkdir(parents=True)
    store.write_json(version / "init-manifest.json", manifest)
    store.commit_marker(version)
    assert store.artifact_name_for_version(tmp_root, "v002") == store.artifact_name(manifest)


# ------------------------------------------------------------------ export


def _committed_version(root: Path, version: str = "v002", weight: bytes = b"weights") -> Path:
    """A minimal committed version directory, no real model required."""
    path = root / version
    path.mkdir(parents=True)
    store.write_json(path / "init-manifest.json", _manifest())
    store.write_json(path / "config.json", {"model_type": "test"})
    (path / "model.safetensors").write_bytes(weight)
    store.commit_marker(path)
    return path


def test_export_lands_under_its_content_address(tmp_root):
    exports = tmp_path_dir = tmp_root.parent / "exports"
    _committed_version(tmp_root)
    result = store.export_version(tmp_root, "v002", exports)

    assert result["path"] == str(exports / store.artifact_name(_manifest()))
    assert (exports / result["artifactName"] / "model.safetensors").is_file()
    assert (exports / result["artifactName"] / "SHA256SUMS").is_file()
    assert (exports / result["artifactName"] / "EXPORT.json").is_file()
    assert tmp_path_dir.is_dir()


def test_export_is_still_directly_loadable_by_transformers(tmp_root):
    """The artifact name must not cost us the standard loader.

    Naming the weight file `simpleminds-...safetensors` would have made the
    content address and `from_pretrained` mutually exclusive. Keeping the name
    on the *directory* means the export is an ordinary checkpoint.
    """
    exports = tmp_root.parent / "exports"
    _committed_version(tmp_root)
    result = store.export_version(tmp_root, "v002", exports)
    dest = Path(result["path"])
    assert (dest / "model.safetensors").is_file()
    assert (dest / "config.json").is_file()
    assert not any(p.name.startswith("simpleminds") for p in dest.iterdir())


def test_export_records_the_version_it_came_from(tmp_root):
    exports = tmp_root.parent / "exports"
    _committed_version(tmp_root)
    result = store.export_version(tmp_root, "v002", exports)
    record = store.read_json(Path(result["path"]) / "EXPORT.json")
    assert record["sourceVersion"] == "v002"
    assert record["artifactName"] == result["artifactName"]


def test_export_refuses_to_overwrite(tmp_root):
    """A content address that already exists is already correct.

    Silently replacing it is the exact failure the naming scheme exists to
    prevent, so this must raise rather than clobber.
    """
    exports = tmp_root.parent / "exports"
    _committed_version(tmp_root)
    store.export_version(tmp_root, "v002", exports)
    with pytest.raises(FileExistsError, match="content-addressed"):
        store.export_version(tmp_root, "v002", exports)


def test_export_of_an_uncommitted_version_is_refused(tmp_root):
    exports = tmp_root.parent / "exports"
    path = tmp_root / "v002"
    path.mkdir(parents=True)
    store.write_json(path / "init-manifest.json", _manifest())
    with pytest.raises(ValueError, match="not committed"):
        store.export_version(tmp_root, "v002", exports)


def test_verify_export_accepts_an_untouched_export(tmp_root):
    exports = tmp_root.parent / "exports"
    _committed_version(tmp_root)
    result = store.export_version(tmp_root, "v002", exports)
    report = store.verify_export(Path(result["path"]))
    assert report["ok"] is True
    assert "model.safetensors" in report["verified"]


def test_verify_export_catches_a_corrupted_weight_file(tmp_root):
    exports = tmp_root.parent / "exports"
    _committed_version(tmp_root)
    result = store.export_version(tmp_root, "v002", exports)
    (Path(result["path"]) / "model.safetensors").write_bytes(b"tampered")

    report = store.verify_export(Path(result["path"]))
    assert report["ok"] is False
    assert report["failed"][0]["file"] == "model.safetensors"
    assert report["failed"][0]["reason"] == "hash mismatch"


def test_verify_export_catches_a_missing_file(tmp_root):
    exports = tmp_root.parent / "exports"
    _committed_version(tmp_root)
    result = store.export_version(tmp_root, "v002", exports)
    (Path(result["path"]) / "config.json").unlink()

    report = store.verify_export(Path(result["path"]))
    assert report["ok"] is False
    assert report["failed"][0]["reason"] == "missing"


def test_serving_resolves_the_version_directory_not_an_export(tmp_root):
    """Chat/eval/generate load the canonical directory.

    An export is a copy for distribution. Serving from it would mean two 247 MB
    copies of the same weights and a permanent obligation to prove they agree.
    """
    _committed_version(tmp_root)
    resolved = store.resolve_version_dir(tmp_root, "v002")
    assert resolved == tmp_root / "v002"
    assert store.is_committed(resolved)
    assert store.weight_files(resolved)[0].name == "model.safetensors"


# ------------------------------------------------------- where the store lives
#
# The weights must live outside any working tree. A directory named "scratch" is
# a promise that someone will delete it; the model lineage is the one thing that
# must not be disposable. These tests pin that, because the failure mode is
# silent -- nothing errors, the weights are simply gone after a re-clone.


def test_store_root_ignores_the_working_tree_by_default(monkeypatch):
    monkeypatch.delenv("SMA_STORE", raising=False)
    root = store.store_root()
    assert "python" not in str(root).lower().split(os.sep)[-3:]


def test_store_root_follows_the_environment(monkeypatch, tmp_root):
    monkeypatch.setenv("SMA_STORE", str(tmp_root / "srv" / "sma"))
    assert store.store_root() == tmp_root / "srv" / "sma"


def test_store_root_prefers_an_explicit_argument_over_the_environment(monkeypatch, tmp_root):
    monkeypatch.setenv("SMA_STORE", str(tmp_root / "from_env"))
    assert store.store_root(tmp_root / "explicit") == tmp_root / "explicit"


def test_the_two_surviving_lineages_load_from_the_permanent_store():
    """v001 and v002 are no longer in a disposable directory."""
    root = store.store_root()
    versions = store.list_versions(root)
    assert {"v001", "v002"}.issubset(set(versions)), f"missing from {root}: {versions}"


# ------------------------------------------------------------ the git mirror


def test_mirror_carries_the_record_and_leaves_the_weights_behind(tmp_root):
    version = _committed_version(tmp_root)
    (version / "model.safetensors").write_bytes(b"x" * 4096)
    repo_models = tmp_root / "repo" / "models"

    result = store.mirror_record(tmp_root, "v002", repo_models)

    assert "model.safetensors" not in result["files"]
    assert not (repo_models / "v002" / "model.safetensors").exists()
    assert (repo_models / "v002" / "init-manifest.json").is_file()


def test_the_mirrored_record_is_small_enough_to_live_in_git(tmp_root):
    _committed_version(tmp_root)
    result = store.mirror_record(tmp_root, "v002", tmp_root / "repo")
    assert result["bytes"] < store.RECORD_MAX_BYTES


def test_mirror_verifies_clean(tmp_root):
    _committed_version(tmp_root)
    repo_models = tmp_root / "repo"
    store.mirror_record(tmp_root, "v002", repo_models)
    assert store.verify_mirror(tmp_root, repo_models)["ok"]


def test_mirror_refuses_a_binary_that_leaked_into_the_record(tmp_root):
    version = _committed_version(tmp_root)
    (version / "provenance.json").write_bytes(b"0" * (store.RECORD_MAX_BYTES + 1))
    with pytest.raises(ValueError, match="record cap"):
        store.mirror_record(tmp_root, "v002", tmp_root / "repo")


def test_mirror_needs_a_manifest(tmp_root):
    _committed_version(tmp_root)
    (tmp_root / "v002" / "init-manifest.json").unlink()
    with pytest.raises(FileNotFoundError, match="init-manifest"):
        store.mirror_record(tmp_root, "v002", tmp_root / "repo")


def test_drift_between_the_mirror_and_the_store_is_detected(tmp_root):
    _committed_version(tmp_root)
    repo_models = tmp_root / "repo"
    store.mirror_record(tmp_root, "v002", repo_models)

    # Someone hand-edits the "reviewable" copy. It must not be believed.
    (repo_models / "v002" / "init-manifest.json").write_text('{"version": "trust me"}')

    report = store.verify_mirror(tmp_root, repo_models)
    assert not report["ok"]
    assert report["drifted"][0]["reason"] == "differs from store"


def test_a_mirror_file_deleted_from_the_repo_is_detected(tmp_root):
    _committed_version(tmp_root)
    repo_models = tmp_root / "repo"
    store.mirror_record(tmp_root, "v002", repo_models)
    (repo_models / "v002" / "config.json").unlink()
    reasons = {d["reason"] for d in store.verify_mirror(tmp_root, repo_models)["drifted"]}
    assert "missing from mirror" in reasons


def test_content_invented_in_the_mirror_is_detected(tmp_root):
    """The mirror must not become a second, unverified source of truth.

    This is the dangerous direction: a file the store never had would sail
    through a store-driven comparison and then get read as reviewed history.
    """
    _committed_version(tmp_root)
    repo_models = tmp_root / "repo"
    store.mirror_record(tmp_root, "v002", repo_models)

    (repo_models / "v002" / "provenance.json").write_text('{"version": "trust me"}')

    report = store.verify_mirror(tmp_root, repo_models)
    assert not report["ok"]
    assert any(d["reason"] == "not in store" for d in report["drifted"])


def test_a_weight_stray_in_the_mirror_is_detected(tmp_root):
    _committed_version(tmp_root)
    repo_models = tmp_root / "repo"
    store.mirror_record(tmp_root, "v002", repo_models)
    (repo_models / "v002" / "model.safetensors").write_bytes(b"247 MB of trouble")

    report = store.verify_mirror(tmp_root, repo_models)
    assert not report["ok"]
    assert any(d["reason"] == "not a record file" for d in report["drifted"])


# ------------------------------------------------------ the active pointer


def test_nothing_is_active_until_it_is_set(tmp_root):
    assert store.active_version(tmp_root) is None


def test_active_points_at_the_right_artifact(tmp_root):
    _committed_version(tmp_root)
    pointer = store.set_active(tmp_root, "v002")
    assert pointer["version"] == "v002"
    assert pointer["artifactName"] == store.artifact_name_for_version(tmp_root, "v002")
    assert store.active_version(tmp_root) == "v002"


def test_active_cannot_point_at_a_version_that_does_not_exist(tmp_root):
    _committed_version(tmp_root)
    with pytest.raises(FileNotFoundError):
        store.set_active(tmp_root, "v009")


def test_active_never_appears_inside_a_manifest(tmp_root):
    """Activity is a property of a deployment, not of a weight file."""
    version = _committed_version(tmp_root)
    store.set_active(tmp_root, "v002")
    assert "active" not in (version / "init-manifest.json").read_text().lower()


def test_a_corrupt_pointer_does_not_take_the_server_down(tmp_root):
    _committed_version(tmp_root)
    store.set_active(tmp_root, "v002")
    store.active_pointer_path(tmp_root).write_text("{ not json")
    assert store.active_version(tmp_root) is None
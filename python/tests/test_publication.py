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

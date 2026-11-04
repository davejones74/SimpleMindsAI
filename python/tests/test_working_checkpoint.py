"""Durable working pointer and optimizer continuity.

These tests do not touch production. They build local committed-version metadata
and, for the optimizer test, a real short CPU training run.
"""

from __future__ import annotations

import copy
from pathlib import Path

import pytest
import torch

from conftest import FIXTURE_CORPUS
from sma import arch, data as data_mod
from sma import store
from sma import train as train_mod


def _manifest(version: str = "v001"):
    return {
        "version": version,
        "createdAt": "2026-11-02T00:00:00Z",
        "sizes": {"parametersUniqueByStorage": 61_839_744},
        "tensors": {"model.norm.weight": "a" * 64, "model.embed_tokens.weight": "b" * 64},
        "parentVersion": None,
    }


def _make_committed(root: Path, version: str):
    version_dir = root / version
    version_dir.mkdir(parents=True)
    store.write_json(version_dir / "init-manifest.json", _manifest(version))
    store.commit_marker(version_dir, {"parentVersion": None})
    return version_dir


def test_working_pointer_is_separate_from_active(tmp_path):
    root = tmp_path / "store"
    root.mkdir()
    _make_committed(root, "v001")
    _make_committed(root, "v002")

    # active remains absent until an explicit stable activation
    assert store.active_version(root) is None

    working = store.set_working(root, "v002", {"runId": "run-1", "guardDecision": "accepted"})
    assert working["version"] == "v002"
    assert working["artifactName"]
    assert working["weightFingerprint"]
    assert working["runId"] == "run-1"
    assert store.working_version(root) == "v002"
    assert store.working_pointer(root)["version"] == "v002"
    assert store.active_version(root) is None, "working must never become serving implicitly"

    last_good = store.set_working_last_good(root, "v001", {"reason": "rollback anchor"})
    assert last_good["version"] == "v001"
    assert store.working_last_good_version(root) == "v001"
    assert store.working_version(root) == "v002"


def test_working_pointer_refuses_uncommitted_or_unknown_versions(tmp_path):
    root = tmp_path / "store"
    root.mkdir()
    _make_committed(root, "v001")
    (root / "v002.tmp").mkdir()
    with pytest.raises((FileNotFoundError, ValueError)):
        store.set_working(root, "v002")
    with pytest.raises((FileNotFoundError, ValueError)):
        store.set_working(root, "v999")


def test_carry_optimizer_moments_survive_a_new_corpus_configuration(tokenizer):
    docs = data_mod.load_documents([FIXTURE_CORPUS])

    def cfg(steps=2):
        return train_mod.TrainConfig(
            learningRate=1e-4,
            steps=steps,
            sequenceLength=64,
            microBatchSize=2,
            gradAccumSteps=2,
            warmupSteps=1,
            validationBlocks=1,
            spikeWarmup=1000,
            computeDtype="float32",
            validationPolicy="legacy-tail-split",
            allowLegacyValidation=True,
        )

    model1, _, _ = arch.build_model("small", seed=7)
    model1 = model1.float()
    _r1, _s1, opt1 = train_mod.train(
        model=model1,
        tokenizer=tokenizer,
        documents=docs,
        cfg=cfg(2),
        parent_version="v001",
        new_version="v002",
        tokenizer_path=FIXTURE_CORPUS,
        device="cpu",
    )
    carried = copy.deepcopy(opt1.state_dict())
    first_step = int(next(iter(opt1.state.values()))["step"])
    assert first_step >= 2

    model2, _, _ = arch.build_model("small", seed=7)
    model2 = model2.float()
    _r2, _s2, opt2 = train_mod.train(
        model=model2,
        tokenizer=tokenizer,
        documents=docs,
        cfg=cfg(2),
        parent_version="v002",
        new_version="v003",
        tokenizer_path=FIXTURE_CORPUS,
        device="cpu",
        carry_optimizer_state=carried,
    )
    second_step = int(next(iter(opt2.state.values()))["step"])
    assert second_step > first_step, "AdamW step counters continue across the working run"
    assert torch.isfinite(torch.tensor(second_step))


def test_incompatible_carried_optimizer_state_fails_closed(tokenizer):
    docs = data_mod.load_documents([FIXTURE_CORPUS])
    model, _, _ = arch.build_model("small", seed=11)
    model = model.float()
    cfg = train_mod.TrainConfig(
        learningRate=1e-4,
        steps=1,
        sequenceLength=64,
        microBatchSize=2,
        gradAccumSteps=2,
        warmupSteps=1,
        validationBlocks=1,
        spikeWarmup=1000,
        computeDtype="float32",
        validationPolicy="legacy-tail-split",
        allowLegacyValidation=True,
    )
    with pytest.raises(ValueError, match="carry_optimizer_state"):
        train_mod.train(
            model=model,
            tokenizer=tokenizer,
            documents=docs,
            cfg=cfg,
            parent_version="v001",
            new_version="v002",
            tokenizer_path=FIXTURE_CORPUS,
            device="cpu",
            carry_optimizer_state={"state": {}, "param_groups": []},
        )

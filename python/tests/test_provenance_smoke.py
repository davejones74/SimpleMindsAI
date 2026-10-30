"""Isolated end-to-end provenance smoke test.

Gated because it performs a real random init and two optimizer steps on the 62M
development model. It uses a temporary store only; no production path is read or
written. Run with:

    SMA_RUN_SMOKE=1 python -m pytest python/tests/test_provenance_smoke.py -q
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import pytest

from sma import brain, configs

pytestmark = pytest.mark.skipif(
    os.environ.get("SMA_RUN_SMOKE") != "1",
    reason="set SMA_RUN_SMOKE=1 to run the real init/train provenance smoke test",
)


def _corpus(path: Path) -> None:
    rows = []
    for role, count in (("train", 20), ("validation", 8)):
        for index in range(count):
            text = " ".join([
                f"{role} document {index} demonstrates stable provenance and validation separation "
                "with words about engines history science and language."
            ] * 20)
            rows.append({
                "articleId": f"{role}-{index}",
                "text": text,
                "contentHash": hashlib.sha256(text.encode()).hexdigest(),
                "corpusRole": role,
            })
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")


def test_isolated_provenance_smoke(tmp_path, monkeypatch):
    store_root = tmp_path / "store"
    store_root.mkdir()
    monkeypatch.setenv("SMA_STORE", str(store_root))

    init = brain.cmd_init(argparse.Namespace(
        config="small",
        out=str(store_root),
        version="v001",
        seed=0,
        repo=configs.ARCH_REFERENCE_REPO,
    ))
    assert init["ok"] is True
    assert init["initialisationType"] == "RANDOM"
    assert init["pretrainedWeightsUsed"] is False

    corpus = tmp_path / "smoke.jsonl"
    _corpus(corpus)
    trained = brain.cmd_train(argparse.Namespace(
        out=str(store_root),
        config="small",
        parent="v001",
        version="v002",
        run_id="smoke-run",
        corpus=[str(corpus)],
        lr=1e-4,
        steps=2,
        seq_len=32,
        micro_batch=1,
        grad_accum=1,
        warmup=1,
        val_blocks=2,
        eval_every=1,
        validation_policy="document-source-disjoint",
        require_prospective_validation=True,
        allow_legacy_validation=False,
        seed=17,
        device="cpu",
        compute_dtype="float32",
        grad_clip=1.0,
        spike_factor=2.5,
        spike_consecutive=3,
        log_every=1,
        resume_from=None,
        select_best=True,
        stage_only=False,
        min_steps=0,
        min_delta=1e-7,
        document_boundary="separator",
    ))
    assert trained["ok"] is True, trained

    version = store_root / "v002"
    provenance = json.loads((version / "provenance.json").read_text())
    state = json.loads((version / "train-state.json").read_text())
    manifest = json.loads((version / "init-manifest.json").read_text())
    diff = json.loads((version / "parameter-diff.json").read_text())
    committed = json.loads((version / "COMMITTED").read_text())

    assert provenance["parentVersion"] == "v001"
    assert provenance["parentWeightFingerprint"]
    assert provenance["trainerCodeFingerprint"]["digest"]
    assert provenance["trainingSeed"] == 17
    assert provenance["pretrainedWeightsUsed"] is False
    assert provenance["parentInitialisationType"] == "RANDOM"
    assert provenance["validationSplit"]["policy"] == "document-source-disjoint"
    assert provenance["validationSplit"]["splitHash"]
    assert provenance["corpusFiles"][0]["sha256"]

    assert state["parentVersion"] == "v001"
    assert state["config"]["seed"] == 17
    assert state["corpusSplit"]["mode"] == "role-appended"
    assert state["corpusSplit"]["trainTokensSeen"] > 0
    assert state["corpusSplit"]["validationTokensSeen"] > 0
    assert state["selectedStep"] is not None
    assert state["selectedValidationLoss"] is not None

    assert manifest["pretrainedWeightsUsed"] is False
    assert manifest["derivedFrom"] == "v001"
    assert len(manifest["tensorHashesAfterTraining"]["tensors"]) == 76
    assert diff["parameters"]["changedCount"] > 0
    assert diff["buffers"]["driftedCount"] == 0
    assert committed["parentVersion"] == "v001"
    assert committed["stepsCompleted"] == 2

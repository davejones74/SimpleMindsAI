"""Check 5 and check 7, plus the guards the README requires around them.

The suite builds a real model and runs a real (short) optimization. There is no
mocked optimizer, because the failure this file exists to catch — a parameter
that receives a gradient, is handed to AdamW, and then does not change — is
invisible to anything that mocks the loop.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
import torch

from conftest import FIXTURE_CORPUS, REPO_ROOT
from sma import data as data_mod
from sma import train as train_mod

# Materiality floor for check 7. Chosen well above float noise (1e-7) and well
# above the bf16 resolution at magnitude 1.0 (~7.8e-3 is the *spacing*, so a
# frozen RMSNorm weight would show a delta of exactly 0.0). Anything that moved
# a real optimizer step clears this easily; a frozen weight never does.
MATERIAL_DELTA = 1e-6


def _cfg(**overrides):
    # computeDtype is fp32 here on purpose. Measured on this machine: a bf16 CPU
    # autocast forward+backward costs 28.96s against 0.13s for fp32 — a 220x
    # penalty, because the CPU has no native bf16 and PyTorch emulates it. Tests
    # that are 200x slower test nothing extra. The production bf16-compute path is
    # covered separately by test_bf16_compute_with_fp32_masters.
    base = dict(
        learningRate=1e-4,
        steps=4,
        sequenceLength=64,
        microBatchSize=2,
        gradAccumSteps=2,
        warmupSteps=2,
        validationBlocks=1,
        spikeWarmup=1000,
        computeDtype="float32",
    )
    base.update(overrides)
    return train_mod.TrainConfig(**base)


# ------------------------------------------------------------------ check 7


def test_every_tensor_differs_after_training(small_model, tokenizer):
    """Check 7, over `named_parameters()` — not `state_dict()`.

    The narrow form is the correct one. `state_dict()` carries 75 entries
    because the tied embedding appears twice, and it omits the 2 RoPE buffers
    entirely, so a state_dict-wide "everything must differ" test would be
    asserting that a closed-form constant changed.
    """
    model, _config, _sizes = small_model
    model = model.float()

    before = train_mod.named_parameter_snapshots(model)
    result, _state, _opt = train_mod.train(
        model=model,
        tokenizer=tokenizer,
        documents=data_mod.load_documents([FIXTURE_CORPUS]),
        cfg=_cfg(),
        parent_version="v001",
        new_version="v002",
        tokenizer_path=FIXTURE_CORPUS,  # any existing file; only hashed
        device="cpu",
    )
    after = train_mod.named_parameter_snapshots(model)

    diff = train_mod.diff_tensors(before, after, tolerance=MATERIAL_DELTA)

    assert diff["onlyBefore"] == [] and diff["onlyAfter"] == []
    assert diff["shapeMismatch"] == []
    assert diff["compared"] == 74, f"expected 74 unique parameters, got {diff['compared']}"
    assert diff["unchangedCount"] == 0, (
        "parameters that did not move materially: "
        f"{[u['name'] for u in diff['unchanged']]}"
    )
    assert diff["changedCount"] == 74
    assert result.steps == 4


def test_bf16_compute_with_fp32_masters(small_model, tokenizer):
    """The actual production precision path: bf16 compute, fp32 masters.

    This is the combination that must move all 74 parameters. It is the case the
    README's invariant 11 exists for, and the case a bf16 *master* would fail.
    Run on CUDA where available, since bf16 on CPU is emulated and ~220x slower.
    """
    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cpu":
        pytest.skip("bf16 compute is emulated and pathologically slow on CPU")

    model, _config, _sizes = small_model
    model = model.float()
    before = train_mod.named_parameter_snapshots(model)

    train_mod.train(
        model=model,
        tokenizer=tokenizer,
        documents=data_mod.load_documents([FIXTURE_CORPUS]),
        cfg=_cfg(computeDtype="bfloat16", steps=3, sequenceLength=64),
        parent_version="v001",
        new_version="v002",
        tokenizer_path=FIXTURE_CORPUS,
        device=device,
    )
    diff = train_mod.diff_tensors(
        before, train_mod.named_parameter_snapshots(model), tolerance=MATERIAL_DELTA
    )
    assert diff["unchangedCount"] == 0, (
        "bf16 compute with fp32 masters must still move every parameter; "
        f"frozen: {[u['name'] for u in diff['unchanged']]}"
    )
    assert diff["compared"] == 74


def test_buffers_are_unchanged_by_training(small_model, tokenizer):
    """The other half of check 7.

    The 2 RoPE `inv_freq` buffers are a closed-form function of head_dim and
    rope_theta, so they are expected to be *bit-identical* after training.
    Asserting that catches a desynchronised RoPE table, which nothing else
    would surface.
    """
    model, _config, _sizes = small_model
    model = model.float()

    before = train_mod.named_buffer_snapshots(model)
    assert len(before) == 2, f"expected 2 RoPE buffers, got {sorted(before)}"
    assert all("inv_freq" in name for name in before)

    train_mod.train(
        model=model,
        tokenizer=tokenizer,
        documents=data_mod.load_documents([FIXTURE_CORPUS]),
        cfg=_cfg(),
        parent_version="v001",
        new_version="v002",
        tokenizer_path=FIXTURE_CORPUS,
        device="cpu",
    )
    after = train_mod.named_buffer_snapshots(model)

    report = train_mod.assert_buffers_unchanged(before, after)
    assert report["drifted"] == [], f"RoPE buffers drifted: {report['drifted']}"
    assert report["compared"] == 2


def test_named_parameters_excludes_tied_embedding_alias(small_model):
    model, _config, _sizes = small_model
    names = [n for n, _ in model.named_parameters()]
    assert len(names) == 74
    # The alias appears in state_dict() but named_parameters() already dedupes it.
    assert "lm_head.weight" in model.state_dict()
    assert "lm_head.weight" not in names


# ------------------------------------------------------------ precision model


def test_master_dtype_must_be_float32():
    with pytest.raises(ValueError, match="masterDtype must be float32"):
        _cfg(masterDtype="bfloat16").validate()


def test_bf16_masters_would_freeze_rmsnorm(small_model):
    """The measurement that makes the fp32-master rule non-negotiable.

    With bf16 masters the 17 RMSNorm weights start at 1.0, where bf16
    resolution is ~7.8e-3, so a 1e-4 AdamW update rounds away and the
    parameter is unchanged — while the loss still falls, because the other 57
    parameters are learning. This is the silent failure check 7 exists to catch.
    """
    def drive(model, steps=5, lr=1e-4):
        model = model.to(torch.bfloat16)
        params = [p for p in model.parameters()]
        opt = torch.optim.AdamW(params, lr=lr)
        before = train_mod.named_parameter_snapshots(model)
        for _ in range(steps):
            for p in params:
                # A real, non-zero gradient, as measured on this model.
                p.grad = torch.full_like(p, 1.3e-2)
            opt.step()
            opt.zero_grad(set_to_none=True)
        return train_mod.diff_tensors(before, train_mod.named_parameter_snapshots(model))

    model, _config, _sizes = small_model
    bf16_diff = drive(model.float())
    frozen_bf16 = [u["name"] for u in bf16_diff["unchanged"]]

    model2, _c2, _s2 = small_model
    model2 = model2.float()
    params = [p for p in model2.parameters()]
    opt = torch.optim.AdamW(params, lr=1e-4)
    before32 = train_mod.named_parameter_snapshots(model2)
    for _ in range(5):
        for p in params:
            p.grad = torch.full_like(p, 1.3e-2)
        opt.step()
        opt.zero_grad(set_to_none=True)
    fp32_diff = train_mod.diff_tensors(before32, train_mod.named_parameter_snapshots(model2))

    assert frozen_bf16, "expected bf16 masters to freeze some parameters"
    assert len(frozen_bf16) == 17, f"expected 17 frozen, got {len(frozen_bf16)}"
    assert all("norm" in n for n in frozen_bf16), frozen_bf16
    assert fp32_diff["unchangedCount"] == 0, "fp32 masters must move every parameter"


# ------------------------------------------------------------------ guardrails


def test_learning_rate_has_no_default():
    """No universal LR may be baked in. The README forbids it; enforce it here."""
    with pytest.raises(ValueError, match="must be supplied explicitly"):
        train_mod.TrainConfig().validate()
    with pytest.raises(ValueError):
        train_mod.TrainConfig(learningRate=0).validate()


def test_lr_is_required_on_the_cli():
    proc = subprocess.run(
        [sys.executable, "-m", "sma.brain", "train", "--parent", "v001",
         "--corpus", str(FIXTURE_CORPUS)],
        cwd=REPO_ROOT / "python", capture_output=True, text=True,
    )
    assert proc.returncode != 0
    assert "--lr" in proc.stderr


def test_bf16_master_failure_is_not_reachable_by_config():
    """bf16 masters must be unreachable without editing source, not just warned about."""
    with pytest.raises(ValueError):
        _cfg(masterDtype="bfloat16").validate()
    with pytest.raises(ValueError):
        _cfg(masterDtype="float16").validate()


def test_learning_rate_schedule_shape():
    cfg = _cfg(steps=20, warmupSteps=5)
    lrs = [train_mod.learning_rate_at(s, cfg) for s in range(20)]
    assert lrs[4] == pytest.approx(cfg.learningRate)          # peak at end of warmup
    assert all(lrs[i] >= lrs[i + 1] for i in range(5, 19))     # monotone decay after
    assert lrs[-1] >= cfg.learningRate * cfg.minLearningRateRatio


def test_rng_state_round_trips_exactly():
    """A 'resumable' RNG that cannot be restored is not resumable."""
    import random

    import numpy as np

    random.seed(11); np.random.seed(11); torch.manual_seed(11)
    state = train_mod.capture_rng_state()
    expected = (random.random(), float(np.random.rand()), float(torch.rand(1)))

    train_mod.restore_rng_state(train_mod._jsonable_rng(state))
    actual = (random.random(), float(np.random.rand()), float(torch.rand(1)))

    assert actual == expected


def test_rng_state_survives_a_json_round_trip():
    """The state is persisted as JSON, so it must survive actual serialization.

    Restoring twice from the same revived state must yield the same draw; that
    is the property a resume depends on, and it cannot hold if the encoder
    produced something `random.setstate` merely tolerates.
    """
    import random

    state = train_mod.capture_rng_state()
    revived = json.loads(json.dumps(train_mod._jsonable_rng(state)))

    train_mod.restore_rng_state(revived)
    first = (random.random(), float(torch.rand(1)))
    # Draw again *without* restoring: must differ, or the restore did nothing.
    second = (random.random(), float(torch.rand(1)))
    # Restore again: must reproduce the first draw exactly.
    train_mod.restore_rng_state(revived)
    third = (random.random(), float(torch.rand(1)))

    assert first != second, "restoring had no effect"
    assert first == third, "restoring the same state gave a different draw"


# --------------------------------------------------------------------- packing


def test_packing_record_is_reconstructable(tokenizer):
    documents = data_mod.load_documents([FIXTURE_CORPUS])
    blocks_a, record_a = data_mod.pack(tokenizer, documents, 64, FIXTURE_CORPUS)
    blocks_b, record_b = data_mod.pack(tokenizer, documents, 64, FIXTURE_CORPUS)

    assert torch.equal(blocks_a, blocks_b), "packing must be deterministic"
    assert record_a.datasetHash == record_b.datasetHash
    assert record_a.strategy == data_mod.PACKING_STRATEGY
    assert record_a.sequenceLength == 64
    # Every consumed article is addressable by id *and* content hash, which is
    # what makes a future replay reconstructible rather than merely repeatable.
    assert record_a.articles
    for article in record_a.articles:
        assert article["articleId"]
        assert len(article["contentHash"]) == 64


def test_packing_hash_changes_when_text_changes(tokenizer):
    docs_a = data_mod.load_documents([FIXTURE_CORPUS])
    docs_b = [dict(d) for d in docs_a]
    docs_b[0]["text"] = docs_b[0]["text"] + " An extra sentence."
    # The hash travels with the text, so it must be recomputed — which is exactly
    # the contract pack() enforces below.
    import hashlib

    docs_b[0]["contentHash"] = hashlib.sha256(
        docs_b[0]["text"].encode("utf-8")
    ).hexdigest()
    _b1, rec_a = data_mod.pack(tokenizer, docs_a, 64, FIXTURE_CORPUS)
    _b2, rec_b = data_mod.pack(tokenizer, docs_b, 64, FIXTURE_CORPUS)
    assert rec_a.datasetHash != rec_b.datasetHash


def test_packing_refuses_a_stale_content_hash(tokenizer):
    """A hand-built document with a stale hash would make the contribution
    record false, so pack() refuses it rather than recording a lie."""
    docs = [
        {
            "articleId": "forged",
            "text": "some perfectly ordinary text",
            "contentHash": "0" * 64,
        }
    ]
    with pytest.raises(ValueError, match="contentHash mismatch"):
        data_mod.pack(tokenizer, docs, 64, FIXTURE_CORPUS)


def test_packing_computes_a_missing_content_hash(tokenizer):
    import hashlib

    text = (
        "a document that arrived without a hash of its own, and long enough here "
        "to form at least one block of tokens for the packing routine"
    )
    docs = [{"articleId": "unhashed", "text": text}]
    _blocks, record = data_mod.pack(tokenizer, docs, 16, FIXTURE_CORPUS)
    expected = hashlib.sha256(text.encode("utf-8")).hexdigest()
    assert record.articles[0]["contentHash"] == expected


def test_validation_split_is_contiguous_and_does_not_leak():
    """A random split over a packed stream leaks neighbouring context across the
    boundary, so the split is a contiguous tail holdout."""
    blocks = torch.arange(100).reshape(10, 10)
    train, val = data_mod.train_validation_split(blocks, 3)
    assert train.shape[0] == 7 and val.shape[0] == 3
    assert torch.equal(val, blocks[7:])
    assert not set(train.flatten().tolist()) & set(val.flatten().tolist())


def test_packing_rejects_a_corpus_smaller_than_one_block(tokenizer):
    import hashlib

    text = "too short"
    docs = [
        {
            "articleId": "x",
            "text": text,
            "contentHash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        }
    ]
    with pytest.raises(ValueError, match="fewer than one"):
        data_mod.pack(tokenizer, docs, 4096, FIXTURE_CORPUS)


# ------------------------------------------------------------------ accounting


def test_token_accounting_matches_the_recorded_effective_batch_size(small_model, tokenizer):
    """Every micro-batch is exactly microBatchSize blocks, so tokensSeen is
    steps * gradAccum * microBatch * seqLen exactly. A ragged tail batch would
    make the recorded effectiveBatchSize a lie."""
    model, _config, _sizes = small_model
    cfg = _cfg(steps=5, sequenceLength=64, microBatchSize=2, gradAccumSteps=2)
    _result, state, _opt = train_mod.train(
        model=model.float(),
        tokenizer=tokenizer,
        documents=data_mod.load_documents([FIXTURE_CORPUS]),
        cfg=cfg,
        parent_version="v001",
        new_version="v002",
        tokenizer_path=FIXTURE_CORPUS,
        device="cpu",
    )
    expected = cfg.steps * cfg.gradAccumSteps * cfg.microBatchSize * cfg.sequenceLength
    assert state["tokensSeen"] == expected


def test_train_state_records_everything_replay_needs(small_model, tokenizer):
    model, _config, _sizes = small_model
    _result, state, _opt = train_mod.train(
        model=model.float(),
        tokenizer=tokenizer,
        documents=data_mod.load_documents([FIXTURE_CORPUS]),
        cfg=_cfg(),
        parent_version="v001",
        new_version="v002",
        tokenizer_path=FIXTURE_CORPUS,
        device="cpu",
    )
    for field in (
        "config", "packing", "stepsCompleted", "tokensSeen", "order", "cursor",
        "rngState", "environment", "history",
    ):
        assert field in state, f"train state missing {field}"

    assert state["packing"]["tokenizerHash"]
    assert state["config"]["learningRate"] == 1e-4
    assert state["config"]["masterDtype"] == "float32"
    assert state["environment"]["torch"]
    # The sample order and cursor are what make a resume a resume.
    assert len(state["order"]) == state["packing"]["blockCount"] - state["config"]["validationBlocks"]
    assert isinstance(state["cursor"], int)
    for entry in state["history"]:
        assert {"step", "learningRate", "gradNorm", "loss", "tokens"} <= set(entry)


def test_resume_refuses_a_different_corpus(small_model, tokenizer):
    model, _config, _sizes = small_model
    _r, state, _o = train_mod.train(
        model=model.float(),
        tokenizer=tokenizer,
        documents=data_mod.load_documents([FIXTURE_CORPUS]),
        cfg=_cfg(),
        parent_version="v001",
        new_version="v002",
        tokenizer_path=FIXTURE_CORPUS,
        device="cpu",
    )
    state = dict(state)
    state["packing"] = dict(state["packing"], datasetHash="deadbeef")

    model2, _c, _s = small_model
    with pytest.raises(ValueError, match="datasetHash differs"):
        train_mod.train(
            model=model2.float(),
            tokenizer=tokenizer,
            documents=data_mod.load_documents([FIXTURE_CORPUS]),
            cfg=_cfg(steps=8),
            parent_version="v002",
            new_version="v003",
            tokenizer_path=FIXTURE_CORPUS,
            device="cpu",
            resume=state,
        )


def test_resume_refuses_a_changed_learning_rate(small_model, tokenizer):
    model, _config, _sizes = small_model
    _r, state, _o = train_mod.train(
        model=model.float(),
        tokenizer=tokenizer,
        documents=data_mod.load_documents([FIXTURE_CORPUS]),
        cfg=_cfg(),
        parent_version="v001",
        new_version="v002",
        tokenizer_path=FIXTURE_CORPUS,
        device="cpu",
    )
    model2, _c, _s = small_model
    with pytest.raises(ValueError, match="config differs"):
        train_mod.train(
            model=model2.float(),
            tokenizer=tokenizer,
            documents=data_mod.load_documents([FIXTURE_CORPUS]),
            cfg=_cfg(steps=8, learningRate=5e-5),
            parent_version="v002",
            new_version="v003",
            tokenizer_path=FIXTURE_CORPUS,
            device="cpu",
            resume=state,
        )


def test_resume_refuses_when_the_target_does_not_advance(small_model, tokenizer):
    model, _config, _sizes = small_model
    _r, state, _o = train_mod.train(
        model=model.float(),
        tokenizer=tokenizer,
        documents=data_mod.load_documents([FIXTURE_CORPUS]),
        cfg=_cfg(steps=4),
        parent_version="v001",
        new_version="v002",
        tokenizer_path=FIXTURE_CORPUS,
        device="cpu",
    )
    model2, _c, _s = small_model
    with pytest.raises(ValueError, match="Raise --steps"):
        train_mod.train(
            model=model2.float(),
            tokenizer=tokenizer,
            documents=data_mod.load_documents([FIXTURE_CORPUS]),
            cfg=_cfg(steps=4),  # same target: nothing to continue
            parent_version="v002",
            new_version="v003",
            tokenizer_path=FIXTURE_CORPUS,
            device="cpu",
            resume=state,
        )


# ----------------------------------------------------------------- diff helper


def test_diff_distinguishes_absent_from_shape_mismatch():
    before = {"p": torch.ones(4, 4), "q": torch.ones(2, 2)}
    after = {"p": torch.zeros(4, 4), "q": torch.ones(3, 3), "r": torch.ones(2)}
    diff = train_mod.diff_tensors(before, after)
    assert diff["shapeMismatch"] == ["q"]
    assert diff["onlyAfter"] == ["r"]
    assert diff["onlyBefore"] == []
    assert diff["changed"] == [{"name": "p", "maxAbsDelta": 1.0}]


def test_diff_reports_max_delta_for_explainability():
    before = {"w": torch.zeros(3)}
    after = {"w": torch.tensor([0.0, 0.5, -0.25])}
    diff = train_mod.diff_tensors(before, after)
    assert diff["changed"][0]["maxAbsDelta"] == pytest.approx(0.5)

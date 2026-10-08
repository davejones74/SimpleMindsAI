"""Phase 1 gate checks 6, 8, 9, 10 and 11, driven through the real CLI.

These run the actual `python -m sma.brain` subprocess against the committed
store, exactly the way Node will. Every assertion is a statement about bytes on
disk or a number produced by loading them — there is no mock in this file,
because the failure each check exists to catch (a stale tensor, a fabricated
loss, an unexplainable diff, a generate path that never loaded the model) is
invisible to a mock.

The checks need a populated store (`v001` untrained, `v002` trained). It is the
same store the pipeline uses; the tests only ever read it. If it is absent they
skip rather than pretend to pass.
"""

from __future__ import annotations

import json
import subprocess
import sys

import pytest

from conftest import FIXTURE_CORPUS, REPO_ROOT
from sma import store

STORE = store.store_root()
V001 = STORE / "v001"
V002 = STORE / "v002"

needs_store = pytest.mark.skipif(
    not (V001.is_dir() and (V001 / "init-manifest.json").is_file()),
    reason=f"comitted v001 store required at {STORE}",
)
needs_trained = pytest.mark.skipif(
    not (V002.is_dir() and (V002 / "train-state.json").is_file()),
    reason=f"trained v002 store required at {STORE}",
)


def _run(*args: str) -> tuple[int, dict]:
    """Invoke the CLI as Node would and return (exit code, JSON payload)."""
    proc = subprocess.run(
        [sys.executable, "-m", "sma.brain", *args, "--out", str(STORE)],
        cwd=REPO_ROOT / "python",
        capture_output=True,
        text=True,
    )
    payload = json.loads(proc.stdout) if proc.stdout.strip() else {}
    return proc.returncode, payload


# ------------------------------------------------------------------ check 6


@needs_store
def test_check6_fresh_process_reproduces_persisted_tensor_digests():
    """A fresh interpreter reload must re-hash the persisted bytes exactly.

    The two RoPE cache buffers are `persistent=False`: no safetensors file
    stores them, so they are recomputed by the loader and cannot be part of a
    byte-level claim. The check verifies the 74 persisted tensors and reports
    the derived buffers separately instead of silently passing on 76.
    """
    code, out = _run("eval", "--version", "v001", "--corpus", str(FIXTURE_CORPUS), "--verify-weights")

    assert code == 0, out
    assert out["ok"] is True
    weights = out["weights"]
    assert weights["parameterUniqueByStorage"] == 61_839_744
    assert weights["verified"] is True
    assert weights["persistedCount"] == 74
    assert weights["recordedCount"] == 76
    assert weights["matched"] == 74
    assert weights["mismatched"] == []
    assert weights["missing"] == []
    assert weights["unexpected"] == []

    derived = {d["name"]: d for d in weights["derivedTensors"]}
    assert set(derived) == {
        "model.rotary_emb.inv_freq",
        "model.rotary_emb.original_inv_freq",
    }
    assert all(d["persistent"] is False for d in derived.values())
    assert all(d["loadedDtype"] == "float32" for d in derived.values())
    # The dtype difference is reconciled, not ignored: casting the reloaded fp32
    # buffer back to the recorded (bf16) dtype must reproduce the manifest digest.
    assert weights["derivedReconstructed"] is True
    assert weights["verifiedAll"] is True
    assert all(d["reconstructed"] is True for d in derived.values())
    assert all(d["recordedDtype"] == "bfloat16" for d in derived.values())


@needs_store
def test_check6_tampered_manifest_digest_is_rejected():
    """If the recording lies, verification must fail — otherwise it proves nothing.

    This is done by hand, on a throwaway copy, so the real store is untouched.
    """
    import shutil
    import tempfile

    from sma import brain

    with tempfile.TemporaryDirectory() as tmp:
        target = f"{tmp}/v001"
        shutil.copytree(V001, target)
        manifest_path = f"{target}/init-manifest.json"
        manifest = store.read_json(manifest_path)
        # `_tensor_hash_map` reads the flat "tensors" block of an init manifest.
        first = sorted(manifest["tensors"])[0]
        manifest["tensors"][first]["sha256"] = "0" * 64
        store.write_json(manifest_path, manifest)

        from transformers import AutoModelForCausalLM

        model = AutoModelForCausalLM.from_pretrained(target, dtype="auto")
        report = brain._verify_weights(model, store.read_json(manifest_path))
        assert report["verified"] is False
        assert report["mismatched"] and report["mismatched"][0]["name"] == first


# ------------------------------------------------------------------ check 8


@needs_store
def test_check8_untrained_loss_matches_initialisation_signature():
    code, out = _run("eval", "--version", "v001", "--corpus", str(FIXTURE_CORPUS))

    assert code == 0, out
    assert out["ok"] is True
    assert out["trainedSteps"] == 0
    signature = out["lossSignature"]
    assert signature["applies"] is True
    assert signature["ok"] is True, signature
    assert signature["vocabSize"] == 128_256
    assert signature["band"] == [10.5, 12.5]
    assert signature["band"][0] <= out["evalLoss"] <= signature["band"][1]
    assert signature["expectedUniform"] == pytest.approx(11.76178, abs=1e-4)
    assert out["evaluationSet"]["blockCount"] > 0
    assert out["evaluationSet"]["datasetHash"]


@needs_store
def test_eval_requires_a_source():
    """No corpus and no eval-set is a usage error, not a silent default set."""
    code, _ = _run("eval", "--version", "v001")
    assert code != 0


# ------------------------------------------------------------------ check 9


@needs_store
@needs_trained
def test_check9_training_lowers_the_eval_loss():
    code_a, a = _run("eval", "--version", "v001", "--corpus", str(FIXTURE_CORPUS))
    code_b, b = _run("eval", "--version", "v002", "--corpus", str(FIXTURE_CORPUS))

    assert code_a == 0 and code_b == 0
    assert b["trainedSteps"] > 0
    # The ln(V) band is only meaningful before any optimizer step; a trained
    # checkpoint is *expected* to sit below it and must not be flagged.
    assert b["lossSignature"]["applies"] is False
    assert b["evalLoss"] < a["evalLoss"]
    assert b["evaluationSet"]["datasetHash"] == a["evaluationSet"]["datasetHash"], (
        "parent and candidate must be scored on the identical frozen set"
    )


# ----------------------------------------------------------------- check 10


@needs_store
@needs_trained
def test_check10_diff_is_explainable_and_names_the_move():
    code, out = _run("diff", "--a", "v001", "--b", "v002", "--corpus", str(FIXTURE_CORPUS))

    assert code == 0, out
    assert out["ok"] is True
    assert out["sameArchitecture"] is True
    assert all(field["equal"] for field in out["architectureParity"].values())

    params = out["parameters"]
    assert params["onlyBefore"] == []
    assert params["onlyAfter"] == []
    assert params["shapeMismatch"] == []
    assert params["compared"] == 74

    # 74 entries but only 59 distinct digests: a set comparison could not name
    # which tensor moved, so the diff must be keyed by name.
    explain = out["explainableDiff"]
    assert explain["parameterNamesMatch"] is True
    assert explain["changedCount"] == 74
    assert explain["unchangedCount"] == 0
    assert explain["buffersUnchanged"] is True
    assert "model.embed_tokens.weight" in explain["changedNames"]

    assert out["buffers"]["drifted"] == []
    assert out["buffers"]["compared"] == 2

    assert out["parentChain"] == {
        "a": None,
        "b": "v001",
        "aInitialisationType": "RANDOM",
        "bInitialisationType": "TRAINED",
    }

    assert out["losses"]["decreased"] is True
    assert out["losses"]["b"] < out["losses"]["a"]


@needs_store
def test_diff_rejects_an_unknown_version():
    code, out = _run("diff", "--a", "v001", "--b", "v999")
    assert code != 0
    assert out.get("ok") is False


# ----------------------------------------------------------------- check 11


@needs_store
@needs_trained
def test_check11_generate_loads_the_committed_checkpoint():
    code, out = _run(
        "generate", "--version", "v002", "--prompt", "Once upon a time",
        "--max-new-tokens", "8", "--seed", "0",
    )

    assert code == 0, out
    assert out["ok"] is True
    assert out["generatedTokens"] == 8
    assert isinstance(out["text"], str)
    assert out["prompt"] == "Once upon a time"
    assert out["artifactName"] == store.artifact_name_for_version(STORE, "v002")


@needs_store
def test_generate_has_no_fallback_for_a_missing_version():
    """An unavailable checkpoint must fail loudly; it must not answer anyway."""
    code, out = _run("generate", "--version", "v999", "--prompt", "hello")
    assert code != 0
    assert out.get("ok") is False
    assert "text" not in out

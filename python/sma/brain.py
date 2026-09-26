"""
SimpleMindsAI compute-plane CLI.

    python -m sma.brain init    --config small --out data/models
    python -m sma.brain status  --out data/models
    python -m sma.brain train   --config small --parent v001 --out data/models
    python -m sma.brain eval    --version v001 --out data/models
    python -m sma.brain generate --version v002 --prompt "..."

Node invokes this as a subprocess. stdout carries exactly one JSON object;
stderr carries logs; a non-zero exit means failure and the caller must treat
the run as failed. There is deliberately no fallback path.

Phase 1 implements `init`, `status` and `train`. `eval` and `generate` are
still stubbed so the contract is visible early.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict

DEFAULT_OUT = Path("data/models")


def _log(msg: str) -> None:
    print(f"[sma] {msg}", file=sys.stderr, flush=True)


def _emit(payload: Dict[str, Any]) -> None:
    """The single JSON object Node parses. Nothing else may reach stdout."""
    json.dump(payload, sys.stdout, indent=2, sort_keys=True, default=str)
    sys.stdout.write("\n")
    sys.stdout.flush()


# --------------------------------------------------------------------- init


def cmd_init(args: argparse.Namespace) -> Dict[str, Any]:
    from . import arch, proof, store

    root = Path(args.out)
    version = args.version or store.next_version(root)
    t0 = time.perf_counter()

    _log(f"init {version} from config {args.config!r} seed={args.seed}")

    # --- 1. config + tokenizer ONLY, before going offline ------------------
    fetch_info = proof.fetch_config_and_tokenizer(
        args.repo, root / "_reference" / version
    )
    _log(f"fetched {len(fetch_info['filesDownloaded'])} config/tokenizer files, 0 weight files")

    # --- 2. from here on, the Hub is unreachable -------------------------
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    offline_env = proof.assert_offline_build()

    # --- 3. random init ---------------------------------------------------
    model, config, sizes = arch.build_model(args.config, seed=args.seed)
    architecture = arch.architecture_report(args.config)

    _log(
        f"built {architecture['modelClass']} "
        f"{sizes['parametersUniqueByStorage']:,} params "
        f"({architecture['numHiddenLayers']}L d{architecture['hiddenSize']} "
        f"gqa {architecture['gqaRatio']}:1 head_dim {architecture['headDim']})"
    )

    # --- 4. structural audit ---------------------------------------------
    audit = proof.audit_from_pretrained_usage(Path(__file__).parent)
    if audit["violations"]:
        raise AssertionError(
            "pretrained-weight loads found in the model path: "
            + json.dumps(audit["violations"], indent=2)
        )
    _log(f"structural audit clean ({len(audit['calls'])} from_pretrained call(s), 0 violations)")

    manifest = proof.build_manifest(
        config_name=args.config,
        version=version,
        model=model,
        architecture=architecture,
        sizes=sizes,
        seed=args.seed,
        dtype=str(model.dtype).replace("torch.", ""),
        fetch_info=fetch_info,
        offline_env=offline_env,
        structural_audit=audit,
        repo=args.repo,
    )

    # --- 5. write the version atomically ---------------------------------
    with store.staging_dir(root, version) as tmp:
        model.save_pretrained(tmp, safe_serialization=True)
        try:
            from transformers import AutoTokenizer

            tok = AutoTokenizer.from_pretrained(fetch_info["localDir"])
            tok.save_pretrained(tmp)
        except Exception as exc:  # tokenizer is required for training
            raise RuntimeError(f"tokenizer save failed: {exc}") from exc

        store.write_json(tmp / "init-manifest.json", manifest)
        store.write_json(
            tmp / "provenance.json",
            {
                "schema": "sma/provenance@1",
                "version": version,
                "configName": args.config,
                "parentVersion": None,
                "trainingRunId": None,
                "initialisationType": "RANDOM",
                "pretrainedWeightsUsed": False,
                "architectureReferenceRepo": args.repo,
                "architecture": architecture,
                "sizes": sizes,
                "createdAt": manifest["createdAt"],
            },
        )

    store.commit_marker(
        root / version,
        {"configName": args.config, "parameterCount": sizes["parametersUniqueByStorage"]},
    )
    _log(f"committed {version}")

    summary = proof.manifest_summary(manifest)
    summary.update(
        ok=True,
        verb="init",
        version=version,
        checkpointPath=str(root / version),
        durationMs=int((time.perf_counter() - t0) * 1000),
        architecture=architecture,
        structuralAudit={"calls": len(audit["calls"]), "violations": 0},
    )
    return summary


# ------------------------------------------------------------------- status


def cmd_status(args: argparse.Namespace) -> Dict[str, Any]:
    from . import store

    root = Path(args.out)
    versions = []
    for name in store.list_versions(root):
        path = root / name
        manifest_path = path / "init-manifest.json"
        entry: Dict[str, Any] = {
            "version": name,
            "committed": store.is_committed(path),
            "hasTrainState": (path / "train-state.pt").exists(),
        }
        if manifest_path.exists():
            manifest = store.read_json(manifest_path)
            entry["manifest"] = manifest
            try:
                entry["artifactName"] = store.artifact_name(manifest)
            except ValueError as exc:
                entry["artifactName"] = None
                entry["artifactNameError"] = str(exc)
        versions.append(entry)

    return {
        "ok": True,
        "verb": "status",
        "root": str(root),
        "nextVersion": store.next_version(root),
        "versions": versions,
    }


# ------------------------------------------------------------- not yet here


def _resolve_device(requested: str) -> str:
    import torch

    if requested == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    return requested


def cmd_train(args: argparse.Namespace) -> Dict[str, Any]:
    """Phase 1 check 5: real optimization, published atomically or not at all."""
    from transformers import AutoModelForCausalLM, AutoTokenizer

    from . import proof, store, train as train_mod

    root = Path(args.out)
    parent = args.parent
    parent_dir = store.version_path(root, parent)
    if not store.is_committed(parent_dir):
        raise FileNotFoundError(
            f"parent {parent} is not committed ({parent_dir}); refusing to train from it"
        )

    version = args.version or store.next_version(root)
    device = _resolve_device(args.device)
    t0 = time.perf_counter()
    _log(f"train {version} from {parent} on {device} for {args.steps} step(s)")

    # Our own checkpoint on local disk. The audit allows a filesystem path and
    # forbids a Hub id, which is exactly this case.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"

    tokenizer = AutoTokenizer.from_pretrained(parent_dir)
    tokenizer_file = parent_dir / "tokenizer.json"
    if not tokenizer_file.is_file():
        raise FileNotFoundError(f"parent has no tokenizer.json: {tokenizer_file}")

    # Load straight into fp32: the parent is bf16 and upcasting is lossless, and
    # this avoids loading-then-converting.
    model = AutoModelForCausalLM.from_pretrained(parent_dir, dtype="auto")
    # Promote to fp32 masters *before* snapshotting. Diffing bf16 against fp32
    # would show every parameter as changed purely from dtype rounding, and check 7
    # would pass without a single real update.
    model = model.float()

    audit = proof.audit_from_pretrained_usage(Path(__file__).parent)
    if audit["violations"]:
        raise AssertionError(
            "pretrained-weight loads found in the model path: "
            + json.dumps(audit["violations"], indent=2)
        )

    from . import data as data_mod

    documents = data_mod.load_documents([Path(p) for p in args.corpus])
    _log(f"ingested {len(documents)} document(s) from {len(args.corpus)} path(s)")

    # Check 7 baselines, taken on the same fp32 masters the optimizer will update.
    before_params = train_mod.named_parameter_snapshots(model)
    before_buffers = train_mod.named_buffer_snapshots(model)
    _log(f"snapshotted {len(before_params)} parameters and {len(before_buffers)} buffers")

    cfg = train_mod.TrainConfig(
        learningRate=args.lr,
        steps=args.steps,
        sequenceLength=args.seq_len,
        microBatchSize=args.micro_batch,
        gradAccumSteps=args.grad_accum,
        warmupSteps=args.warmup,
        gradClip=None if args.grad_clip <= 0 else args.grad_clip,
        validationBlocks=args.val_blocks,
        seed=args.seed,
        computeDtype=args.compute_dtype,
        logEvery=args.log_every,
        spikeFactor=args.spike_factor,
    )
    cfg.validate()

    resume_state = None
    optimizer_state = None
    if args.resume_from:
        # Both halves are needed: the JSON carries the config/dataset identity the
        # guard checks, the pickle carries the optimizer moments. Neither alone can
        # resume, and silently resuming without the moments would restart AdamW's
        # accumulators from zero.
        resume_json = store.read_json(
            store.version_path(root, args.resume_from) / "train-state.json"
        )
        resume_blob_path = root / "_runs" / f"{args.resume_from}.train-state.pt"
        if not resume_blob_path.is_file():
            raise FileNotFoundError(
                f"no resume state for {args.resume_from} at {resume_blob_path}"
            )
        blob = train_mod.load_train_state(resume_blob_path)
        resume_state = resume_json
        optimizer_state = blob["optimizer"]
        _log(
            f"resuming {args.resume_from} from step {resume_json['stepsCompleted']} "
            f"({len(blob['optimizer']['state'])} optimizer tensors)"
        )

    try:
        result, train_state, optimizer = train_mod.train(
            model=model,
            tokenizer=tokenizer,
            documents=documents,
            cfg=cfg,
            parent_version=parent,
            new_version=version,
            tokenizer_path=tokenizer_file,
            device=device,
            resume=resume_state,
            optimizer_state=optimizer_state,
            log=_log,
        )
    except train_mod.NumericalFailure as exc:
        # Invariant 9: a failed run must never become the active brain. Nothing has
        # been written yet, so there is nothing to roll back.
        _log(f"GUARD TRIPPED, nothing published: {exc}")
        return {
            "ok": False,
            "verb": "train",
            "published": False,
            "parentVersion": parent,
            "error": str(exc),
            "kind": "numerical_failure",
        }

    after_params = train_mod.named_parameter_snapshots(model)
    after_buffers = train_mod.named_buffer_snapshots(model)
    param_diff = train_mod.diff_tensors(before_params, after_params, tolerance=args.min_delta)
    buffer_diff = train_mod.assert_buffers_unchanged(before_buffers, after_buffers)
    _log(
        f"check 7: {param_diff['changedCount']}/{param_diff['compared']} parameters "
        f"changed; {len(buffer_diff['drifted'])} buffer(s) drifted"
    )

    # Identify the run by what it consumed, not by its version name: two runs can
    # both target v004 and differ in corpus, config or parent.
    run_id = hashlib.sha256(
        json.dumps(
            {
                "parent": parent,
                "config": train_state["config"],
                "packing": train_state["packing"],
            },
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()[:12]

    # --- publish atomically; staging is discarded if anything below throws ---
    with store.staging_dir(root, version) as tmp:
        model.save_pretrained(tmp, safe_serialization=True)
        tokenizer.save_pretrained(tmp)
        # The readable state stays in the version: it is provenance, and the README
        # requires the config, dataset hash and RNG states on every checkpoint.
        store.write_json(tmp / "train-state.json", train_state)
        store.write_json(tmp / "parameter-diff.json", {"parameters": param_diff, "buffers": buffer_diff})
        store.write_json(
            tmp / "provenance.json",
            {
                "schema": "sma/provenance@1",
                "version": version,
                "configName": args.config,
                "parentVersion": parent,
                "trainingRunId": run_id,
                "initialisationType": "TRAINED",
                "pretrainedWeightsUsed": False,
                "parentInitialisationType": "RANDOM",
                "checkpointDtype": str(next(model.parameters()).dtype).replace("torch.", ""),
                "datasetHash": train_state["packing"]["datasetHash"],
                "tokenizerHash": train_state["packing"]["tokenizerHash"],
                "stepsCompleted": train_state["stepsCompleted"],
                "tokensSeen": train_state["tokensSeen"],
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
        )
        manifest = store.read_json(parent_dir / "init-manifest.json")
        manifest = dict(manifest)
        manifest["version"] = version
        manifest["parentVersion"] = parent
        manifest["derivedFrom"] = parent
        manifest["initialisationType"] = "TRAINED"
        manifest["trainedSteps"] = train_state["stepsCompleted"]
        manifest["tensorHashesAfterTraining"] = proof.tensor_hashes(model)
        store.write_json(tmp / "init-manifest.json", manifest)

    store.commit_marker(
        root / version,
        {
            "parentVersion": parent,
            "stepsCompleted": train_state["stepsCompleted"],
            "finalTrainLoss": result.finalTrainLoss,
        },
    )

    # Optimizer moments live outside the version directory, deliberately. They are
    # ~8x the size of the fp32 weights for a 62M model, they are a torch pickle
    # rather than a reviewable record, and they describe a *run* that may continue,
    # not a version that is immutable once committed. Putting them in the version
    # would make every checkpoint 724 MiB instead of 230 MiB and would mean
    # checking a binary blob into git to satisfy provenance that the JSON
    # already carries.
    runs_dir = root / "_runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    resume_blob = runs_dir / f"{version}.train-state.pt"
    train_mod.save_train_state(resume_blob, train_state, optimizer)
    _log(f"committed {version} (resume state -> {resume_blob.name})")


    return {
        "ok": True,
        "verb": "train",
        "version": version,
        "parentVersion": parent,
        "trainingRunId": run_id,
        "published": True,
        "device": device,
        "checkpointDtype": str(next(model.parameters()).dtype).replace("torch.", ""),
        "initialTrainLoss": result.initialTrainLoss,
        "finalTrainLoss": result.finalTrainLoss,
        "initialValidationLoss": result.initialValidationLoss,
        "finalValidationLoss": result.finalValidationLoss,
        "stepsCompleted": train_state["stepsCompleted"],
        "tokensSeen": result.tokensSeen,
        "datasetHash": train_state["packing"]["datasetHash"],
        "blockCount": train_state["packing"]["blockCount"],
        "durationMs": int((time.perf_counter() - t0) * 1000),
        "checks": {
            "check5_ran": {"ok": True, "steps": train_state["stepsCompleted"]},
            "check7_parametersChanged": {
                "ok": param_diff["unchangedCount"] == 0 and not param_diff["onlyBefore"]
                and not param_diff["onlyAfter"]
                and not param_diff["shapeMismatch"],
                "compared": param_diff["compared"],
                "changed": param_diff["changedCount"],
                "unchanged": param_diff["unchangedCount"],
                "unchangedNames": [u["name"] for u in param_diff["unchanged"]],
                "minDelta": min((c["maxAbsDelta"] for c in param_diff["changed"]), default=0.0),
                "maxDelta": max((c["maxAbsDelta"] for c in param_diff["changed"]), default=0.0),
            },
            "check7_buffersUnchanged": {
                "ok": not buffer_diff["drifted"],
                "compared": buffer_diff["compared"],
                "drifted": buffer_diff["drifted"],
            },
        },
    }


def cmd_eval(args: argparse.Namespace) -> Dict[str, Any]:
    raise NotImplementedError("eval lands in the next Phase 1 step")


def cmd_generate(args: argparse.Namespace) -> Dict[str, Any]:
    raise NotImplementedError("generate lands in the next Phase 1 step")


# --------------------------------------------------------------------- main


def build_parser() -> argparse.ArgumentParser:
    from . import configs

    p = argparse.ArgumentParser(prog="python -m sma.brain", description=__doc__)
    p.add_argument("--out", default=str(DEFAULT_OUT), help="brain version root")
    sub = p.add_subparsers(dest="verb", required=True)

    def common(sp):
        sp.add_argument("--out", default=str(DEFAULT_OUT))

    sp = sub.add_parser("init", help="randomly initialise a new brain version")
    sp.add_argument("--config", default="small", choices=list(configs.CONFIG_NAMES))
    sp.add_argument("--seed", type=int, default=0)
    sp.add_argument("--repo", default=configs.ARCH_REFERENCE_REPO)
    sp.add_argument("--version", default=None, help="explicit version name; default is next free vNNN")
    sp.add_argument("--out", default=str(DEFAULT_OUT))
    sp.set_defaults(func=cmd_init)

    sp = sub.add_parser("status", help="list brain versions")
    sp.add_argument("--out", default=str(DEFAULT_OUT))
    sp.set_defaults(func=cmd_status)

    sp = sub.add_parser("train", help="train a child version from a parent")
    sp.add_argument("--parent", required=True, help="committed parent version, e.g. v001")
    sp.add_argument("--corpus", required=True, nargs="+", help="fixture .txt or .jsonl")
    sp.add_argument("--config", default="small", choices=list(configs.CONFIG_NAMES))
    sp.add_argument("--version", default=None, help="default is next free vNNN")
    sp.add_argument("--out", default=str(DEFAULT_OUT))
    sp.add_argument(
        "--lr",
        type=float,
        required=True,
        help="learning rate. Required, with no default, on purpose: see the README "
        "section on loss instability before picking a value.",
    )
    sp.add_argument("--steps", type=int, default=60)
    sp.add_argument("--seq-len", type=int, default=128)
    sp.add_argument("--micro-batch", type=int, default=2)
    sp.add_argument("--grad-accum", type=int, default=2)
    sp.add_argument("--warmup", type=int, default=10)
    sp.add_argument("--val-blocks", type=int, default=2)
    sp.add_argument("--grad-clip", type=float, default=1.0, help="0 disables clipping")
    sp.add_argument("--spike-factor", type=float, default=2.5, help="0 disables spike detection")
    sp.add_argument("--min-delta", type=float, default=1e-7, help="check 7 materiality floor")
    sp.add_argument("--seed", type=int, default=0)
    sp.add_argument("--device", default="auto", help="auto | cpu | cuda")
    sp.add_argument("--compute-dtype", default="bfloat16", choices=["bfloat16", "float32"])
    sp.add_argument("--log-every", type=int, default=1)
    sp.add_argument(
        "--resume-from",
        default=None,
        help="version whose train state to continue from; pair with a larger --steps",
    )
    sp.set_defaults(func=cmd_train)

    for name, fn, helptext in (
        ("eval", cmd_eval, "evaluate a version"),
        ("generate", cmd_generate, "greedy/sample decode from a version"),
    ):
        sp = sub.add_parser(name, help=helptext)
        common(sp)
        sp.set_defaults(func=fn)

    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        _emit(args.func(args))
        return 0
    except NotImplementedError as exc:
        _log(f"not implemented: {exc}")
        _emit({"ok": False, "verb": args.verb, "error": str(exc), "kind": "not_implemented"})
        return 2
    except Exception as exc:  # noqa: BLE001 — the contract is one JSON object, always
        import traceback

        traceback.print_exc(file=sys.stderr)
        _emit({"ok": False, "verb": getattr(args, "verb", None), "error": str(exc), "kind": type(exc).__name__})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

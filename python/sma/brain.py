"""
SimpleMindsAI compute-plane CLI.

    python -m sma.brain init    --config small --out data/models
    python -m sma.brain status  --out data/models
    python -m sma.brain train   --config small --parent v001 --out data/models
    python -m sma.brain eval    --version v001 --out data/models --corpus corpus.txt
    python -m sma.brain generate --version v002 --prompt "..."
    python -m sma.brain diff    --a v001 --b v002 --out data/models

Node invokes this as a subprocess. stdout carries exactly one JSON object;
stderr carries logs; a non-zero exit means failure and the caller must treat
the run as failed. There is deliberately no fallback path.

Phase 1 implements `init`, `status`, `train`, `eval`, `generate` and `diff`.
Phase 2 adds `preflight`, the read-only memory/portability budget that gates a
long run before it is started.
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

from .store import store_root

# The store root is resolved at *parse* time from SMA_STORE rather than at
# import time, so a caller or a test can change the environment and be
# honoured. Import-time capture would silently pin the wrong lineage.
DEFAULT_EXPORT = Path("data/exports")
DEFAULT_REPO_MODELS = Path("../models")


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


# ------------------------------------------------------------- publication


def cmd_export(args: argparse.Namespace) -> Dict[str, Any]:
    """Copy a committed version out under its content-addressed name.

    This exists to move bytes to a machine without the repository. Serving --
    chat, eval, generate -- deliberately does not go through it; those load the
    immutable version directory, which is canonical. An export is a copy, and
    a second copy of the same weights is a second thing that can be wrong.
    """
    from . import store

    result = store.export_version(Path(args.out), args.version, Path(args.dest))
    _log(f"exported {result['sourceVersion']} -> {result['path']}")
    _log(f"  {result['bytes']:,} bytes, {len(result['files'])} files")
    return {"ok": True, "verb": "export", **result}


def cmd_verify_export(args: argparse.Namespace) -> Dict[str, Any]:
    from . import store

    result = store.verify_export(Path(args.path))
    if not result["ok"]:
        _log(f"FAILED: {len(result['failed'])} file(s) did not verify")
    return {"ok": result["ok"], "verb": "verify-export", **result}


def cmd_active(args: argparse.Namespace) -> Dict[str, Any]:
    """Show, set, or sync the deployment pointer and the git record mirror."""
    from . import store

    root = Path(args.out)
    result: Dict[str, Any] = {
        "ok": True,
        "verb": "active",
        "store": str(root),
        "mirror": args.models,
    }

    if args.sync:
        mirrored = [store.mirror_record(root, v, Path(args.models)) for v in store.list_versions(root)]
        result["mirrored"] = mirrored
        _log(f"mirrored {len(mirrored)} version record(s) into {args.models}")

    check = store.verify_mirror(root, Path(args.models))
    result["mirrorCheck"] = check
    if check["drifted"]:
        _log(f"WARNING: {len(check['drifted'])} mirrored file(s) differ from the store")

    if args.set_to:
        pointer = store.set_active(root, args.set_to)
        result["activated"] = pointer
        _log(f"active -> {pointer['version']} ({pointer['artifactName']})")
    else:
        current = store.active_version(root)
        result["activeVersion"] = current
        if current:
            try:
                result["artifactName"] = store.artifact_name_for_version(root, current)
            except (FileNotFoundError, ValueError):
                pass
        _log(f"active = {current or '(none set)'}")

    return result


# ------------------------------------------------------------- preflight


def cmd_preflight(args: argparse.Namespace) -> Dict[str, Any]:
    """Phase 2: measure the machine and print the budget before any long run.

    Read-only by construction: it builds no model and touches no version. It
    exits non-zero when a check fails so a caller refuses to start a run the
    machine cannot finish, matching the one-JSON-object contract.
    """
    from . import preflight

    report = preflight.run_preflight(
        args.config,
        store_root=Path(args.out),
        optimizer=args.optimizer,
        storage_dtype=args.storage_dtype,
        compute_dtype=args.compute_dtype,
        micro_batch=args.micro_batch,
        seq_len=args.seq_len,
        grad_checkpointing=args.grad_checkpointing,
        resume_from=args.resume_from,
        allow_cross_vendor=args.allow_cross_vendor,
        include_bf16_probe=not args.counts_only,
    )

    mem = report["memory"]
    _log(
        f"preflight {args.config} on {report['backend']}: "
        f"resident {mem['resident']['human']}, checkpoint {mem['checkpoint']['totalHuman']}"
    )
    for c in report["checks"]:
        flag = "ok" if c["ok"] else "WARN" if c["ok"] is None else "FAIL"
        _log(f"  [{flag}] {c['name']}: {c['detail']}")

    report["exitCode"] = 0 if report["ok"] else 1
    return report


# ------------------------------------------------------------- not yet here


def _resolve_device(requested: str) -> str:
    import torch

    if requested == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    return requested


def _validate_run_id(run_id: Optional[str]) -> Optional[str]:
    """Validate the caller-supplied run id before it is written to provenance.

    The Node orchestration plane owns the training-run identity and passes it in
    so the committed checkpoint can be linked back to the ledger. It is written
    into provenance BEFORE the commit marker, so a committed version can never be
    linked to the wrong run. Reject anything that is not a short, safe token.
    """
    if run_id is None:
        return None
    import re

    node_run_id = str(run_id).strip()
    if not node_run_id:
        raise ValueError("run-id must be a non-empty string")
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", node_run_id):
        raise ValueError(
            "run-id must match [A-Za-z0-9._:-]{1,128} "
            f"(got {node_run_id!r})"
        )
    return node_run_id


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
    node_run_id = _validate_run_id(getattr(args, "run_id", None))
    t0 = time.perf_counter()
    _log(
        f"train {version} from {parent} on {device} for {args.steps} step(s)"
        + (f" node-run {node_run_id}" if node_run_id else "")
    )

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
        evalEvery=args.eval_every,
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
                "nodeRunId": node_run_id,
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
        "nodeRunId": node_run_id,
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
        "articleCount": len(train_state["packing"].get("articles", [])),
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


def _safe_read_json(path: Path) -> Dict[str, Any]:
    from . import store

    if Path(path).is_file():
        return store.read_json(path)
    return {}


def _load_version_for_serving(
    root: Path, version: str, device: str
) -> tuple[Any, Any, Path]:
    """Load a committed version the one legal way: from its immutable directory.

    Chat, eval, generate and diff all resolve through `store.resolve_version_dir`,
    never through an export. The dtype is left at whatever the checkpoint stores
    so a hash check sees the real bytes; callers upcast to fp32 themselves when
    they want numerically comparable math across versions.
    """
    from transformers import AutoModelForCausalLM, AutoTokenizer

    from . import store

    version_dir = store.resolve_version_dir(root, version)
    tokenizer = AutoTokenizer.from_pretrained(version_dir)
    model = AutoModelForCausalLM.from_pretrained(version_dir, dtype="auto")
    model = model.to(device)
    return model, tokenizer, version_dir


def _pack_paths(
    tokenizer: Any, paths: list, seq_len: int, tokenizer_path: Path
):
    from . import data as data_mod

    documents = data_mod.load_documents([Path(p) for p in paths])
    blocks, record = data_mod.pack(tokenizer, documents, seq_len, tokenizer_path)
    return blocks, record


def _torch_dtype(name: Optional[str]):
    """Map a manifest dtype string to a torch dtype, or None if unknown."""
    import torch

    if not name:
        return None
    return {"bfloat16": torch.bfloat16, "float16": torch.float16, "float32": torch.float32}.get(
        name.removeprefix("torch.")
    )


def _verify_weights(model: Any, manifest: Dict[str, Any]) -> Dict[str, Any]:
    """Re-hash the loaded tensors and compare to the recorded manifest.

    This is what makes check 6 a statement about the bytes on disk rather than
    about the loader returning without raising: a fresh process must reproduce
    the exact digests the manifest committed.

    Only tensors that are actually *persisted* in the checkpoint can make that
    byte-level claim. The RoPE cache buffers are registered with
    ``persistent=False``, so every safetensors file omits them and the loader
    recomputes them from config (in fp32, whereas the init-time model held them
    in the build dtype, bf16). They cannot match a raw fp32 hash, but they are
    not unverifiable either: casting the reloaded buffer back to the *recorded*
    dtype must reproduce the manifest digest exactly. That reconciles the dtype
    difference and proves the buffer was reconstructed faithfully rather than
    merely present. Both facts are reported, and neither is counted as a
    persisted-tensor mismatch.
    """
    from . import proof, store

    recorded = store._tensor_hash_map(manifest)
    actual = proof.tensor_hashes(model)["tensors"]

    persisted = set(model.state_dict().keys())
    buffer_names = {name for name, _ in model.named_buffers()}
    derived_names = sorted(buffer_names - persisted)

    matched = 0
    mismatched: list = []
    missing: list = []
    derived: list = []
    for name, entry_rec in sorted(recorded.items()):
        digest = entry_rec["sha256"] if isinstance(entry_rec, dict) else entry_rec
        entry = actual.get(name)
        if name in derived_names:
            recorded_dtype = entry_rec.get("dtype") if isinstance(entry_rec, dict) else None
            loaded = None
            try:
                loaded = model.get_buffer(name)
            except AttributeError:
                loaded = None
            reconstructed = None
            if loaded is not None and isinstance(entry_rec, dict):
                torch_dtype = _torch_dtype(recorded_dtype)
                if torch_dtype is not None:
                    reconstructed = proof.tensor_sha256(loaded.to(torch_dtype)) == digest
            derived.append(
                {
                    "name": name,
                    "persistent": False,
                    "recordedSha256": digest,
                    "loadedSha256": entry["sha256"] if entry else None,
                    "recordedDtype": recorded_dtype,
                    "loadedDtype": entry["dtype"] if entry else None,
                    "reconstructed": reconstructed,
                    "reason": (
                        "non-persistent buffer: not stored in the checkpoint, recomputed "
                        "by the loader; reconciles to the manifest digest when cast to the "
                        "recorded dtype"
                    ),
                }
            )
            continue
        if entry is None:
            missing.append(name)
        elif entry["sha256"] == digest:
            matched += 1
        else:
            mismatched.append({"name": name, "recorded": digest, "actual": entry["sha256"]})

    unexpected = sorted(
        name
        for name in actual
        if name in persisted and name not in recorded
    )
    persisted_ok = not mismatched and not missing and not unexpected
    derived_ok = all(d.get("reconstructed") for d in derived)
    return {
        "verified": persisted_ok,
        "derivedReconstructed": derived_ok,
        "verifiedAll": persisted_ok and derived_ok,
        "recordedCount": len(recorded),
        "persistedCount": len(recorded) - len(derived),
        "actualCount": len(actual),
        "matched": matched,
        "mismatched": mismatched,
        "missing": missing,
        "unexpected": unexpected,
        "derivedTensors": derived,
    }


def cmd_eval(args: argparse.Namespace) -> Dict[str, Any]:
    """Check 8: a loss number. Check 6 (with --verify-weights): the bytes reload.

    The loss-signature band applies only to a freshly initialised, untrained
    checkpoint. A trained v002 legitimately scores far below ln(V); applying the
    band there would report a weight leak that did not happen.
    """
    from . import arch, proof, store, train as train_mod

    root = Path(args.out)
    device = _resolve_device(args.device)
    model, tokenizer, version_dir = _load_version_for_serving(root, args.version, device)
    model.eval()

    manifest = store.read_json(version_dir / "init-manifest.json")
    _total, _trainable, unique = arch.count_parameters(model)

    weights = {"parameterUniqueByStorage": unique}
    if args.verify_weights:
        weights.update(_verify_weights(model, manifest))
        if not weights["verified"]:
            raise AssertionError(
                f"{args.version} weights do not match its manifest: "
                f"{len(weights['mismatched'])} mismatch, {len(weights['missing'])} missing"
            )
        if not weights["derivedReconstructed"]:
            raise AssertionError(
                f"{args.version} non-persistent buffers did not reconcile to their "
                "manifest digests at the recorded dtype"
            )

    if args.eval_set:
        paths = [Path(args.eval_set)]
        source = "eval-set"
    else:
        paths = [Path(p) for p in (args.corpus or [])]
        source = "corpus"

    tokenizer_path = version_dir / "tokenizer.json"
    blocks, record = _pack_paths(tokenizer, paths, args.seq_len, tokenizer_path)
    model = model.float()
    loss = train_mod.mean_cross_entropy(
        model,
        blocks,
        device=device,
        micro_batch_size=args.micro_batch,
        compute_dtype="float32",
    )

    trained_steps = int(_safe_read_json(version_dir / "train-state.json").get("stepsCompleted") or 0)
    vocab = (manifest.get("architecture") or {}).get("vocabSize")
    if manifest.get("initialisationType") == "RANDOM" and trained_steps == 0:
        signature = {"applies": True, **proof.check_loss_signature(loss, int(vocab))}
    else:
        signature = {
            "applies": False,
            "loss": loss,
            "reason": (
                "the ln(V) band applies only to untrained RANDOM initialisations; a "
                "trained checkpoint is expected to score below it"
            ),
        }

    _log(
        f"eval {args.version}: loss {loss:.4f} over {record.blockCount} block(s) "
        f"from {record.documentCount} document(s)"
    )

    return {
        "ok": True,
        "verb": "eval",
        "version": args.version,
        "device": device,
        "source": source,
        "evalLoss": loss,
        "lossSignature": signature,
        "trainedSteps": trained_steps,
        "weights": weights,
        "evaluationSet": {
            "strategy": record.strategy,
            "datasetHash": record.datasetHash,
            "tokenizerHash": record.tokenizerHash,
            "sequenceLength": record.sequenceLength,
            "documentCount": record.documentCount,
            "blockCount": record.blockCount,
            "tokensSeen": record.tokensSeen,
            "articles": record.articles,
        },
    }


def generate_text(
    model: Any,
    tokenizer: Any,
    *,
    prompt: str,
    max_new_tokens: int = 32,
    temperature: float = 0.0,
    top_p: float = 0.95,
    seed: Optional[int] = 0,
    device: Optional[str] = None,
) -> Dict[str, Any]:
    """Run one generation pass and return the decoded result.

    Shared by the one-shot `generate` verb and the long-lived student worker so
    both decode identically. Sampling is greedy unless temperature > 0.
    """
    import torch

    gen_kwargs: Dict[str, Any] = {"max_new_tokens": int(max_new_tokens)}
    if temperature and temperature > 0:
        if seed is not None:
            torch.manual_seed(seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(seed)
        gen_kwargs.update(do_sample=True, temperature=float(temperature), top_p=float(top_p))
        mode = "sample"
    else:
        gen_kwargs.update(do_sample=False)
        mode = "greedy"

    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    prompt_tokens = int(inputs["input_ids"].shape[1])

    with torch.no_grad():
        output = model.generate(**inputs, **gen_kwargs)

    new_tokens = output[0][prompt_tokens:]
    text = tokenizer.decode(new_tokens, skip_special_tokens=True)
    return {
        "text": text,
        "mode": mode,
        "promptTokens": prompt_tokens,
        "generatedTokens": int(new_tokens.shape[0]),
    }


def cmd_generate(args: argparse.Namespace) -> Dict[str, Any]:
    """Check 11: generation runs from a committed checkpoint.

    Nonsense output is expected and acceptable at 62M with a few thousand tokens
    of training; the point is that the plumbing loads the immutable directory and
    decodes. The prompt is echoed so a caller can tell it is the same request.
    """
    from . import store

    root = Path(args.out)
    device = _resolve_device(args.device)
    model, tokenizer, version_dir = _load_version_for_serving(root, args.version, device)
    model.eval()

    result = generate_text(
        model,
        tokenizer,
        prompt=args.prompt,
        max_new_tokens=args.max_new_tokens,
        temperature=args.temperature,
        top_p=args.top_p,
        seed=args.seed,
        device=device,
    )

    manifest = store.read_json(version_dir / "init-manifest.json")
    try:
        artifact = store.artifact_name(manifest)
    except ValueError:
        artifact = None

    _log(f"generate {args.version}: {result['generatedTokens']} new token(s) ({result['mode']})")

    return {
        "ok": True,
        "verb": "generate",
        "version": args.version,
        "artifactName": artifact,
        "device": device,
        "dtype": str(next(model.parameters()).dtype).replace("torch.", ""),
        "mode": result["mode"],
        "prompt": args.prompt,
        "text": result["text"],
        "promptTokens": result["promptTokens"],
        "generatedTokens": result["generatedTokens"],
    }


def cmd_diff(args: argparse.Namespace) -> Dict[str, Any]:
    """Check 10: versions are comparable and the diff is explainable.

    Compared by tensor name and by fp32 value, never by digest sets: the model
    records 76 entries that yield only 59 distinct digests (17 RMSNorm weights
    are 1.0, the RoPE buffers are a closed form), so a digest-set comparison
    cannot say which tensor moved. Values are cast to fp32 first so a bf16 v001
    and an fp32 v002 are compared on what they mean, not on how they were stored.
    """
    from . import store, train as train_mod

    root = Path(args.out)
    device = _resolve_device(args.device)
    a_dir = store.resolve_version_dir(root, args.a)
    b_dir = store.resolve_version_dir(root, args.b)

    model_a, tok_a, _ = _load_version_for_serving(root, args.a, device)
    model_b, tok_b, _ = _load_version_for_serving(root, args.b, device)
    model_a, model_b = model_a.float().eval(), model_b.float().eval()

    param_diff = train_mod.diff_tensors(
        train_mod.named_parameter_snapshots(model_a),
        train_mod.named_parameter_snapshots(model_b),
        tolerance=args.tolerance,
    )
    buffer_diff = train_mod.assert_buffers_unchanged(
        train_mod.named_buffer_snapshots(model_a),
        train_mod.named_buffer_snapshots(model_b),
    )

    man_a = store.read_json(a_dir / "init-manifest.json")
    man_b = store.read_json(b_dir / "init-manifest.json")
    prov_a = _safe_read_json(a_dir / "provenance.json")
    prov_b = _safe_read_json(b_dir / "provenance.json")
    arch_a, arch_b = man_a.get("architecture") or {}, man_b.get("architecture") or {}

    parity_fields = (
        "numHiddenLayers",
        "hiddenSize",
        "numAttentionHeads",
        "numKeyValueHeads",
        "headDim",
        "intermediateSize",
        "vocabSize",
        "ropeTheta",
        "noRopeLayerInterval",
        "tieWordEmbeddings",
    )
    architecture_parity = {
        field: {"a": arch_a.get(field), "b": arch_b.get(field), "equal": arch_a.get(field) == arch_b.get(field)}
        for field in parity_fields
    }

    names_match = (
        not param_diff["onlyBefore"]
        and not param_diff["onlyAfter"]
        and not param_diff["shapeMismatch"]
    )

    losses = None
    if args.eval_set or args.corpus:
        paths = [Path(args.eval_set)] if args.eval_set else [Path(p) for p in args.corpus]
        blocks_a, record = _pack_paths(tok_a, paths, args.seq_len, a_dir / "tokenizer.json")
        loss_a = train_mod.mean_cross_entropy(
            model_a, blocks_a, device=device, micro_batch_size=args.micro_batch, compute_dtype="float32"
        )
        blocks_b, _ = _pack_paths(tok_b, paths, args.seq_len, b_dir / "tokenizer.json")
        loss_b = train_mod.mean_cross_entropy(
            model_b, blocks_b, device=device, micro_batch_size=args.micro_batch, compute_dtype="float32"
        )
        losses = {
            "datasetHash": record.datasetHash,
            "a": loss_a,
            "b": loss_b,
            "delta": (loss_b - loss_a) if (loss_a is not None and loss_b is not None) else None,
            "decreased": (
                loss_b < loss_a if (loss_a is not None and loss_b is not None) else None
            ),
        }

    _log(
        f"diff {args.a} -> {args.b}: {param_diff['changedCount']}/{param_diff['compared']} "
        f"parameters differ, {len(buffer_diff['drifted'])} buffer(s) drifted"
    )

    return {
        "ok": True,
        "verb": "diff",
        "a": args.a,
        "b": args.b,
        "device": device,
        "parentChain": {
            "a": prov_a.get("parentVersion"),
            "b": prov_b.get("parentVersion"),
            "aInitialisationType": man_a.get("initialisationType"),
            "bInitialisationType": man_b.get("initialisationType"),
        },
        "architectureParity": architecture_parity,
        "sameArchitecture": names_match and all(v["equal"] for v in architecture_parity.values()),
        "parameters": param_diff,
        "buffers": buffer_diff,
        "losses": losses,
        "explainableDiff": {
            "parameterNamesMatch": names_match,
            "compared": param_diff["compared"],
            "changedCount": param_diff["changedCount"],
            "unchangedCount": param_diff["unchangedCount"],
            "changedNames": [c["name"] for c in param_diff["changed"]],
            "unchangedNames": [u["name"] for u in param_diff["unchanged"]],
            "buffersUnchanged": not buffer_diff["drifted"],
            "lossDecreased": losses["decreased"] if losses else None,
        },
    }


# --------------------------------------------------------------------- main


def build_parser() -> argparse.ArgumentParser:
    from . import configs

    p = argparse.ArgumentParser(prog="python -m sma.brain", description=__doc__)
    p.add_argument("--out", default=str(store_root()), help="brain version root")
    sub = p.add_subparsers(dest="verb", required=True)

    def common(sp):
        sp.add_argument("--out", default=str(store_root()))

    sp = sub.add_parser("init", help="randomly initialise a new brain version")
    sp.add_argument("--config", default="small", choices=list(configs.CONFIG_NAMES))
    sp.add_argument("--seed", type=int, default=0)
    sp.add_argument("--repo", default=configs.ARCH_REFERENCE_REPO)
    sp.add_argument("--version", default=None, help="explicit version name; default is next free vNNN")
    sp.add_argument("--out", default=str(store_root()))
    sp.set_defaults(func=cmd_init)

    sp = sub.add_parser("status", help="list brain versions")
    sp.add_argument("--out", default=str(store_root()))
    sp.set_defaults(func=cmd_status)

    sp = sub.add_parser("train", help="train a child version from a parent")
    sp.add_argument("--parent", required=True, help="committed parent version, e.g. v001")
    sp.add_argument("--corpus", required=True, nargs="+", help="fixture .txt or .jsonl")
    sp.add_argument("--config", default="small", choices=list(configs.CONFIG_NAMES))
    sp.add_argument("--version", default=None, help="default is next free vNNN")
    sp.add_argument("--out", default=str(store_root()))
    sp.add_argument(
        "--run-id",
        dest="run_id",
        default=None,
        help="Node TrainingRun id; persisted into provenance before commit so the "
        "committed checkpoint is linked to the run that produced it",
    )
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
        "--eval-every",
        type=int,
        default=int(os.environ.get("TRAIN_EVAL_EVERY", "0")),
        help="record held-out validation loss every N steps (0 = only opening and closing)",
    )
    sp.add_argument(
        "--resume-from",
        default=None,
        help="version whose train state to continue from; pair with a larger --steps",
    )
    sp.set_defaults(func=cmd_train)

    sp = sub.add_parser("eval", help="evaluate a committed version (check 8)")
    common(sp)
    sp.add_argument("--version", required=True, help="committed version to evaluate, e.g. v002")
    source = sp.add_mutually_exclusive_group(required=True)
    source.add_argument("--corpus", nargs="+", help="fixture .txt or .jsonl path(s)")
    source.add_argument("--eval-set", dest="eval_set", help="frozen eval-set .jsonl path")
    sp.add_argument("--seq-len", type=int, default=128)
    sp.add_argument("--micro-batch", type=int, default=2)
    sp.add_argument("--device", default="auto", help="auto | cpu | cuda")
    sp.add_argument(
        "--verify-weights",
        action="store_true",
        help="re-hash loaded tensors against the manifest (check 6)",
    )
    sp.set_defaults(func=cmd_eval)

    sp = sub.add_parser("generate", help="decode from a committed version (check 11)")
    common(sp)
    sp.add_argument("--version", required=True, help="committed version to generate from")
    sp.add_argument("--prompt", required=True)
    sp.add_argument("--max-new-tokens", type=int, default=32)
    sp.add_argument("--temperature", type=float, default=0.0, help="0 = greedy")
    sp.add_argument("--top-p", type=float, default=0.95)
    sp.add_argument("--seed", type=int, default=0)
    sp.add_argument("--device", default="auto", help="auto | cpu | cuda")
    sp.set_defaults(func=cmd_generate)

    sp = sub.add_parser("diff", help="explain the difference between two versions (check 10)")
    common(sp)
    sp.add_argument("--a", required=True, help="first committed version, e.g. v001")
    sp.add_argument("--b", required=True, help="second committed version, e.g. v002")
    source = sp.add_mutually_exclusive_group(required=False)
    source.add_argument("--corpus", nargs="+", help="optional corpus to compare eval loss on")
    source.add_argument("--eval-set", dest="eval_set", help="optional frozen eval-set .jsonl")
    sp.add_argument("--seq-len", type=int, default=128)
    sp.add_argument("--micro-batch", type=int, default=2)
    sp.add_argument("--tolerance", type=float, default=1e-9, help="parameter materiality floor")
    sp.add_argument("--device", default="auto", help="auto | cpu | cuda")
    sp.set_defaults(func=cmd_diff)

    sp = sub.add_parser(
        "export",
        help="copy a committed version to a content-addressed directory (distribution, not serving)",
    )
    common(sp)
    sp.add_argument("--version", required=True, help="committed version to export, e.g. v002")
    sp.add_argument("--dest", default=str(DEFAULT_EXPORT), help="export root directory")
    sp.set_defaults(func=cmd_export)

    sp = sub.add_parser("verify-export", help="re-check an export's SHA256SUMS")
    sp.add_argument("--path", required=True, help="export directory to verify")
    sp.set_defaults(func=cmd_verify_export)

    act = sub.add_parser(
        "active",
        help="show or set which version a server serves (the one mutable pointer)",
    )
    common(act)
    act.add_argument("--set", dest="set_to", default=None, help="activate this committed version")
    act.add_argument("--models", default=str(DEFAULT_REPO_MODELS), help="git-tracked record mirror")
    act.add_argument("--sync", action="store_true", help="mirror every version's record into git")
    act.set_defaults(func=cmd_active)

    from . import preflight as preflight_mod

    sp = sub.add_parser(
        "preflight",
        help="Phase 2: budget memory/portability before a long run (read-only)",
    )
    common(sp)
    sp.add_argument("--config", default="3b", choices=list(configs.CONFIG_NAMES))
    sp.add_argument("--optimizer", default="adamw", choices=list(preflight_mod.OPTIMIZERS))
    sp.add_argument("--storage-dtype", dest="storage_dtype", default="bfloat16", choices=["bfloat16", "float32"])
    sp.add_argument("--compute-dtype", dest="compute_dtype", default="bfloat16", choices=["bfloat16", "float32"])
    sp.add_argument("--seq-len", dest="seq_len", type=int, default=8192)
    sp.add_argument("--micro-batch", dest="micro_batch", type=int, default=1)
    sp.add_argument("--grad-checkpointing", dest="grad_checkpointing", action="store_true")
    sp.add_argument("--resume-from", dest="resume_from", default=None, help="version whose backend is reconciled")
    sp.add_argument("--allow-cross-vendor", dest="allow_cross_vendor", action="store_true")
    sp.add_argument("--counts-only", dest="counts_only", action="store_true", help="skip the bf16 timing probe (reported as a warning)")
    sp.set_defaults(func=cmd_preflight)

    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        payload = args.func(args)
        _emit(payload)
        exit_code = payload.get("exitCode", 0) if isinstance(payload, dict) else 0
        return int(exit_code)
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

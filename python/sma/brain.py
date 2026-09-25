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

Phase 1 implements `init` and `status`. `train`/`eval`/`generate` land in
the next step and are stubbed here so the contract is visible early.
"""

from __future__ import annotations

import argparse
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
            entry["manifest"] = store.read_json(manifest_path)
        versions.append(entry)

    return {
        "ok": True,
        "verb": "status",
        "root": str(root),
        "nextVersion": store.next_version(root),
        "versions": versions,
    }


# ------------------------------------------------------------- not yet here


def cmd_train(args: argparse.Namespace) -> Dict[str, Any]:
    raise NotImplementedError("train lands in the next Phase 1 step")


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

    for name, fn, helptext in (
        ("train", cmd_train, "train a child version from a parent"),
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

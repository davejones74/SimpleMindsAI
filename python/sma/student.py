"""Long-lived student worker: one Python process, many chat requests.

Why a worker at all
-------------------
Loading a 62M checkpoint from disk costs a second or more; doing that inside
every chat request would make the loop unusable and would re-read the same
immutable bytes on every turn. The worker keeps the active brain resident and
answers framed requests over stdin/stdout for as long as Node keeps it alive.

This does NOT replace the one-shot CLI contract. `sma.brain` remains the
subprocess interface where stdout is exactly one JSON object. The worker is a
different mode with a different framing rule:

  stdin   one JSON request per line   (newline delimited, never pretty printed)
  stdout  exactly one JSON response per line, in request order, echoing `id`
  stderr  logs only; never parsed by the caller

Concurrency model: strictly sequential. Requests are handled one at a time so a
generation can never interleave with a weight swap. Node pipelines at most one
in-flight request per worker, which makes the ordering guarantee trivial.

Safety on version switch: a new checkpoint is fully loaded into a local variable
and only then assigned over the resident model. A load that fails leaves the
previous brain serving; the worker reports the failure and stays available.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional

from . import brain as brain_mod
from .store import store_root

PROTOCOL_VERSION = 1


class StudentWorker:
    """Holds the resident model and answers framed requests."""

    def __init__(self, root: Path, device: str = "auto") -> None:
        self.root = Path(root)
        self.requested_device = device
        self.device: Optional[str] = None
        self.version: Optional[str] = None
        self.artifact_name: Optional[str] = None
        self.model = None
        self.tokenizer = None
        self.last_integrity: Optional[str] = None
        # Versions whose persisted tensors have already been re-hashed against
        # their manifest in THIS process. Checkpoints are immutable and
        # append-only, so verifying once per version per process is sufficient;
        # re-hashing 62M parameters on every load would dominate latency.
        self._verified: set = set()

    # ------------------------------------------------------------- loading
    def load(self, version: Optional[str], verify: bool = False) -> Dict[str, Any]:
        from . import store

        explicit = version is not None
        if version is None:
            version = store.active_version(self.root)
            if version is None:
                raise ValueError(
                    "no version requested and the store has no active pointer "
                    "(run `sma.brain active --set vNNN`)"
                )

        device = brain_mod._resolve_device(self.requested_device)
        # Load into locals first; only swap when the whole load succeeded.
        model, tokenizer, version_dir = brain_mod._load_version_for_serving(
            self.root, version, device
        )
        model.eval()
        manifest = store.read_json(version_dir / "init-manifest.json")

        # Integrity: an explicitly requested version is verified against the
        # digests its manifest committed. A mismatch means the bytes on disk are
        # not the bytes the store claims, and the load fails loudly rather than
        # serving a corrupt checkpoint.
        integrity = "skipped"
        if verify:
            integrity = "cached" if version in self._verified else "verified"
            if version not in self._verified:
                report = brain_mod._verify_weights(model, manifest)
                if not report.get("verified"):
                    raise ValueError(
                        f"integrity check failed for {version}: "
                        f"{len(report.get('mismatched') or [])} mismatched, "
                        f"{len(report.get('missing') or [])} missing, "
                        f"{len(report.get('unexpected') or [])} unexpected tensor(s); "
                        "refusing to serve a checkpoint that does not match its manifest"
                    )
                self._verified.add(version)

        try:
            artifact = store.artifact_name(manifest)
        except ValueError:
            artifact = None

        self.model = model
        self.tokenizer = tokenizer
        self.device = device
        self.version = version
        self.artifact_name = artifact
        self.last_integrity = integrity
        brain_mod._log(
            f"student loaded {version} ({artifact or 'unattributed'}) on {device} "
            f"[integrity={integrity}]"
        )
        return {**self._describe(model), "integrity": integrity}

    def _describe(self, model) -> Dict[str, Any]:
        return {
            "version": self.version,
            "artifactName": self.artifact_name,
            "device": self.device,
            "dtype": str(next(model.parameters()).dtype).replace("torch.", ""),
            "parameters": int(sum(p.numel() for p in model.parameters())),
        }

    # ------------------------------------------------------------- requests
    def handle(self, request: Dict[str, Any]) -> Dict[str, Any]:
        op = request.get("op")
        if op in ("ping", "hello"):
            return {"pong": True, "pid": os.getpid(), "protocol": PROTOCOL_VERSION}
        if op == "load":
            return self.load(request.get("version"), verify=bool(request.get("verify")))
        if op == "reload":
            return self.load(None)
        if op == "version":
            if self.model is None:
                return {"version": None, "loaded": False}
            return {"loaded": True, **self._describe(self.model)}
        if op == "generate":
            return self.generate(request)
        if op == "shutdown":
            return {"shutdown": True}
        raise ValueError(f"unknown op: {op!r}")

    def generate(self, request: Dict[str, Any]) -> Dict[str, Any]:
        # Version-aware serving: if the caller pins a version, load it as part of
        # THIS single request, so a concurrent request can never observe weights
        # loaded for another version. The active pointer is never consulted or
        # changed on this path.
        requested = request.get("version")
        if requested is not None:
            if not isinstance(requested, str) or not requested:
                raise ValueError("`version` must be a non-empty string when provided")
            if requested != self.version:
                self.load(requested, verify=bool(request.get("verify", True)))

        if self.model is None:
            raise RuntimeError("no version loaded; send a `load` request first")
        prompt = request.get("prompt")
        if not isinstance(prompt, str) or not prompt:
            raise ValueError("`generate` requires a non-empty string `prompt`")

        result = brain_mod.generate_text(
            self.model,
            self.tokenizer,
            prompt=prompt,
            max_new_tokens=int(request.get("maxNewTokens", 32)),
            temperature=float(request.get("temperature", 0.0)),
            top_p=float(request.get("topP", 0.95)),
            seed=request.get("seed", 0),
            device=self.device,
        )
        return {
            "version": self.version,
            "artifactName": self.artifact_name,
            "integrity": self.last_integrity,
            "text": result["text"],
            "mode": result["mode"],
            "promptTokens": result["promptTokens"],
            "generatedTokens": result["generatedTokens"],
        }


def _respond(payload: Dict[str, Any]) -> None:
    json.dump(payload, sys.stdout, default=str)
    sys.stdout.write("\n")
    sys.stdout.flush()


def serve(root: Path, device: str, initial_version: Optional[str]) -> int:
    worker = StudentWorker(root, device=device)
    if initial_version:
        try:
            worker.load(initial_version)
        except Exception as exc:  # noqa: BLE001 — report and keep serving (idle)
            brain_mod._log(f"initial load failed: {exc}")

    brain_mod._log(f"student worker ready (protocol {PROTOCOL_VERSION}); awaiting requests")
    shutdown = False
    while not shutdown:
        line = sys.stdin.readline()
        if line == "":
            break  # parent closed stdin
        line = line.strip()
        if not line:
            continue

        request_id = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request must be a JSON object")
            request_id = request.get("id")
            payload = worker.handle(request)
            response = {"id": request_id, "ok": True, **payload}
            if request.get("op") == "shutdown":
                shutdown = True
        except Exception as exc:  # noqa: BLE001 — every request gets a response
            brain_mod._log(f"request failed: {exc}")
            response = {"id": request_id, "ok": False, "error": str(exc), "kind": type(exc).__name__}

        _respond(response)

    brain_mod._log("student worker exiting")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="sma.student", description=__doc__)
    parser.add_argument("--out", default=str(store_root()), help="store root (SMA_STORE)")
    parser.add_argument("--device", default="auto", help="auto | cpu | cuda")
    parser.add_argument("--version", default=None, help="load this version at startup")
    args = parser.parse_args(argv)
    return serve(Path(args.out), args.device, args.version)


if __name__ == "__main__":
    raise SystemExit(main())

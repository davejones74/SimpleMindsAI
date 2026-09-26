"""The training loop.

Precision model, and it is not negotiable:

    master weights   fp32   <- the optimizer updates these, always
    compute          bf16   <- an autocast detail, cast on the way in
    gradients        fp32   <- accumulated against the fp32 masters

Keeping the master in bf16 freezes 17 of 74 parameters at lr=1e-4, because
their values sit at 1.0 where bf16 resolution is ~7.8e-3. That failure is
silent: the loss still falls. See the README section
"bf16 master weights silently freeze 17 parameters".

Everything the README's loss-instability section requires is recorded here:
per-step learning rate, gradient norm, training loss, validation loss, NaN/Inf
detection, gradient clipping, and loss-spike detection. A run that trips a
guard stops before it can publish anything, so a failed run can never become
the active brain.
"""

from __future__ import annotations

import contextlib
import platform
import random
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import torch

from . import data as data_mod

SCHEMA = "sma/train-state@1"


class NumericalFailure(RuntimeError):
    """Raised when a guard trips. Never caught-and-continued."""


@dataclass
class TrainConfig:
    """Recorded verbatim in train state, so an instability episode can later be
    attributed to an exact configuration."""

    # Deliberately no default. The README forbids committing to a universal
    # learning rate: the right value depends on optimizer, effective batch size,
    # sequence length, model size, schedule and warm-up. A default here would be
    # a number that looks measured and is not, so it must be supplied explicitly.
    learningRate: Optional[float] = None
    minLearningRateRatio: float = 0.1
    warmupSteps: int = 10
    weightDecay: float = 0.01
    betas: tuple = (0.9, 0.95)
    eps: float = 1e-8
    gradClip: float = 1.0
    sequenceLength: int = 128
    microBatchSize: int = 2
    gradAccumSteps: int = 2
    steps: int = 60
    seed: int = 0
    computeDtype: str = "bfloat16"
    masterDtype: str = "float32"
    optimizer: str = "adamw"
    scheduler: str = "cosine"
    validationBlocks: int = 2
    logEvery: int = 1
    spikeFactor: float = 2.5
    spikeWarmup: int = 10
    maxNonFiniteConsecutive: int = 3

    def effectiveBatchSize(self) -> int:
        return self.microBatchSize * self.gradAccumSteps

    def to_json(self) -> Dict[str, Any]:
        d = asdict(self)
        d["betas"] = list(self.betas)
        d["effectiveBatchSize"] = self.effectiveBatchSize()
        return d

    def validate(self) -> None:
        if self.learningRate is None:
            raise ValueError(
                "learningRate must be supplied explicitly. There is intentionally no "
                "default: see the README section on loss instability."
            )
        if self.learningRate <= 0:
            raise ValueError("learningRate must be positive")
        if self.masterDtype != "float32":
            raise ValueError(
                f"masterDtype must be float32, got {self.masterDtype!r}. bf16 masters "
                "silently freeze the 17 RMSNorm parameters; see the README."
            )
        if self.steps <= 0:
            raise ValueError("steps must be positive")
        if self.gradClip is not None and self.gradClip <= 0:
            raise ValueError("gradClip must be positive or None")
        if self.microBatchSize <= 0 or self.gradAccumSteps <= 0:
            raise ValueError("batch dimensions must be positive")


def environment() -> Dict[str, Any]:
    import transformers

    return {
        "python": platform.python_version(),
        "torch": torch.__version__,
        "transformers": transformers.__version__,
        "cudaAvailable": torch.cuda.is_available(),
        "device": "cuda" if torch.cuda.is_available() else "cpu",
    }


def capture_rng_state() -> Dict[str, Any]:
    state: Dict[str, Any] = {
        "python": random.getstate(),
        "numpy": np.random.get_state(),
        "torch": torch.get_rng_state(),
    }
    if torch.cuda.is_available():
        state["torchCuda"] = torch.cuda.get_rng_state_all()
    return state


def _jsonable_rng(state: Dict[str, Any]) -> Dict[str, Any]:
    version, internal, gauss_next = state["python"]
    out = {
        # Encoded structurally, not as repr(). repr() round-trips to a string
        # that random.setstate() cannot consume, which is how a "resumable"
        # RNG state quietly stops being resumable.
        "python": {
            "version": version,
            "internal": list(internal),
            "gaussNext": gauss_next,
        },
        "numpy": [
            state["numpy"][0].hex() if hasattr(state["numpy"][0], "hex") else state["numpy"][0],
            state["numpy"][1].tolist(),
            state["numpy"][2],
            state["numpy"][3],
            state["numpy"][4],
        ],
        "torch": state["torch"].tolist(),
    }
    if "torchCuda" in state:
        out["torchCuda"] = [t.tolist() for t in state["torchCuda"]]
    return out


def restore_rng_state(state: Dict[str, Any]) -> None:
    py = state["python"]
    random.setstate((py["version"], tuple(py["internal"]), py["gaussNext"]))
    np_state = state["numpy"]
    np.random.set_state(
        (
            np_state[0],
            np.asarray(np_state[1], dtype=np.int64),
            np_state[2],
            np_state[3],
            np_state[4],
        )
    )
    torch.set_rng_state(torch.tensor(state["torch"], dtype=torch.uint8))
    if "torchCuda" in state and torch.cuda.is_available():
        torch.cuda.set_rng_state_all(
            [torch.tensor(t, dtype=torch.uint8) for t in state["torchCuda"]]
        )


def learning_rate_at(step: int, cfg: TrainConfig) -> float:
    """Linear warm-up then cosine decay to minLearningRateRatio of peak."""
    if cfg.warmupSteps > 0 and step < cfg.warmupSteps:
        return cfg.learningRate * (step + 1) / cfg.warmupSteps
    span = max(cfg.steps - cfg.warmupSteps, 1)
    progress = min(max(step - cfg.warmupSteps, 0) / span, 1.0)
    floor = cfg.learningRate * cfg.minLearningRateRatio
    cosine = 0.5 * (1.0 + np.cos(np.pi * progress))
    return floor + (cfg.learningRate - floor) * cosine


@dataclass
class StepRecord:
    step: int
    learningRate: float
    gradNorm: float
    clipped: bool
    loss: float
    nonFinite: bool
    tokens: int
    seconds: float


@dataclass
class TrainResult:
    version: str
    parentVersion: str
    steps: int
    tokensSeen: int
    finalTrainLoss: float
    finalValidationLoss: Optional[float]
    initialTrainLoss: float
    initialValidationLoss: Optional[float]
    blocks: int
    microBatchSize: int
    gradAccumSteps: int
    effectiveBatchSize: int
    wallSeconds: float
    stoppedEarly: bool
    stopReason: Optional[str]
    history: List[Dict[str, Any]] = field(default_factory=list)


def _finite(t: torch.Tensor) -> bool:
    return bool(torch.isfinite(t).all())


def train(
    *,
    model: torch.nn.Module,
    tokenizer: Any,
    documents: List[Dict[str, str]],
    cfg: TrainConfig,
    parent_version: str,
    new_version: str,
    tokenizer_path: Path,
    device: str,
    resume: Optional[Dict[str, Any]] = None,
    optimizer_state: Optional[Dict[str, Any]] = None,
    log=lambda _msg: None,
) -> tuple[TrainResult, Dict[str, Any], "torch.optim.Optimizer"]:
    """Run real optimization.

    Returns the result, the JSON-readable train state, and the optimizer (whose
    moments cannot be JSON, so the caller persists them separately).

    Does not save anything. The caller publishes, so a failure here can never
    leave a half-written checkpoint looking valid.
    """
    cfg.validate()
    started = time.perf_counter()

    random.seed(cfg.seed)
    np.random.seed(cfg.seed)
    torch.manual_seed(cfg.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(cfg.seed)

    blocks, pack_record = data_mod.pack(
        tokenizer, documents, cfg.sequenceLength, tokenizer_path
    )
    train_blocks, val_blocks = data_mod.train_validation_split(blocks, cfg.validationBlocks)
    log(
        f"packed {pack_record.documentCount} docs -> {pack_record.blockCount} blocks "
        f"({pack_record.tokensSeen} tokens, {pack_record.droppedTokens} dropped); "
        f"{train_blocks.shape[0]} train / {val_blocks.shape[0]} val"
    )

    model = model.to(device)
    # Masters are fp32. This is the whole precision model.
    model = model.float()
    compute_dtype = getattr(torch, cfg.computeDtype)

    start_step = 0
    order = torch.randperm(train_blocks.shape[0])
    cursor = 0
    tokens_seen = 0
    history: List[Dict[str, Any]] = []
    losses: List[float] = []

    decay, no_decay = [], []
    for name, param in model.named_parameters():
        (no_decay if param.ndim < 2 else decay).append(param)
    optimizer = torch.optim.AdamW(
        [
            {"params": decay, "weight_decay": cfg.weightDecay},
            {"params": no_decay, "weight_decay": 0.0},
        ],
        lr=cfg.learningRate,
        betas=tuple(cfg.betas),
        eps=cfg.eps,
    )

    if resume is not None:
        # Refuse to resume across a changed corpus or config. Silently continuing
        # against different data would make the recorded attribution a lie, which
        # is the whole reason the train state records these hashes.
        if resume.get("packing", {}).get("datasetHash") != pack_record.datasetHash:
            raise ValueError(
                "refusing to resume: datasetHash differs "
                f"({resume.get('packing', {}).get('datasetHash')} -> {pack_record.datasetHash})"
            )
        # `steps` is exempt: growing the target is what resuming *is*. Every other
        # field must match exactly, because a changed LR, schedule, packing or
        # batch shape would make the two halves of the run non-comparable.
        prev_cfg = dict(resume.get("config", {}))
        want_cfg = cfg.to_json()
        prev_steps = prev_cfg.pop("steps", None)
        want_steps = want_cfg.pop("steps", None)
        if prev_cfg != want_cfg:
            differing = sorted(
                k for k in set(prev_cfg) | set(want_cfg) if prev_cfg.get(k) != want_cfg.get(k)
            )
            raise ValueError(
                "refusing to resume: train config differs on " + ", ".join(differing)
            )
        if int(resume["stepsCompleted"]) >= cfg.steps:
            raise ValueError(
                f"refusing to resume: already at step {resume['stepsCompleted']}, "
                f"target is {cfg.steps}. Raise --steps to continue."
            )
        if optimizer_state is not None:
            optimizer.load_state_dict(optimizer_state)
        restore_rng_state(resume["rngState"])
        start_step = int(resume["stepsCompleted"])
        order = torch.tensor(resume["order"], dtype=torch.long)
        cursor = int(resume["cursor"])
        tokens_seen = int(resume["tokensSeen"])
        history = list(resume.get("history", []))
        losses = [h["loss"] for h in history if "loss" in h]
        log(
            f"resuming at step {start_step}/{cfg.steps} "
            f"(cursor {cursor}, {tokens_seen} tokens already seen)"
        )

    autocast_dtype = compute_dtype
    device_type = torch.device(device).type

    if device_type == "cpu" and cfg.computeDtype == "bfloat16":
        # Measured on this machine: 28.96s per forward+backward against 0.13s for
        # fp32, a 220x penalty, because this CPU has no native bf16 and PyTorch
        # emulates it. Correct, but so slow it reads as a hang. bf16 compute is
        # for the accelerator; fp32 is for the CPU.
        log(
            "WARNING: bf16 compute on CPU is emulated and ~220x slower than fp32 "
            "on this machine. Correct, but expect it to crawl. Use "
            "--compute-dtype float32 for CPU runs."
        )

    def autocast():
        # fp32 "autocast" is a no-op that torch warns about on every call. Skip it
        # rather than pay a warning per step to express "do not change dtype".
        if cfg.computeDtype == "float32":
            return contextlib.nullcontext()
        return torch.autocast(device_type=device_type, dtype=autocast_dtype)

    def evaluate() -> Optional[float]:
        if val_blocks.numel() == 0:
            return None
        was_training = model.training
        model.eval()
        weighted = 0.0
        tokens = 0
        with torch.no_grad():
            for i in range(0, val_blocks.shape[0], cfg.microBatchSize):
                batch = val_blocks[i : i + cfg.microBatchSize].to(device)
                with autocast():
                    loss = float(model(input_ids=batch, labels=batch).loss)
                # Weight by tokens, not by batch. A short final batch is smaller,
                # and averaging batch means would silently over-weight it.
                weighted += loss * int(batch.numel())
                tokens += int(batch.numel())
        if was_training:
            model.train()
        return weighted / tokens

    # Baseline before any update: the honest "before" number. Measured through the
    # same autocast path as the training steps, or it is not a comparable baseline.
    initial_batch = train_blocks[: cfg.microBatchSize].to(device)
    with torch.no_grad(), autocast():
        initial_train_loss = float(
            model(input_ids=initial_batch, labels=initial_batch).loss
        )
    initial_validation_loss = evaluate()
    log(f"initial train loss {initial_train_loss:.4f} (uniform = ln(V))")
    if initial_validation_loss is not None:
        log(f"initial validation loss {initial_validation_loss:.4f}")

    model.train()
    consecutive_nonfinite = 0
    stopped_early = False
    stop_reason: Optional[str] = None
    steps_this_run = 0

    for step in range(start_step, cfg.steps):
        step_started = time.perf_counter()
        lr = learning_rate_at(step, cfg)
        for group in optimizer.param_groups:
            group["lr"] = lr

        optimizer.zero_grad(set_to_none=True)
        accumulated = 0.0
        step_nonfinite = False
        step_clipped = False

        for _ in range(cfg.gradAccumSteps):
            # Drop the ragged tail rather than taking a short micro-batch. A
            # partial batch makes the effective batch size vary per step, which
            # makes the recorded effectiveBatchSize a lie and weights the loss
            # average unevenly. Dropping is honest; a varying shape is not.
            if order.shape[0] - cursor < cfg.microBatchSize:
                order = torch.randperm(train_blocks.shape[0])
                cursor = 0
            batch = train_blocks[
                order[cursor : cursor + cfg.microBatchSize]
            ].to(device)
            cursor += cfg.microBatchSize
            tokens_seen += int(batch.numel())

            with autocast():
                loss = model(input_ids=batch, labels=batch).loss
            loss_value = float(loss.detach())
            if not np.isfinite(loss_value):
                step_nonfinite = True
            (loss / cfg.gradAccumSteps).backward()
            accumulated += loss_value / cfg.gradAccumSteps

        if cfg.gradClip is not None:
            total_norm = float(torch.nn.utils.clip_grad_norm_(model.parameters(), cfg.gradClip))
            step_clipped = total_norm > cfg.gradClip
            if not np.isfinite(total_norm):
                step_nonfinite = True
        else:
            total_norm = float(
                torch.linalg.vector_norm(
                    torch.stack(
                        [p.grad.detach().float().norm() for p in model.parameters() if p.grad is not None]
                    )
                )
            )

        if step_nonfinite:
            consecutive_nonfinite += 1
            log(
                f"step {step}: NON-FINITE loss/grad (consecutive {consecutive_nonfinite}) "
                "- stopping before publish"
            )
            if consecutive_nonfinite >= cfg.maxNonFiniteConsecutive:
                raise NumericalFailure(
                    f"{consecutive_nonfinite} consecutive non-finite steps at step {step}"
                )
            stopped_early = True
            stop_reason = "non_finite"
            break

        consecutive_nonfinite = 0
        optimizer.step()
        losses.append(accumulated)

        if (
            step >= cfg.spikeWarmup
            and len(losses) > 10
            and cfg.spikeFactor > 0
        ):
            window = losses[:-1][-20:]
            mean = float(np.mean(window))
            std = float(np.std(window))
            if std > 0 and accumulated > mean + cfg.spikeFactor * std:
                raise NumericalFailure(
                    f"loss spike at step {step}: {accumulated:.4f} vs "
                    f"mean {mean:.4f} + {cfg.spikeFactor}sd"
                )

        if step % cfg.logEvery == 0:
            log(
                f"step {step:4d}/{cfg.steps}  loss {accumulated:.4f}  lr {lr:.2e}  "
                f"gnorm {total_norm:.3f}{'  (clipped)' if step_clipped else ''}"
            )
        history.append(
            {
                "step": step,
                "learningRate": lr,
                "gradNorm": total_norm,
                "clipped": step_clipped,
                "loss": accumulated,
                "nonFinite": step_nonfinite,
                "tokens": tokens_seen,
                "seconds": round(time.perf_counter() - step_started, 4),
            }
        )
        steps_this_run += 1

    # Derived from an explicit counter rather than the loop variable's final
    # value, which is wrong by one on both the normal and the early-break path.
    completed = start_step + steps_this_run
    final_train_loss = history[-1]["loss"] if history else initial_train_loss
    final_validation_loss = evaluate() if not stopped_early else None

    result = TrainResult(
        version=new_version,
        parentVersion=parent_version,
        steps=completed,
        tokensSeen=tokens_seen,
        finalTrainLoss=final_train_loss,
        finalValidationLoss=final_validation_loss,
        initialTrainLoss=initial_train_loss,
        initialValidationLoss=initial_validation_loss,
        blocks=int(train_blocks.shape[0]),
        microBatchSize=cfg.microBatchSize,
        gradAccumSteps=cfg.gradAccumSteps,
        effectiveBatchSize=cfg.effectiveBatchSize(),
        wallSeconds=round(time.perf_counter() - started, 3),
        stoppedEarly=stopped_early,
        stopReason=stop_reason,
        history=history,
    )

    train_state = {
        "schema": SCHEMA,
        "version": new_version,
        "parentVersion": parent_version,
        "resumedFromStep": start_step,
        "config": cfg.to_json(),
        "packing": pack_record.to_json(),
        "stepsCompleted": completed,
        "tokensSeen": tokens_seen,
        # The sample order and its cursor are part of the resume state. Without
        # them a resumed run silently restarts the shuffle, so "resumed" and
        # "retrained from the same corpus" become indistinguishable in the record.
        "order": [int(i) for i in order.tolist()],
        "cursor": cursor,
        "wallSeconds": result.wallSeconds,
        "stoppedEarly": stopped_early,
        "stopReason": stop_reason,
        "initialTrainLoss": initial_train_loss,
        "finalTrainLoss": final_train_loss,
        "initialValidationLoss": initial_validation_loss,
        "finalValidationLoss": final_validation_loss,
        "environment": environment(),
        "rngState": _jsonable_rng(capture_rng_state()),
        "history": history,
    }
    return result, train_state, optimizer


def save_train_state(path: Path, train_state: Dict[str, Any], optimizer) -> None:
    """Optimizer moments are torch-pickled; everything a human reads stays JSON.

    Kept separate from the checkpoint so the readable record stays reviewable in
    a diff and the pickle is never the only copy of anything.
    """
    torch.save(
        {
            "schema": SCHEMA,
            "optimizer": optimizer.state_dict(),
            "rngState": train_state["rngState"],
            "order": train_state["order"],
            "cursor": train_state["cursor"],
            "stepsCompleted": train_state["stepsCompleted"],
        },
        path,
    )


def load_train_state(path: Path) -> Dict[str, Any]:
    return torch.load(path, map_location="cpu", weights_only=False)


def named_parameter_snapshots(model: torch.nn.Module) -> Dict[str, torch.Tensor]:
    """`named_parameters()` only. Tied embeddings are already deduplicated here,
    which is why the diff counts 74 rather than the 75 state_dict entries.

    Snapshotted onto CPU deliberately. `train()` moves the model to the
    accelerator in place, so a before/after pair taken around it can end up on
    two different devices and fail the comparison for a reason that has nothing
    to do with the weights.
    """
    return {name: p.detach().to("cpu").clone() for name, p in model.named_parameters()}


def named_buffer_snapshots(model: torch.nn.Module) -> Dict[str, torch.Tensor]:
    return {name: b.detach().to("cpu").clone() for name, b in model.named_buffers()}


def diff_tensors(
    before: Dict[str, Any], after: Dict[str, Any], tolerance: float = 0.0
) -> Dict[str, Any]:
    """Check 7, narrowly.

    Compares `named_parameters()` only. The 2 RoPE buffers are non-persistent,
    absent from `state_dict()`, and constant by construction — asserting they
    changed would be asserting a constant moved.

    `tolerance` is a *materiality* threshold on the max absolute delta, not a
    numerical-noise epsilon. A parameter that moved by 1e-7 has not been
    meaningfully trained, and counting it as changed would hide exactly the
    bf16-freeze failure this check exists to catch.
    """
    only_before = sorted(set(before) - set(after))
    only_after = sorted(set(after) - set(before))
    common = sorted(set(before) & set(after))

    changed: List[Dict[str, Any]] = []
    unchanged: List[Dict[str, Any]] = []
    shape_mismatch: List[str] = []

    for name in common:
        b, a = before[name], after[name]
        if tuple(b.shape) != tuple(a.shape):
            shape_mismatch.append(name)
            continue
        delta = float((a.float() - b.float()).abs().max()) if a.numel() else 0.0
        entry = {"name": name, "maxAbsDelta": delta}
        (changed if delta > tolerance else unchanged).append(entry)

    return {
        "compared": len(common),
        "changed": changed,
        "unchanged": unchanged,
        "changedCount": len(changed),
        "unchangedCount": len(unchanged),
        "onlyBefore": only_before,
        "onlyAfter": only_after,
        "shapeMismatch": shape_mismatch,
        "tolerance": tolerance,
    }


def assert_buffers_unchanged(
    before: Dict[str, torch.Tensor], after: Dict[str, torch.Tensor]
) -> Dict[str, Any]:
    """The other half of check 7. Buffers are expected to be *identical*, not
    merely similar: the RoPE tables are a closed-form function of head_dim and
    rope_theta, so any movement means the tables are desynchronised."""
    drifted = [
        name
        for name in sorted(set(before) & set(after))
        if not torch.equal(before[name], after[name])
    ]
    return {
        "compared": len(set(before) & set(after)),
        "drifted": drifted,
        "driftedCount": len(drifted),
        "onlyBefore": sorted(set(before) - set(after)),
        "onlyAfter": sorted(set(after) - set(before)),
    }

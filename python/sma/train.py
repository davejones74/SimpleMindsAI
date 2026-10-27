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
the active brain. A spike is only fatal when it *persists*: an isolated
excursion above the trailing window is recorded and logged, because a model
training from random init crosses that line by ordinary noise long before it
diverges.
"""

from __future__ import annotations

import contextlib
import math
import random
import re
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import torch

from . import data as data_mod

SCHEMA = "sma/train-state@1"
LAYER_PARAMETER_RE = re.compile(r"^model\.layers\.(\d+)\.")


def layer_parameter_groups(model: torch.nn.Module) -> Dict[int, List[torch.nn.Parameter]]:
    """Reference parameters grouped by decoder block.

    This stores parameter references only (already owned by the model); it never
    copies weights, gradients or activations.
    """
    groups: Dict[int, List[torch.nn.Parameter]] = {}
    for name, parameter in model.named_parameters():
        match = LAYER_PARAMETER_RE.match(name)
        if match:
            groups.setdefault(int(match.group(1)), []).append(parameter)
    return groups


def summarize_layer_gradient_rms(
    groups: Dict[int, List[torch.nn.Parameter]],
    *,
    step: Optional[int] = None,
    phase: str = "pre-clip",
) -> Optional[Dict[str, Any]]:
    """Aggregate gradient RMS per decoder block, with one host synchronisation.

    For each block:

        rms = sqrt(mean(g^2))

    over every gradient element in that block, measured after backward and
    BEFORE gradient clipping. `g` is the gradient already produced by the
    normal training pass; nothing is captured, retained or modified. The
    per-tensor reductions remain on the device and only the final one-scalar-
    per-layer vector is copied to the host, once per sample.

    This is a training-gradient magnitude, not an activation, attention map,
    neuron activity or signal pathway.
    """
    if not groups:
        return None
    entries: List[Dict[str, Any]] = []
    scalars: List[Optional[torch.Tensor]] = []
    with torch.no_grad():
        for index in sorted(groups):
            total_sq = None
            elements = 0
            for parameter in groups[index]:
                gradient = parameter.grad
                if gradient is None:
                    continue
                elements += int(gradient.numel())
                norm_sq = torch.linalg.vector_norm(gradient.detach().float()) ** 2
                total_sq = norm_sq if total_sq is None else total_sq + norm_sq
            if total_sq is None or elements == 0:
                scalars.append(None)
                entries.append({
                    "index": index,
                    "componentId": f"model.layers.{index}",
                    "rms": None,
                    "elements": 0,
                })
            else:
                scalars.append(torch.sqrt(total_sq / elements))
                entries.append({
                    "index": index,
                    "componentId": f"model.layers.{index}",
                    "rms": None,
                    "elements": elements,
                })
        present = [value for value in scalars if value is not None]
        if present:
            values = torch.stack(present).detach().cpu().tolist()
            cursor = 0
            for entry, scalar in zip(entries, scalars):
                if scalar is None:
                    continue
                value = float(values[cursor])
                cursor += 1
                entry["rms"] = value if math.isfinite(value) else None
    return {
        "measure": "gradientRms",
        "phase": phase,
        "aggregation": "per-transformer-block",
        "step": step,
        "layers": entries,
    }


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
    # A spike threshold is crossed by ordinary noise as well as by divergence, so
    # a single crossing is logged but not fatal. Only this many *consecutive*
    # steps above `mean + spikeFactor*sd` mean the run has actually left the
    # basin and must not publish.
    maxSpikeConsecutive: int = 3
    maxNonFiniteConsecutive: int = 3
    # Record held-out validation loss every N steps so a validation *curve*
    # exists, not just the two endpoints. 0 disables periodic sampling (a run
    # then records only the opening and closing validation losses, and trend
    # classification honestly reports "insufficient evidence").
    evalEvery: int = 0

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
        if self.evalEvery < 0:
            raise ValueError("evalEvery cannot be negative; 0 disables periodic validation")
        if self.maxSpikeConsecutive < 1:
            raise ValueError(
                "maxSpikeConsecutive must be at least 1: a lone spike is logged, "
                "so 0 would leave no spike ever fatal"
            )


def environment() -> Dict[str, Any]:
    # Vendor-neutral. This records the accelerator *vendor* ("cuda" / "rocm" /
    # "cpu") plus the runtime version, not a CUDA-only "cudaAvailable" flag that
    # is true-by-design under ROCm. See sma/portability.py.
    from . import portability

    return portability.runtime_environment()


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
    validationHistory: List[Dict[str, Any]] = field(default_factory=list)
    # Best-checkpoint selection: the step whose held-out (in-training) validation
    # loss was lowest, and that loss. When selection is disabled or no validation
    # was ever measurable, both are None and the final step is published.
    selectedStep: Optional[int] = None
    selectedValidationLoss: Optional[float] = None


def _finite(t: torch.Tensor) -> bool:
    return bool(torch.isfinite(t).all())


def loss_spike_exceeded(
    recent_losses: List[float],
    current: float,
    factor: float,
    *,
    window: int = 20,
    min_history: int = 10,
) -> Optional[Dict[str, float]]:
    """Return the trailing-window stats when `current` sits above them, else None.

    Pure, so the guard's arithmetic is testable without building a model.
    Detection needs an established baseline: with fewer than `min_history`
    points, or with zero spread, nothing can be called a spike. `factor <= 0`
    disables detection entirely.
    """
    if factor <= 0 or len(recent_losses) < min_history:
        return None
    window_losses = recent_losses[-window:]
    mean = float(np.mean(window_losses))
    std = float(np.std(window_losses))
    if std <= 0:
        return None
    if current > mean + factor * std:
        return {"mean": mean, "std": std, "z": (current - mean) / std}
    return None


@dataclass
class SpikeTracker:
    """Counts *consecutive* spikes so one transient excursion is not fatal.

    A single step above the trailing window is ordinary noise while training
    from random init; a run that stays above it is diverging. Only the latter
    may stop a run, so this tracks the streak and resets it on any in-band step.
    Kept separate from the loop so the streak arithmetic is testable on its own.
    """

    factor: float
    warmup: int
    max_consecutive: int
    consecutive: int = 0

    def observe(
        self, step: int, recent_losses: List[float], current: float
    ) -> tuple:
        """Return `(stats, fatal_message)`; either or both may be None.

        `stats` is non-None whenever this step exceeded the threshold (so the
        caller logs every spike), `fatal_message` only once the streak reaches
        `max_consecutive`.
        """
        if step < self.warmup:
            self.consecutive = 0
            return None, None
        stats = loss_spike_exceeded(recent_losses, current, self.factor)
        if stats is None:
            self.consecutive = 0
            return None, None
        self.consecutive += 1
        if self.consecutive >= self.max_consecutive:
            return stats, (
                f"{self.consecutive} consecutive loss spikes at step {step}: "
                f"{current:.4f} vs mean {stats['mean']:.4f} + {self.factor}sd"
            )
        return stats, None


def mean_cross_entropy(
    model: torch.nn.Module,
    blocks: torch.Tensor,
    *,
    device: str,
    micro_batch_size: int,
    compute_dtype: str = "float32",
) -> Optional[float]:
    """Token-weighted mean next-token cross-entropy over fixed-length blocks.

    Weighted by token count rather than by the mean of batch means: a short
    final batch is smaller, and averaging batch means would silently over-weight
    it. This is exactly the reduction the training loop's validation uses,
    exposed as a function so evaluation and training cannot drift apart — the
    promotion gate compares parent and candidate through this one path.

    Returns None for an empty block set.
    """
    if blocks.numel() == 0:
        return None
    was_training = model.training
    model.eval()
    device_type = torch.device(device).type
    weighted = 0.0
    tokens = 0
    with torch.no_grad():
        for i in range(0, blocks.shape[0], micro_batch_size):
            batch = blocks[i : i + micro_batch_size].to(device)
            if compute_dtype == "float32":
                ctx = contextlib.nullcontext()
            else:
                ctx = torch.autocast(
                    device_type=device_type, dtype=getattr(torch, compute_dtype)
                )
            with ctx:
                loss = float(model(input_ids=batch, labels=batch).loss)
            weighted += loss * int(batch.numel())
            tokens += int(batch.numel())
    if was_training:
        model.train()
    return weighted / tokens


def per_document_cross_entropy(
    model: torch.nn.Module,
    documents: List[Dict[str, Any]],
    tokenizer: Any,
    *,
    device: str,
    max_sequence_length: int,
    compute_dtype: str = "float32",
) -> List[Dict[str, Any]]:
    """Token-weighted next-token cross-entropy scored PER DOCUMENT.

    The promotion gate needs a paired unit (document or source group) so parent
    and candidate can be compared on the SAME evidence rather than on one pooled
    average whose standard error is not defined. Packing concatenates documents
    across block boundaries, so a per-document number cannot be recovered from
    the packed stream; each document is therefore tokenised and scored on its
    own, in non-overlapping `max_sequence_length` windows, weighted by the
    number of label tokens.

    `documents` rows are `{ articleId, text, group }`. Documents that tokenise to
    fewer than two tokens produce no finite loss and are omitted (they cannot
    contribute a next-token label).
    """
    was_training = model.training
    model.eval()
    device_type = torch.device(device).type
    out: List[Dict[str, Any]] = []
    with torch.no_grad():
        for doc in documents:
            text = str(doc.get("text") or "")
            if not text.strip():
                continue
            ids = tokenizer(text, add_special_tokens=False).input_ids
            if len(ids) < 2:
                continue
            weighted = 0.0
            tokens = 0
            for start in range(0, len(ids), max_sequence_length):
                chunk = ids[start : start + max_sequence_length]
                if len(chunk) < 2:
                    continue
                batch = torch.tensor([chunk], dtype=torch.long, device=device)
                if compute_dtype == "float32":
                    ctx = contextlib.nullcontext()
                else:
                    ctx = torch.autocast(
                        device_type=device_type, dtype=getattr(torch, compute_dtype)
                    )
                with ctx:
                    loss = float(model(input_ids=batch, labels=batch).loss)
                weighted += loss * int(batch.numel())
                tokens += int(batch.numel())
            if tokens <= 0:
                continue
            out.append(
                {
                    "articleId": doc.get("articleId"),
                    "group": doc.get("group"),
                    "tokens": tokens,
                    "loss": weighted / tokens,
                }
            )
    if was_training:
        model.train()
    return out


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
    telemetry=lambda _event: None,
    telemetry_interval_ms: int = 1000,
    layer_activity_enabled: bool = False,
    layer_activity_interval_ms: int = 2000,
    select_best: bool = True,
) -> tuple[TrainResult, Dict[str, Any], "torch.optim.Optimizer"]:
    """Run real optimization.

    Returns the result, the JSON-readable train state, and the optimizer (whose
    moments cannot be JSON, so the caller persists them separately).

    `telemetry` is observational only: it receives a bounded snapshot at
    `telemetry_interval_ms` boundaries, plus evaluation/start events. It is
    called from the main training thread, never from a worker, and every error
    it raises is swallowed so an observer can never affect the run.

    Does not save anything. The caller publishes, so a failure here can never
    leave a half-written checkpoint looking valid.
    """
    cfg.validate()
    started = time.perf_counter()
    telemetry_interval_s = max(0.25, min(60.0, float(telemetry_interval_ms) / 1000.0))
    layer_activity_interval_s = max(0.5, min(60.0, float(layer_activity_interval_ms) / 1000.0))
    last_telemetry_at = 0.0
    last_layer_activity_at = 0.0

    def emit_telemetry(kind: str, **fields: Any) -> None:
        """Never let presentation work perturb optimization or its outcome."""
        try:
            telemetry({"type": kind, **fields})
        except Exception:
            pass

    def finite_or_none(value: Any) -> Optional[float]:
        number = float(value)
        return number if np.isfinite(number) else None

    random.seed(cfg.seed)
    np.random.seed(cfg.seed)
    torch.manual_seed(cfg.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(cfg.seed)

    train_blocks, val_blocks, pack_record, split = data_mod.pack_for_training(
        tokenizer,
        documents,
        cfg.sequenceLength,
        tokenizer_path,
        cfg.validationBlocks,
        on_warning=log,
    )
    log(
        f"packed {pack_record.documentCount} docs -> {pack_record.blockCount} blocks "
        f"({pack_record.tokensSeen} tokens, {pack_record.droppedTokens} dropped); "
        f"{train_blocks.shape[0]} train / {val_blocks.shape[0]} val "
        f"({split['mode']})"
    )
    if split["shortfall"]:
        log(
            f"WARNING: validation requested {split['requestedValidationBlocks']} block(s), "
            f"only {split['actualValidationBlocks']} available"
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
    validation_history: List[Dict[str, Any]] = []

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
    layer_groups = layer_parameter_groups(model) if layer_activity_enabled else {}

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
        validation_history = list(resume.get("validationHistory", []))
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
        return mean_cross_entropy(
            model,
            val_blocks,
            device=device,
            micro_batch_size=cfg.microBatchSize,
            compute_dtype=cfg.computeDtype,
        )

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

    # Best-checkpoint selection. The candidate that gets published is the TRAINED
    # step with the LOWEST held-out (in-training) validation loss, not the final
    # step: a schedule whose validation drifts back up after a mid-run minimum
    # must not ship the degraded tail. The opening (parent) state is NOT a
    # candidate — the least-bad trained checkpoint is still a trained checkpoint,
    # and the frozen evaluation set remains the promotion GATE (in-training
    # validation is only the SELECTION criterion). Best weights are held on the
    # CPU as fp32 masters (one extra ~248 MB copy for the 62M model).
    best_validation_loss = None
    best_step = None
    best_state = None

    # Seed the validation curve with the opening point. On a resume the carried
    # history already ends on the boundary this segment opens from (its final
    # sample sits at start_step - 1), so only a genuinely new boundary is
    # recorded -- a resumed curve stays continuous rather than double-counting
    # the same weights under the previous segment's last label.
    if initial_validation_loss is not None:
        if not validation_history:
            validation_history.append({"step": start_step, "loss": initial_validation_loss})
        elif validation_history[-1]["step"] < start_step - 1:
            validation_history.append({"step": start_step - 1, "loss": initial_validation_loss})

    emit_telemetry(
        "started",
        step=start_step,
        totalSteps=cfg.steps,
        learningRate=finite_or_none(learning_rate_at(start_step, cfg)),
        tokensSeen=tokens_seen,
        initialTrainLoss=finite_or_none(initial_train_loss),
        initialValidationLoss=finite_or_none(initial_validation_loss) if initial_validation_loss is not None else None,
        elapsedMs=round((time.perf_counter() - started) * 1000, 1),
    )
    if initial_validation_loss is not None:
        emit_telemetry(
            "evaluation",
            step=start_step,
            loss=finite_or_none(initial_validation_loss),
            learningRate=finite_or_none(learning_rate_at(start_step, cfg)),
        )

    model.train()
    consecutive_nonfinite = 0
    spikes = SpikeTracker(
        factor=cfg.spikeFactor,
        warmup=cfg.spikeWarmup,
        max_consecutive=cfg.maxSpikeConsecutive,
    )
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

        now_perf = time.perf_counter()
        snapshot_due = (
            now_perf - last_telemetry_at >= telemetry_interval_s
            or step == cfg.steps - 1
        )
        layer_activity = None
        if (
            layer_activity_enabled
            and snapshot_due
            and (
                now_perf - last_layer_activity_at >= layer_activity_interval_s
                or step == cfg.steps - 1
            )
        ):
            # Read-only aggregate of gradients that backward already produced.
            # Deliberately BEFORE clipping, so the published number describes
            # the raw per-block gradient magnitude for this sampled step. An
            # optional observer must never be able to fail the training run.
            try:
                layer_activity = summarize_layer_gradient_rms(
                    layer_groups,
                    step=step + 1,
                    phase="pre-clip",
                )
            except Exception:
                layer_activity = None
            last_layer_activity_at = time.perf_counter()

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

        spike_stats, spike_fatal = spikes.observe(step, losses[:-1], accumulated)
        if spike_stats is not None:
            log(
                f"step {step}: loss spike {accumulated:.4f} vs mean "
                f"{spike_stats['mean']:.4f} + {cfg.spikeFactor}sd "
                f"({spike_stats['z']:.1f}sd, consecutive {spikes.consecutive})"
            )
        if spike_fatal is not None:
            raise NumericalFailure(spike_fatal)

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
                "spike": spike_stats is not None,
                "tokens": tokens_seen,
                "seconds": round(time.perf_counter() - step_started, 4),
            }
        )
        steps_this_run += 1

        # Bounded observational snapshot. All values below are already computed
        # for the durable history; this adds no tensor sync and no device copy.
        if snapshot_due:
            now_perf = time.perf_counter()
            elapsed = max(now_perf - started, 1e-9)
            snapshot_fields = {
                "step": step + 1,
                "totalSteps": cfg.steps,
                "loss": finite_or_none(accumulated),
                "learningRate": finite_or_none(lr),
                "gradNorm": finite_or_none(total_norm),
                "clipped": step_clipped,
                "tokensSeen": tokens_seen,
                "stepSeconds": history[-1]["seconds"],
                "stepsPerSecond": round(steps_this_run / elapsed, 4),
                "elapsedMs": round(elapsed * 1000, 1),
            }
            if layer_activity is not None:
                snapshot_fields["layerActivity"] = layer_activity
            emit_telemetry("snapshot", **snapshot_fields)
            last_telemetry_at = now_perf

        # Periodic held-out validation: measured in eval mode, under no_grad,
        # through the same token-weighted mean_cross_entropy path the promotion
        # gate uses, so training and evaluation cannot drift apart. Sampled
        # after the optimizer step, labelled with that step.
        if cfg.evalEvery > 0 and (step + 1) % cfg.evalEvery == 0:
            periodic_val = evaluate()
            if periodic_val is not None:
                validation_history.append({"step": step, "loss": periodic_val})
                if select_best and (best_validation_loss is None or periodic_val < best_validation_loss):
                    best_validation_loss = periodic_val
                    best_step = step
                    # `state_dict()` (not `named_parameters()`) so the tied
                    # `lm_head.weight` alias is present and load_state_dict can
                    # restore strict; values are detached CPU clones so they are
                    # a true snapshot, not a live reference to the model.
                    best_state = {
                        name: tensor.detach().to("cpu").clone()
                        for name, tensor in model.state_dict().items()
                    }
                emit_telemetry(
                    "evaluation",
                    step=step + 1,
                    loss=finite_or_none(periodic_val),
                    learningRate=finite_or_none(lr),
                    tokensSeen=tokens_seen,
                )

    # Derived from an explicit counter rather than the loop variable's final
    # value, which is wrong by one on both the normal and the early-break path.
    completed = start_step + steps_this_run
    final_train_loss = history[-1]["loss"] if history else initial_train_loss
    final_validation_loss = evaluate() if not stopped_early else None
    if not stopped_early and final_validation_loss is not None:
        if not validation_history or validation_history[-1]["step"] != completed - 1:
            validation_history.append({"step": completed - 1, "loss": final_validation_loss})
        emit_telemetry(
            "evaluation",
            step=completed,
            loss=finite_or_none(final_validation_loss),
            tokensSeen=tokens_seen,
        )

    # Publish the best-checkpoint weights. The final step is also a trained
    # candidate, evaluated just above. `best_state` holds the argmin among the
    # periodic samples (or None when no periodic sample yet improved, or when
    # selection is disabled). If the final step is the best observed, the live
    # model already holds its weights and no restore is needed; otherwise
    # restore the saved mid-run snapshot so the caller snapshots and saves
    # exactly the weights that won.
    selected_step = None
    selected_validation_loss = None
    if select_best and final_validation_loss is not None:
        if best_validation_loss is None or final_validation_loss < best_validation_loss:
            # Final step wins; it is already resident.
            best_validation_loss = final_validation_loss
            best_step = completed - 1
            best_state = None
        selected_step = best_step
        selected_validation_loss = best_validation_loss
        if best_state is not None:
            model.load_state_dict(best_state)
            log(
                f"best-checkpoint selection: publishing step {best_step} "
                f"(validation {best_validation_loss:.4f}) over the final step "
                f"({final_validation_loss:.4f})"
            )
        else:
            log(
                f"best-checkpoint selection: final step {best_step} is best "
                f"(validation {best_validation_loss:.4f})"
            )
    elif select_best and best_state is not None and not stopped_early:
        # No final validation (should not happen when not stopped early), but a
        # periodic sample was recorded; restore it rather than the unseen tail.
        selected_step = best_step
        selected_validation_loss = best_validation_loss
        model.load_state_dict(best_state)

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
        validationHistory=validation_history,
        selectedStep=selected_step,
        selectedValidationLoss=selected_validation_loss,
    )

    train_state = {
        "schema": SCHEMA,
        "version": new_version,
        "parentVersion": parent_version,
        "resumedFromStep": start_step,
        "config": cfg.to_json(),
        "packing": pack_record.to_json(),
        "corpusSplit": split,
        "stepsCompleted": completed,
        "tokensSeen": tokens_seen,
        # Whether the published weights are the best-checkpoint (and which step)
        # or the final step. Recorded so a reader can tell a selected checkpoint
        # from a final-step publish after the fact.
        "selectBest": bool(select_best),
        "selectedStep": selected_step,
        "selectedValidationLoss": selected_validation_loss,
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
        "validationHistory": validation_history,
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

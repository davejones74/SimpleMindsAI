"""Token-ID based generation diagnostics.

This module is deliberately free of model and inference code. It turns token
ids, next-token distributions and EOS observations into reproducible,
JSON-serialisable measurements. Raw measurements are reported separately from
the optional advisory classification so a caller can always inspect the numbers
that produced a flag.

The existing ``generate-quality`` path is left untouched. This module backs the
new ``generate-diagnostics`` verb and is safe to use from tests without a model.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import Counter, defaultdict
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

METRICS_VERSION = "generation-metrics-v1"

# Advisory defaults only. The CLI reports raw measurements whether or not these
# are applied, and every threshold can be overridden by the caller.
DEFAULT_CLASSIFICATION_THRESHOLDS: Dict[str, Any] = {
    "uniqueTokenRatioFloor": 0.35,
    "uniqueBigramRatioFloor": 0.45,
    "repeatedBigramFractionCeiling": 0.55,
    "maxRunCeiling": 4,
    "cycleMinRepetitions": 3,
    "cycleMinPeriod": 2,
    "cycleMaxPeriod": 8,
    "cycleCoverageFloor": 6,
}


def _ids(token_ids: Iterable[Any]) -> List[int]:
    return [int(value) for value in token_ids]


def _decode(tokenizer: Any, token_ids: Sequence[int]) -> Optional[str]:
    if tokenizer is None:
        return None
    try:
        return str(tokenizer.decode(list(token_ids), skip_special_tokens=False))
    except Exception:
        return None


def _ngrams(ids: Sequence[int], size: int) -> List[Tuple[int, ...]]:
    if size <= 0 or len(ids) < size:
        return []
    return [tuple(ids[index : index + size]) for index in range(len(ids) - size + 1)]


def _first_positions(grams: Sequence[Tuple[int, ...]]) -> Dict[Tuple[int, ...], List[int]]:
    positions: Dict[Tuple[int, ...], List[int]] = defaultdict(list)
    for index, gram in enumerate(grams):
        positions[gram].append(index)
    return positions


def _ngram_metrics(
    ids: Sequence[int],
    size: int,
    *,
    tokenizer: Any = None,
    top_n: int = 10,
) -> Dict[str, Any]:
    grams = _ngrams(ids, size)
    if not grams:
        return {
            "n": size,
            "total": 0,
            "unique": 0,
            "uniqueRatio": None,
            "duplicateOccurrences": 0,
            "duplicateOccurrenceFraction": None,
            "typesWithRepeats": 0,
            "top": [],
        }
    positions = _first_positions(grams)
    counts = {gram: len(found) for gram, found in positions.items()}
    total = len(grams)
    unique = len(counts)
    duplicate_occurrences = sum(count - 1 for count in counts.values() if count > 1)
    repeated = [
        (gram, count, positions[gram])
        for gram, count in counts.items()
        if count > 1
    ]
    repeated.sort(key=lambda item: (-item[1], item[2][0], item[0]))
    top = []
    for gram, count, found in repeated[: max(0, int(top_n))]:
        top.append(
            {
                "ids": list(gram),
                "text": _decode(tokenizer, gram),
                "count": int(count),
                "positions": [int(p) for p in found[:20]],
            }
        )
    return {
        "n": size,
        "total": total,
        "unique": unique,
        "uniqueRatio": unique / total,
        "duplicateOccurrences": duplicate_occurrences,
        "duplicateOccurrenceFraction": duplicate_occurrences / total,
        "typesWithRepeats": len(repeated),
        "top": top,
    }


def detect_cycles(
    token_ids: Iterable[Any],
    *,
    min_repetitions: int = 3,
    min_period: int = 1,
    max_period: int = 8,
) -> List[Dict[str, Any]]:
    """Find contiguous token cycles repeated at least ``min_repetitions`` times.

    A cycle is ``(start, period, repetitions)`` such that the pattern beginning
    at ``start`` is repeated consecutively. For each start, the cycle with the
    largest coverage (period * repetitions) is kept; ties prefer the smaller
    period. This catches alternating loops such as ``the same as the same as``
    (period 3) that a longest-adjacent-run metric cannot see.
    """
    ids = _ids(token_ids)
    n = len(ids)
    min_repetitions = max(2, int(min_repetitions))
    min_period = max(1, int(min_period))
    max_period = max(min_period, int(max_period))
    found: Dict[int, Dict[str, Any]] = {}
    for start in range(n):
        max_possible = min(max_period, (n - start) // min_repetitions)
        for period in range(min_period, max_possible + 1):
            pattern = ids[start : start + period]
            repetitions = 1
            while (
                start + (repetitions + 1) * period <= n
                and ids[start + repetitions * period : start + (repetitions + 1) * period]
                == pattern
            ):
                repetitions += 1
            if repetitions < min_repetitions:
                continue
            coverage = period * repetitions
            candidate = {
                "start": start,
                "period": period,
                "repetitions": repetitions,
                "coverage": coverage,
                "end": start + coverage,
                "patternIds": list(pattern),
                "patternText": None,
            }
            current = found.get(start)
            if current is None or coverage > current["coverage"] or (
                coverage == current["coverage"] and period < current["period"]
            ):
                found[start] = candidate
    cycles = sorted(found.values(), key=lambda item: (item["start"], -item["coverage"]))
    return cycles


def _maximal_cycles(cycles: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Keep non-overlapping, earliest cycles so rotations are not double-counted.

    ``detect_cycles`` deliberately returns every candidate start (useful for
    inspection). The summary uses maximal cycles: once a cycle is selected, its
    covered span is skipped, so the alternating loop ``the same as`` is one
    cycle rather than one per rotation.
    """
    selected: List[Dict[str, Any]] = []
    cursor = 0
    for cycle in sorted(cycles, key=lambda item: (item["start"], -item["coverage"])):
        if cycle["start"] < cursor:
            continue
        selected.append(cycle)
        cursor = cycle["end"]
    return selected


def repetition_metrics(
    token_ids: Iterable[Any],
    *,
    tokenizer: Any = None,
    ngram_sizes: Sequence[int] = (2, 3, 4, 5),
    top_n: int = 10,
    min_cycle_repetitions: int = 3,
    min_cycle_period: int = 2,
    max_cycle_period: int = 8,
) -> Dict[str, Any]:
    """Deterministic repetition measurements over raw token ids.

    Decoded text is attached for human inspection, but every count, ratio,
    position and cycle is computed from token ids only.
    """
    ids = _ids(token_ids)
    n = len(ids)
    if n == 0:
        return {
            "tokens": 0,
            "outputLength": 0,
            "uniqueTokens": 0,
            "uniqueTokenRatio": None,
            "maxRun": 0,
            "maxRunStart": None,
            "maxRunTokenId": None,
            "maxRunTokenText": None,
            "ngrams": {},
            "topRepeatedNgrams": {},
            "cycles": [],
            "cycleCount": 0,
            "candidateCycleCount": 0,
            "phraseCycleCount": 0,
            "earliestCycleStart": None,
            "earliestPhraseCycleStart": None,
            "earliestPhraseCycleSecondOccurrence": None,
            "longestCycle": None,
            "maxCycleCoverageFraction": None,
            "earliestRepeatedBigramPosition": None,
            "earliestRepeatedTrigramPosition": None,
            "earlyDegenerationPosition": None,
            "earlyDegenerationTokenId": None,
            "earlyDegenerationTokenText": None,
        }

    unique_tokens = len(set(ids))
    max_run = 1
    max_run_start = 0
    run = 1
    for index in range(1, n):
        if ids[index] == ids[index - 1]:
            run += 1
            if run > max_run:
                max_run = run
                max_run_start = index - run + 1
        else:
            run = 1

    ngram_metrics: Dict[str, Any] = {}
    top_repeated: Dict[str, Any] = {}
    for size in ngram_sizes:
        entry = _ngram_metrics(ids, int(size), tokenizer=tokenizer, top_n=top_n)
        ngram_metrics[str(size)] = entry
        top_repeated[str(size)] = entry["top"]

    candidate_cycles = detect_cycles(
        ids,
        min_repetitions=min_cycle_repetitions,
        min_period=1,
        max_period=max_cycle_period,
    )
    cycles = _maximal_cycles(candidate_cycles)
    phrase_cycles = [
        cycle for cycle in cycles if cycle["period"] >= max(2, int(min_cycle_period))
    ]
    for cycle in cycles:
        cycle["patternText"] = _decode(tokenizer, cycle["patternIds"])
    longest_cycle = max(cycles, key=lambda item: (item["coverage"], -item["period"])) if cycles else None

    def earliest_second_occurrence(size: int) -> Optional[int]:
        grams = _ngrams(ids, size)
        first: Dict[Tuple[int, ...], int] = {}
        earliest: Optional[int] = None
        for index, gram in enumerate(grams):
            if gram in first:
                if earliest is None or index < earliest:
                    earliest = index
            else:
                first[gram] = index
        return earliest

    earliest_bigram = earliest_second_occurrence(2)
    earliest_trigram = earliest_second_occurrence(3)
    earliest_phrase = phrase_cycles[0]["start"] if phrase_cycles else None
    earliest_phrase_second = (
        phrase_cycles[0]["start"] + phrase_cycles[0]["period"] if phrase_cycles else None
    )
    candidates = [
        value
        for value in (earliest_bigram, earliest_trigram, earliest_phrase_second)
        if value is not None
    ]
    early_position = min(candidates) if candidates else None

    return {
        "tokens": n,
        "outputLength": n,
        "uniqueTokens": unique_tokens,
        "uniqueTokenRatio": unique_tokens / n,
        "maxRun": max_run,
        "maxRunStart": max_run_start,
        "maxRunTokenId": ids[max_run_start],
        "maxRunTokenText": _decode(tokenizer, [ids[max_run_start]]),
        "ngrams": ngram_metrics,
        "topRepeatedNgrams": top_repeated,
        "cycles": cycles[:20],
        "cycleCount": len(cycles),
        "candidateCycleCount": len(candidate_cycles),
        "phraseCycleCount": len(phrase_cycles),
        "earliestCycleStart": cycles[0]["start"] if cycles else None,
        "earliestPhraseCycleStart": earliest_phrase,
        "earliestPhraseCycleSecondOccurrence": earliest_phrase_second,
        "longestCycle": longest_cycle,
        "maxCycleCoverageFraction": (
            longest_cycle["coverage"] / n if longest_cycle is not None else None
        ),
        "earliestRepeatedBigramPosition": earliest_bigram,
        "earliestRepeatedTrigramPosition": earliest_trigram,
        "earlyDegenerationPosition": early_position,
        "earlyDegenerationTokenId": (
            ids[early_position] if early_position is not None and early_position < n else None
        ),
        "earlyDegenerationTokenText": (
            _decode(tokenizer, [ids[early_position]])
            if early_position is not None and early_position < n
            else None
        ),
    }


def resolve_thresholds(overrides: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Merge caller overrides onto the advisory defaults."""
    thresholds = dict(DEFAULT_CLASSIFICATION_THRESHOLDS)
    if overrides:
        for key, value in overrides.items():
            if key not in thresholds:
                raise ValueError(f"unknown classification threshold {key!r}")
            if value is None:
                continue
            thresholds[key] = value
    for key in (
        "uniqueTokenRatioFloor",
        "uniqueBigramRatioFloor",
        "repeatedBigramFractionCeiling",
    ):
        thresholds[key] = float(thresholds[key])
    for key in (
        "maxRunCeiling",
        "cycleMinRepetitions",
        "cycleMinPeriod",
        "cycleMaxPeriod",
        "cycleCoverageFloor",
    ):
        thresholds[key] = int(thresholds[key])
    if thresholds["cycleMinPeriod"] < 1:
        raise ValueError("cycleMinPeriod must be >= 1")
    if thresholds["cycleMaxPeriod"] < thresholds["cycleMinPeriod"]:
        raise ValueError("cycleMaxPeriod must be >= cycleMinPeriod")
    return thresholds


def classify_repetition(
    metrics: Dict[str, Any],
    *,
    thresholds: Optional[Dict[str, Any]] = None,
    applied: bool = True,
) -> Dict[str, Any]:
    """Advisory flagging. Raw metrics are always reported by the caller.

    Nothing is flagged unless ``applied`` is true. This keeps ordinary
    grammatical repetition from being treated as degeneration by default.
    """
    resolved = resolve_thresholds(thresholds)
    flags: List[str] = []
    unique_token = metrics.get("uniqueTokenRatio")
    if unique_token is not None and unique_token < resolved["uniqueTokenRatioFloor"]:
        flags.append("low_unique_token_ratio")
    bigram = (metrics.get("ngrams") or {}).get("2") or {}
    unique_bigram = bigram.get("uniqueRatio")
    if unique_bigram is not None and unique_bigram < resolved["uniqueBigramRatioFloor"]:
        flags.append("low_unique_bigram_ratio")
    repeated_bigram = bigram.get("duplicateOccurrenceFraction")
    if (
        repeated_bigram is not None
        and repeated_bigram > resolved["repeatedBigramFractionCeiling"]
    ):
        flags.append("high_repeated_bigram_fraction")
    if metrics.get("maxRun", 0) > resolved["maxRunCeiling"]:
        flags.append("long_token_run")

    phrase_cycles = [
        cycle
        for cycle in (metrics.get("cycles") or [])
        if cycle["period"] >= resolved["cycleMinPeriod"]
        and cycle["repetitions"] >= resolved["cycleMinRepetitions"]
        and cycle["coverage"] >= resolved["cycleCoverageFloor"]
    ]
    if phrase_cycles:
        flags.append("repeated_phrase_cycle")

    return {
        "applied": bool(applied),
        "thresholds": resolved,
        "flags": flags,
        "degenerate": bool(applied and flags),
        "phraseCycleCount": len(phrase_cycles),
    }


def _probability_vector(logits: Any) -> Optional[List[float]]:
    """Return a normalised probability list, or None for empty/non-finite input."""
    try:
        import torch  # type: ignore

        if isinstance(logits, torch.Tensor):
            vector = logits.detach().float().reshape(-1)
            if vector.numel() == 0 or not bool(torch.isfinite(vector).all()):
                return None
            return torch.softmax(vector, dim=-1).tolist()
    except Exception:
        pass
    try:
        values = [float(value) for value in logits]
    except TypeError:
        return None
    if not values or any(not math.isfinite(value) for value in values):
        return None
    maximum = max(values)
    exponentials = [math.exp(value - maximum) for value in values]
    total = sum(exponentials)
    if total <= 0 or not math.isfinite(total):
        return None
    return [value / total for value in exponentials]


def _rank_of(probability: float, probabilities: Sequence[float]) -> int:
    return 1 + sum(1 for value in probabilities if value > probability)


def distribution_stats(
    logits: Any,
    *,
    tokenizer: Any = None,
    top_k: Sequence[int] = (1, 5, 10),
    eos_token_id: Optional[int] = None,
    target_token_id: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    """Measure one next-token distribution without altering it."""
    probabilities = _probability_vector(logits)
    if probabilities is None:
        return None
    vocab_size = len(probabilities)
    entropy = -sum(
        probability * math.log(probability)
        for probability in probabilities
        if probability > 0
    )
    concentration = sum(probability * probability for probability in probabilities)
    requested = sorted({max(1, int(k)) for k in top_k})
    max_k = min(max(requested), vocab_size)
    ordered = sorted(
        range(vocab_size), key=lambda index: probabilities[index], reverse=True
    )
    top_indices = ordered[:max_k]
    top_tokens = [
        {
            "tokenId": int(index),
            "prob": float(probabilities[index]),
            "text": _decode(tokenizer, [int(index)]),
        }
        for index in top_indices
    ]
    masses = {
        f"top{k}": float(sum(probabilities[index] for index in ordered[: min(k, vocab_size)]))
        for k in requested
    }
    eos_prob = None
    eos_rank = None
    if eos_token_id is not None and 0 <= int(eos_token_id) < vocab_size:
        eos_prob = float(probabilities[int(eos_token_id)])
        eos_rank = _rank_of(eos_prob, probabilities)
    target_prob = None
    target_rank = None
    if target_token_id is not None and 0 <= int(target_token_id) < vocab_size:
        target_prob = float(probabilities[int(target_token_id)])
        target_rank = _rank_of(target_prob, probabilities)
    return {
        "vocabSize": vocab_size,
        "entropyNats": float(entropy),
        "perplexity": float(math.exp(entropy)) if entropy < 700 else None,
        "normalizedEntropy": float(entropy / math.log(vocab_size)) if vocab_size > 1 else 0.0,
        "concentration": float(concentration),
        "top1Prob": float(probabilities[ordered[0]]) if ordered else None,
        "top5ProbMass": masses.get("top5"),
        "top10ProbMass": masses.get("top10"),
        "topKMasses": masses,
        "topTokenIds": [int(index) for index in top_indices],
        "topTokens": top_tokens,
        "distinctTopK": len(set(int(index) for index in top_indices)),
        "eosTokenId": int(eos_token_id) if eos_token_id is not None else None,
        "eosProb": eos_prob,
        "eosRank": eos_rank,
        "targetTokenId": int(target_token_id) if target_token_id is not None else None,
        "targetProb": target_prob,
        "targetRank": target_rank,
    }


def _mean(values: Sequence[float]) -> Optional[float]:
    return sum(values) / len(values) if values else None


def summarize_steps(steps: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Aggregate per-position distribution statistics."""
    if not steps:
        return {
            "positions": 0,
            "meanEntropyNats": None,
            "minEntropyNats": None,
            "maxEntropyNats": None,
            "meanTop1Prob": None,
            "minTop1Prob": None,
            "maxTop1Prob": None,
            "meanTop5Mass": None,
            "meanTop10Mass": None,
            "meanConcentration": None,
            "meanEosProb": None,
            "maxEosProb": None,
            "minEosRank": None,
            "topKUnionSize": 0,
        }

    def values(key: str) -> List[float]:
        return [float(step[key]) for step in steps if step.get(key) is not None]

    top_union = set()
    for step in steps:
        for token_id in step.get("topTokenIds") or []:
            top_union.add(int(token_id))
    entropy_values = values("entropyNats")
    top1_values = values("top1Prob")
    top5_values = values("top5ProbMass")
    top10_values = values("top10ProbMass")
    concentration_values = values("concentration")
    eos_values = values("eosProb")
    eos_ranks = values("eosRank")
    return {
        "positions": len(steps),
        "meanEntropyNats": _mean(entropy_values),
        "minEntropyNats": min(entropy_values) if entropy_values else None,
        "maxEntropyNats": max(entropy_values) if entropy_values else None,
        "meanTop1Prob": _mean(top1_values),
        "minTop1Prob": min(top1_values) if top1_values else None,
        "maxTop1Prob": max(top1_values) if top1_values else None,
        "meanTop5Mass": _mean(top5_values),
        "meanTop10Mass": _mean(top10_values),
        "meanConcentration": _mean(concentration_values),
        "meanEosProb": _mean(eos_values),
        "maxEosProb": max(eos_values) if eos_values else None,
        "minEosRank": min(eos_ranks) if eos_ranks else None,
        "topKUnionSize": len(top_union),
    }


def eos_diagnostics(
    steps: Sequence[Dict[str, Any]],
    generated_token_ids: Sequence[int],
    *,
    eos_token_id: Optional[int],
    max_new_tokens: int,
) -> Dict[str, Any]:
    """Report EOS probability/rank and whether the sequence actually stopped on EOS."""
    ids = _ids(generated_token_ids)
    emitted_positions = (
        [index for index, token in enumerate(ids) if int(token) == int(eos_token_id)]
        if eos_token_id is not None
        else []
    )
    eos_probs = [
        float(step["eosProb"])
        for step in steps
        if step.get("eosProb") is not None
    ]
    eos_ranks = [
        int(step["eosRank"])
        for step in steps
        if step.get("eosRank") is not None
    ]
    max_prob = max(eos_probs) if eos_probs else None
    max_prob_position = None
    if max_prob is not None:
        for index, step in enumerate(steps):
            if step.get("eosProb") == max_prob:
                max_prob_position = int(step.get("position", index))
                break
    if emitted_positions:
        termination = "eos"
    elif int(max_new_tokens) > 0 and len(ids) >= int(max_new_tokens):
        termination = "max_new_tokens"
    elif len(ids) == 0:
        termination = "no_tokens"
    else:
        termination = "stopped_early_without_eos"
    return {
        "eosTokenId": int(eos_token_id) if eos_token_id is not None else None,
        "emitted": bool(emitted_positions),
        "emissionCount": len(emitted_positions),
        "emissionPosition": emitted_positions[0] if emitted_positions else None,
        "maxEosProb": max_prob,
        "maxEosProbPosition": max_prob_position,
        "meanEosProb": _mean(eos_probs),
        "minEosRank": min(eos_ranks) if eos_ranks else None,
        "eosRankAtFirstStep": steps[0].get("eosRank") if steps else None,
        "eosRankAtLastStep": steps[-1].get("eosRank") if steps else None,
        "assignedProbabilityAtEveryStep": bool(steps)
        and len(eos_probs) == len(steps),
        "termination": termination,
        "generatedTokens": len(ids),
        "maxNewTokens": int(max_new_tokens),
    }


def aggregate_samples(samples: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Aggregate per-prompt diagnostics without making an acceptance decision."""
    samples = list(samples)
    if not samples:
        return {
            "promptCount": 0,
            "totalGeneratedTokens": 0,
            "meanOutputLength": None,
            "meanUniqueTokenRatio": None,
            "meanUniqueBigramRatio": None,
            "meanUniqueTrigramRatio": None,
            "meanRepeatedBigramFraction": None,
            "meanRepeatedTrigramFraction": None,
            "maxRun": 0,
            "samplesWithPhraseCycle": 0,
            "samplesWithEarlyDegeneration": 0,
            "meanEarlyDegenerationPosition": None,
            "meanEntropyNats": None,
            "meanTop1Prob": None,
            "meanEosProb": None,
            "maxEosProb": None,
            "eosEmittedCount": 0,
            "maxNewTokensStops": 0,
        }

    def mean(values: Sequence[float]) -> Optional[float]:
        return sum(values) / len(values) if values else None

    reps = [sample.get("repetition") or {} for sample in samples]
    dists = [sample.get("distributionSummary") or {} for sample in samples]
    eoses = [sample.get("eos") or {} for sample in samples]
    early_positions = [
        rep["earlyDegenerationPosition"]
        for rep in reps
        if rep.get("earlyDegenerationPosition") is not None
    ]
    bigram = [rep.get("ngrams", {}).get("2") or {} for rep in reps]
    trigram = [rep.get("ngrams", {}).get("3") or {} for rep in reps]
    return {
        "promptCount": len(samples),
        "totalGeneratedTokens": sum(len(sample.get("generatedTokenIds") or []) for sample in samples),
        "meanOutputLength": mean([rep.get("outputLength", 0) for rep in reps]),
        "meanUniqueTokenRatio": mean(
            [rep["uniqueTokenRatio"] for rep in reps if rep.get("uniqueTokenRatio") is not None]
        ),
        "meanUniqueBigramRatio": mean(
            [entry["uniqueRatio"] for entry in bigram if entry.get("uniqueRatio") is not None]
        ),
        "meanUniqueTrigramRatio": mean(
            [entry["uniqueRatio"] for entry in trigram if entry.get("uniqueRatio") is not None]
        ),
        "meanRepeatedBigramFraction": mean(
            [
                entry["duplicateOccurrenceFraction"]
                for entry in bigram
                if entry.get("duplicateOccurrenceFraction") is not None
            ]
        ),
        "meanRepeatedTrigramFraction": mean(
            [
                entry["duplicateOccurrenceFraction"]
                for entry in trigram
                if entry.get("duplicateOccurrenceFraction") is not None
            ]
        ),
        "maxRun": max((rep.get("maxRun", 0) for rep in reps), default=0),
        "samplesWithPhraseCycle": sum(
            1 for rep in reps if (rep.get("phraseCycleCount") or 0) > 0
        ),
        "samplesWithEarlyDegeneration": len(early_positions),
        "meanEarlyDegenerationPosition": mean(early_positions),
        "meanEntropyNats": mean(
            [entry["meanEntropyNats"] for entry in dists if entry.get("meanEntropyNats") is not None]
        ),
        "meanTop1Prob": mean(
            [entry["meanTop1Prob"] for entry in dists if entry.get("meanTop1Prob") is not None]
        ),
        "meanEosProb": mean(
            [entry["meanEosProb"] for entry in dists if entry.get("meanEosProb") is not None]
        ),
        "maxEosProb": max(
            (entry["maxEosProb"] for entry in eoses if entry.get("maxEosProb") is not None),
            default=None,
        ),
        "eosEmittedCount": sum(1 for entry in eoses if entry.get("emitted")),
        "maxNewTokensStops": sum(
            1 for entry in eoses if entry.get("termination") == "max_new_tokens"
        ),
    }


def prompt_text_hash(text: str) -> str:
    return hashlib.sha256(str(text).encode("utf-8")).hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

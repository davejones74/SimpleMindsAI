from __future__ import annotations

import math

import pytest

from sma import generation_metrics as gm
from sma import generation_prompts as gp


class FakeTokenizer:
    def decode(self, token_ids, skip_special_tokens=False):
        return "decoded:" + ",".join(str(int(value)) for value in token_ids)


def test_empty_and_single_token_outputs() -> None:
    empty = gm.repetition_metrics([])
    assert empty["tokens"] == 0
    assert empty["outputLength"] == 0
    assert empty["uniqueTokenRatio"] is None
    assert empty["maxRun"] == 0
    assert empty["cycles"] == []
    assert empty["earlyDegenerationPosition"] is None

    single = gm.repetition_metrics([5])
    assert single["tokens"] == 1
    assert single["uniqueTokenRatio"] == 1.0
    assert single["maxRun"] == 1
    assert single["ngrams"]["2"]["total"] == 0
    assert single["cycles"] == []


def test_unigram_and_ngram_repetition_ratios() -> None:
    metrics = gm.repetition_metrics([1, 2, 1, 2, 1, 2])
    assert metrics["uniqueTokens"] == 2
    assert metrics["uniqueTokenRatio"] == 2 / 6
    assert metrics["ngrams"]["2"]["total"] == 5
    assert metrics["ngrams"]["2"]["unique"] == 2
    assert metrics["ngrams"]["2"]["uniqueRatio"] == 2 / 5
    assert metrics["ngrams"]["2"]["duplicateOccurrences"] == 3
    assert metrics["ngrams"]["2"]["duplicateOccurrenceFraction"] == 3 / 5
    assert metrics["ngrams"]["3"]["total"] == 4
    assert metrics["ngrams"]["3"]["unique"] == 2
    assert metrics["ngrams"]["3"]["duplicateOccurrenceFraction"] == 2 / 4


def test_max_run_and_start_position() -> None:
    metrics = gm.repetition_metrics([1, 2, 2, 2, 3])
    assert metrics["maxRun"] == 3
    assert metrics["maxRunStart"] == 1
    assert metrics["maxRunTokenId"] == 2


def test_phrase_cycle_detection() -> None:
    ids = [1, 2, 3] * 4
    cycles = gm.detect_cycles(ids, min_repetitions=3, min_period=2, max_period=8)
    assert cycles
    first = cycles[0]
    assert first["start"] == 0
    assert first["period"] == 3
    assert first["repetitions"] == 4
    assert first["coverage"] == 12
    metrics = gm.repetition_metrics(ids)
    assert metrics["phraseCycleCount"] == 1
    assert metrics["cycleCount"] == 1
    assert metrics["earliestPhraseCycleStart"] == 0
    assert metrics["earliestPhraseCycleSecondOccurrence"] == 3
    assert metrics["earlyDegenerationPosition"] == 3
    assert metrics["longestCycle"]["period"] == 3


def test_unigram_run_is_not_a_phrase_cycle() -> None:
    metrics = gm.repetition_metrics([7] * 5)
    assert metrics["maxRun"] == 5
    assert metrics["phraseCycleCount"] == 0
    assert metrics["earliestPhraseCycleStart"] is None
    assert metrics["cycleCount"] >= 1
    assert metrics["cycles"][0]["period"] == 1


def test_no_cycle_for_non_repeating_sequence() -> None:
    assert gm.detect_cycles([1, 2, 3, 4, 5]) == []
    metrics = gm.repetition_metrics([1, 2, 3, 4, 5])
    assert metrics["cycles"] == []
    assert metrics["earlyDegenerationPosition"] is None


def test_classification_is_optionally_applied_and_raw_metrics_remain() -> None:
    metrics = gm.repetition_metrics([1, 2, 3] * 4)
    disabled = gm.classify_repetition(metrics, applied=False)
    assert disabled["applied"] is False
    assert disabled["degenerate"] is False
    assert "repeated_phrase_cycle" in disabled["flags"]

    enabled = gm.classify_repetition(metrics, applied=True)
    assert enabled["applied"] is True
    assert enabled["degenerate"] is True
    assert enabled["phraseCycleCount"] == 1


def test_classification_boundaries_and_unknown_threshold() -> None:
    base = {
        "uniqueTokenRatio": 0.5,
        "maxRun": 2,
        "ngrams": {"2": {"uniqueRatio": 0.8, "duplicateOccurrenceFraction": 0.2}},
        "cycles": [],
    }
    clean = gm.classify_repetition(base, applied=True)
    assert clean["degenerate"] is False
    assert clean["flags"] == []

    exactly_floor = gm.classify_repetition(
        {**base, "uniqueTokenRatio": 0.35},
        thresholds={"uniqueTokenRatioFloor": 0.35},
        applied=True,
    )
    assert "low_unique_token_ratio" not in exactly_floor["flags"]

    below_floor = gm.classify_repetition(
        {**base, "uniqueTokenRatio": 0.3499},
        thresholds={"uniqueTokenRatioFloor": 0.35},
        applied=True,
    )
    assert "low_unique_token_ratio" in below_floor["flags"]

    at_run_ceiling = gm.classify_repetition(
        {**base, "maxRun": 4},
        thresholds={"maxRunCeiling": 4},
        applied=True,
    )
    assert "long_token_run" not in at_run_ceiling["flags"]

    above_run_ceiling = gm.classify_repetition(
        {**base, "maxRun": 5},
        thresholds={"maxRunCeiling": 4},
        applied=True,
    )
    assert "long_token_run" in above_run_ceiling["flags"]

    with pytest.raises(ValueError):
        gm.resolve_thresholds({"notAThreshold": 1})


def test_distribution_statistics_from_synthetic_logits() -> None:
    logits = [math.log(0.5), math.log(0.3), math.log(0.2)]
    stats = gm.distribution_stats(logits, eos_token_id=2, target_token_id=1)
    assert stats is not None
    assert stats["vocabSize"] == 3
    assert stats["top1Prob"] == pytest.approx(0.5)
    assert stats["top5ProbMass"] == pytest.approx(1.0)
    assert stats["top10ProbMass"] == pytest.approx(1.0)
    assert stats["concentration"] == pytest.approx(0.25 + 0.09 + 0.04)
    assert stats["entropyNats"] == pytest.approx(-(0.5 * math.log(0.5) + 0.3 * math.log(0.3) + 0.2 * math.log(0.2)))
    assert stats["eosProb"] == pytest.approx(0.2)
    assert stats["eosRank"] == 3
    assert stats["targetProb"] == pytest.approx(0.3)
    assert stats["targetRank"] == 2
    assert stats["distinctTopK"] == 3
    assert [entry["tokenId"] for entry in stats["topTokens"]] == [0, 1, 2]


def test_distribution_statistics_edge_cases() -> None:
    assert gm.distribution_stats([]) is None
    assert gm.distribution_stats([float("nan"), 1.0]) is None
    assert gm.distribution_stats([float("inf"), 1.0]) is None
    stats = gm.distribution_stats([0.0])
    assert stats is not None
    assert stats["top1Prob"] == pytest.approx(1.0)
    assert stats["entropyNats"] == pytest.approx(0.0)


def test_summarize_steps() -> None:
    steps = [
        {"entropyNats": 1.0, "top1Prob": 0.5, "top5ProbMass": 0.9, "top10ProbMass": 1.0,
         "concentration": 0.3, "eosProb": 0.01, "eosRank": 10, "topTokenIds": [1, 2]},
        {"entropyNats": 2.0, "top1Prob": 0.25, "top5ProbMass": 0.8, "top10ProbMass": 0.95,
         "concentration": 0.2, "eosProb": 0.02, "eosRank": 20, "topTokenIds": [2, 3]},
    ]
    summary = gm.summarize_steps(steps)
    assert summary["positions"] == 2
    assert summary["meanEntropyNats"] == pytest.approx(1.5)
    assert summary["minEntropyNats"] == pytest.approx(1.0)
    assert summary["maxEntropyNats"] == pytest.approx(2.0)
    assert summary["meanTop1Prob"] == pytest.approx(0.375)
    assert summary["meanEosProb"] == pytest.approx(0.015)
    assert summary["maxEosProb"] == pytest.approx(0.02)
    assert summary["minEosRank"] == 10
    assert summary["topKUnionSize"] == 3
    assert gm.summarize_steps([])["positions"] == 0


def test_eos_diagnostics() -> None:
    steps = [
        {"position": 0, "eosProb": 0.1, "eosRank": 5},
        {"position": 1, "eosProb": 0.2, "eosRank": 4},
        {"position": 2, "eosProb": 0.3, "eosRank": 3},
    ]
    stopped_by_limit = gm.eos_diagnostics(steps, [1, 2, 3], eos_token_id=9, max_new_tokens=3)
    assert stopped_by_limit["emitted"] is False
    assert stopped_by_limit["termination"] == "max_new_tokens"
    assert stopped_by_limit["maxEosProb"] == pytest.approx(0.3)
    assert stopped_by_limit["maxEosProbPosition"] == 2
    assert stopped_by_limit["meanEosProb"] == pytest.approx(0.2)
    assert stopped_by_limit["minEosRank"] == 3
    assert stopped_by_limit["assignedProbabilityAtEveryStep"] is True

    emitted = gm.eos_diagnostics(steps, [1, 9, 3], eos_token_id=9, max_new_tokens=8)
    assert emitted["emitted"] is True
    assert emitted["emissionCount"] == 1
    assert emitted["emissionPosition"] == 1
    assert emitted["termination"] == "eos"

    early = gm.eos_diagnostics(steps, [1, 2], eos_token_id=9, max_new_tokens=8)
    assert early["termination"] == "stopped_early_without_eos"

    empty = gm.eos_diagnostics([], [], eos_token_id=9, max_new_tokens=8)
    assert empty["emitted"] is False
    assert empty["termination"] == "no_tokens"
    assert empty["maxEosProb"] is None


def test_aggregate_samples() -> None:
    samples = [
        {
            "generatedTokenIds": [1, 2, 3],
            "repetition": {
                "outputLength": 3,
                "uniqueTokenRatio": 1.0,
                "maxRun": 1,
                "phraseCycleCount": 0,
                "earlyDegenerationPosition": None,
                "ngrams": {
                    "2": {"uniqueRatio": 1.0, "duplicateOccurrenceFraction": 0.0},
                    "3": {"uniqueRatio": 1.0, "duplicateOccurrenceFraction": 0.0},
                },
            },
            "distributionSummary": {"meanEntropyNats": 2.0, "meanTop1Prob": 0.4, "meanEosProb": 0.01, "maxEosProb": 0.02},
            "eos": {"emitted": False, "termination": "max_new_tokens", "maxEosProb": 0.02},
        },
        {
            "generatedTokenIds": [1, 2, 1, 2],
            "repetition": {
                "outputLength": 4,
                "uniqueTokenRatio": 0.5,
                "maxRun": 1,
                "phraseCycleCount": 1,
                "earlyDegenerationPosition": 2,
                "ngrams": {
                    "2": {"uniqueRatio": 0.6667, "duplicateOccurrenceFraction": 0.3333},
                    "3": {"uniqueRatio": 0.5, "duplicateOccurrenceFraction": 0.5},
                },
            },
            "distributionSummary": {"meanEntropyNats": 1.0, "meanTop1Prob": 0.6, "meanEosProb": 0.03, "maxEosProb": 0.04},
            "eos": {"emitted": True, "termination": "eos", "maxEosProb": 0.04},
        },
    ]
    aggregate = gm.aggregate_samples(samples)
    assert aggregate["promptCount"] == 2
    assert aggregate["totalGeneratedTokens"] == 7
    assert aggregate["meanOutputLength"] == pytest.approx(3.5)
    assert aggregate["meanUniqueTokenRatio"] == pytest.approx(0.75)
    assert aggregate["meanUniqueBigramRatio"] == pytest.approx((1.0 + 0.6667) / 2)
    assert aggregate["samplesWithPhraseCycle"] == 1
    assert aggregate["samplesWithEarlyDegeneration"] == 1
    assert aggregate["meanEarlyDegenerationPosition"] == pytest.approx(2.0)
    assert aggregate["eosEmittedCount"] == 1
    assert aggregate["maxNewTokensStops"] == 1
    assert gm.aggregate_samples([])["promptCount"] == 0


def test_prompt_suite_identity_and_hash() -> None:
    suite = gp.get_prompt_suite("generation-prompts-v2")
    assert suite["version"] == "generation-prompts-v2"
    assert suite["promptCount"] == len(gp.PROMPTS)
    assert suite["hash"] == gp.prompt_suite_hash("generation-prompts-v2")
    ids = [prompt["id"] for prompt in suite["prompts"]]
    texts = [prompt["text"] for prompt in suite["prompts"]]
    assert len(ids) == len(set(ids))
    assert len(texts) == len(set(texts))
    assert all(prompt["category"] for prompt in suite["prompts"])
    assert all(prompt["text"].strip() for prompt in suite["prompts"])
    assert gp.get_prompt_suite() == suite
    with pytest.raises(KeyError):
        gp.get_prompt_suite("not-a-suite")


def test_token_id_primary_and_reproducible() -> None:
    ids = [1, 2, 3, 1, 2, 3, 1, 2, 3]
    first = gm.repetition_metrics(ids)
    second = gm.repetition_metrics(ids)
    assert first == second
    with_fake_text = gm.repetition_metrics(ids, tokenizer=FakeTokenizer())
    assert with_fake_text["uniqueTokenRatio"] == first["uniqueTokenRatio"]
    assert with_fake_text["maxRun"] == first["maxRun"]
    assert with_fake_text["ngrams"]["2"]["unique"] == first["ngrams"]["2"]["unique"]
    assert with_fake_text["cycles"][0]["patternText"].startswith("decoded:")

    logits = [math.log(0.4), math.log(0.35), math.log(0.25)]
    assert gm.distribution_stats(logits) == gm.distribution_stats(logits)
    assert gp.prompt_suite_hash("generation-prompts-v2") == gp.prompt_suite_hash("generation-prompts-v2")


class _LegacyEncoding:
    def __init__(self, input_ids):
        self.input_ids = input_ids


class LegacyTokenizer:
    def __call__(self, text, add_special_tokens=False):
        return _LegacyEncoding([ord(char) % 5 for char in str(text)])


def test_legacy_generation_quality_helpers_remain_unchanged() -> None:
    from sma import brain

    assert brain.QUALITY_PROMPTS == [
        "The capital of France is",
        "Water boils at a temperature of",
        "The first law of thermodynamics states that",
        "A steam engine converts heat into",
        "Photosynthesis uses light to produce",
    ]
    metrics = brain.repetition_metrics(LegacyTokenizer(), "aabbc")
    assert metrics == {
        "tokens": 5,
        "unique1": 3,
        "unique2": 4,
        "rep1": 3 / 5,
        "rep2": 1.0,
        "maxRun": 2,
    }


def test_generation_kwargs_are_shared_and_unchanged() -> None:
    from sma import brain

    greedy, greedy_mode = brain._generation_kwargs(
        max_new_tokens=5,
        temperature=0.0,
        top_p=0.95,
        seed=0,
        repetition_penalty=1.0,
        no_repeat_ngram_size=0,
    )
    assert greedy == {"max_new_tokens": 5, "do_sample": False}
    assert greedy_mode == "greedy"

    sampled, sampled_mode = brain._generation_kwargs(
        max_new_tokens=5,
        temperature=0.8,
        top_p=0.9,
        seed=0,
        repetition_penalty=1.2,
        no_repeat_ngram_size=3,
    )
    assert sampled == {
        "max_new_tokens": 5,
        "repetition_penalty": 1.2,
        "no_repeat_ngram_size": 3,
        "do_sample": True,
        "temperature": 0.8,
        "top_p": 0.9,
    }
    assert sampled_mode == "sample"


def test_prompt_suite_v3_is_frozen_and_v2_is_unchanged() -> None:
    v2 = gp.get_prompt_suite("generation-prompts-v2")
    assert v2["promptCount"] == 15
    assert v2["hash"] == "ff7b909053b22cd5dcdbe2f9a9e830478239e1448fb2021c0728655724477d88"

    v3 = gp.get_prompt_suite("generation-prompts-v3")
    assert v3["version"] == "generation-prompts-v3"
    assert v3["promptCount"] == 68
    assert v3["promptCount"] >= 40
    assert v3["hash"] == "f25b99a1bff0f61afc52b5d1c730cb325c73d06f007d2e9849ebd9d385272867"
    ids = [prompt["id"] for prompt in v3["prompts"]]
    texts = [prompt["text"] for prompt in v3["prompts"]]
    categories = {prompt["category"] for prompt in v3["prompts"]}
    assert len(ids) == len(set(ids))
    assert len(texts) == len(set(texts))
    assert len(categories) >= 20
    assert all(prompt["text"].strip() for prompt in v3["prompts"])
    v2_texts = {prompt["text"] for prompt in v2["prompts"]}
    assert not (set(texts) & v2_texts)
    assert gp.list_prompt_suites() == ["generation-prompts-v2", "generation-prompts-v3"]

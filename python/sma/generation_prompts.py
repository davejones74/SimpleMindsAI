"""Versioned, training-independent prompt suites for generation diagnostics.

The suite is data, not a capability claim. Prompts are written for this
measurement and screened against the frozen corpus before use; the screening
result belongs to the work-package report, not to this module. Every prompt has
a stable id and category, and the suite hash covers the exact text.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List, Optional

PROMPT_SUITE_VERSION = "generation-prompts-v2"

PROMPTS: List[Dict[str, str]] = [
    {
        "id": "gp-v2-01",
        "category": "factual",
        "text": "What causes the sky to appear blue during the day?",
    },
    {
        "id": "gp-v2-02",
        "category": "explanation",
        "text": "Explain why a metal spoon feels colder than a wooden spoon at room temperature.",
    },
    {
        "id": "gp-v2-03",
        "category": "narrative",
        "text": "The lighthouse keeper had not seen a ship for three weeks when, one foggy morning,",
    },
    {
        "id": "gp-v2-04",
        "category": "descriptive",
        "text": "Describe a quiet harbour town at dawn in three sentences.",
    },
    {
        "id": "gp-v2-05",
        "category": "procedural",
        "text": "List the steps for sharpening a kitchen knife safely.",
    },
    {
        "id": "gp-v2-06",
        "category": "open-ended",
        "text": "If I could redesign the local library, I would",
    },
    {
        "id": "gp-v2-07",
        "category": "contextual-short",
        "text": "The meeting was moved to Thursday because",
    },
    {
        "id": "gp-v2-08",
        "category": "contextual-long",
        "text": "A small bakery has decided to reduce its food waste. The owner has asked you to propose three practical changes, starting with",
    },
    {
        "id": "gp-v2-09",
        "category": "unfamiliar",
        "text": "Explain the difference between a pulsar and a magnetar to a curious teenager.",
    },
    {
        "id": "gp-v2-10",
        "category": "technical",
        "text": "Write a Python function that returns the second-largest number in a list, or None if it does not exist:",
    },
    {
        "id": "gp-v2-11",
        "category": "commonsense",
        "text": "A glass of water is left outside on a freezing night. By morning,",
    },
    {
        "id": "gp-v2-12",
        "category": "summarization",
        "text": "Summarise the main trade-offs between solar and wind power in two sentences.",
    },
    {
        "id": "gp-v2-13",
        "category": "dialogue",
        "text": "Customer: I ordered a blue jacket, but the parcel contained a red one.\nSupport agent:",
    },
    {
        "id": "gp-v2-14",
        "category": "creative",
        "text": "Write the opening paragraph of a children's story about a robot who is afraid of rain.",
    },
    {
        "id": "gp-v2-15",
        "category": "safety",
        "text": "Explain how to check whether a bicycle helmet still fits correctly.",
    },
]

_SUITES: Dict[str, List[Dict[str, str]]] = {
    PROMPT_SUITE_VERSION: PROMPTS,
}


def list_prompt_suites() -> List[str]:
    return sorted(_SUITES)


def get_prompt_suite(version: str = PROMPT_SUITE_VERSION) -> Dict[str, Any]:
    if version not in _SUITES:
        raise KeyError(
            f"unknown prompt suite {version!r}; expected one of {list_prompt_suites()}"
        )
    prompts = [dict(prompt) for prompt in _SUITES[version]]
    return {
        "version": version,
        "prompts": prompts,
        "promptCount": len(prompts),
        "hash": prompt_suite_hash(version),
    }


def _payload(version: str) -> Dict[str, Any]:
    if version not in _SUITES:
        raise KeyError(
            f"unknown prompt suite {version!r}; expected one of {list_prompt_suites()}"
        )
    return {
        "version": version,
        "prompts": [
            {"id": prompt["id"], "category": prompt["category"], "text": prompt["text"]}
            for prompt in _SUITES[version]
        ],
    }


def prompt_suite_hash(version: str = PROMPT_SUITE_VERSION) -> str:
    payload = json.dumps(
        _payload(version),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def prompt_text_hash(text: str) -> str:
    return hashlib.sha256(str(text).encode("utf-8")).hexdigest()

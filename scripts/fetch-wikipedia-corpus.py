#!/usr/bin/env python3
"""Fetch clean English Wikipedia prose for a controlled training experiment.

Reads Category:Featured_articles (and optionally Good_articles), fetches full
plain-text extracts one article at a time, filters English/length/eval overlap,
and writes a trainer-compatible JSONL corpus. Experiment only: it does not touch
the article store, registry, production models, or training jobs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

API = "https://en.wikipedia.org/w/api.php"
USER_AGENT = "SimpleMindsAI/0.2 (training-corpus experiment; contact: local operator)"
ENGLISH_STOPWORDS = set(
    "the a an and or but if while of to in on at by for from with without into "
    "is are was were be been being it its this that these those as not no "
    "he she they we you i his her their our your them him us do does did done "
    "have has had can could may might will would should about after before "
    "over under between through during more most other some such only also than "
    "then there where which who whom whose what when why how all any both each "
    "few many much neither nor own same so too very just".split()
)


def api(params: dict) -> dict:
    query = urllib.parse.urlencode({**params, "format": "json", "formatversion": "2"})
    request = urllib.request.Request(f"{API}?{query}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def category_titles(category: str, limit: int) -> list[str]:
    titles: list[str] = []
    cont: dict = {}
    while len(titles) < limit:
        data = api(
            {
                "action": "query",
                "list": "categorymembers",
                "cmtitle": category,
                "cmtype": "page",
                "cmlimit": min(500, limit - len(titles)),
                **cont,
            }
        )
        for item in data.get("query", {}).get("categorymembers", []):
            if item.get("ns") == 0 and item.get("title"):
                titles.append(item["title"])
        if "continue" not in data:
            break
        cont = data["continue"]
    return titles[:limit]


def extract(title: str) -> str:
    data = api(
        {
            "action": "query",
            "prop": "extracts",
            "explaintext": "1",
            "exsectionformat": "plain",
            "redirects": "1",
            "titles": title,
        }
    )
    pages = data.get("query", {}).get("pages", [])
    if not pages:
        return ""
    return str(pages[0].get("extract") or "")


def english_score(text: str) -> tuple[float, float]:
    words = re.findall(r"[A-Za-z']+", text.lower())
    if not words:
        return 0.0, 0.0
    stopword_ratio = sum(1 for word in words if word in ENGLISH_STOPWORDS) / len(words)
    ascii_ratio = sum(1 for ch in text if ch.isascii()) / max(1, len(text))
    return stopword_ratio, ascii_ratio


def word_ngrams(text: str, size: int = 8) -> set[tuple[str, ...]]:
    words = re.findall(r"[a-z0-9']+", text.lower())
    if len(words) < size:
        return set()
    return {tuple(words[i : i + size]) for i in range(len(words) - size + 1)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="output corpus JSONL")
    parser.add_argument("--eval-set", required=True, help="frozen evaluation JSONL")
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--min-chars", type=int, default=3000)
    parser.add_argument("--validation-percent", type=int, default=5)
    parser.add_argument("--category", action="append", default=None)
    parser.add_argument("--sleep", type=float, default=0.2)
    args = parser.parse_args()

    categories = args.category or ["Category:Featured_articles"]
    titles: list[str] = []
    for category in categories:
        for title in category_titles(category, args.limit):
            if title not in titles:
                titles.append(title)
    titles = titles[: args.limit]

    eval_ngrams: set[tuple[str, ...]] = set()
    for line in Path(args.eval_set).read_text(encoding="utf-8").split("\n"):
        if line.strip():
            row = json.loads(line)
            eval_ngrams |= word_ngrams(str(row.get("text") or row.get("completion") or ""))

    kept: list[dict] = []
    skipped = Counter()
    seen_text: set[str] = set()
    for index, title in enumerate(titles, 1):
        try:
            text = extract(title).strip()
        except Exception:
            skipped["fetch-error"] += 1
            continue
        finally:
            time.sleep(args.sleep)
        if len(text) < args.min_chars:
            skipped["short"] += 1
            continue
        stopword_ratio, ascii_ratio = english_score(text)
        if stopword_ratio < 0.08 or ascii_ratio < 0.85:
            skipped["not-english"] += 1
            continue
        if eval_ngrams and word_ngrams(text) & eval_ngrams:
            skipped["eval-overlap"] += 1
            continue
        content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        if content_hash in seen_text:
            skipped["duplicate"] += 1
            continue
        seen_text.add(content_hash)
        bucket = int(hashlib.sha256(title.encode("utf-8")).hexdigest(), 16) % 100
        role = "validation" if bucket < args.validation_percent else "train"
        kept.append(
            {
                "articleId": f"wiki_{hashlib.sha256(title.encode('utf-8')).hexdigest()[:16]}",
                "contentHash": content_hash,
                "text": text,
                "corpusRole": role,
                "sourceUrl": "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_")),
                "group": "en.wikipedia.org",
            }
        )
        if index % 100 == 0:
            print(json.dumps({"fetched": index, "kept": len(kept), "skipped": dict(skipped)}), flush=True)

    kept.sort(key=lambda row: row["articleId"])
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as handle:
        for row in kept:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    chars = sum(len(row["text"]) for row in kept)
    train_chars = sum(len(row["text"]) for row in kept if row["corpusRole"] == "train")
    summary = {
        "titles": len(titles),
        "kept": len(kept),
        "skipped": dict(skipped),
        "chars": chars,
        "approxTokens": chars // 4,
        "trainChars": train_chars,
        "trainApproxTokens": train_chars // 4,
        "validationApproxTokens": (chars - train_chars) // 4,
        "output": str(out),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

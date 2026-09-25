"""
sma — SimpleMindsAI compute plane.

Owns architecture initialisation, training, checkpointing, evaluation and
inference. Node owns orchestration, GraphQL, articles, provenance and the
registry. The two communicate through a JSON subprocess contract and never
through a shared library import.

The load-bearing rule for this package: **no pretrained neural weights are
ever loaded into a brain.** Architecture comes from a config; the tokenizer is
an accepted pretrained encoding artifact. `proof.py` is what makes that
claim checkable rather than aspirational.
"""

__version__ = "0.1.0"

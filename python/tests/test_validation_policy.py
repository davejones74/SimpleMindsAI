"""Production-reachable validation policy guards.

Legacy tail splitting is useful for isolated fixtures, but it must require an
explicit opt-in. Document/source-disjoint training must also assert that its
validation came from a prospective partition.
"""
from __future__ import annotations

import pytest

from sma import brain
from sma import train as train_mod


def test_legacy_tail_split_requires_explicit_opt_in():
    with pytest.raises(ValueError, match="allowLegacyValidation"):
        train_mod.TrainConfig(
            learningRate=1e-4,
            validationPolicy="legacy-tail-split",
        ).validate()

    # Explicit opt-in is accepted.
    train_mod.TrainConfig(
        learningRate=1e-4,
        validationPolicy="legacy-tail-split",
        allowLegacyValidation=True,
    ).validate()


def test_document_policy_requires_prospective_assertion():
    with pytest.raises(ValueError, match="requireProspectiveValidation"):
        train_mod.TrainConfig(
            learningRate=1e-4,
            validationPolicy="document-source-disjoint",
        ).validate()

    train_mod.TrainConfig(
        learningRate=1e-4,
        validationPolicy="document-source-disjoint",
        requireProspectiveValidation=True,
    ).validate()


def test_invalid_validation_policy_is_rejected():
    with pytest.raises(ValueError, match="validationPolicy"):
        train_mod.TrainConfig(
            learningRate=1e-4,
            validationPolicy="whatever",
            requireProspectiveValidation=True,
        ).validate()


def test_cli_omission_fails_closed():
    parser = brain.build_parser()
    args = parser.parse_args([
        "train",
        "--parent", "v001",
        "--corpus", "fixture.jsonl",
        "--lr", "1e-4",
    ])
    assert args.validation_policy == "document-source-disjoint"
    assert args.require_prospective_validation is False
    with pytest.raises(ValueError, match="requireProspectiveValidation"):
        train_mod.TrainConfig(
            learningRate=1e-4,
            validationPolicy=args.validation_policy,
            allowLegacyValidation=args.allow_legacy_validation,
            requireProspectiveValidation=args.require_prospective_validation,
        ).validate()

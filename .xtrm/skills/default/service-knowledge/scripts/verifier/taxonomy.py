#!/usr/bin/env python3
"""Claim taxonomy for the service-skills claim verifier.

Defines the 13-type claim classification (research §2.3), the verdict /
completeness / comparison / risk vocabularies, and the ``Claim`` record shape
(research §2.5).

Five claim types are implemented in this revision (REVISION 3 scope cut):
``quoted_literal``, ``set_claim``, ``metric_label_set``, ``environment_constant``
and ``compose_resource``. The remaining eight are enumerated so the taxonomy is
stable and consumers can switch on them, but the extractor does not produce them
yet — they default to ``UNKNOWN`` completeness, which yields no false positives.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class ClaimType(str, Enum):
    """The 13-type claim taxonomy (research §2.3)."""

    QUOTED_LITERAL = "quoted_literal"
    ENVIRONMENT_CONSTANT = "environment_constant"
    SYMBOL_NAME = "symbol_name"
    COMPOSE_RESOURCE = "compose_resource"
    METRIC_FAMILY = "metric_family"
    METRIC_LABEL_SET = "metric_label_set"
    CONFIG_VALUE = "config_value"
    SET_CLAIM = "set_claim"
    CITATION_CLAIM = "citation_claim"
    PROCEDURE_CLAIM = "procedure_claim"
    CAUSAL_CLAIM = "causal_claim"
    RUNTIME_CLAIM = "runtime_claim"
    EXTERNAL_CLAIM = "external_claim"


class Verdict(str, Enum):
    """Outcome of deterministic verification for a single claim."""

    PASS = "PASS"
    CONFLICT = "CONFLICT"
    UNKNOWN = "UNKNOWN"


class Completeness(str, Enum):
    """Whether a claim asserts a closed (complete) set (research §2.4).

    Defaults to ``UNKNOWN`` aggressively: a false ``COMPLETE`` would produce a
    false CONFLICT downstream (research §7)."""

    COMPLETE = "complete"
    PARTIAL = "partial"
    UNKNOWN = "unknown"


class Comparison(str, Enum):
    """Relationship between the claimed value(s) and the observed source truth."""

    EQUAL = "equal"
    UNEQUAL = "unequal"
    SUBSET = "subset"
    SUPERSET = "superset"
    UNRESOLVED = "unresolved"
    NOT_APPLICABLE = "not_applicable"


class Risk(str, Enum):
    """Blast radius if the claim is wrong."""

    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


# Claim types the extractor actively produces in this revision.
IMPLEMENTED_TYPES: frozenset[ClaimType] = frozenset(
    {
        ClaimType.QUOTED_LITERAL,
        ClaimType.SET_CLAIM,
        ClaimType.METRIC_LABEL_SET,
        ClaimType.ENVIRONMENT_CONSTANT,
        ClaimType.COMPOSE_RESOURCE,
    }
)

# Enumerated but not yet extracted; deferred to follow-up beads.
DEFERRED_TYPES: frozenset[ClaimType] = frozenset(set(ClaimType) - set(IMPLEMENTED_TYPES))


@dataclass
class Claim:
    """One verifiable claim extracted from a SKILL diff (research §2.5).

    ``claim_id`` is a stable content hash (see ``manifest.claim_id``) so repeated
    regenerations of the same claim collide — this underpins the PR3 invalidation
    model. Fields default to the safest advisory value (``UNKNOWN`` / ``unknown``)."""

    service_id: str
    section_path: str
    claim_text: str
    claim_type: ClaimType
    subject: str = ""
    predicate: str = ""
    objects: list[str] = field(default_factory=list)
    completeness: Completeness = Completeness.UNKNOWN
    expected_count: int | None = None
    observed_count: int | None = None
    comparison: Comparison = Comparison.NOT_APPLICABLE
    risk: Risk = Risk.MEDIUM
    authority_required: int = 0
    source_refs: list[str] = field(default_factory=list)
    verdict: Verdict = Verdict.UNKNOWN
    verified_at_ref: str = ""
    evidence_digest: str = ""
    advisories: list[str] = field(default_factory=list)

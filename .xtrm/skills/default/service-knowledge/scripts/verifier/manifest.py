#!/usr/bin/env python3
"""Claim manifest: stable IDs, serialization, and schema validation.

The manifest is the verifier's machine-readable output — one row per claim with
every field from research §2.5. ``claim_id`` is a stable content hash so the same
claim regenerated across runs collides (the PR3 invalidation model depends on
this). ``schema_version`` is locked at 1; breaking changes bump it, never silently
change shape.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

import jsonschema

from .taxonomy import Claim

SCHEMA_VERSION = 1
VERIFIER_ID = "service-skills-claim-verifier"
VERIFIER_VERSION = "0.1.0"

_SCHEMA_PATH = Path(__file__).resolve().parent / "schema" / "manifest_schema.json"


def content_hash(text: str) -> str:
    """Stable sha256 hex digest of a document's text."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def claim_id(claim: Claim) -> str:
    """Stable ID: hash of service_id + section_path + normalized S/P/O.

    Normalization strips whitespace and sorts the object set so cosmetically
    different phrasings of the same claim still collide.
    """
    normalized_objects = ",".join(sorted(" ".join(obj.split()) for obj in claim.objects))
    key = "|".join(
        [
            claim.service_id,
            " ".join(claim.section_path.split()),
            " ".join(claim.subject.split()),
            " ".join(claim.predicate.split()),
            normalized_objects,
            claim.claim_type.value,
        ]
    )
    return "clm_" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def _claim_to_dict(claim: Claim) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "claim_id": claim_id(claim),
        "service_id": claim.service_id,
        "section_path": claim.section_path,
        "claim_text": claim.claim_text,
        "claim_type": claim.claim_type.value,
        "subject": claim.subject,
        "predicate": claim.predicate,
        "objects": list(claim.objects),
        "completeness": claim.completeness.value,
        "expected_count": claim.expected_count,
        "observed_count": claim.observed_count,
        "comparison": claim.comparison.value,
        "risk": claim.risk.value,
        "authority_required": claim.authority_required,
        "source_refs": list(claim.source_refs),
        "verdict": claim.verdict.value,
        "verifier_id": VERIFIER_ID,
        "verifier_version": VERIFIER_VERSION,
        "verified_at_ref": claim.verified_at_ref,
        "evidence_digest": claim.evidence_digest,
        "advisories": list(claim.advisories),
    }


@dataclass
class ClaimManifest:
    """The full verifier output for one candidate-vs-current run."""

    service_id: str
    candidate_hash: str
    current_hash: str
    verified_at_ref: str = ""
    claims: list[Claim] = field(default_factory=list)
    structural_issues: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "schema_version": SCHEMA_VERSION,
            "verifier_id": VERIFIER_ID,
            "verifier_version": VERIFIER_VERSION,
            "service_id": self.service_id,
            "candidate_hash": self.candidate_hash,
            "current_hash": self.current_hash,
            "verified_at_ref": self.verified_at_ref,
            "structural_issues": list(self.structural_issues),
            "claims": [_claim_to_dict(claim) for claim in self.claims],
            "summary": self.verdict_counts(),
        }

    def to_json(self, *, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, sort_keys=False)

    def verdict_counts(self) -> dict[str, int]:
        counts: dict[str, int] = {"PASS": 0, "CONFLICT": 0, "UNKNOWN": 0}
        for claim in self.claims:
            counts[claim.verdict.value] = counts.get(claim.verdict.value, 0) + 1
        return counts


def load_schema() -> dict:
    return json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))


def validate_manifest(data: dict) -> list[str]:
    """Validate a manifest dict against the shipped jsonschema; returns error messages."""
    schema = load_schema()
    validator = jsonschema.Draft202012Validator(schema)
    return sorted({err.json_path + ": " + err.message for err in validator.iter_errors(data)})


def manifest_from_json(text: str) -> dict:
    return json.loads(text)

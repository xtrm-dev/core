#!/usr/bin/env python3
"""service-skills claim verifier (advisory-only, deterministic).

Public entry point: :func:`verify_candidate`. The verifier diffs a candidate SKILL
against the in-force one, extracts only the new/modified claims, checks each against
the service territory's source of truth, and returns a :class:`ClaimManifest`. It
never blocks, never mutates, never calls an LLM — exit semantics are advisory; the
manifest carries the verdicts (PR2 wires the gate).
"""
from __future__ import annotations

import json
from pathlib import Path

from .claim_extractor import extract_claims
from .diff_parser import parse_diff
from .gate import (
    BLOCKING_VERDICTS,
    WRITABLE_VERDICTS,
    GateDecision,
    GateVerdict,
    compute_gate,
    corpus_fingerprint,
    source_fingerprint,
)
from .manifest import (
    SCHEMA_VERSION,
    VERIFIER_ID,
    VERIFIER_VERSION,
    ClaimManifest,
    claim_id,
    content_hash,
    load_schema,
    validate_manifest,
)
from .source_corpus import SourceCorpus
from .structural_validator import validate_structure
from .taxonomy import (
    DEFERRED_TYPES,
    IMPLEMENTED_TYPES,
    Claim,
    ClaimType,
    Comparison,
    Completeness,
    Risk,
    Verdict,
)
from .telemetry import Timer, emit_run

__version__ = VERIFIER_VERSION

# service-skills/references/service_skill_contract.json — two levels up from this package.
_CONTRACT_PATH = Path(__file__).resolve().parents[2] / "references" / "service_skill_contract.json"


def load_canonical_headings(contract_path: Path | None = None) -> list[str]:
    """Canonical H2 headings from the service-skill contract (empty list if absent)."""
    path = contract_path or _CONTRACT_PATH
    try:
        contract = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return [entry["heading"] for entry in contract.get("canonical_headings", []) if "heading" in entry]


def verify_candidate(
    candidate_text: str,
    current_text: str,
    *,
    service_id: str,
    corpus: SourceCorpus | None = None,
    verified_at_ref: str = "",
    canonical_headings: list[str] | None = None,
    emit_telemetry: bool = True,
    telemetry_stream=None,
) -> ClaimManifest:
    """Run the full advisory verification and return the manifest.

    ``corpus`` is the loaded service territory (source of truth). When omitted, an
    empty corpus is used and every claim resolves to UNKNOWN — still a valid,
    schema-conformant manifest.
    """
    timer = Timer()
    effective_corpus = corpus if corpus is not None else SourceCorpus(base_dir=Path("."))
    headings = canonical_headings if canonical_headings is not None else load_canonical_headings()

    diff = parse_diff(candidate_text, current_text)
    structural = validate_structure(candidate_text, canonical_headings=headings)
    claims = extract_claims(
        candidate_text,
        diff.changed_line_numbers,
        effective_corpus,
        service_id,
        verified_at_ref,
    )

    manifest = ClaimManifest(
        service_id=service_id,
        candidate_hash=content_hash(candidate_text),
        current_hash=content_hash(current_text),
        verified_at_ref=verified_at_ref,
        claims=claims,
        structural_issues=[
            {"severity": i.severity, "code": i.code, "message": i.message, "line": i.line}
            for i in structural
        ],
    )

    if emit_telemetry:
        emit_run(manifest, timer.elapsed_ms(), stream=telemetry_stream)
    return manifest


__all__ = [
    "SCHEMA_VERSION",
    "VERIFIER_ID",
    "VERIFIER_VERSION",
    "ClaimManifest",
    "Claim",
    "ClaimType",
    "Comparison",
    "Completeness",
    "Risk",
    "Verdict",
    "IMPLEMENTED_TYPES",
    "DEFERRED_TYPES",
    "SourceCorpus",
    "GateDecision",
    "GateVerdict",
    "WRITABLE_VERDICTS",
    "BLOCKING_VERDICTS",
    "compute_gate",
    "corpus_fingerprint",
    "source_fingerprint",
    "claim_id",
    "content_hash",
    "load_canonical_headings",
    "load_schema",
    "validate_manifest",
    "verify_candidate",
    "__version__",
]

"""Unit tests for the §2.7 gate lattice: every cell, precedence, and decision props."""
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[2]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from verifier.gate import (  # noqa: E402
    BLOCKING_VERDICTS,
    WRITABLE_VERDICTS,
    GateDecision,
    GateVerdict,
    compute_gate,
    corpus_fingerprint,
    source_fingerprint,
)
from verifier.manifest import ClaimManifest  # noqa: E402
from verifier.taxonomy import Claim, ClaimType, Risk, Verdict  # noqa: E402


def _claim(verdict: Verdict, risk: Risk = Risk.MEDIUM, advisories: list[str] | None = None) -> Claim:
    return Claim(
        service_id="svc",
        section_path="## Overview",
        claim_text="a claim",
        claim_type=ClaimType.QUOTED_LITERAL,
        verdict=verdict,
        risk=risk,
        advisories=list(advisories or []),
    )


def _manifest(claims=None, structural_issues=None) -> ClaimManifest:
    return ClaimManifest(
        service_id="svc",
        candidate_hash="cand",
        current_hash="cur",
        claims=list(claims or []),
        structural_issues=list(structural_issues or []),
    )


# --------------------------------------------------------------------------- #
# every lattice cell
# --------------------------------------------------------------------------- #

def test_pass_clean_manifest():
    decision = compute_gate(_manifest(claims=[_claim(Verdict.PASS)]))
    assert decision.verdict is GateVerdict.PASS
    assert decision.is_writable
    assert not decision.blocks_pr
    assert decision.exit_code == 0


def test_pass_with_advisories_from_advisory_notes():
    decision = compute_gate(_manifest(claims=[_claim(Verdict.PASS, advisories=["subset note"])]))
    assert decision.verdict is GateVerdict.PASS_WITH_ADVISORIES
    assert decision.is_writable
    assert decision.advisory_count == 1
    assert decision.exit_code == 0


def test_pass_with_advisories_from_low_risk_unknown():
    decision = compute_gate(_manifest(claims=[_claim(Verdict.UNKNOWN, risk=Risk.LOW)]))
    assert decision.verdict is GateVerdict.PASS_WITH_ADVISORIES
    assert decision.is_writable
    assert decision.unknown_count == 1
    assert decision.high_risk_unknown_count == 0


def test_insufficient_evidence_high_risk():
    decision = compute_gate(_manifest(claims=[_claim(Verdict.UNKNOWN, risk=Risk.HIGH)]))
    assert decision.verdict is GateVerdict.INSUFFICIENT_EVIDENCE_HIGH_RISK
    assert not decision.is_writable
    assert decision.is_draft_pr
    assert decision.high_risk_unknown_count == 1
    assert decision.exit_code == 0  # draft-PR path, not a hard job failure


def test_conflict():
    decision = compute_gate(_manifest(claims=[_claim(Verdict.CONFLICT)]))
    assert decision.verdict is GateVerdict.CONFLICT
    assert not decision.is_writable
    assert decision.blocks_pr
    assert decision.conflict_count == 1
    assert decision.exit_code == 1


def test_invalid_from_structural_error():
    issues = [{"severity": "error", "code": "semantic_block_deleted", "message": "gone", "line": 1}]
    decision = compute_gate(_manifest(claims=[_claim(Verdict.PASS)], structural_issues=issues))
    assert decision.verdict is GateVerdict.INVALID
    assert not decision.is_writable
    assert decision.invalid_count == 1
    assert decision.exit_code == 1


def test_structural_warning_does_not_invalidate():
    issues = [{"severity": "warning", "code": "broken_link", "message": "link", "line": 3}]
    decision = compute_gate(_manifest(claims=[_claim(Verdict.PASS)], structural_issues=issues))
    assert decision.verdict is GateVerdict.PASS
    assert decision.invalid_count == 0


def test_evidence_race():
    decision = compute_gate(_manifest(claims=[_claim(Verdict.PASS)]), evidence_race=True)
    assert decision.verdict is GateVerdict.EVIDENCE_RACE
    assert decision.is_retryable
    assert not decision.is_writable
    assert decision.blocks_pr
    assert decision.exit_code == 1


# --------------------------------------------------------------------------- #
# precedence (most severe wins)
# --------------------------------------------------------------------------- #

def test_evidence_race_dominates_conflict():
    decision = compute_gate(_manifest(claims=[_claim(Verdict.CONFLICT)]), evidence_race=True)
    assert decision.verdict is GateVerdict.EVIDENCE_RACE


def test_invalid_dominates_conflict():
    issues = [{"severity": "error", "code": "missing_frontmatter", "message": "x", "line": 1}]
    decision = compute_gate(_manifest(claims=[_claim(Verdict.CONFLICT)], structural_issues=issues))
    assert decision.verdict is GateVerdict.INVALID


def test_conflict_dominates_high_risk_unknown():
    claims = [_claim(Verdict.CONFLICT), _claim(Verdict.UNKNOWN, risk=Risk.HIGH)]
    assert compute_gate(_manifest(claims=claims)).verdict is GateVerdict.CONFLICT


def test_high_risk_unknown_dominates_advisories():
    claims = [_claim(Verdict.UNKNOWN, risk=Risk.HIGH), _claim(Verdict.PASS, advisories=["note"])]
    assert compute_gate(_manifest(claims=claims)).verdict is GateVerdict.INSUFFICIENT_EVIDENCE_HIGH_RISK


def test_empty_manifest_is_pass():
    # No claims, no structural issues -> nothing to contradict -> PASS (writable).
    assert compute_gate(_manifest()).verdict is GateVerdict.PASS


# --------------------------------------------------------------------------- #
# decision helpers + writable/blocking sets
# --------------------------------------------------------------------------- #

def test_writable_set_is_exactly_pass_variants():
    assert WRITABLE_VERDICTS == frozenset({GateVerdict.PASS, GateVerdict.PASS_WITH_ADVISORIES})


def test_blocking_set():
    assert BLOCKING_VERDICTS == frozenset(
        {GateVerdict.INVALID, GateVerdict.CONFLICT, GateVerdict.EVIDENCE_RACE}
    )


def test_to_dict_round_trips_verdict_and_counts():
    decision = compute_gate(_manifest(claims=[_claim(Verdict.CONFLICT), _claim(Verdict.UNKNOWN)]))
    payload = decision.to_dict()
    assert payload["verdict"] == "CONFLICT"
    assert payload["conflict_count"] == 1
    assert payload["unknown_count"] == 1
    assert payload["is_writable"] is False
    assert isinstance(payload["reasons"], list) and payload["reasons"]


def test_gate_decision_is_immutable():
    decision = GateDecision(verdict=GateVerdict.PASS)
    with pytest.raises(Exception):
        decision.verdict = GateVerdict.CONFLICT  # type: ignore[misc]


# --------------------------------------------------------------------------- #
# fingerprint helpers (EVIDENCE_RACE detection substrate)
# --------------------------------------------------------------------------- #

def test_corpus_fingerprint_is_order_independent():
    a = {"x.py": "print(1)", "y.py": "print(2)"}
    b = {"y.py": "print(2)", "x.py": "print(1)"}
    assert corpus_fingerprint(a) == corpus_fingerprint(b)


def test_corpus_fingerprint_detects_content_change():
    a = {"x.py": "print(1)"}
    b = {"x.py": "print(2)"}
    assert corpus_fingerprint(a) != corpus_fingerprint(b)


def test_source_fingerprint_detects_file_change(tmp_path: Path):
    (tmp_path / "a.py").write_text("v1", encoding="utf-8")
    fp1 = source_fingerprint(tmp_path, ["**/*.py"])
    (tmp_path / "a.py").write_text("v2", encoding="utf-8")
    fp2 = source_fingerprint(tmp_path, ["**/*.py"])
    assert fp1 != fp2


def test_source_fingerprint_stable_when_unchanged(tmp_path: Path):
    (tmp_path / "a.py").write_text("v1", encoding="utf-8")
    assert source_fingerprint(tmp_path, ["**/*.py"]) == source_fingerprint(tmp_path, ["**/*.py"])

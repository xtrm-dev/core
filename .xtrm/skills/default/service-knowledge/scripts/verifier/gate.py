#!/usr/bin/env python3
"""Deterministic gate lattice for the claim verifier (research §2.7).

PR1 shipped the verifier as advisory-only. This module turns a :class:`ClaimManifest`
into a single :class:`GateVerdict` that decides whether a candidate SKILL may reach the
canonical ``atomic_write``. It is pure, deterministic and LLM-free (REVISION 3 scope:
no residual LLM critic — the lattice is the arbiter).

The 6-tier lattice, most severe first:

    EVIDENCE_RACE                    source truth changed mid-run -> invalidate + retry
    INVALID                          candidate failed structural validation
    CONFLICT                         >=1 claim deterministically contradicted by source
    INSUFFICIENT_EVIDENCE_HIGH_RISK  >=1 high-risk claim could not be verified (UNKNOWN)
    PASS_WITH_ADVISORIES             writable; unresolved low/medium claims or advisories
    PASS                             writable; clean

Only ``PASS`` and ``PASS_WITH_ADVISORIES`` are writable. ``PASS`` never auto-merges —
auto-merge is a separate later decision (research §2.7, canary policy PR5b).
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

from .manifest import ClaimManifest, content_hash
from .taxonomy import Risk, Verdict

# Structural-issue severities that hard-fail the gate (see structural_validator.py).
_ERROR_SEVERITIES = frozenset({"error", "blocker", "fatal"})


class GateVerdict(str, Enum):
    """The 6-tier gate lattice (research §2.7), ordered most -> least severe."""

    EVIDENCE_RACE = "EVIDENCE_RACE"
    INVALID = "INVALID"
    CONFLICT = "CONFLICT"
    INSUFFICIENT_EVIDENCE_HIGH_RISK = "INSUFFICIENT_EVIDENCE_HIGH_RISK"
    PASS_WITH_ADVISORIES = "PASS_WITH_ADVISORIES"
    PASS = "PASS"


# Verdicts that may reach the canonical atomic_write.
WRITABLE_VERDICTS: frozenset[GateVerdict] = frozenset(
    {GateVerdict.PASS, GateVerdict.PASS_WITH_ADVISORIES}
)

# Verdicts that block a PR entirely (no PR opened; report only).
BLOCKING_VERDICTS: frozenset[GateVerdict] = frozenset(
    {GateVerdict.INVALID, GateVerdict.CONFLICT, GateVerdict.EVIDENCE_RACE}
)


@dataclass(frozen=True)
class GateDecision:
    """The gate outcome for one candidate-vs-current run.

    Carries the verdict plus the aggregate counts that feed the
    ``component=reconcile-gate`` telemetry line and the PR-description renderer.
    """

    verdict: GateVerdict
    invalid_count: int = 0
    conflict_count: int = 0
    unknown_count: int = 0
    high_risk_unknown_count: int = 0
    advisory_count: int = 0
    reasons: tuple[str, ...] = field(default_factory=tuple)

    @property
    def is_writable(self) -> bool:
        """True only for PASS / PASS_WITH_ADVISORIES — the atomic_write gate."""
        return self.verdict in WRITABLE_VERDICTS

    @property
    def blocks_pr(self) -> bool:
        """True when no PR may be opened (INVALID / CONFLICT / EVIDENCE_RACE)."""
        return self.verdict in BLOCKING_VERDICTS

    @property
    def is_draft_pr(self) -> bool:
        """True when the workflow should open a draft, do-not-merge PR."""
        return self.verdict is GateVerdict.INSUFFICIENT_EVIDENCE_HIGH_RISK

    @property
    def is_retryable(self) -> bool:
        """True when the whole run should be invalidated and retried."""
        return self.verdict is GateVerdict.EVIDENCE_RACE

    @property
    def exit_code(self) -> int:
        """Process exit code for ``--gate-mode`` CI gating.

        Blocking verdicts (INVALID / CONFLICT / EVIDENCE_RACE) return non-zero so a CI
        job fails cleanly. INSUFFICIENT_EVIDENCE_HIGH_RISK returns 0 because the workflow
        proceeds to open a *draft* PR rather than failing the job.
        """
        return 1 if self.blocks_pr else 0

    def to_dict(self) -> dict:
        return {
            "verdict": self.verdict.value,
            "is_writable": self.is_writable,
            "blocks_pr": self.blocks_pr,
            "is_draft_pr": self.is_draft_pr,
            "is_retryable": self.is_retryable,
            "exit_code": self.exit_code,
            "invalid_count": self.invalid_count,
            "conflict_count": self.conflict_count,
            "unknown_count": self.unknown_count,
            "high_risk_unknown_count": self.high_risk_unknown_count,
            "advisory_count": self.advisory_count,
            "reasons": list(self.reasons),
        }


def compute_gate(manifest: ClaimManifest, *, evidence_race: bool = False) -> GateDecision:
    """Reduce a manifest to a single :class:`GateDecision` (research §2.7 lattice).

    ``evidence_race`` is supplied by the caller, which recomputes source SHAs at the
    start and end of the verifier run; when True the whole run is suspect and the
    lattice short-circuits to EVIDENCE_RACE (invalidate + retry).
    """
    invalid_count = sum(
        1 for issue in manifest.structural_issues if issue.get("severity") in _ERROR_SEVERITIES
    )
    conflict_claims = [c for c in manifest.claims if c.verdict is Verdict.CONFLICT]
    unknown_claims = [c for c in manifest.claims if c.verdict is Verdict.UNKNOWN]
    high_risk_unknown = [c for c in unknown_claims if c.risk is Risk.HIGH]
    advisory_count = sum(len(c.advisories) for c in manifest.claims)

    conflict_count = len(conflict_claims)
    unknown_count = len(unknown_claims)
    high_risk_unknown_count = len(high_risk_unknown)

    reasons: list[str] = []
    if evidence_race:
        verdict = GateVerdict.EVIDENCE_RACE
        reasons.append("source corpus changed during verifier run; verdicts unreliable")
    elif invalid_count:
        verdict = GateVerdict.INVALID
        reasons.append(f"{invalid_count} structural error(s) in candidate")
    elif conflict_count:
        verdict = GateVerdict.CONFLICT
        reasons.append(f"{conflict_count} claim(s) contradicted by source of truth")
    elif high_risk_unknown_count:
        verdict = GateVerdict.INSUFFICIENT_EVIDENCE_HIGH_RISK
        reasons.append(f"{high_risk_unknown_count} high-risk claim(s) could not be verified")
    elif unknown_count or advisory_count:
        verdict = GateVerdict.PASS_WITH_ADVISORIES
        if unknown_count:
            reasons.append(f"{unknown_count} claim(s) unresolved (advisory only)")
        if advisory_count:
            reasons.append(f"{advisory_count} advisory note(s) attached")
    else:
        verdict = GateVerdict.PASS
        reasons.append("all extracted claims verified PASS")

    return GateDecision(
        verdict=verdict,
        invalid_count=invalid_count,
        conflict_count=conflict_count,
        unknown_count=unknown_count,
        high_risk_unknown_count=high_risk_unknown_count,
        advisory_count=advisory_count,
        reasons=tuple(reasons),
    )


def corpus_fingerprint(files: dict[str, str]) -> str:
    """Stable sha256 over a {rel_path: text} mapping (order-independent)."""
    digest = hashlib.sha256()
    for rel in sorted(files):
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(content_hash(files[rel]).encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def source_fingerprint(base_dir: Path, globs: list[str]) -> str:
    """Re-read the territory files from disk and fingerprint them.

    Called at the start and end of a verifier run; a differing pair means the source
    of truth changed mid-run (EVIDENCE_RACE). Excludes nothing — the caller passes the
    same territory globs it verified against.
    """
    files: dict[str, str] = {}
    seen: set[Path] = set()
    for pattern in globs:
        for path in sorted(base_dir.glob(pattern)):
            if not path.is_file() or path in seen:
                continue
            seen.add(path)
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            files[path.relative_to(base_dir).as_posix()] = text
    return corpus_fingerprint(files)

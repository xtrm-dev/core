#!/usr/bin/env python3
"""Authority hierarchy for evidence sources (research §2.6).

A claim is only as trustworthy as the source that backs it. Sources are ranked so
the verifier (and, in PR2, the gate lattice) can require a minimum authority before
accepting a verdict. Higher rank wins a conflict.

Ranking (high → low):
    executable code (7) > tests/fixtures (6) > read-only probes (5)
    > semantic blocks (4) > verified claims (3) > auto-gen unverified (2)
    > memory items (1)

Curatorial semantic blocks are authority-4: the verifier reads THROUGH them for
context but never extracts claims from inside them (human-authored, not
machine-verifiable).
"""
from __future__ import annotations

from enum import IntEnum
from pathlib import PurePosixPath


class Authority(IntEnum):
    """Evidence authority levels (research §2.6)."""

    MEMORY_ITEM = 1
    AUTO_GEN_UNVERIFIED = 2
    VERIFIED_CLAIM = 3
    SEMANTIC_BLOCK = 4
    READ_ONLY_PROBE = 5
    TESTS_FIXTURES = 6
    EXECUTABLE_CODE = 7


# File-path hints used to classify a source_ref when no explicit kind is given.
_TEST_HINTS = ("test", "tests", "fixture", "fixtures", "spec", "mock", "e2e")
_EXECUTABLE_SUFFIXES = (
    ".py",
    ".sh",
    ".bash",
    ".js",
    ".ts",
    ".go",
    ".rs",
    ".rb",
    ".java",
    ".c",
    ".cpp",
    ".h",
)
_PROBE_SUFFIXES = (".json", ".yaml", ".yml", ".toml", ".txt", ".log", ".csv")


def authority_rank(source_ref: str) -> int:
    """Best-effort authority rank for a source reference path.

    Pure heuristic over the path shape — deterministic, no I/O. Callers that know
    the true provenance should pass an explicit rank instead of relying on this.
    """
    posix = PurePosixPath(source_ref)
    lowered = source_ref.lower()
    parts = {part.lower() for part in posix.parts}

    if parts & set(_TEST_HINTS) or any(hint in lowered for hint in _TEST_HINTS):
        return int(Authority.TESTS_FIXTURES)
    if posix.suffix.lower() in _EXECUTABLE_SUFFIXES:
        return int(Authority.EXECUTABLE_CODE)
    if posix.suffix.lower() in _PROBE_SUFFIXES:
        return int(Authority.READ_ONLY_PROBE)
    return int(Authority.AUTO_GEN_UNVERIFIED)


def meets_authority(source_refs: list[str], required: int) -> bool:
    """True if any source_ref reaches the required authority rank."""
    if required <= 0:
        return True
    return any(authority_rank(ref) >= required for ref in source_refs)

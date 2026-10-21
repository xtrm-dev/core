#!/usr/bin/env python3
"""Closure-marker detection (research §2.4).

A closure marker is prose that asserts a set is CLOSED — "exactly N", "the N
variables are", "all", "only", "the complete list". When a SKILL section claims a
complete set, the verifier can CONTRADICT it by finding a member missing or an
extra member present. Without a closure marker the set is open and the verifier
must stay silent (UNKNOWN) — over-detecting completeness here is the single most
dangerous false-positive class, because a spurious ``complete`` turns into a false
CONFLICT in PR2. So this module defaults to ``unknown`` aggressively.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .taxonomy import Completeness

_WORD_NUMBER = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
}

# "exactly 4", "exactly four"
_EXACTLY_RE = re.compile(r"\bexactly\s+(\d+|[a-z]+)\b", re.IGNORECASE)
# "the 4 sed variables are", "the three keys are:"
_THE_N_ARE_RE = re.compile(
    r"\bthe\s+(\d+|[a-z]+)\s+[\w-]+\s+(?:are|is)\b", re.IGNORECASE
)
# Strong closure keywords. Kept narrow on purpose.
_COMPLETE_LIST_RE = re.compile(
    r"\b(?:complete\s+list|exhaustive\s+list|full\s+list|complete\s+set)\b", re.IGNORECASE
)
_ALL_ONLY_RE = re.compile(r"\b(?:all\s+of\s+the|only\s+the|one\s+and\s+only)\b", re.IGNORECASE)


@dataclass(frozen=True)
class ClosureInfo:
    """What a block of prose asserts about set closure."""

    completeness: Completeness
    expected_count: int | None
    marker: str  # the matched marker text, for the evidence report


def _to_count(token: str) -> int | None:
    if token.isdigit():
        return int(token)
    return _WORD_NUMBER.get(token.lower())


def detect_closure(text: str) -> ClosureInfo:
    """Detect the strongest closure marker in ``text``.

    Order matters: an explicit count ("exactly 4", "the 4 variables are") is the
    strongest signal and wins. Absent any marker, completeness is ``unknown``.
    """
    exactly = _EXACTLY_RE.search(text)
    if exactly:
        count = _to_count(exactly.group(1))
        if count is not None:
            return ClosureInfo(Completeness.COMPLETE, count, exactly.group(0).strip())

    the_n = _THE_N_ARE_RE.search(text)
    if the_n:
        count = _to_count(the_n.group(1))
        if count is not None:
            return ClosureInfo(Completeness.COMPLETE, count, the_n.group(0).strip())

    complete_list = _COMPLETE_LIST_RE.search(text)
    if complete_list:
        return ClosureInfo(Completeness.COMPLETE, None, complete_list.group(0).strip())

    all_only = _ALL_ONLY_RE.search(text)
    if all_only:
        return ClosureInfo(Completeness.COMPLETE, None, all_only.group(0).strip())

    return ClosureInfo(Completeness.UNKNOWN, None, "")

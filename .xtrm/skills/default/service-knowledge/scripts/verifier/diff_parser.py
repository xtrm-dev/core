#!/usr/bin/env python3
"""Markdown diff parser: isolate NEW/MODIFIED substantive lines.

The verifier must only check claims the candidate SKILL actually introduced or
changed — not re-litigate the whole document. This module diffs candidate vs
current (the in-force SKILL) and returns the candidate lines that are genuinely
new or modified, dropping whitespace-only / reformatting churn so those never
surface as false claims.

Each returned line carries its section path (the stack of Markdown headings it
sits under) so claims can be attributed to a location in the document.
"""
from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")


@dataclass(frozen=True)
class DiffLine:
    """A substantive new/modified line in the candidate document."""

    line_number: int  # 1-based position in the candidate text
    text: str
    section_path: str  # "Heading > Subheading" stack at this line


@dataclass
class DiffResult:
    """Outcome of diffing candidate against current."""

    lines: list[DiffLine] = field(default_factory=list)
    candidate_hash: str = ""
    current_hash: str = ""

    @property
    def changed_line_numbers(self) -> set[int]:
        return {line.line_number for line in self.lines}


def _normalize_whitespace(text: str) -> str:
    """Collapse runs of whitespace so reformatting compares equal."""
    return re.sub(r"\s+", " ", text).strip()


def _is_whitespace_only_change(old_block: list[str], new_block: list[str]) -> bool:
    """True when a replaced block differs only by whitespace/formatting."""
    old_norm = [_normalize_whitespace(line) for line in old_block if _normalize_whitespace(line)]
    new_norm = [_normalize_whitespace(line) for line in new_block if _normalize_whitespace(line)]
    return old_norm == new_norm


def build_section_paths(candidate_lines: list[str]) -> list[str]:
    """Per-line section path for a document (heading stack joined by ' > ')."""
    stack: list[tuple[int, str]] = []  # (level, title)
    paths: list[str] = []
    for raw in candidate_lines:
        match = _HEADING_RE.match(raw)
        if match:
            level = len(match.group(1))
            title = match.group(2).strip()
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, title))
        paths.append(" > ".join(title for _, title in stack))
    return paths


def parse_diff(candidate_text: str, current_text: str) -> DiffResult:
    """Return the candidate's substantive new/modified lines.

    ``equal`` blocks are skipped; ``delete`` blocks (lines only in current) are
    skipped; ``replace`` blocks that are whitespace-only after normalization are
    skipped. Everything else in the candidate is a candidate for claim extraction.
    """
    candidate_lines = candidate_text.splitlines()
    current_lines = current_text.splitlines()
    paths = build_section_paths(candidate_lines)

    matcher = difflib.SequenceMatcher(a=current_lines, b=candidate_lines, autojunk=False)
    result = DiffResult()

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        if tag == "delete":
            continue
        if tag == "replace" and _is_whitespace_only_change(current_lines[i1:i2], candidate_lines[j1:j2]):
            continue
        for offset, line_index in enumerate(range(j1, j2)):
            text = candidate_lines[line_index]
            if not text.strip():
                continue
            result.lines.append(
                DiffLine(
                    line_number=line_index + 1,
                    text=text,
                    section_path=paths[line_index],
                )
            )
            _ = offset
    return result

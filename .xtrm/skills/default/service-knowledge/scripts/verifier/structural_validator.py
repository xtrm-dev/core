#!/usr/bin/env python3
"""Structural validator for SKILL Markdown.

Enforces the invariants that umbrella_generator + verifier must never corrupt
(research §2.6): YAML frontmatter, canonical heading order, the preserved
``SEMANTIC_START``/``SEMANTIC_END`` block, a parseable Markdown AST, and sane
inline-link syntax. A deleted or unbalanced semantic block is a hard failure —
that is the regression this validator exists to catch.

Decoupled from I/O: callers pass the canonical heading list (loaded from the
service-skill contract) rather than this module reaching for it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from markdown_it import MarkdownIt

SEMANTIC_START = "<!-- SEMANTIC_START -->"
SEMANTIC_END = "<!-- SEMANTIC_END -->"

_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.DOTALL)
# Inline link with a broken/empty target: [text]( ) or [text]( or a dangling [text]
_BROKEN_LINK_RE = re.compile(r"\[[^\]]*\]\(\s*\)|\[[^\]]*\]\([^)]*$", re.MULTILINE)


@dataclass(frozen=True)
class StructuralIssue:
    """One structural defect."""

    severity: str  # "error" | "warning"
    code: str
    message: str
    line: int = 0


def _check_frontmatter(text: str) -> list[StructuralIssue]:
    if _FRONTMATTER_RE.match(text):
        return []
    return [StructuralIssue("error", "missing_frontmatter", "Document must begin with a YAML frontmatter block (--- ... ---).", 1)]


def _check_semantic_block(text: str) -> list[StructuralIssue]:
    starts = text.count(SEMANTIC_START)
    ends = text.count(SEMANTIC_END)
    issues: list[StructuralIssue] = []
    if starts == 0 and ends == 0:
        issues.append(
            StructuralIssue(
                "error",
                "semantic_block_deleted",
                "SEMANTIC_START/SEMANTIC_END block is missing — curatorial content must be preserved verbatim.",
                _line_of(text, "Semantic Deep Dive") or 1,
            )
        )
        return issues
    if starts != ends:
        issues.append(
            StructuralIssue(
                "error",
                "semantic_block_unbalanced",
                f"Unbalanced semantic markers: {starts} start vs {ends} end.",
                _line_of(text, SEMANTIC_START) or 1,
            )
        )
        return issues
    start_idx = text.find(SEMANTIC_START)
    end_idx = text.find(SEMANTIC_END)
    if end_idx < start_idx:
        issues.append(
            StructuralIssue(
                "error",
                "semantic_block_order",
                "SEMANTIC_END appears before SEMANTIC_START.",
                _line_of(text, SEMANTIC_END) or 1,
            )
        )
    return issues


def _line_of(text: str, needle: str) -> int | None:
    idx = text.find(needle)
    if idx < 0:
        return None
    return text.count("\n", 0, idx) + 1


def _check_headings(text: str, canonical_headings: list[str] | None) -> list[StructuralIssue]:
    if not canonical_headings:
        return []
    # Canonical headings are all H2; collect them in document order.
    found = [m.group(1).strip() for m in re.finditer(r"^##\s+(.*\S)\s*$", text, re.MULTILINE)]

    issues: list[StructuralIssue] = []
    found_set = set(found)
    for heading in canonical_headings:
        if heading not in found_set:
            issues.append(
                StructuralIssue(
                    "error",
                    "missing_heading",
                    f"Required canonical heading missing: '{heading}'.",
                    1,
                )
            )
    # Order check over the headings that ARE present.
    expected_order = [h for h in canonical_headings if h in found_set]
    present_in_order = [h for h in found if h in expected_order]
    if present_in_order != expected_order:
        issues.append(
            StructuralIssue(
                "warning",
                "heading_order",
                "Canonical headings are out of order.",
                1,
            )
        )
    return issues


def _check_markdown_ast(text: str) -> list[StructuralIssue]:
    try:
        MarkdownIt("commonmark").parse(text)
    except Exception as exc:  # markdown-it is lenient; a raise means truly malformed input
        return [StructuralIssue("error", "markdown_parse_error", f"Markdown AST failed to parse: {exc}", 1)]
    return []


def _check_links(text: str) -> list[StructuralIssue]:
    issues: list[StructuralIssue] = []
    for match in _BROKEN_LINK_RE.finditer(text):
        line = text.count("\n", 0, match.start()) + 1
        issues.append(
            StructuralIssue("warning", "broken_link", f"Malformed inline link near: {match.group(0)!r}", line)
        )
    return issues


def validate_structure(
    text: str,
    *,
    canonical_headings: list[str] | None = None,
    require_semantic_block: bool = True,
) -> list[StructuralIssue]:
    """Run all structural checks; returns every issue found (empty == valid)."""
    issues: list[StructuralIssue] = []
    issues += _check_frontmatter(text)
    if require_semantic_block:
        issues += _check_semantic_block(text)
    issues += _check_headings(text, canonical_headings)
    issues += _check_markdown_ast(text)
    issues += _check_links(text)
    return issues


def has_errors(issues: list[StructuralIssue]) -> bool:
    return any(issue.severity == "error" for issue in issues)

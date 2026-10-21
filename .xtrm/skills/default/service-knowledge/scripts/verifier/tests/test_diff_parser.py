"""Diff parser: only substantive new/modified lines; whitespace churn ignored."""
from verifier.diff_parser import build_section_paths, parse_diff


def test_inserted_line_is_captured():
    current = "line one\nline two\n"
    candidate = "line one\nline two\nline three\n"
    result = parse_diff(candidate, current)
    assert result.lines[-1].text == "line three"
    assert result.lines[-1].line_number == 3


def test_deleted_line_is_not_captured():
    current = "line one\nline two\nline three\n"
    candidate = "line one\nline three\n"
    result = parse_diff(candidate, current)
    assert all(line.text != "line two" for line in result.lines)


def test_whitespace_only_change_is_ignored():
    current = "alpha   beta\n"
    candidate = "alpha beta\n"  # collapsed whitespace only
    result = parse_diff(candidate, current)
    assert result.lines == []


def test_reformatting_indent_change_is_ignored():
    current = "key: value\n"
    candidate = "  key: value\n"  # indentation churn only
    result = parse_diff(candidate, current)
    assert result.lines == []


def test_substantive_modification_is_captured():
    current = "count: 4\n"
    candidate = "count: 5\n"
    result = parse_diff(candidate, current)
    assert any(line.text == "count: 5" for line in result.lines)


def test_section_path_tracks_heading_stack():
    text = "# Top\n\n## A\n\nbody\n\n### A1\n\ndeep\n\n## B\n\nother\n"
    paths = build_section_paths(text.splitlines())
    by_line = dict(zip(text.splitlines(), paths))
    assert by_line["body"] == "Top > A"
    assert by_line["deep"] == "Top > A > A1"
    assert by_line["other"] == "Top > B"


def test_changed_line_numbers_set():
    current = "same\nold\n"
    candidate = "same\nnew\n"
    result = parse_diff(candidate, current)
    assert 2 in result.changed_line_numbers
    assert 1 not in result.changed_line_numbers

#!/usr/bin/env python3
"""Comment-text rules shared by this lane's Jira write paths and its detectors (LANE-RULES 19, 21).

WHY ONE MODULE. Four scripts talk about a comment's opening line: go-post.py (relay duplicate
check), post-prlink.py (PR-link duplicate check), post-r2.py (verdict duplicate check) and
cycle.py (the comment watch's skip branch plus the PR-link coverage detector). Since
2026-10-28T14:00Z the Jira helper prepends `[agent:<holder> | run:<id>]` as its own first
paragraph, so EVERY one of those tests has to step over the header before it looks at the body -
and a fixture that agrees with one copy of the rule proves nothing about the other three.
So the rule lives here once and every consumer imports it. Each caller keeps its own flattener
because they join paragraphs differently (one newline vs a blank line); strip_header() handles
both, which is the property the controls pin.

GENERAL LESSON THIS FILE ENCODES (seq 111, 112, 118, 119): a new writer or detector inherits
nothing. When a text-level contract changes, the change is not done until every reader of that
text has been found and given the same rule.
"""
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import lanecfg  # noqa: E402

# Short repository name in the legacy PR-link form; PM_REPO_NAME, see board-audit/references/setup-lane.md
REPO_NAME = lanecfg.repo_name()
_RN = re.escape(REPO_NAME)

HEADER_PREFIX = "[agent:"
PRLINK_PREFIX = f"PR-link {REPO_NAME}#"
# Operator rule 2026-10-29: a PR reference in Jira becomes a full URL, so a new PR-link comment opens
# "PR-link https://github.com/<org>/<repo>/pull/<n>". BOTH forms are read, because the comments
# already on the board carry the legacy form and the lane rewrites them only afterwards. The org and
# repo are deliberately not pinned: the rule is about the shape, not about one repository.
PRLINK_LEGACY_RE = re.compile(r"^PR-link " + _RN + r"#(\d+)\b")
PRLINK_URL_RE = re.compile(r"^PR-link https?://github\.com/[^\s/]+/[^\s/]+/pull/(\d+)\b")
PRLINK_RE = re.compile(r"^PR-link (?:https?://github\.com/[^\s/]+/[^\s/]+/pull/|" + _RN + r"#)(\d+)\b")
VERDICT_RE = re.compile(r"^(VERIFIED(?:-WITH-CAVEAT)?|FAIL) (\d{4}-\d{2}-\d{2})-(b\d+)-")


def strip_header(text):
    """Drop a leading `[agent:...]` paragraph and any blank line behind it.

    Returns the text unchanged when there is no header, so a comment posted before the change is
    read exactly as before (control: a real pre-change comment, never a fixture). Both paragraph
    joins are handled because the callers differ: go-post/cycle separate paragraphs with a blank
    line, post-prlink/post-r2 with a single newline.
    """
    t = (text or "").lstrip()
    if not t.startswith(HEADER_PREFIX):
        return text
    nl = t.find("\n")
    if nl == -1:
        return ""
    return t[nl + 1:].lstrip("\n")


def opening_line(text):
    """First line of the BODY, header stripped: what a duplicate check compares against."""
    body = strip_header(text)
    first = body.strip().split("\n", 1)[0].strip()
    return first


def is_prlink_comment(text):
    """True when the comment's body opens with a formal PR-link line (cycle.py's skip branch).

    Accepts both the legacy `PR-link <repo>#<n>` form and the URL form the operator requires
    from 2026-10-29 (`PR-link https://github.com/<org>/<repo>/pull/<n>`)."""
    return PRLINK_RE.match(strip_header(text).lstrip()) is not None


def prlink_numbers(text):
    """Every PR number named by a formal PR-link LINE in the text, both forms, header-independent.

    Per line, not per body: a comment may carry more than one PR-link line, and the legacy readers
    scanned line by line. Header-independent for the same reason verdict_of_line is.
    """
    out = set()
    for ln in strip_header(text).split("\n"):
        m = PRLINK_RE.match(ln.lstrip())
        if m:
            out.add(int(m.group(1)))
    return out


def prlink_number(text):
    """The PR number of a formal PR-link comment, or None (post-prlink.py's duplicate check)."""
    m = PRLINK_RE.match(strip_header(text).lstrip())
    return int(m.group(1)) if m else None


def verdict_of_line(line):
    """(kind, day, batch) for a line that IS a verdict line, else None. Header-independent:
    verdicts are matched per line, so a header above them cannot hide one."""
    m = VERDICT_RE.match(line)
    return (m.group(1), m.group(2), m.group(3)) if m else None


def paragraphs_text(body):
    """ADF -> text with paragraphs joined EXACTLY as jira.paragraphs() joins them ("\n\n").

    This is the inverse of jira.adf()/jira.paragraphs(), and it exists because a read-back can only
    be compared to jira.post_comment()'s posted text when both sides use the SAME paragraph
    separator. The lane's older flatteners used a single newline per paragraph, which was invisible
    while comments had one paragraph and became a guaranteed mismatch the moment the agent header
    added a second one (control D5/D6, 2026-10-28).
    """
    if not isinstance(body, dict):
        return ""
    paras = []
    for para in (body.get("content") or []):
        buf = []

        def walk(n):
            if isinstance(n, dict):
                t = n.get("type")
                if t == "text":
                    buf.append(n.get("text", ""))
                elif t == "hardBreak":
                    buf.append("\n")
                elif t == "inlineCard":
                    buf.append((n.get("attrs") or {}).get("url", ""))
                for c in n.get("content") or []:
                    walk(c)
            elif isinstance(n, list):
                for c in n:
                    walk(c)

        walk(para)
        paras.append("".join(buf))
    return "\n\n".join(p.strip("\n") for p in paras).strip()


def compare(readback, posted):
    """(ok, why). The read-back must equal the text actually posted, never the input file.

    A file comparator false-fails as soon as the post path adds anything (the agent header) and
    false-passes if the path drops a line - wrong in both directions at once.
    """
    if readback == posted:
        return True, ""
    for i, (a, b) in enumerate(zip(readback, posted)):
        if a != b:
            return False, f"first difference at char {i}: got {a!r} want {b!r}"
    return False, f"length differs: readback {len(readback)} vs posted {len(posted)}"

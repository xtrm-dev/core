#!/usr/bin/env python3
"""Apply a rule-46 description (eight /planning sections) to a Jira row, from a draft JSON.

WHY THIS EXISTS. Rule 46 (coordinator ruling 2026-11-06) requires every new or edited ticket
description to use the planning sections in plain words: Context, Outcome, Scope, Not in scope,
Constraints and decisions, How we check it, Deliverable and window, Substrate ref. The rows created
before the rule (four of them) use prose instead, and rewriting four descriptions by hand
in an ADF editor is how a section silently goes missing — so the draft is a JSON list of
[heading, body] pairs and this script refuses to write anything that is not the full eight in order.

Safety: no write without `--apply`, and every apply re-reads and prints the section list it found.

Usage:
    python3 r46-apply.py writes/r46/673.json PROJ-673            # dry: prints what would be written
    python3 r46-apply.py writes/r46/673.json PROJ-673 --apply    # writes, then re-reads
"""
import json
import sys

import lanecfg  # noqa: E402,F401  (puts project-management/scripts on sys.path)
import jira  # noqa: E402

SECTIONS = ("Context", "Outcome", "Scope", "Not in scope", "Constraints and decisions",
            "How we check it", "Deliverable and window", "Substrate ref")


def adf(pairs):
    """One bold heading paragraph per section, then the body paragraph."""
    content = []
    for head, body in pairs:
        content.append({"type": "paragraph", "content": [
            {"type": "text", "text": head, "marks": [{"type": "strong"}]}]})
        content.append({"type": "paragraph", "content": [{"type": "text", "text": body}]})
    return {"type": "doc", "version": 1, "content": content}


def read_sections(key):
    f = jira.call("GET", f"/rest/api/3/issue/{key}?fields=description")[1]["fields"]
    out = []
    for node in ((f.get("description") or {}).get("content") or []):
        parts = []
        def walk(n):
            if isinstance(n, list):
                for x in n:
                    walk(x)
                return
            if not isinstance(n, dict):
                return
            if n.get("type") == "text":
                parts.append(n.get("text") or "")
            for v in n.get("content") or []:
                walk(v)
        walk(node.get("content") or [])
        line = " ".join(" ".join(parts).split())
        if line:
            out.append(line)
    return out


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    path, key = argv[1], argv[2]
    apply = "--apply" in argv[3:]
    pairs = json.load(open(path, encoding="utf-8"))["sections"]
    names = tuple(p[0] for p in pairs)
    if names != SECTIONS:
        print(f"REFUSED: sections are {names}, rule 46 requires {SECTIONS} in that order")
        return 1
    if any(not p[1].strip() for p in pairs):
        print("REFUSED: an empty section body is not a section")
        return 1
    before = read_sections(key)
    print(f"{key} before: {len(before)} paragraphs; sections found: "
          f"{[s for s in SECTIONS if any(s.lower() in b.lower() for b in before)] or 'NONE'}")
    if not apply:
        print("DRY — would write these eight sections:")
        for head, body in pairs:
            print(f"  {head}: {body[:96]}{'…' if len(body) > 96 else ''}")
        return 0
    st, body = jira.call("PUT", f"/rest/api/3/issue/{key}", {"fields": {"description": adf(pairs)}})
    print("PUT", st)
    after = read_sections(key)
    missing = [s for s in SECTIONS if not any(line.strip() == s for line in after)]
    print(f"{key} after: {len(after)} paragraphs; missing headings: {missing or 'none'}")
    return 0 if st < 300 and not missing else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

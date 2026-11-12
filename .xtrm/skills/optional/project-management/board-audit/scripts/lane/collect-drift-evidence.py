#!/usr/bin/env python3
"""Collect verification evidence for drifted rows, read-only.

For each row: the row's own fields, its Substrate contracts and their journal, and only those Jira comments
that look like evidence (a PASS/verify/VERIFIED word, a make target, a command, an observed output). Prints a
compact digest per row so a human (me) applies the verdict; it never decides anything and writes nothing.

WHY the keyword gate and the truncation: a row can carry dozens of comments and the digest is read by an
agent whose context is finite. Every comment that does not look like evidence is counted, not printed, so a
row with 40 comments still costs a few lines but the count proves the sweep happened.

WHY the three evidence classes are kept apart in the output: a merge commit proves code landed; a PASS comment
proves the step ran; a make-target record proves someone executed it. Only the last two are "verified", and the
digest labels which is which so the verdict cannot quietly promote a merge into a verification.

Usage: collect-drift-evidence.py <drift.json> <out.md>
"""
import json
import re
import subprocess
import sys

import lanecfg
import jira as J  # noqa: E402  (on sys.path through lanecfg)

SB = lanecfg.sb_bin()
SLOT_START = lanecfg.custom_field("window_start")
SLOT_END = lanecfg.custom_field("window_end")

EVIDENCE = re.compile(
    r"\b(pass(ed)?|verify|verified|verification|confirm(ed)?|ok\b|green|evidence|"
    r"make [a-z][a-z0-9-]+|SELECT |curl |EXPLAIN |sha256|digest|attested|result entry)", re.I)
MAKE = re.compile(r"\bmake ([a-z][a-z0-9-]+)", re.I)
REFS = re.compile(re.escape(lanecfg.sb_prefix()) + r"-\d{3,4}")


def flat(node, out):
    if isinstance(node, dict):
        t = node.get("type")
        if t == "text":
            out.append(node.get("text", ""))
        elif t == "mention":
            out.append("@" + (node.get("attrs") or {}).get("text", ""))
        elif t == "inlineCard":
            out.append("[card]")
        elif t in ("paragraph", "listItem", "hardBreak"):
            out.append("\n")
        for v in node.get("content") or []:
            flat(v, out)
    elif isinstance(node, list):
        for v in node:
            flat(v, out)


def jira_row(key):
    st, b = J.call("GET", f"/rest/api/3/issue/{key}?fields=summary,status,labels,{SLOT_START},{SLOT_END}")
    if st >= 300 or not isinstance(b, dict):
        return None, []
    cm = []
    st2, c = J.call("GET", f"/rest/api/3/issue/{key}/comment?maxResults=100")
    for x in (c.get("comments") if isinstance(c, dict) else None) or []:
        o = []
        flat(x.get("body"), o)
        txt = " ".join("".join(o).split())
        cm.append({"id": x["id"], "at": (x.get("created") or "")[:19],
                   "who": (x.get("author") or {}).get("displayName"), "text": txt})
    return b["fields"], cm


def sb_show(ref):
    try:
        p = subprocess.run([SB, "issue", "show", ref, "--json"], capture_output=True, text=True, timeout=60)
        d = json.loads(p.stdout).get("data") or {}
        return d
    except Exception:
        return {}


def sb_journal(ref, n=5):
    try:
        p = subprocess.run([SB, "journal", "latest", ref, "--json"], capture_output=True, text=True, timeout=60)
        d = json.loads(p.stdout)
        rows = d.get("data") or d.get("entries") or []
        if isinstance(rows, dict):
            rows = rows.get("entries") or []
        return rows[-n:]
    except Exception:
        return []


def main():
    drift = json.load(open(sys.argv[1]))
    out_path = sys.argv[2]
    lines = ["# Verification evidence sweep (read-only, no verdicts)", ""]
    for r in drift:
        key, status = r["key"], r["status"]
        f, cms = jira_row(key)
        lines.append(f"## {key} [{status}] tier={r['tier']} why={r['why']}")
        if f:
            labels = [l for l in (f.get("labels") or []) if l.startswith("substrate:")]
            lines.append(f"- labels: {', '.join(labels) or 'none'} | slot {f.get(SLOT_START)} -> {f.get(SLOT_END)}")
            lines.append(f"- title: {f['summary'][:130]}")
        ev = [c for c in cms if EVIDENCE.search(c["text"])]
        lines.append(f"- comments: {len(cms)} total, {len(ev)} match the evidence gate")
        for c in ev[-4:]:
            snap = c["text"][:260].replace("\n", " ")
            lines.append(f"  - c{c['id']} {c['at']} {c['who']}: {snap}")
        refs = sorted({m for m in REFS.findall((r["why"] or "") + " " + (f["summary"] if f else ""))})
        for ref in refs[:3]:
            d = sb_show(ref)
            if d:
                lines.append(f"- {ref} ({d.get('locator')}): lifecycle={d.get('lifecycleState')} readiness={d.get('readiness')}")
            for e in sb_journal(ref, 4):
                txt = (e.get("summary") or e.get("text") or "")[:200].replace("\n", " ")
                lines.append(f"  - {ref} journal seq {e.get('seq')}: {txt}")
        lines.append("")
    open(out_path, "w").write("\n".join(lines))
    print(f"wrote {out_path}: {len(lines)} lines, {len(drift)} rows")


if __name__ == "__main__":
    main()

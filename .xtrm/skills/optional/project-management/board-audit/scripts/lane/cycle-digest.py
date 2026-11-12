#!/usr/bin/env python3
"""Turn one CYCLE markdown into event lines and per-task extracts.

The cycle engine writes one long markdown per pass. This digest keeps the report file intact and
publishes only what has to wake a coordinator: one counts line per pass, and a separate extract when
there are new comments, new tickets, or a broken control. Silent when nothing needs attention.
"""
import json
import os
import re
import sys

import lanecfg

LANE = lanecfg.lane()
_F = lanecfg.data("PM_HYGIENE_FILTERS", required=True)
NO_DATES, OVERDUE, NEXT48 = (str(_F[r]["id"]) for r in ("open_without_dates", "overdue", "next_48h"))
KEY_RE = lanecfg.jira_key_re()
KEYS = (f"{NO_DATES}_window", OVERDUE, NEXT48, "no_slot", "fold_orphans", "fold_stale", "fold_dateless", "gate_escalations",
        "drift", "unmirrored_prod_contracts", "pr_links_missing", "pr_no_window", "new_comments",
        "new_tickets", "control_failures", "control_gaps")
SECTIONS = {
    "comments": ("## 5. Comment watch", "## 6."),
    "newtickets": ("## 7. New tickets", "## 8."),
    "hygiene": ("## 1. Hygiene filters", "## 2. Window health"),
    "windows": ("## 2. Window health", "## 2b."),
    "drift": ("## 3. Finished-not-closed", "## 4."),
    "prlinks": ("## 4. PR-link top-up", "## 5."),
    "unmirrored": ("## 8. Production contracts", "## Counts"),
}
HDR = re.compile(r"^\s*\(\s*\d+\s+rows?\)|\*\*" + NO_DATES + r"|^- \*\*(" + OVERDUE + "|" + NEXT48 + ")", re.M)


def section(text, name):
    start, end = SECTIONS[name]
    i = text.find(start)
    if i < 0:
        return ""
    j = text.find(end, i + len(start))
    return text[i:j if j > 0 else len(text)].strip()


def main(path):
    text = open(path, encoding="utf-8", errors="replace").read()
    m = re.search(r"## Counts\s*```\s*(\{.*?\n\})\s*```", text, re.S)
    if not m:
        print(f"CYCLE-ERROR no counts block in {path}")
        return 1
    c = json.loads(m.group(1))
    stamp = re.search(r"^# CYCLE (\S+)", text, re.M)
    stamp = stamp.group(1) if stamp else "unknown"
    hhmm = stamp[11:16].replace(":", "") if len(stamp) > 16 else "0000"
    parts = " ".join(f"{k}={c.get(k)}" for k in KEYS)
    print(f"CYCLE {stamp} rc=0 {parts}")
    if c.get("gate_escalations"):
        body = next((l for l in text.splitlines() if "ESCALATE" in l), "")
        # Once per day per row (mon02, 2026-11-03): a repeat inside the day adds nothing to a
        # sweep the coordinator reads, and hides new escalations behind old noise.
        seen_p = f"{LANE}/gate-escalation.seen.json"
        try:
            seen = json.load(open(seen_p))
        except Exception:
            seen = {}
        today = stamp[:10]
        key = re.search(f"({KEY_RE})", body)
        key = key.group(1) if key else "unknown"
        if seen.get(key) != today:
            seen[key] = today
            open(seen_p, "w").write(json.dumps(seen, indent=1))
            print(f"GATE-ESCALATION {stamp} n={c['gate_escalations']} first={body.strip()[:160]} file={path}")
        else:
            print(f"GATE-ESCALATION-SUPPRESSED {stamp} {key} already reported today")
    if c.get("control_failures"):
        print(f"CONTROL-FAILED {stamp} control_failures={c['control_failures']} file={path}")
    if c.get("new_comments"):
        body = f"# Comment watch {stamp}\n\n{section(text, 'comments')}\n"
        p = f"{LANE}/COMMENT-{hhmm}Z.md"
        open(p, "w").write(body)
        print(f"COMMENT-NEW {stamp} n={c['new_comments']} file={p}")
    # Mechanical operator detection, so forwarding is never a reading judgement: a comment whose author
    # is not this bot is an operator/other-agent comment and must reach the coordinator at once.
    for line in section(text, "comments").splitlines():
        m = re.match(r"\s*-\s+(" + KEY_RE + r")\s+c(\d+)\s+\(([^)]+)\):\s*(.*)", line)
        if m and m.group(3).strip().lower() != "xtrm-bot":
            print(f"OPERATOR-COMMENT {stamp} {m.group(1)} c{m.group(2)} author={m.group(3).strip()} "
                  f"text={m.group(4).strip()[:180]}")
    if c.get("new_tickets"):
        body = f"# New tickets {stamp}\n\n{section(text, 'newtickets')}\n"
        p = f"{LANE}/NEWTICKET-{hhmm}Z.md"
        open(p, "w").write(body)
        print(f"NEWTICKET {stamp} n={c['new_tickets']} thin={c.get('new_tickets_thin')} file={p}")
    if c.get("control_gaps"):
        # A steady gap is a fact about the board, not an event: report it once, and again only when the
        # gap itself changes. Otherwise one empty control pole wakes the coordinator every 15 minutes.
        gaps = sorted({l.strip()[:200] for l in text.splitlines() if "INSTRUMENT GAP" in l})
        prev_file = f"{LANE}/last-control-gap.txt"
        prev = open(prev_file).read().strip() if os.path.exists(prev_file) else ""
        cur = "\n".join(gaps)
        if cur != prev:
            for g in gaps:
                print(f"CONTROL-GAP {stamp} {g}")
            open(prev_file, "w").write(cur)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))

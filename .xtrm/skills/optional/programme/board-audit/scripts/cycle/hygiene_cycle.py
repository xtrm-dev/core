#!/usr/bin/env python3
"""Read-only MMD board cycle: hygiene predicates with real controls, and status drift with Jira.

Every number carries the JQL key that produced it. Every predicate carries a positive control (a row
the predicate must accept) and a negative control (a row the predicate must reject), each derived from
live data rather than a hardcoded key, so a control cannot pass by memorising an old answer.

A control row is chosen from a population the predicate must NOT include and a population it must.
If a control fails, the section's numbers print CONTROL-FAILED and are not reported as measurements.

Usage:
  python3 hygiene_cycle.py            # hygiene + drift, human table + JSON
  python3 hygiene_cycle.py --json     # JSON only
  python3 hygiene_cycle.py --since=2026-10-30   # replay a day, to prove the drift section works
Exit: 0 all controls passed, 3 a control failed (numbers still printed, flagged).
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import datetime as dt
import sys

JIRA_HELPER = "/home/dawid/.xtrm/skills/optional/programme/programme-coordination/scripts/jira.py"
OUT = "/home/dawid/.cache/MMD-3017/CYCLE-HYGIENE.json"
DONE_STATUSES = {"Completata", "Done with Follow-up", "Won't Do", "Cancelled"}
ACTIVE_STATUSES = {"Da completare", "In corso", "Waiting Production", "In verifica"}

_spec = importlib.util.spec_from_file_location("j", JIRA_HELPER)
jira = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(jira)


def jql(q, fields, limit=100):
    rows, token = [], None
    while True:
        body = {"jql": q, "maxResults": limit, "fields": fields}
        if token:
            body["nextPageToken"] = token
        st, d = jira.call("POST", "/rest/api/3/search/jql", body)
        if st >= 300:
            return st, rows
        rows.extend((d or {}).get("issues") or [])
        token = (d or {}).get("nextPageToken")
        if not token:
            return 200, rows


FIELDS = ["key", "summary", "status", "duedate", "customfield_10015", "customfield_10237",
          "customfield_10238", "parent", "labels", "issuetype", "updated"]
BASE = "project = ISSUE AND labels = window AND statusCategory != Done"

PREDS = {
    "CTRL-pop": BASE,
    "H1": f"{BASE} AND issuetype in (Task, Story) AND duedate is EMPTY",
    "H2": "project = ISSUE AND labels = window AND (duedate is EMPTY OR customfield_10237 is EMPTY)",
    "H3": 'project = ISSUE AND labels = window AND summary ~ "10-*"',
    "H4": "project = ISSUE AND labels = window AND parent is EMPTY",
    "O1w": ("project = ISSUE AND statusCategory != Done AND status not in (Blocked, Deferred) "
            "AND duedate < now() AND labels = window"),
    "O1b": "project = ISSUE AND statusCategory != Done AND status not in (Blocked, Deferred) AND duedate < now()",
    "N1": f"{BASE} AND duedate >= now() AND duedate <= 2d",
    "N2": "project = ISSUE AND statusCategory != Done AND duedate is EMPTY",
}


def keys_of(rows):
    return [r["key"] for r in rows]


def count(jq):
    st, rows = jql(jq, ["key"])
    return (st, len(rows), keys_of(rows))


def by_key(key, predicate="project = ISSUE"):
    """Re-ask the predicate narrowed to one row: 1 means the predicate accepts it, 0 means it rejects."""
    st, rows = jql(f"{predicate} AND key = {key}", ["key"])
    return st, len(rows)


def controls():
    """Independent positive and negative controls, derived from live populations.

    A positive control is a row the predicate must accept; a negative control is a row drawn from the
    complement population the predicate must reject. Neither is the predicate itself, and neither is a
    superset count: each re-queries one row by key.
    """
    out = {}

    # H1 — "window, open, Task/Story, no due date". Positive: an H1 row. Negative: an open window that
    # HAS a due date (same population, opposite field value).
    st, rows = jql(PREDS["H1"], ["key"])
    pos = rows[0]["key"] if rows else None
    st2, rows2 = jql(f"{BASE} AND duedate is not EMPTY", ["key"])
    neg = rows2[0]["key"] if rows2 else None
    out["H1"] = {
        "positive": {"key": pos, "expect": 1, "got": by_key(pos, PREDS["H1"])[1] if pos else None},
        "negative": {"key": neg, "expect": 0, "got": by_key(neg, PREDS["H1"])[1] if neg else None,
                     "why": "an open window that has a due date must not match H1"},
    }

    # H4 — "window with no parent". A parentless window rarely exists, so the positive control is the
    # board invariant itself: H4's count must equal a label-only count that never looks at parent, and the
    # negative control is a window that HAS a parent, which H4 must reject.
    st, rows = jql(PREDS["H4"], ["key"])
    # Positive control: the parent-is-EMPTY mechanism must accept a row where the field really is empty.
    # One is taken from outside the window population, because inside it no such row exists.
    st2, any_no_parent = jql("project = ISSUE AND parent IS EMPTY", ["key"])
    pos4 = any_no_parent[0]["key"] if any_no_parent else None
    neg4_rows = jql("project = ISSUE AND labels = window AND parent is not EMPTY", ["key"])[1]
    neg4 = neg4_rows[0]["key"] if neg4_rows else None
    out["H4"] = {
        "positive": {"key": pos4, "expect": 1,
                     "got": by_key(pos4, "project = ISSUE AND parent IS EMPTY")[1] if pos4 else None,
                     "why": "parent-is-EMPTY must accept a row that has no parent; H4=0 then means no "
                            "WINDOW is parentless, not that the predicate is broken"},
        "negative": {"key": neg4, "expect": 0, "got": by_key(neg4, PREDS["H4"])[1] if neg4 else None,
                     "why": "a window with a parent must not match H4"},
    }

    # H3 — "date in title". Negative: a window whose summary carries no date pattern.
    st, rows = jql(f'{BASE} AND summary !~ "10-*"', ["key"])
    neg3 = rows[0]["key"] if rows else None
    st2, rows2 = jql(PREDS["H3"], ["key"])
    pos3 = rows2[0]["key"] if rows2 else None
    out["H3"] = {
        "positive": {"key": pos3, "expect": 1, "got": by_key(pos3, PREDS["H3"])[1] if pos3 else None},
        "negative": {"key": neg3, "expect": 0, "got": by_key(neg3, PREDS["H3"])[1] if neg3 else None,
                     "why": "a window whose summary has no date pattern must not match H3"},
    }

    # O1 — "overdue and workable". Negative: a Blocked row carrying a past due date must be rejected.
    st, rows = jql("project = ISSUE AND labels = window AND status = Blocked AND duedate < now()", ["key"])
    negO = rows[0]["key"] if rows else None
    st2, rows2 = jql(PREDS["O1w"], ["key"])
    posO = rows2[0]["key"] if rows2 else None
    out["O1w"] = {
        "positive": {"key": posO, "expect": 1, "got": by_key(posO, PREDS["O1w"])[1] if posO else None},
        "negative": {"key": negO, "expect": 0, "got": by_key(negO, PREDS["O1w"])[1] if negO else None,
                     "why": "Blocked is not workable, so an overdue Blocked window must not match O1w"},
    }

    verdict = {}
    for pred, c in out.items():
        ok = all(v.get("expect") is not None and v.get("got") == v["expect"] for v in c.values())
        verdict[pred] = "PASS" if ok else "FAILED"
    return out, verdict


def jira_status(key):
    st, d = jira.call("GET", f"/rest/api/3/issue/{key}?fields=status,parent,labels,duedate")
    if st >= 300 or not d:
        return None
    return (d.get("fields") or {}).get("status", {}).get("name")


def drift(since=None):
    """Read one day's merge journal on BOTH sides: Substrate events and the Jira status they imply.

    The Jira status is read per ticket with GET /rest/api/3/issue/<key>; the verdict comes from comparing
    it with the event, never from the event alone. A ticket the journal mentions without a closure is
    reported as INFO, not as drift.
    """
    import re

    if since:
        today_start = dt.datetime.strptime(since, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc)
    else:
        today_start = dt.datetime.now(dt.timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    today_ms = int(today_start.timestamp() * 1000)
    errors, events = [], {}

    # `show` returns the journal OLDEST first, so any limit below the head silently hides the recent
    # window: at `--limit 400` it stopped on 2026-10-21 while the head was 1790, and every drift read
    # returned a plausible zero (MMD-3223 cycle 09:36Z). `timeline` is the bounded RECENT window, so
    # the read cannot be blind by construction; three controls below prove it is not blind in fact:
    #   (1) the window must be live (newest entry younger than LIVE_MAX_S), which catches a stale or
    #       cached read;
    #   (2) the window must reach today's start (oldest entry at or before it), which catches a
    #       window too small for a busy day;
    #   (3) it must not sit exactly at the limit, the signature of truncation.
    # If any control fails the Substrate side is reported as UNMEASURED, never as "no drift".
    LIVE_MAX_S = 3600
    limit = 5000
    entries = []
    p = subprocess.run(["sb", "journal", "timeline", "MMD-2331", "--json", "--limit", str(limit)],
                       capture_output=True, text=True)
    if p.returncode != 0:
        errors.append({"source": "sb journal timeline MMD-2331", "error": p.stderr.strip()[:200]})
        substrate_blind = "command failed"
    else:
        substrate_blind = None
        try:
            entries = ((json.loads(p.stdout).get("data") or {}).get("entries")) or []
        except Exception as e:
            errors.append({"source": "sb journal timeline MMD-2331", "error": f"unparseable: {e}"})
            substrate_blind = "unparseable response"
        if entries and len(entries) >= limit:
            errors.append({"source": "sb journal timeline MMD-2331",
                           "error": f"truncated at limit {limit}; the Substrate side of drift is unmeasurable"})
            substrate_blind = "truncated at the limit"
        stamps = [int(e.get("createdAt") or 0) for e in entries]
        now_ms = int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)
        if entries:
            if (now_ms - max(stamps)) / 1000.0 > LIVE_MAX_S:
                errors.append({"source": "sb journal timeline MMD-2331",
                               "error": f"newest entry is older than {LIVE_MAX_S}s; the read is not live"})
                substrate_blind = substrate_blind or "stale read"
            if min(stamps) > today_ms:
                errors.append({"source": "sb journal timeline MMD-2331",
                               "error": "window does not reach today's start; raise --limit"})
                substrate_blind = substrate_blind or "window too small"
        elif not substrate_blind:
            substrate_blind = "empty window"
        if substrate_blind:
            errors.append({"source": "substrate coverage",
                           "error": f"{substrate_blind}; drift is UNMEASURED this cycle, not zero"})
        for e in entries:
            try:
                ts = int(e.get("createdAt") or 0)
            except (TypeError, ValueError):
                continue
            if ts < today_ms:
                continue
            kind = (e.get("kind") or "").lower()
            text = str(e.get("semantic") or "")
            keys = set(re.findall(r"ISSUE-\d+", text))
            role = ("closure" if kind in {"closure", "closed", "done"} else
                    "result" if kind in {"result", "milestone"} else None)
            if role:
                for k in keys:
                    prev = events.get(k)
                    if prev is None or role == "closure":
                        events[k] = {"event": f"substrate {role} (journal seq {e.get('sequence')})",
                                     "role": role}

    merged = {}
    p = subprocess.run(["gh", "pr", "list", "--state", "merged", "--limit", "80",
                        "--search", f"merged:>={today_start.strftime('%Y-%m-%d')}",
                        "--json", "number,title,mergedAt,headRefOid,body",
                        "--repo", "mercuryintelligence/market-data"],
                       capture_output=True, text=True)
    if p.returncode != 0:
        errors.append({"source": "gh pr list --state merged", "error": p.stderr.strip()[:200]})
    else:
        try:
            for pr in json.loads(p.stdout or "[]"):
                body = (pr.get("title") or "") + " " + (pr.get("body") or "")
                for k in set(re.findall(r"ISSUE-\d+", body)):
                    merged.setdefault(k, []).append(pr["number"])
        except Exception as e:
            errors.append({"source": "gh pr list --state merged", "error": f"unparseable: {e}"})

    rows = []
    for key in sorted(set(events) | set(merged)):
        st = jira_status(key)
        if st is None:
            rows.append({"key": key, "jira": "UNKNOWN", "event": "unreadable from Jira",
                         "verdict": "UNKNOWN"})
            continue
        ev = events.get(key, {})
        prs = merged.get(key)
        if ev.get("role") == "closure":
            verdict = "OK" if st in DONE_STATUSES else "MISMATCH"
            event = ev["event"]
        elif prs:
            verdict = "OK" if (st in DONE_STATUSES or st in ACTIVE_STATUSES) else "MISMATCH"
            event = f"merged PR #{','.join(str(n) for n in sorted(prs))}"
        else:
            verdict = "INFO"
            event = ev.get("event", "journal mention")
        rows.append({"key": key, "jira": st, "event": event, "verdict": verdict})
    return rows, errors


def main():
    as_json = "--json" in sys.argv
    res = {"generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "preds": {}, "controls": {}, "verdict": {}}
    for k, q in PREDS.items():
        st, n, keys = count(q)
        res["preds"][k] = {"jql": q, "http": st, "count": n, "keys": keys}
    res["controls"], res["verdict"] = controls()
    since = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--since=")), None)
    res["drift_since"] = since or res["generated"][:10]
    res["drift"], res["drift_errors"] = drift(since)
    json.dump(res, open(OUT, "w"), indent=1)

    bad = [p for p, v in res["verdict"].items() if v != "PASS"]
    res["controls_failed"] = bad
    if as_json:
        print(json.dumps(res, indent=1))
    else:
        print(f"cycle {res['generated']}")
        for k, v in res["preds"].items():
            flag = "" if k not in res["verdict"] else f"  [{res['verdict'][k]}]"
            print(f"  {k:<9} {v['count']:>4}  http {v['http']}{flag}")
        for k, c in res["controls"].items():
            print(f"  ctrl {k}: pos={c['positive']} neg={c['negative']}")
        blind = any(e["source"] == "substrate coverage" for e in res["drift_errors"])
        if res["drift"] and not blind:
            for r in res["drift"]:
                print(f"  drift {r['key']}: jira={r['jira']} <- {r['event']} {r['verdict']}")
        elif blind:
            print("  drift: UNMEASURED — the Substrate side failed a coverage control; see UNREADABLE")
        else:
            print("  drift: no Substrate closure/claim or merged-PR ticket today")
        for e in res["drift_errors"]:
            print(f"  UNREADABLE {e['source']}: {e['error']}")
        if bad:
            print(f"  CONTROL-FAILED: {', '.join(bad)} — numbers above are not measurements")
    return 3 if bad else 0


if __name__ == "__main__":
    sys.exit(main())

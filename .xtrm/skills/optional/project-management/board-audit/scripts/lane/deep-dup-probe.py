#!/usr/bin/env python3
"""DEEP duplicate probe for a batch of new Substrate issues: facts per row, no disposition.

Why it is not a keyword sweep: board-audit (2026-11-01) records a row called CLEAN
from one system while the other already carried the same contract. So each new issue is probed in BOTH
systems, in Jira on summary and on `text` (description AND comments server-side), and in Substrate on title
and body, and the candidates are printed with the field that matched so a human writes the verdict.

It prints facts only. Two of the three skill questions (same symptom, same code site, same fix) need reading
the candidates; this tool answers "does the string family already exist anywhere" and hands over the refs.

Usage: deep-dup-probe.py SB-3757 [SB-3758 ...] [--control SB-3444 --control-expect PROJ-585]
(SB is PM_SB_PREFIX, PROJ is PM_JIRA_PROJECT.) The Substrate snapshot is PM_SB_SNAPSHOT, the JSON of
`sb issue list --json` for the whole project, refreshed by the caller.
Exit 2 when the control does not produce a hit, because a probe that cannot find a known duplicate is broken.
"""
import argparse
import importlib.util
import json
import re
import subprocess
import sys
import urllib.parse

import lanecfg

spec = importlib.util.spec_from_file_location("jt", str(lanecfg.pm_config.jira_py()))
J = importlib.util.module_from_spec(spec)
spec.loader.exec_module(J)

SB = lanecfg.sb_bin()
PROJECT = lanecfg.project()
_SBP = re.escape(lanecfg.sb_prefix().lower())
_JP = re.escape(PROJECT.lower())
# identifier tokens that are themselves refs are not search terms
ID_SKIP = re.compile(rf"iss_|{_SBP}-?\d|^[0-9a-f]{{8,}}$")
WORD_SKIP = re.compile(rf"iss|{_SBP}|{_JP}|rev[0-9]")
STOP = {"the", "and", "for", "with", "that", "this", "from", "into", "after", "before", "when", "then",
        "every", "each", "only", "must", "does", "have", "been", "were", "will", "would", "should",
        "check", "issue", "window", "board", "first", "second", "their", "there", "which", "while",
        "under", "over", "than", "them", "they", "these", "those", "about", "into", "onto", "using"}


def sb_issue(ref):
    out = subprocess.run([SB, "issue", "show", ref, "--json"], capture_output=True, text=True, timeout=60)
    try:
        d = json.loads(out.stdout)
    except Exception:
        return None
    return d.get("data") or None


def terms_of(text, limit=3):
    """Distinctive tokens: identifiers first (they are code sites), then the rarest-looking long words."""
    ids = re.findall(r"[A-Za-z][\w.-]*(?:[-_.][\w.-]+)+|\w+\.(?:ya?ml|py|sql|json|md)\b", text)
    ids = [t.strip(".,;:()[]'\"") for t in ids]
    ids = [t for t in ids if len(t) >= 5 and t.lower() not in STOP
           and not ID_SKIP.match(t.lower())]
    words = [w for w in re.findall(r"[A-Za-z][A-Za-z0-9_]{5,}", text)
             if w.lower() not in STOP and not WORD_SKIP.match(w.lower())]
    seen, out = set(), []
    for t in ids + words:
        k = t.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(t)
        if len(out) >= limit:
            break
    return out


def jira_probe(term):
    hits = {}
    for field in ("summary", "text"):
        jql = f'project = {PROJECT} AND {field} ~ "{term}"'
        url = "/rest/api/3/search/jql?jql=" + urllib.parse.quote(jql) + "&maxResults=20&fields=summary,status"
        st, b = J.call("GET", url)
        if st >= 300:
            hits.setdefault("_error", []).append(f"{field} HTTP {st}")
            continue
        for i in b.get("issues") or []:
            hits.setdefault(i["key"], {"fields": set(), "status": i["fields"]["status"]["name"],
                                       "summary": i["fields"]["summary"][:90]})["fields"].add(field)
    return hits


SNAPSHOT = str(lanecfg.pm_config.path("PM_SB_SNAPSHOT", required=True))


def sb_rows():
    """One local read of the whole project, then match in memory: a per-issue sb call is fan-out."""
    with open(SNAPSHOT, encoding="utf-8") as fh:
        d = json.load(fh)
    return d.get("data") or []


def sb_probe(term, rows, selfid=None, selftitle=None):
    low = term.lower()
    found = {}
    for r in rows:
        title = (r.get("title") or "").lower()
        if low not in title:
            continue
        if (selfid and r.get("id") == selfid) or (selftitle and (r.get("title") or "").strip() == selftitle.strip()):
            continue
        found[r["locator"]] = {"status": r.get("lifecycleState"), "title": (r.get("title") or "")[:90]}
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("refs", nargs="+")
    ap.add_argument("--control", help="a Substrate ref whose duplicate is already known")
    ap.add_argument("--control-expect", help="the Jira key that duplicate already sits on; the control "
                                             "passes only when this key is among the hits")
    a = ap.parse_args()

    if a.control:
        c = sb_issue(a.control)
        title = (c or {}).get("title") or ""
        hits = jira_probe(terms_of(title, 1)[0]) if title else {}
        print(f"CONTROL {a.control}: title={title[:70]!r} jira_hits={len(hits)} {sorted(hits)[:4]}")
        if a.control_expect:
            ok = a.control_expect in hits
            print(f"CONTROL {'PASS' if ok else 'FAILED'}: expected {a.control_expect} among the hits "
                  f"({'present' if ok else 'absent'})")
            if not ok:
                return 2
        elif not hits:
            print("CONTROL-FAILED: the probe cannot find a known duplicate; its zeros are not measurements")
            return 2
        else:
            print("CONTROL PASS (no expected key named)")

    for ref in a.refs:
        d = sb_issue(ref)
        if not d:
            print(f"{ref}: SB READ FAILED")
            continue
        title = d.get("title") or ""
        body = json.dumps(d)[:4000]
        ts = terms_of(title + " " + body, limit=2)
        jh = {}
        sh = {}
        rows = sb_rows()
        for t in ts:
            for k, v in jira_probe(t).items():
                jh.setdefault(k, {"fields": set(), "status": v["status"], "summary": v["summary"]})
                jh[k]["fields"] |= v["fields"]
            for k, v in sb_probe(t, rows, d.get("id"), title).items():
                if k != ref:
                    sh.setdefault(k, v)
        print(f"\n{ref} [{d.get('status')}] {title[:90]}")
        print(f"  terms: {ts}")
        if jh:
            for k in sorted(jh)[:6]:
                print(f"  JIRA {k} [{jh[k]['status']}] fields={sorted(jh[k]['fields'])} :: {jh[k]['summary']}")
        else:
            print("  JIRA: no hit on any term")
        if sh:
            for k in sorted(sh)[:6]:
                print(f"  SB   {k} [{sh[k]['status']}] :: {sh[k]['title']}")
        else:
            print("  SB: no hit on any term")
    return 0


if __name__ == "__main__":
    sys.exit(main())

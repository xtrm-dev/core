#!/usr/bin/env python3
"""Duplicate-probe that reads EVERY field, not just the summary (board-audit, 2026-10-29 lesson: a path
inside an ADF inline link was invisible to a flattener that read only `text` nodes, and a lane reported
"no artefact path stored" on a row that carried it in the description).

Searches the Jira project (PM_JIRA_PROJECT), open and recently closed, in four places and prints a per-field count plus the
keys, so a zero can be read as a measurement rather than as a broken probe:
  1. summary            JQL `summary ~ "<term>"`
  2. description+text   JQL `text ~ "<term>"` (covers description and comments on the server side)
  3. client-side scan   every ADF node of the description and the comments: text, mention text, inlineCard
                        url, media url, and link marks (href) - the case that produced the false zero
  4. v2 wiki render     GET /rest/api/3/issue/<key>?fields=description&expand=renderedBody (or the v2
                        endpoint) as a second renderer, only for the candidate rows
Then it applies the three questions of the skill: same symptom, same code site, same fix - it does NOT
decide them, it prints the evidence per candidate so the verdict is written from facts.

Usage: dup-probe.py "<term>" ["<term>" ...] [--control <Jira-key>]
Exit: 0 = probe ran and at least one control passed, 2 = a control failed (do not trust the zeros).
"""
import argparse
import importlib.util
import json
import re
import sys

import lanecfg

spec = importlib.util.spec_from_file_location("jt", str(lanecfg.pm_config.jira_py()))
J = importlib.util.module_from_spec(spec)
spec.loader.exec_module(J)
PROJECT = lanecfg.project()


def adf_strings(node, out):
    if isinstance(node, list):
        for n in node:
            adf_strings(n, out)
        return
    if not isinstance(node, dict):
        return
    t = node.get("type")
    attrs = node.get("attrs") or {}
    if t in ("text", "mention"):
        out.append(str(attrs.get("text") or node.get("text") or ""))
    for k in ("url", "href"):
        if attrs.get(k):
            out.append(str(attrs[k]))
    for m in node.get("marks") or []:
        if (m.get("attrs") or {}).get("href"):
            out.append(str(m["attrs"]["href"]))
    for c in node.get("content") or []:
        adf_strings(c, out)


def jql(query, fields=("key", "summary", "status")):
    rows, token = [], None
    while True:
        body = {"jql": query + " ORDER BY updated DESC", "maxResults": 100, "fields": list(fields)}
        if token:
            body["nextPageToken"] = token
        st, d = J.call("POST", "/rest/api/3/search/jql", body)
        if st != 200:
            print(f"  probe error HTTP {st}: {str(d)[:160]}")
            return rows
        rows += d.get("issues") or []
        token = d.get("nextPageToken")
        if d.get("isLast") or not token:
            return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("terms", nargs="+")
    ap.add_argument("--control", default=None, help="a key known to contain the term; the probe must find it")
    a = ap.parse_args()
    ok = True
    for term in a.terms:
        print(f"\n=== term {term!r}")
        wide = jql(f'project = {PROJECT} AND (summary ~ "{term}" OR text ~ "{term}")')
        summ = jql(f'project = {PROJECT} AND summary ~ "{term}"')
        print(f"  summary-only hits: {len(summ)} -> {[r['key'] for r in summ][:12]}")
        print(f"  summary-or-text hits: {len(wide)} -> {[r['key'] for r in wide][:12]}")
        low = term.lower()
        hits = []
        for r in wide:
            k = r["key"]
            st, d = J.call("GET", f"/rest/api/3/issue/{k}?fields=description,comment,summary&expand=renderedFields")
            if st != 200:
                continue
            f = d["fields"]
            strings = []
            adf_strings(f.get("description") or {}, strings)
            for c in (f.get("comment") or {}).get("comments") or []:
                adf_strings(c.get("body") or {}, strings)
            rendered = json.dumps(d.get("renderedFields") or {})
            where = []
            if low in (f.get("summary") or "").lower():
                where.append("summary")
            if any(low in s.lower() for s in strings):
                where.append("description/comments/links")
            if low in rendered.lower():
                where.append("v2-render")
            hits.append((k, where, (f.get("summary") or "")[:70]))
        for k, where, summary in hits:
            print(f"  - {k} fields={','.join(where) or 'NONE'} | {summary}")
        if not hits:
            print("  no candidate rows: the wide query itself returned nothing (probe ran, board says none)")
        if a.control:
            ck = a.control
            st, d = J.call("GET", f"/rest/api/3/issue/{ck}?fields=description,comment,summary")
            strings = []
            if st == 200:
                adf_strings(d["fields"].get("description") or {}, strings)
                for c in (d["fields"].get("comment") or {}).get("comments") or []:
                    adf_strings(c.get("body") or {}, strings)
                found = low in " ".join(strings).lower() or low in (d["fields"].get("summary") or "").lower()
                print(f"  control {ck}: term found = {found} (must be True for a zero to mean anything)")
                ok = ok and found
            else:
                print(f"  control {ck}: unreadable HTTP {st}")
                ok = False
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Waiting Production audit, 60-minute cadence, read-only: reports, never transitions.

Method: board-audit/references/waiting-production-audit.md rev 5.
A row is Waiting Production when every build vehicle it needs is merged and nothing its own step
consumes is unrun. "Not live" is measured against the RUNNING image SHA per container
(`make deploy-status`), never against origin/stable - a merge on stable says nothing about what runs.

Classes this instrument reports for every row currently reading Waiting Production:
  OPEN-PR        an open (incl. draft) PR binds the row: its own step is not the only thing left
  NO-VEHICLE     no merged PR binds the row: the status is a claim, not a measurement
  UNMEASURABLE   the vehicles scope to no running image (docs/tests/migrate/rust): absence of
                 evidence, not absence of work
  LIVE           every scoped container already contains the merge: the row is not Waiting Production
  PENDING        merged, not live on at least one scoped container: correctly Waiting Production,
                 with the per-container comparison printed
Each row also prints its unrun inward Blocks links, so a coordinator can apply the "consumes the
output" test without another read.

Controls, from the same artefact, printed every run: a known merged binding must resolve (config key
wp_known_binding), both ancestry poles are derived from the running images, and the reference rows
(config key wp_reference_keys) are re-classed and printed. A control that disagrees exits 2 and the
caller shouts. The path -> container map is config key container_paths.
"""
import importlib.util
import json
import os
import re
import subprocess
import sys

import lanecfg

LANE = lanecfg.lane()
REPO = lanecfg.repo()
PROJECT = lanecfg.project()
SB_PREFIX = lanecfg.sb_prefix()
WAITING = lanecfg.statuses()["waiting_production"]
CYCLE = str(lanecfg.SCRIPTS / "cycle" / "cycle.py")
SCOPE_CACHE = f"{LANE}/wp-scope-cache.json"
SNAP = f"{LANE}/deploy-snapshot.json"

_spec = importlib.util.spec_from_file_location("boardcycle", CYCLE)
C = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(C)

FIELDS = ["key", "summary", "status", "labels", "issuelinks", "duedate", "parent", "description"]
BINDING = re.compile(r"Jira binding:\s*(" + lanecfg.jira_key_re() + ")", re.I)
ISSUE_REF = re.compile(lanecfg.jira_key_re(group=True))
# A PR number in a row summary: "#123" or "<repo>#123" for the delivery repo and any gate repo.
_REPOS = [lanecfg.repo_name()] + list(lanecfg.data("PM_GATE_REPOS", {}))
PR_IN_TEXT = re.compile(r"(?:" + "|".join(re.escape(r) for r in _REPOS) + r")?#(\d{1,4})\b")

# Fail-closed control (coordinator rule 2026-11-10): a known merged binding must resolve or every
# verdict is UNKNOWN. The configured PR (wp_known_binding = [jira-key, pr-number]) is MERGED and declares
# "Jira binding: <key>" in its body, so a complete index always places it under that key. When it
# does not, the index is partial and a NO-VEHICLE verdict is a rendering artefact, not a measurement:
# on 2026-11-10 two runs produced exactly that on three rows.
# Coordinator ruling 2026-11-10 (after both poles were shown): the block on acting from a NO-VEHICLE
# verdict is lifted, with one condition - a status change driven by NO-VEHICLE still goes to the
# coordinator as a PROPOSAL first. This instrument never transitions a row; it only reports.
KNOWN_BINDING = tuple(lanecfg.data("PM_WP_KNOWN_BINDING", required=True))
REFERENCE_KEYS = list(lanecfg.data("PM_WP_REFERENCE_KEYS", []))
CONTROL = {"ok": None, "line": ""}

DOC_ONLY = re.compile(r"^(docs/|tests/|examples/|\.github/|Makefile|docker-compose\.ya?ml|.*\.md$)")
MIGRATIONS = re.compile(r"^(alembic/|alembic\.ini|config/|requirements[^/]*\.txt$)")
# Ordered rules, first match wins: {"prefixes": [...], "match": optional regex, "containers": [...]}
CONTAINER_PATHS = lanecfg.data("PM_CONTAINER_PATHS", required=True)


def containers_for(paths):
    """Path -> container set (rev 5 mapping, from config key container_paths)."""
    out = set()
    for p in paths:
        if DOC_ONLY.match(p) or MIGRATIONS.match(p):
            continue
        for rule in CONTAINER_PATHS:
            if not p.startswith(tuple(rule["prefixes"])):
                continue
            if rule.get("match") and not re.search(rule["match"], p):
                continue
            out |= set(rule["containers"])
            break
    return out


def deploy():
    """Running image SHAs. Falls back to a live `make deploy-status` when no snapshot exists, so an
    empty map can never masquerade as 'nothing is running' (the failure that made 19 rows UNMEASURABLE
    on the first run of this instrument)."""
    try:
        return json.load(open(SNAP))["containers"]
    except (OSError, ValueError, KeyError):
        pass
    spec = importlib.util.spec_from_file_location("deploycheck", str(lanecfg.SCRIPTS / "deploy-check.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.snapshot() or {}


def scope(sha):
    cache = {}
    try:
        cache = json.load(open(SCOPE_CACHE))
    except (OSError, ValueError):
        pass
    if sha in cache:
        return cache[sha]
    p = subprocess.run(["git", "show", "--name-only", "--format=", sha], cwd=REPO,
                       capture_output=True, text=True, timeout=60)
    files = [l.strip() for l in p.stdout.splitlines() if l.strip()] if p.returncode == 0 else []
    cache[sha] = files
    json.dump(cache, open(SCOPE_CACHE, "w"), indent=0)
    return files


def ancestry(merge, running):
    """(True|False|None) - is <merge> in <running>? None when a commit is absent locally: unknown, not no."""
    for sha in (merge, running):
        if subprocess.run(["git", "cat-file", "-e", f"{sha}^{{commit}}"], cwd=REPO,
                          capture_output=True).returncode != 0:
            return None
    return subprocess.run(["git", "merge-base", "--is-ancestor", merge, running], cwd=REPO,
                          capture_output=True).returncode == 0


def pr_keys(pr):
    keys = []
    m = BINDING.search(pr.get("body") or "")
    if m:
        keys.append(m.group(1).upper())
    text = (pr.get("title") or "") + " " + (pr.get("headRefName") or "")
    keys += [f"{PROJECT}-{n}" for n in dict.fromkeys(ISSUE_REF.findall(text))]
    return list(dict.fromkeys(keys))


MMD_REF = re.compile(re.escape(SB_PREFIX) + r"[-_ ]?(\d{4,})", re.I)


def substrate_refs(row):
    refs = [x.split(":", 1)[1] for x in (row.get("labels") or []) if x.startswith(f"substrate:{SB_PREFIX}-")]
    refs += [f"{SB_PREFIX}-" + n for n in MMD_REF.findall(row.get("summary") or "")]
    return list(dict.fromkeys(refs))


def fetch_pr(num):
    """Read a single PR by number (gh pr view N), so a bound PR that has aged out of the 500-row
    merged list is still resolved. Returns the PR dict or None."""
    fields = "number,title,body,mergeCommit,mergedAt,headRefName,isDraft,state,files"
    out = C.gh(["pr", "view", str(num), "--json", fields])
    return out if isinstance(out, dict) else None


def load_prs():
    """500 merged PRs reach back to 2026-09-06, well past the 2026-10-06 project cut-off. The window is
    a window: its read time is printed with the audit. Bound PRs (KNOWN_BINDING and any named in rows) are
    also fetched by number, because the fixed-size list can age them out (2026-11-10)."""
    fields = "number,title,body,mergeCommit,mergedAt,headRefName,isDraft,state,files"
    merged = C.gh(["pr", "list", "--state", "merged", "--limit", "500", "--json", fields])
    opens = C.gh(["pr", "list", "--state", "open", "--limit", "200", "--json", fields])
    merged = (merged if isinstance(merged, list) else [])
    opens = (opens if isinstance(opens, list) else [])
    # fetch the known binding PR by number so the control never depends on list size
    kb = fetch_pr(KNOWN_BINDING[1])
    if kb is not None and kb.get("number") not in {p.get("number") for p in merged}:
        merged.append(kb)
    return merged, opens


def index(prs):
    """(Jira index, Substrate index). The Jira index is strict - only the declared `Jira binding:` line or a
    title/branch key, never body prose (rev 5). The Substrate index is a second tier for rows bound through a
    `substrate:SB-n` label, which cycle.py's ladder also honours; it is printed separately so a
    body-mention binding is never confused with a declared one."""
    idx, mdx = {}, {}
    for p in prs:
        for k in pr_keys(p):
            idx.setdefault(k, []).append(p)
        blob = " ".join((p.get("title") or "", p.get("body") or "", p.get("headRefName") or ""))
        for n in dict.fromkeys(MMD_REF.findall(blob)):
            mdx.setdefault(f"{SB_PREFIX}-{n}", []).append(p)
    return idx, mdx, prs


def verdicts(key, merged_idx, open_idx, dep, refs=(), named=()):
    """(class, detail lines) for one row.

    A vehicle is a DECLARED binding only: the `Jira binding:` line, the key in the PR title or branch, or
    a PR number the row's own text names. Body prose mentioning a `substrate:SB-n` ref is a reference,
    not a vehicle (rev 5 correction: 16 of 22 rows flip under a mention-counts reading), so those PRs are
    printed as an advisory hint and never decide a class."""
    merged = list(merged_idx[0].get(key, []))
    opens = list(open_idx[0].get(key, []))
    bynum_m = {p["number"]: p for p in merged_idx[2]}
    bynum_o = {p["number"]: p for p in open_idx[2]}
    for n in named:
        if n in bynum_m and bynum_m[n] not in merged:
            merged.append(bynum_m[n])
        if n in bynum_o and bynum_o[n] not in opens:
            opens.append(bynum_o[n])
    detail = []
    hint = [p["number"] for ref in refs for p in merged_idx[1].get(ref, [])]
    if hint:
        detail.append(f"{SB_PREFIX} prose mentions (not bindings): " + ", ".join(f"#{n}" for n in sorted(set(hint))))
    if opens:
        detail.append("open PR(s): " + ", ".join(f"#{p['number']}({p['state']})" for p in opens))
    if not merged:
        return "NO-VEHICLE", detail + ["no merged PR binds this key"]
    conts = set()
    for p in merged:
        sha = (p.get("mergeCommit") or {}).get("oid")
        if not sha:
            detail.append(f"#{p['number']}: no merge commit (squash/rebase): unmeasurable")
            continue
        conts |= containers_for(scope(sha))
        detail.append(f"#{p['number']} merge {sha[:10]} scopes {sorted(containers_for(scope(sha))) or 'nothing'}")
    if not conts:
        return ("OPEN-PR" if opens else "UNMEASURABLE"), detail
    live, pending, unknown = [], [], []
    for c in sorted(conts):
        running = (dep.get(c) or {}).get("sha", "absent")
        if running == "absent":
            unknown.append(f"{c}: not running")
            continue
        if running == "unknown":
            unknown.append(f"{c}: no git SHA in the tag")
            continue
        r = None
        for p in merged:
            sha = (p.get("mergeCommit") or {}).get("oid")
            if not sha:
                continue
            if containers_for(scope(sha)) >= {c}:
                a = ancestry(sha, running)
                if a is True:
                    r = True
                    break
                if a is None:
                    r = None
                elif r is None:
                    r = False
        (live if r is True else unknown if r is None else pending).append(f"{c}@{running}")
    detail.append(f"live: {live or '-'} | not live: {pending or '-'} | unknown: {unknown or '-'}")
    if opens:
        return "OPEN-PR", detail
    if pending:
        return "PENDING", detail
    if live and not unknown:
        return "LIVE", detail
    return "UNMEASURABLE", detail


def unrun_blocks(row):
    out = []
    for l in row.get("issuelinks") or []:
        t = (l.get("type") or {}).get("name", "")
        inward = l.get("inwardIssue")
        if not inward or t.lower() != "blocks":
            continue
        st = (inward.get("fields") or {}).get("status") or {}
        cat = (st.get("statusCategory") or {}).get("key")
        if cat != "done":
            out.append(f"{inward['key']} ({st.get('name')})")
    return out


def binding_control(merged, midx):
    """Fail closed: the known merged binding must resolve, and its PR must be inside the PR window.

    Returns (ok, line). ok is False when the PR is missing from the window or the index does not place it
    under its declared key - both mean the run cannot distinguish "no vehicle" from "index incomplete".
    """
    key, num = KNOWN_BINDING
    present = any(p.get("number") == num for p in merged)
    under = [p for p in midx[0].get(key, []) if p.get("number") == num]
    ok = present and bool(under)
    why = ("PR #%d absent from the merged window" % num) if not present else (
        "#%d present but not indexed under %s" % (num, key) if not under else "resolved")
    return ok, "- bound control #%d -> %s: %s" % (num, key, why.upper() if not ok else "RESOLVED")


def audit(keys=None):
    merged, opens = load_prs()
    midx, oidx = index(merged), index(opens)  # (issue index, mmd index) each
    dep = deploy()
    q = f"project = {PROJECT} AND statusCategory != Done"
    if keys:
        q = "key in (%s)" % ", ".join(keys)
    rows, complete = C.jql(q, fields=FIELDS)
    if not complete:
        print("WP-AUDIT-INCOMPLETE jql did not finish: population unknown, refuse to report")
        return None
    CONTROL["ok"], CONTROL["line"] = binding_control(merged, midx)
    pop = []
    all_named = set()
    for i in rows:
        r = C.row_of(i)
        if keys or r["status"] == WAITING:
            r["blocks"] = unrun_blocks(i)
            r["refs"] = substrate_refs(i["fields"])
            r["named_prs"] = sorted({int(n) for n in PR_IN_TEXT.findall(r["summary"])})
            all_named |= set(r["named_prs"])
            pop.append(r)
    # fetch named PRs by number so they are not lost to the 500-row list limit
    merged_nums = {p.get("number") for p in merged}
    for n in all_named:
        if n not in merged_nums:
            p = fetch_pr(n)
            if p is not None:
                merged.append(p)
                merged_nums.add(n)
    midx, oidx = index(merged), index(opens)
    CONTROL["ok"], CONTROL["line"] = binding_control(merged, midx)
    res = []
    for r in pop:
        if CONTROL["ok"] is not True:
            cls, detail = "UNKNOWN", [f"control failed (#{KNOWN_BINDING[1]} -> {KNOWN_BINDING[0]} did not resolve): "
                                      "the binding index is incomplete, so no row can be classed"]
        else:
            cls, detail = verdicts(r["key"], midx, oidx, dep, r["refs"], r["named_prs"])
        res.append({"key": r["key"], "summary": r["summary"], "status": r["status"],
                    "cls": cls, "detail": detail, "blocks": r["blocks"]})
    return res, dep, len(rows), merged


def controls(dep, merged):
    """Two poles from the live artefact, so a moved image can never silently invert the instrument.

    positive: ancestry(running, running) must be True for every container with a known SHA (the primitive
    answers yes to a case whose answer is known).
    negative: the newest PR merged AFTER a container started, scoped to that container, must NOT be in its
    running image - an image cannot contain a merge that happened after it started. A True here means the
    SHA comparison is wrong (wrong container, wrong SHA, or an inverted return).
    """
    lines, bad = [], []
    for c, v in sorted(dep.items()):
        sha = v.get("sha")
        if not sha or sha in ("unknown", "absent"):
            continue
        a = ancestry(sha, sha)
        if a is not True:
            bad.append(f"{c}: reflexivity ancestry({sha[:10]},{sha[:10]})={a}, expected True")
        lines.append(f"- {c} positive pole: ancestry({sha[:10]},{sha[:10]})={a}")
    for c, v in sorted(dep.items()):
        sha, started = v.get("sha"), v.get("started")
        if not sha or sha in ("unknown", "absent") or not started:
            continue
        after = [p for p in merged if (p.get("mergedAt") or "") > started
                 and containers_for(scope((p.get("mergeCommit") or {}).get("oid", ""))) & {c}]
        if not after:
            continue
        p = max(after, key=lambda x: x["mergedAt"])
        a = ancestry((p.get("mergeCommit") or {}).get("oid"), sha)
        ok = a is False
        lines.append(f"- {c} negative pole: #{p['number']} merged {p['mergedAt']} after start, "
                     f"ancestry={a} — {'OK' if ok else 'FAIL'}")
        if not ok:
            bad.append(f"{c}: #{p['number']} merged after start reads ancestry={a}, expected False")
    return lines, bad


def vehicle_labels(keys):
    """key -> labels for the audited rows. A label read is the only honest way to ask whether a row
    declares the vehicle its status claims."""
    out = {}
    for k in keys:
        st, d = C.jira.call("GET", f"/rest/api/3/issue/{k}?fields=labels")
        out[k] = list((d["fields"].get("labels") or [])) if st == 200 else []
    return out


def main():
    out = audit()
    if out is None:
        return 1
    res, dep, total, merged = out
    by = {}
    for r in res:
        by.setdefault(r["cls"], []).append(r)
    lines = [f"# Waiting Production audit {C.stamp()} — read-only, rev 5",
             "",
             f"population: {total} open {PROJECT} rows; audited {len(res)} rows reading Waiting Production",
             "", "## Verdicts", ""]
    for cls in ("UNKNOWN", "LIVE", "OPEN-PR", "NO-VEHICLE", "UNMEASURABLE", "PENDING"):
        rows = by.get(cls, [])
        if not rows:
            continue
        lines.append(f"### {cls} — {len(rows)}")
        for r in rows:
            blocks = f" | unrun blocks: {', '.join(r['blocks'])}" if r["blocks"] else ""
            lines.append(f"- {r['key']} | {r['summary'][:80]}{blocks}")
            for d in r["detail"]:
                lines.append(f"  - {d}")
        lines.append("")
    # B291: a Waiting Production row whose vehicle is known must say so in a label, otherwise the class
    # stays a reading exercise. A WP row with no vehicle label is a finding to report each audit.
    lab = vehicle_labels([r["key"] for r in res])
    no_lab = [k for k, ls in lab.items() if not any(x.startswith("vehicle:PR-") for x in ls)]
    lines += ["", f"## Vehicle labels (B291 check) - {len(no_lab)} of {len(res)} WP rows carry none", ""]
    for r in res:
        ls = [x for x in lab.get(r["key"], []) if x.startswith("vehicle:PR-")]
        lines.append(f"- {r['key']} [{r['cls']}] vehicles: {', '.join(ls) if ls else 'NONE - finding'}")
    lines += ["", "## Containers (running image SHA)", ""]
    for name, v in sorted(dep.items()):
        if v.get("sha") not in ("absent", "unknown"):
            lines.append(f"- {name} {v['sha']} since {v['started']}")
    ctrl_lines, bad = controls(dep, merged)
    lines += ["", "## Controls (self-calibrating: both poles derived from the live artefact)", ""]
    lines += [CONTROL["line"]]
    lines += ctrl_lines
    lines += ["", "Reference rows (config key wp_reference_keys) - class now, with the image that decided it. "
              "No pass/fail: their expected verdict moves when the running images move, so a merge once "
              "outside an image may be inside it now."]
    ref = audit(REFERENCE_KEYS) if REFERENCE_KEYS else None
    for r in (ref[0] if ref else []):
        lines.append(f"- {r['key']}: {r['cls']} - {r['detail'][-1]}")
    lines += ["", "A row whose PR carries no `Jira binding:` line is not usable as a control: a "
              "binding-strict index cannot see it by construction. Known limit, recorded not hidden."]
    stamp = C.stamp()
    path = f"{LANE}/WP-AUDIT-{stamp[11:16].replace(':', '')}Z.md"
    open(path, "w").write("\n".join(lines) + "\n")
    counts = {k: len(v) for k, v in by.items()}
    counts["no_vehicle_label"] = len(no_lab)
    # An hourly pass that reports the same classes is a state, not an event. Print the counts line only
    # when the population actually moved (or when a class that must never be quiet - LIVE/OPEN-PR - is
    # non-empty), so an unchanged board does not wake the coordinator every hour. The file is always written.
    classes = ("UNKNOWN", "LIVE", "OPEN-PR", "NO-VEHICLE", "UNMEASURABLE", "PENDING")
    sig = " ".join(f"{k}={counts.get(k, 0)}" for k in classes) + f" novh={counts.get('no_vehicle_label', 0)}"
    state_path = f"{LANE}/wp-last-classes.txt"
    prev = open(state_path).read().strip() if os.path.exists(state_path) else ""
    changed = sig != prev
    if changed or counts.get("LIVE") or counts.get("OPEN-PR"):
        print(f"WP-AUDIT {stamp} {sig}")
    print(f"WP-AUDIT-FILE {path}")
    if changed:
        open(state_path, "w").write(sig)
    if CONTROL["ok"] is not True:
        print(f"WP-AUDIT-CONTROL-FAILED {stamp} {CONTROL['line']} — every row UNKNOWN, exit 2")
        print(f"WP-AUDIT-FILE {path}")
        return 2
    live = by.get("LIVE", []) + by.get("OPEN-PR", [])
    if live:
        print("WP-AUDIT-ACTION " + ", ".join(r["key"] for r in live))
    if bad:
        print("WP-AUDIT-CONTROL-FAILED " + "; ".join(bad))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Pre-window lineage check (project-management rule 41).

Usage: window-lineage.py [--repo DIR] (--service KEY | --paths P [P ...]) [--vehicle SHA] [--term WORD ...] [--project ID]

Defaults come from pm_config (references/setup.md): --repo is PM_REPO_DIR, --project is PM_SB_PROJECT_ID (the
Substrate project id, default prj_<PM_SB_PREFIX in lower case>), and --service reads .xtrm/skills/<PM_REPO_NAME>/service-knowledge/service-registry.json.

Prints, for the paths a window changes in production:
  1. the vehicle and whether it is on origin/stable;
  2. commits on origin/master, not on origin/stable, that touch the paths (newer merged work the window would NOT carry);
  3. open PRs whose files touch the paths, with base branch and head (work that could stack or conflict);
  4. open Substrate issues matching the terms (planned work on the same service).
Read-only. Planned Jira windows for the same service come from the board helper (not read here).
"""
import argparse
import json
import subprocess
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pm_config  # noqa: E402


def run(cmd, cwd):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return r.returncode, r.stdout.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=None, help="repo checkout (default PM_REPO_DIR)")
    ap.add_argument("--paths", nargs="*", default=[])
    ap.add_argument("--service", help="service-registry.json key; adds its territory to --paths")
    ap.add_argument("--vehicle")
    ap.add_argument("--term", nargs="*", default=[])
    ap.add_argument("--project", default=None, help="Substrate project id (default PM_SB_PROJECT_ID)")
    a = ap.parse_args()
    a.repo = a.repo or str(pm_config.path("PM_REPO_DIR", required=True))
    if a.term and not a.project:
        a.project = pm_config.get("PM_SB_PROJECT_ID") or "prj_" + str(pm_config.get("PM_SB_PREFIX", required=True)).lower()
    if a.service:
        slug = pm_config.get("PM_REPO_SLUG") or ""
        repo_name = pm_config.get("PM_REPO_NAME") or slug.rsplit("/", 1)[-1] or os.path.basename(a.repo.rstrip("/"))
        _, reg = run(["git", "show", f"origin/master:.xtrm/skills/{repo_name}/service-knowledge/service-registry.json"], a.repo)
        svc = json.loads(reg).get("services", {}).get(a.service)
        if not svc:
            print(f"service {a.service} not in registry"); return 2
        a.paths += [t.rstrip("*").rstrip("/") for t in svc.get("territory", [])]
    if not a.paths:
        print("no paths"); return 2
    run(["git", "fetch", "-q", "origin"], a.repo)
    _, stable = run(["git", "rev-parse", "origin/stable"], a.repo)
    print(f"origin/stable {stable[:12]}")
    if a.vehicle:
        rc, _ = run(["git", "merge-base", "--is-ancestor", a.vehicle, "origin/stable"], a.repo)
        print(f"vehicle {a.vehicle[:12]} on stable: {'yes' if rc == 0 else 'NO'}")
    _, newer = run(["git", "log", "--oneline", "origin/stable..origin/master", "--", *a.paths], a.repo)
    rows = [l for l in newer.splitlines() if l]
    print(f"\n[newer on master, not on stable, touching paths] {len(rows)}")
    for l in rows[:30]:
        print("  " + l[:140])
    rc, prs = run(["gh", "pr", "list", "--state", "open", "--limit", "100", "--json",
                   "number,title,baseRefName,headRefOid,isDraft,files"], a.repo)
    hits = []
    if rc == 0:
        for p in json.loads(prs or "[]"):
            f = [x["path"] for x in p.get("files") or [] if any(x["path"].startswith(q) for q in a.paths)]
            if f:
                hits.append((p, f))
    else:
        print("\n[open PRs] gh failed: UNKNOWN, not zero")
    print(f"\n[open PRs touching paths] {len(hits)}")
    for p, f in hits:
        d = " draft" if p["isDraft"] else ""
        print(f"  #{p['number']} base={p['baseRefName']} head={p['headRefOid'][:12]}{d} {p['title'][:80]} | {', '.join(f[:3])}")
    for t in a.term:
        rc, out = run(["sb", "issue", "list", "--project", a.project, "--search", t, "--flat", "--plain"], a.repo)
        lines = [l for l in out.splitlines() if l.strip() and "done" not in l.lower() and "closed" not in l.lower()]
        print(f"\n[open sb issues matching '{t}'] {len(lines) if rc == 0 else 'UNKNOWN'}")
        for l in lines[:15]:
            print("  " + l[:140])
    return 0


if __name__ == "__main__":
    sys.exit(main())

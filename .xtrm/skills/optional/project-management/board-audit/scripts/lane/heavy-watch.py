#!/usr/bin/env python3
"""HEAVY gate watch (B294 follow-up): does the nightly Tests & Coverage on master go green after the
merge that fixed the only HEAVY failure?

Word B294 asks for a gate, not a reminder: when the nightly HEAVY run on master is green, PROPOSE
ISSUE-613 -> Completata (a proposal, never the move itself). This script measures; the coordinator rules.

A green run is not by itself a reason to propose the move: the ROW is read first. ISSUE-613 sat Completata
from 2026-11-01T13:15:16 for twelve days while every green night proposed closing it again, and a
coordinator acted on one of those no-ops on 2026-11-13. A terminal row (statusCategory `done`: Completata,
Won't Do, any Done-family name) gets one HEAVY-GATE-SATISFIED line per UTC day and no proposal; a failed
status read gets HEAVY-GATE-ERROR and no proposal, so silence and error never look like a closure.

Why it is not a one-line `gh run list`: the cron is "30 4 * * *" on master but the observed nightly run
was created at 2026-10-31T10:29:35Z, six hours late. A gate that assumed 04:30Z would fire on an empty
window and report "no run" as if the nightly were broken. So the watcher keys on the RUN, not on the clock,
and reports PENDING with the last schedule run it can see.

Emitted lines (state file keeps each one from repeating):
  HEAVY-GREEN <stamp> run=<id> <url> path=nightly|promotion-pr -> PROPOSE ISSUE-613 -> Completata
  HEAVY-RED   <stamp> run=<id> <url> conclusion=<c>
  HEAVY-PENDING <stamp> last-schedule=<stamp|none> last-conclusion=<c|none> since=<merge stamp>
  HEAVY-ERROR <stamp> <why>
  HEAVY-GATE-SATISFIED <stamp> ISSUE-613 is already <status>; no proposal   (at most one per UTC day)
  HEAVY-GATE-ERROR status read failed for ISSUE-613                        (no proposal either way)
"""
import json
import socket
import subprocess
import sys

import lanecfg
import jira  # noqa: E402  (on sys.path through lanecfg)

LANE = lanecfg.lane()
STATE = f"{LANE}/heavy-state.json"
REPO = lanecfg.repo()
# The merge that fixed the only HEAVY failure (PR #1187 squash). A nightly run created before this
# instant cannot be the proof, however green it is.
AFTER = "2026-11-01T03:36:19Z"
WORKFLOW = lanecfg.ci_workflow()
TARGET = "ISSUE-613"  # the row the PROPOSE line would move; its live status decides whether to propose at all


def stamp():
    return subprocess.run(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], capture_output=True, text=True).stdout.strip()


def gh(args):
    p = subprocess.run(["gh"] + args, capture_output=True, text=True, cwd=REPO, timeout=120)
    if p.returncode != 0:
        return None, p.stderr.strip()[:200]
    try:
        return json.loads(p.stdout), None
    except json.JSONDecodeError:
        return None, "non-JSON output"


def target_status():
    """(statusCategory key, status name) for TARGET, or (None, why) when the read fails.

    At most two attempts with a short socket timeout: the lane runs every 15 minutes and must not hammer
    the API. A failed read returns None, never a category, so it cannot be mistaken for a closed row."""
    prev = socket.getdefaulttimeout()
    socket.setdefaulttimeout(10)  # jira.call has no timeout argument; this bounds its urlopen
    why = "unknown"
    try:
        for _ in (1, 2):
            try:
                code, body = jira.call("GET", f"/rest/api/3/issue/{TARGET}?fields=status")
            except Exception as e:
                why = e.__class__.__name__
                continue
            if not isinstance(body, dict):
                why = f"HTTP {code} (non-JSON body)"
                continue
            status = (body.get("fields") or {}).get("status") or {}
            cat = (status.get("statusCategory") or {}).get("key")
            if code == 200 and cat:
                return cat, status.get("name") or cat
            why = f"HTTP {code} without statusCategory"
    finally:
        socket.setdefaulttimeout(prev)
    return None, why


STATUS = []  # one status read per pass, however many proof paths want to speak


def status_once():
    if not STATUS:
        STATUS.append(target_status())
    return STATUS[0]


def load():
    try:
        return json.load(open(STATE))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save(st):
    json.dump(st, open(STATE, "w"), indent=1)


# A green HEAVY run on the promotion PR's OWN head is equally good evidence: it contains e03aac74, so it
# proves the suite on the commit that would ship. The coordinator's rule (2026-11-01T10:33Z) is that
# ISSUE-613 closes on WHICHEVER of the two comes first, so the gate must accept both and say which fired.
def ancestry_ok(sha):
    """True when e03aac74 is an ancestor of sha. A missing object is not a 'no': it means we did not look."""
    have = subprocess.run(["git", "cat-file", "-e", sha], cwd=REPO, capture_output=True)
    if have.returncode != 0:
        subprocess.run(["git", "fetch", "--quiet", "origin", sha], cwd=REPO, capture_output=True, timeout=120)
    a = subprocess.run(["git", "merge-base", "--is-ancestor", "e03aac7460bccace2af0cec6604655eb236c6976", sha],
                       cwd=REPO, capture_output=True)
    if a.returncode == 0:
        return True
    if a.returncode == 1:
        return False
    return None


def promotion_pr_proof():
    """A completed green Tests & Coverage run on the head of an open PR whose base is stable."""
    prs, err = gh(["pr", "list", "--base", "stable", "--state", "open",
                   "--json", "number,headRefOid,headRefName,title"])
    if prs is None:
        return None, f"pr list failed: {err}"
    out = []
    for pr in prs:
        sha = pr["headRefOid"]
        anc = ancestry_ok(sha)
        if anc is not True:
            continue
        runs, err = gh(["run", "list", "--workflow", WORKFLOW, "--event", "pull_request",
                        "--json", "databaseId,createdAt,status,conclusion,url,headSha", "--limit", "60"])
        if runs is None:
            return None, f"run list failed: {err}"
        mine = [r for r in runs if r.get("headSha") == sha
                and r.get("status") == "completed" and r.get("conclusion") == "success"]
        if mine:
            r = max(mine, key=lambda x: x["createdAt"])
            out.append((r, pr))
    return out, None


def main():
    runs, err = gh(["run", "list", "--workflow", WORKFLOW, "--branch", "master", "--limit", "60",
                    "--json", "event,createdAt,conclusion,status,databaseId,url,headBranch"])
    if runs is None:
        print(f"HEAVY-ERROR {stamp()} gh failed: {err}")
        return 1
    sched = [r for r in runs if r.get("event") == "schedule"]
    disp = [r for r in runs if r.get("event") == "workflow_dispatch"]
    sched.sort(key=lambda r: r["createdAt"], reverse=True)
    disp.sort(key=lambda r: r["createdAt"], reverse=True)
    st = load()
    now = stamp()

    def emit(kind, key, line, stable=None):
        """Dedupe on the STABLE text, print with the live stamp. The first version compared the whole line
        including the timestamp, so a "pending" state reprinted every 15 minutes - alarm fatigue for a
        state that has not changed."""
        sig = stable or line
        if st.get(key) == sig:
            return
        st[key] = sig
        save(st)
        print(line)

    # The gate on the PROPOSE lines: read the TARGET ROW, not just the run. One verdict per pass, so two
    # proof paths cannot read twice or print the same line twice; and a terminal row yields ONE line per
    # UTC day (the existing dedupe, keyed on the date), not one per 15-minute pass.
    gate_verdict = []

    def gate_ok():
        if not gate_verdict:
            cat, detail = status_once()
            if cat is None:
                print(f"HEAVY-GATE-ERROR status read failed for {TARGET}")
                gate_verdict.append(False)
            elif cat == "done":
                emit("gate", "gate_satisfied_day",
                     f"HEAVY-GATE-SATISFIED {now} {TARGET} is already {detail}; no proposal",
                     stable=f"satisfied:{now[:10]}")
                gate_verdict.append(False)
            else:
                gate_verdict.append(True)
        return gate_verdict[0]

    # Nightly evidence first: the WORD names the nightly.
    after = [r for r in sched if r["createdAt"] >= AFTER]
    done = [r for r in after if r.get("status") == "completed"]
    green = [r for r in done if r.get("conclusion") == "success"]
    red = [r for r in done if r.get("conclusion") != "success"]
    if green:
        r = max(green, key=lambda x: x["createdAt"])
        if gate_ok():
            emit("green", "green", f"HEAVY-GREEN {now} run={r['databaseId']} {r['url']} created={r['createdAt']} "
                                   f"-> PROPOSE ISSUE-613 -> Completata (the nightly on master is green after e03aac74)",
                 stable=f"green:{r['databaseId']}")
    elif red:
        r = max(red, key=lambda x: x["createdAt"])
        emit("red", "red", f"HEAVY-RED {now} run={r['databaseId']} {r['url']} conclusion={r.get('conclusion')} "
                           f"created={r['createdAt']} -> ISSUE-613 stays open; read the failing step before proposing anything",
             stable=f"red:{r['databaseId']}:{r.get('conclusion')}")
    else:
        last = sched[0] if sched else None
        # Three different worlds printed as one line before: no run at all, a run in flight, and a run that
        # finished without a conclusion. They call for different reactions, so say which one it is.
        lc = (last or {}).get('createdAt')
        lconcl = (last or {}).get('conclusion')
        in_flight = bool(last) and last.get('status') in ('queued', 'pending', 'in_progress')
        if not last:
            verdict = "no schedule run on this branch at all"
        elif in_flight:
            verdict = (f"the newest schedule run ({last.get('status')}) has not finished; "
                       f"HEAVY-STUCK reports it if it sits queued over 30 min")
        else:
            verdict = "the newest schedule run finished without a usable conclusion"
        emit("pending", "pending",
             f"HEAVY-PENDING {now} last-schedule={lc or 'none'} last-status={(last or {}).get('status', 'none')} "
             f"last-conclusion={lconcl or 'none'} since={AFTER} -> {verdict}",
             stable=f"pending:{lc}:{lconcl}:{(last or {}).get('status')}")

    # Second proof path: the promotion PR's own HEAVY lane (its head contains e03aac74).
    proof, perr = promotion_pr_proof()
    if perr:
        print(f"HEAVY-ERROR {now} promotion-pr probe: {perr}")
    for r, pr in (proof or []):
        if not gate_ok():
            continue
        emit("green", "green",
             f"HEAVY-GREEN {now} run={r['databaseId']} {r['url']} path=promotion-pr pr=#{pr['number']} "
             f"head={pr['headRefOid'][:10]} created={r['createdAt']} "
             f"-> PROPOSE ISSUE-613 -> Completata (green HEAVY on the promotion PR head, which contains e03aac74; "
             f"the coordinator's rule: whichever of the two proofs lands first)",
             stable=f"green-pr:{r['databaseId']}")

    # A manual dispatch after the merge is also HEAVY evidence; label it so it is never confused with the nightly.
    d_done = [r for r in disp if r["createdAt"] >= AFTER and r.get("status") == "completed"]
    if d_done:
        r = max(d_done, key=lambda x: x["createdAt"])
        emit("dispatch", "dispatch",
             f"HEAVY-DISPATCH {now} run={r['databaseId']} conclusion={r.get('conclusion')} created={r['createdAt']} "
             f"{r['url']} (manual HEAVY, not the nightly: evidence, not the gate)",
             stable=f"dispatch:{r['databaseId']}:{r.get('conclusion')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

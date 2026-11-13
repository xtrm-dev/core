#!/usr/bin/env python3
"""Offline proof for check 14 (unrowed done work) in cycle/cycle.py.

Every read the check makes is replaced with a fake, so the cases run with no Jira, no gh, no Substrate
CLI and no state.db: the state file is a temp path and nothing under the real lane is read or written.
Each case prints the section the cycle would print, then its assertion.

Existing nine cases:
  1 finished + merged PR + no row        -> proposed create-and-close
  2 finished + journal result + no row   -> proposed
  3 finished WITH a row                  -> not listed, counted as rowed (never proposed)
  4 hierarchical ref resolved by trimming-> rowed via its base ref, not listed
  5 same inputs a second cycle           -> no duplicate proposal, count unchanged
  6 proposal 8 days old                  -> re-proposed (7-day rule)
  7 Jira row read fails                  -> unrowed_done/unrowed_backlog=READ-FAILED, no batch
  8 70 unrowed refs, cap 60              -> 60 proposed, 10 reported as over the cap, count 70
  9 gh read fails                        -> unrowed_done/unrowed_backlog=READ-FAILED, no batch

Added for the 24-hour window / backlog / widened scope (coordinator ruling 2026-11-13):
 10 finished 2 hours ago, no row         -> proposed, in unrowed_done
 11 finished 30 hours ago, no row        -> NOT proposed, not in unrowed_done, in unrowed_backlog
 12 journal result 1h ago + OLD merged PR-> in the window (newest of the two time sources)
 13 merged PR 1h ago + journal 3 days old-> in the window (newest of the two time sources)
 14 issue under SB-2200, finished 1h ago-> proposed (scope is the project, not the epic)
 15 issue in another Substrate project   -> absent entirely (the project read excludes it)
 16 500 out-of-window unrowed refs       -> empty batch, unrowed_backlog=500, unrowed_done=0
 17 both fields FAILED on a Jira read failure; both on a gh failure

Run: python3 test-unrowed-done.py    (exit 0 when every case passes)
"""
import importlib.util
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
# A neutral config, written before cycle.py is imported, so the test never reads an operator's real one.
_CFG_DIR = tempfile.mkdtemp(prefix="unrowed-cfg-")
with open(os.path.join(_CFG_DIR, "pm.json"), "w") as _fh:
    json.dump({"repo_dir": _CFG_DIR, "lane_dir": _CFG_DIR, "jira_project": "PROJ", "sb_prefix": "SB", "epic": "SB-1",
               "repo_name": "example-repo", "repo_slug": "example-org/example-repo",
               "jira_site": "https://example.atlassian.net", "operator_account_id": "0000",
               "custom_fields": {"window_start": "customfield_10001", "window_end": "customfield_10002",
                                 "start_date": "customfield_10003"},
               "waiting_production_status": "Waiting Production", "active_statuses": ["To Do", "In Progress"],
               "deferred_status": "Deferred", "parked_statuses": ["Deferred", "Blocked"],
               "hygiene_filters": {"open_without_dates": {"id": "1", "name": "PROJ open without dates"},
                                   "overdue": {"id": "2", "name": "PROJ overdue"},
                                   "next_48h": {"id": "3", "name": "PROJ next 48 hours"}},
               "cutoff": "2026-01-01 00:00"}, _fh)
os.environ["PM_CONFIG"] = os.path.join(_CFG_DIR, "pm.json")
for _k in [k for k in os.environ if k.startswith("PM_") and k != "PM_CONFIG"]:
    del os.environ[_k]

_spec = importlib.util.spec_from_file_location("cycle_under_test", os.path.join(HERE, "cycle", "cycle.py"))
cycle = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cycle)

TMP = tempfile.mkdtemp(prefix="unrowed-test-")
STATE = os.path.join(TMP, "unrowed.json")
cycle.UNROWED_STATE = STATE
TODAY = datetime.now(timezone.utc).date()
NOW = datetime.now(timezone.utc)

FAILED = []


def ago(hours):
    """An ISO-8601 UTC timestamp this many hours before the test's clock."""
    return (NOW - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")


def row(key, *refs, status="Completata"):
    return {"key": key, "fields": {"labels": [f"substrate:{r}" for r in refs],
                                   "status": {"name": status, "statusCategory": {"key": "done"}},
                                   "summary": f"row {key}"}}


def issue(ref, locator, title="work", state="done", project=None):
    return {"humanRef": ref, "locator": locator, "title": title, "lifecycleState": state,
            "project": project or cycle.SB_PROJECT_ID}


def pr(number, branch, title="feat: work (re: SB-1)", oid="d792fed54d9e24ec", at=None):
    return {"number": number, "headRefName": branch, "title": title,
            "mergeCommit": {"oid": oid}, "mergedAt": at or ago(2)}


def result(sequence, summary="done", at_hours=None):
    """A newest journal `result` as unrowed_results() returns it: sequence, at_ms, summary."""
    at = NOW - timedelta(hours=at_hours if at_hours is not None else 1)
    return {"sequence": sequence, "at_ms": int(at.timestamp() * 1000), "summary": summary}


def run(name, rows=None, prs=None, issues=None, results=None, row_why=None, pr_why=None, state=None,
        fresh=True):
    """One cycle with the fakes installed. Returns (text, counts, out-lines).

    `unrowed_issues` is faked with the SAME project scope as the real read
    (`sb issue list --project prj_mmd --json`): an issue belonging to another Substrate project is
    never returned, which is exactly the boundary case 15 proves.
    """
    if state is not None:
        with open(STATE, "w", encoding="utf-8") as fh:
            json.dump({"refs": state}, fh)
    elif fresh and os.path.exists(STATE):
        os.remove(STATE)          # a clean cycle unless the case is deliberately continuing the memory
    scoped = [i for i in (issues or []) if i.get("project") == cycle.SB_PROJECT_ID]
    cycle.unrowed_rows = lambda: (rows or [], row_why)
    cycle.unrowed_prs = lambda: (prs or [], pr_why)
    cycle.unrowed_issues = lambda: (scoped, None)
    cycle.unrowed_results = lambda: (results or {}, None)
    out, counts = [], {}
    cycle.check_unrowed_done(out, counts)
    text = "\n".join(out)
    print(f"\n=== {name} ===")
    print(text)
    print(f"--- counts: unrowed_done={counts.get('unrowed_done')} "
          f"unrowed_backlog={counts.get('unrowed_backlog')} "
          f"proposed={counts.get('unrowed_proposed')} held={counts.get('unrowed_held')} "
          f"over_cap={counts.get('unrowed_over_cap')}")
    return text, counts, out


def check(case, cond, why):
    print(f"  [{case}] {'PASS' if cond else 'FAIL'} - {why}")
    if not cond:
        FAILED.append(f"{case}: {why}")


# ---------------------------------------------------------------- 1: merged PR, no row
text, counts, _ = run(
    "1. finished + merged PR + no row -> create-and-close",
    rows=[row("PROJ-1", "SB-4700")],
    prs=[pr(1485, "sp/sb-4765", "docs(stir): flip the STIR source flip gates to the SCID oracle ruling")],
    issues=[issue("SB-4765", "SB-1.276.52", "service-knowledge: calculating-stir-spreads flip gates")],
    results={})
check(1, counts["unrowed_done"] == 1, "the unrowed ref is counted (unrowed_done=1)")
check(1, "PROPOSAL: create-and-close" in text, "proposed create-and-close")
check(1, "PR #1485" in text and "d792fed54d9e" in text, "evidence names the PR and merge commit")

# ---------------------------------------------------------------- 2: journal result, no row
text, counts, _ = run(
    "2. finished + journal result + no row -> proposed",
    rows=[row("PROJ-1", "SB-4700")],
    prs=[],
    issues=[issue("SB-4734", "SB-1.275.60", "Swap precheck accepts tracked SCID files")],
    results={"SB-4734": result(3, "PR #1458 merged; guards verified by make check", 1)})
check(2, counts["unrowed_done"] == 1, "a journal result alone makes it evidence-bearing")
check(2, "journal result seq 3" in text, "the block carries the journal result seq")
check(2, "PROPOSAL:" in text, "a proposal is written")

# ---------------------------------------------------------------- 3: a row exists
text, counts, _ = run(
    "3. finished WITH a row -> rowed, never listed",
    rows=[row("PROJ-822", "SB-4765")],
    prs=[pr(1485, "sp/sb-4765")],
    issues=[issue("SB-4765", "SB-1.276.52")],
    results={})
check(3, counts["unrowed_done"] == 0, "counted as rowed (unrowed_done=0)")
check(3, counts["unrowed_backlog"] == 0, "a rowed ref is not in the backlog either")
check(3, "SB-4765" not in text, "the ref does not appear in any proposal")
check(3, "done in that project: **1**" in text, "the finished issue is still counted as done")

# ---------------------------------------------------------------- 4: hierarchical ref trims
text, counts, _ = run(
    "4. hierarchical ref resolved by trimming to its base ref -> rowed",
    rows=[row("PROJ-700", "SB-3685")],
    prs=[pr(900, "xt/SB-3685.2-item")],
    issues=[issue("SB-3685.2", "SB-1.900.2", "second item of 3685")],
    results={"SB-3685.2": result(2, "done", 1)})
check(4, counts["unrowed_done"] == 0, "substrate:SB-3685 makes SB-3685.2 rowed (trimmed)")
check(4, "SB-3685.2" not in text, "the hierarchical ref is not proposed")

# ---------------------------------------------------------------- 5: second cycle, same inputs
same = dict(rows=[row("PROJ-1", "SB-4700")], prs=[pr(1485, "sp/sb-4765")],
            issues=[issue("SB-4765", "SB-1.276.52")], results={})
text1, counts1, _ = run("5a. first cycle proposes it", **same)
text2, counts2, _ = run("5b. second cycle, same inputs -> memory respected", fresh=False, **same)
check(5, counts1["unrowed_proposed"] == 1 and counts2["unrowed_proposed"] == 0,
      "proposed once, not twice (1 then 0)")
check(5, counts2["unrowed_held"] == 1, "the second cycle reports it held by the memory")
check(5, counts2["unrowed_done"] == counts1["unrowed_done"] == 1,
      "the count stays the true in-window total (memory does not filter it)")
check(5, "### Proposals" not in text2, "no proposal block the second time")
with open(STATE, encoding="utf-8") as fh:
    mem = json.load(fh)["refs"]
check(5, mem["SB-4765"]["proposed"] == TODAY.isoformat() and mem["SB-4765"]["first"] == TODAY.isoformat(),
      "memory records first and last proposal dates")

# ---------------------------------------------------------------- 6: 8-day-old proposal
text, counts, _ = run(
    "6. proposal 8 days old, still unrowed -> re-proposed",
    rows=[row("PROJ-1", "SB-4700")], prs=[pr(1485, "sp/sb-4765")],
    issues=[issue("SB-4765", "SB-1.276.52")], results={},
    state={"SB-4765": {"first": (TODAY - timedelta(days=8)).isoformat(),
                        "proposed": (TODAY - timedelta(days=8)).isoformat(),
                        "proposal": "create-and-close", "locator": "SB-1.276.52"}})
check(6, counts["unrowed_proposed"] == 1 and counts["unrowed_held"] == 0, "re-proposed after 7 days")
with open(STATE, encoding="utf-8") as fh:
    mem = json.load(fh)["refs"]["SB-4765"]
check(6, mem["proposed"] == TODAY.isoformat() and mem["first"] == (TODAY - timedelta(days=8)).isoformat(),
      "last proposal advances, first proposal is preserved")

# ---------------------------------------------------------------- 7: Jira read fails
text, counts, _ = run("7. row read fails -> READ-FAILED, no batch",
                      rows=[], prs=[pr(1485, "sp/sb-4765")], issues=[issue("SB-4765", "SB-1.276.52")],
                      results={}, row_why="HTTP 502")
check(7, counts["unrowed_done"] == "READ-FAILED", "the count is READ-FAILED, never 0")
check(7, counts["unrowed_backlog"] == "READ-FAILED", "the backlog is READ-FAILED too, never 0")
check(7, "UNROWED-GATE-ERROR row read failed for HTTP 502" in text, "the gate error names the failure")
check(7, counts.get("unrowed_proposed") == 0 and "### Proposals" not in text,
      "nothing is proposed from a partial read")

# ---------------------------------------------------------------- 8: the 60-issue cap
big = [issue(f"SB-{5000 + n}", f"SB-1.9.{n}", f"bulk work {n}") for n in range(70)]
text, counts, _ = run("8. 70 unrowed refs, cap 60 -> 60 proposed, 10 skipped",
                      rows=[row("PROJ-1", "SB-4700")],
                      prs=[pr(2000 + n, f"xt/SB-{5000 + n}-build") for n in range(70)],
                      issues=big, results={})
check(8, counts["unrowed_done"] == 70, "the count is the true in-window total (70), not the batch size")
check(8, counts["unrowed_proposed"] == 60 and counts["unrowed_over_cap"] == 10,
      "60 proposed under the cap, 10 reported as over the cap")
with open(STATE, encoding="utf-8") as fh:
    check(8, len(json.load(fh)["refs"]) == 60, "only the proposed refs enter the memory")

# ---------------------------------------------------------------- 9: gh read fails
text, counts, _ = run("9. gh read fails -> READ-FAILED, no batch",
                      rows=[row("PROJ-1", "SB-4700")], prs=[],
                      issues=[issue("SB-4765", "SB-1.276.52")], results={},
                      pr_why="HTTP 403")
check(9, counts["unrowed_done"] == "READ-FAILED", "the count is READ-FAILED")
check(9, counts["unrowed_backlog"] == "READ-FAILED", "the backlog is READ-FAILED")
check(9, "UNROWED-GATE-ERROR pr read failed for HTTP 403" in text, "the gate error names the PR read")

# ---------------------------------------------------------------- 10: 2 hours ago -> in window
text, counts, _ = run(
    "10. finished 2 hours ago, no row -> proposed, counted in unrowed_done",
    rows=[row("PROJ-1", "SB-4700")],
    prs=[pr(1500, "sp/sb-4766", at=ago(2))],
    issues=[issue("SB-4766", "SB-1.276.53")], results={})
check(10, counts["unrowed_done"] == 1, "a 2-hour-old finish is in the 24-hour window")
check(10, counts["unrowed_backlog"] == 1, "and it is in the backlog as well")
check(10, counts["unrowed_proposed"] == 1, "it is proposed")

# ---------------------------------------------------------------- 11: 30 hours ago -> out
text, counts, _ = run(
    "11. finished 30 hours ago, no row -> NOT proposed, only in the backlog",
    rows=[row("PROJ-1", "SB-4700")],
    prs=[pr(1501, "sp/sb-4767", at=ago(30))],
    issues=[issue("SB-4767", "SB-1.276.54")], results={})
check(11, counts["unrowed_done"] == 0, "a 30-hour-old finish is outside the window")
check(11, counts["unrowed_proposed"] == 0, "nothing is proposed from outside the window")
check(11, counts["unrowed_backlog"] == 1, "it still counts in the whole-scope backlog")
check(11, "### Proposals" not in text, "no proposal block for an out-of-window ref")

# ---------------------------------------------------------------- 12: new journal, old PR
text, counts, _ = run(
    "12. journal result 1h ago + OLD merged PR -> in the window (newest of the two)",
    rows=[row("PROJ-1", "SB-4700")],
    prs=[pr(1502, "sp/sb-4768", at=ago(24 * 5))],
    issues=[issue("SB-4768", "SB-1.276.55")],
    results={"SB-4768": result(4, "verified", 1)})
check(12, counts["unrowed_done"] == 1 and counts["unrowed_proposed"] == 1,
      "the newest source (journal result, 1h) puts it in the window")

# ---------------------------------------------------------------- 13: new PR, old journal
text, counts, _ = run(
    "13. merged PR 1h ago + journal result 3 days old -> in the window",
    rows=[row("PROJ-1", "SB-4700")],
    prs=[pr(1503, "sp/sb-4769", at=ago(1))],
    issues=[issue("SB-4769", "SB-1.276.56")],
    results={"SB-4769": result(2, "stale result", 24 * 3)})
check(13, counts["unrowed_done"] == 1 and counts["unrowed_proposed"] == 1,
      "the newest source (merged PR, 1h) puts it in the window")

# ---------------------------------------------------------------- 14: under SB-2200
text, counts, _ = run(
    "14. issue under SB-2200 (not SB-1), finished 1h ago -> proposed (scope widened)",
    rows=[row("PROJ-1", "SB-4700")],
    prs=[pr(1504, "sp/sb-4755", at=ago(1))],
    issues=[issue("SB-4755", "SB-2200.17.3")], results={})
check(14, counts["unrowed_done"] == 1 and counts["unrowed_proposed"] == 1,
      "a ref outside the programme epic is in scope and proposed")
check(14, "SB-2200.17.3" in text, "the proposal names the SB-2200 locator")

# ---------------------------------------------------------------- 15: another project
text, counts, _ = run(
    "15. issue in another Substrate project -> absent entirely",
    rows=[row("PROJ-1", "SB-4700")],
    prs=[pr(1505, "sp/bcs-42", at=ago(1))],
    issues=[issue("BCS-42", "BCS-1.4", "other project work", project="prj_barchartscraper")],
    results={})
check(15, counts["unrowed_done"] == 0 and counts["unrowed_backlog"] == 0,
      "an issue from another project is not counted at all")
check(15, "BCS-42" not in text, "and it appears nowhere in the section")

# ---------------------------------------------------------------- 16: backlog never proposes
out_of_window = [issue(f"SB-{6000 + n}", f"SB-1.9.{n}", f"old work {n}") for n in range(500)]
text, counts, _ = run(
    "16. 500 out-of-window unrowed refs -> empty batch, unrowed_backlog=500",
    rows=[row("PROJ-1", "SB-4700")],
    prs=[pr(3000 + n, f"xt/SB-{6000 + n}-build", at=ago(30)) for n in range(500)],
    issues=out_of_window, results={})
check(16, counts["unrowed_backlog"] == 500, "the whole-scope backlog is 500")
check(16, counts["unrowed_done"] == 0, "none of them is in the 24-hour window")
check(16, counts["unrowed_proposed"] == 0 and "### Proposals" not in text,
      "the backlog never yields a proposal")

# ---------------------------------------------------------------- 17: both fields FAILED
text, counts, _ = run("17a. Jira row read fails -> both fields READ-FAILED",
                      rows=[], prs=[pr(1485, "sp/sb-4765")],
                      issues=[issue("SB-4765", "SB-1.276.52")], results={}, row_why="HTTP 502")
check(17, counts["unrowed_done"] == "READ-FAILED" and counts["unrowed_backlog"] == "READ-FAILED",
      "both unrowed_done and unrowed_backlog are READ-FAILED on a Jira failure")
text, counts, _ = run("17b. gh read fails -> both fields READ-FAILED",
                      rows=[row("PROJ-1", "SB-4700")], prs=[],
                      issues=[issue("SB-4765", "SB-1.276.52")], results={}, pr_why="HTTP 403")
check(17, counts["unrowed_done"] == "READ-FAILED" and counts["unrowed_backlog"] == "READ-FAILED",
      "both fields are READ-FAILED on a gh failure")

print()
if FAILED:
    print(f"FAILED: {len(FAILED)}")
    for f in FAILED:
        print("  -", f)
    sys.exit(1)
print("PASS: all cases (nine existing + eight window/backlog/scope cases)")
sys.exit(0)

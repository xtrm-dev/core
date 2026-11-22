#!/usr/bin/env python3
"""Offline proof for check 15 (close sweep direction two) in cycle/cycle.py.

Rule 54 direction two: open Substrate issues whose NEWEST journal entry is a result. The lane reads
them with ONE read-only SQL query against state.db. This test builds fake state.db files in a temp
directory (the real one is never opened) and proves the query's ordering, its counts, the memory and
its failure modes.

Cases:
  a an open issue whose newest entry is a result          -> listed, counted in dir2_result, proposed close
  b the same issue with a NEWER note entry                -> not listed, not counted
  c two journal rows with the same sequence, higher id    -> the higher id wins (a result there IS listed)
  d three rows where MAX(sequence) alone picks wrong      -> not listed; the naive query WOULD list it
  e a specialist:: participant                            -> in dir2_specialist, proposed ask-owner, not close
  f a second cycle                                        -> nothing re-proposed, count unchanged
  g a proposal 8 days old                                 -> re-proposed (7-day rule)
  h a missing DB file                                     -> dir2_result=READ-FAILED, no batch
  i a DB with the wrong schema                            -> READ-FAILED, not a traceback

Run: python3 test-dir2-result.py    (exit 0 when every case passes)
"""
import importlib.util
import json
import os
import re
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("cycle_under_test", os.path.join(HERE, "cycle", "cycle.py"))
cycle = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cycle)

TMP = tempfile.mkdtemp(prefix="dir2-test-")
STATE = os.path.join(TMP, "dir2.json")
cycle.DIR2_STATE = STATE
TODAY = datetime.now(timezone.utc).date()
FAILED = []

# The real state.db column lists, so the fake file has the same shape the query runs against.
ISSUES_DDL = """create table issues (
  id text primary key, project_id text not null, human_number integer not null, kind text not null,
  title text not null, lifecycle_state text not null default 'open',
  priority integer not null default 0, scrutiny text not null default '',
  current_revision integer not null default 1, current_contract_hash text, defer_until integer,
  created_at integer not null, updated_at integer not null)"""
JOURNAL_DDL = """create table issue_journal (
  id text primary key, issue_id text not null, issue_revision integer not null,
  sequence integer not null, run_id text, participant_id text, activation_id text, session_id text,
  kind text not null, mechanical_json text, semantic_json text,
  refs_json text not null default '[]', created_at integer not null, result_json text,
  execution_context_json text)"""


def db_path(name):
    return os.path.join(TMP, f"{name}.db")


def make_db(name, issues, entries):
    """A fake state.db. Written READ-WRITE here because this is the fixture; the lane only reads.

    issues:  [(human_number, title, lifecycle_state, project_id)]
    entries: [(human_number, sequence, kind, participant_id, journal_row_id)]
    """
    path = db_path(name)
    if os.path.exists(path):
        os.remove(path)
    con = sqlite3.connect(path)
    con.execute(ISSUES_DDL)
    con.execute(JOURNAL_DDL)
    for n, title, state, project in issues:
        con.execute("insert into issues (id, project_id, human_number, kind, title, lifecycle_state, "
                    "created_at, updated_at) values (?,?,?,?,?,?,?,?)",
                    (f"iss_{n}", project, n, "task", title, state, 1_700_000_000_000, 1_700_000_000_000))
    for n, seq, kind, pid, row_id in entries:
        con.execute("insert into issue_journal (id, issue_id, issue_revision, sequence, participant_id, "
                    "kind, created_at) values (?,?,?,?,?,?,?)",
                    (row_id, f"iss_{n}", 1, seq, pid, kind, 1_700_000_000_000))
    con.commit()
    con.close()
    return path


def run(name, path):
    out, counts = [], {}
    cycle.check_dir2_results(out, counts, db_path=path)
    text = "\n".join(out)
    print(f"\n=== {name} ===")
    print(text)
    print(f"--- counts: dir2_result={counts.get('dir2_result')} "
          f"dir2_specialist={counts.get('dir2_specialist')} "
          f"proposed={counts.get('dir2_proposed')} held={counts.get('dir2_held')}")
    return text, counts


def proposals(text):
    """{ref: 'close' | 'ask-owner <who>'} parsed back out of the printed blocks."""
    found, cur = {}, None
    for line in text.splitlines():
        m = re.match(r"^- (MMD-\d+) \| seq \d+ \| ", line)
        if m:
            cur = m.group(1)
            continue
        m = re.match(r"^  - PROPOSAL: (close|ask-owner \S+) - ", line)
        if m and cur:
            found[cur] = m.group(1)
            cur = None
    return found


def check(case, cond, why):
    print(f"  [{case}] {'PASS' if cond else 'FAIL'} - {why}")
    if not cond:
        FAILED.append(f"{case}: {why}")


def memory(days_ago=None):
    """A dir2.json whose one ref was proposed `days_ago` days back (or an empty memory)."""
    refs = {}
    if days_ago is not None:
        refs["MMD-9001"] = {"first": (TODAY - timedelta(days=days_ago)).isoformat(),
                            "proposed": (TODAY - timedelta(days=days_ago)).isoformat(),
                            "proposal": "close"}
    with open(STATE, "w", encoding="utf-8") as fh:
        json.dump({"refs": refs}, fh)
    return refs


# ---------------------------------------------------------------- a: newest entry is a result
path = make_db("a", [(9001, "finished work nobody closed", "open", "prj_mmd")],
               [(9001, 1, "result", "wed11-coord", "e1")])
before = open(path, "rb").read()
memory()
text, counts = run("a. open issue, newest entry is a result -> listed and counted", path)
check("a", counts["dir2_result"] == 1, "dir2_result=1 (the whole board read, one row)")
check("a", "MMD-9001" in text and "| seq 1 | wed11-coord |" in text,
      "the block carries ref, sequence and participant")
check("a", proposals(text) == {"MMD-9001": "close"},
      "a coordinator-written terminal result is proposed close")
check("a", open(path, "rb").read() == before and not os.path.exists(path + "-wal"),
      "the fake DB is byte-identical after the read: the lane never writes")

# ---------------------------------------------------------------- b: a newer note hides it
path = make_db("b", [(9002, "result then note", "open", "prj_mmd")],
               [(9002, 1, "result", "wed11-coord", "e1"), (9002, 2, "note", "wed11-coord", "e2")])
memory()
text, counts = run("b. same issue with a NEWER note entry -> not listed", path)
check("b", counts["dir2_result"] == 0, "dir2_result=0: the newest entry is a note, not a result")
check("b", "MMD-9002" not in text, "the ref appears nowhere")

# ---------------------------------------------------------------- c: same sequence, higher id wins
path = make_db("c", [(9003, "tie on sequence", "open", "prj_mmd")],
               [(9003, 2, "note", "wed11-coord", "j1"), (9003, 2, "result", "wed11-coord", "j2")])
memory()
text, counts = run("c. two rows, same sequence, different id -> higher id wins", path)
check("c", counts["dir2_result"] == 1, "the higher id is the result, so the issue IS listed")
check("c", "MMD-9003" in text, "and its block is printed")

# ---------------------------------------------------------------- d: MAX(sequence) is not enough
path = make_db("d", [(9004, "sequence alone misleads", "open", "prj_mmd")],
               [(9004, 7, "result", "wed11-coord", "a"),
                (9004, 7, "note", "wed11-coord", "b"),
                (9004, 6, "result", "wed11-coord", "c")])
naive = list(sqlite3.connect(f"file:{path}?mode=ro", uri=True).execute(
    "select i.human_number from issues i join issue_journal j on j.issue_id = i.id "
    "where i.lifecycle_state = 'open' and j.kind = 'result' and j.sequence = "
    "(select max(k.sequence) from issue_journal k where k.issue_id = j.issue_id and k.kind = 'result')"))
memory()
text, counts = run("d. three rows where MAX(sequence) alone picks the wrong one", path)
print(f"--- control: a MAX(sequence)-only join returns {naive} (it WOULD list MMD-9004)")
check("d", naive == [(9004,)], "the control proves the naive query is misled by this fixture")
check("d", counts["dir2_result"] == 0, "dir2_result=0: the newest row (seq 7, id b) is a note")
check("d", "MMD-9004" not in text, "the ref appears nowhere")

# ---------------------------------------------------------------- e: specialist vs coordinator
path = make_db("e", [(9005, "specialist finished work", "open", "prj_mmd"),
                     (9006, "coordinator finished work", "open", "prj_mmd")],
               [(9005, 1, "result", "specialist::test-engineer", "e1"),
                (9006, 1, "result", "wed11-coord", "e2")])
memory()
text, counts = run("e. specialist:: participant -> dir2_specialist, ask-owner (not close)", path)
prop = proposals(text)
check("e", counts["dir2_result"] == 2 and counts["dir2_specialist"] == 1,
      "dir2_result=2 and dir2_specialist=1")
check("e", prop.get("MMD-9005") == f"ask-owner {cycle.DIR2_OWNER}",
      f"the specialist result is proposed ask-owner {cycle.DIR2_OWNER}")
check("e", prop.get("MMD-9006") == "close", "the coordinator result is proposed close")
check("e", {r for r, p in prop.items() if p.startswith("ask-owner")} == {"MMD-9005"},
      "the ask-owner set is the specialist subset only")

# ---------------------------------------------------------------- f: second cycle re-proposes nothing
memory()
run("f1. first cycle (memory is empty)", path)
text, counts = run("f2. second cycle -> nothing re-proposed, count unchanged", path)
check("f", counts["dir2_proposed"] == 0 and counts["dir2_held"] == 2,
      "proposed=0 and both refs held by the memory")
check("f", counts["dir2_result"] == 2 and counts["dir2_specialist"] == 1,
      "the counts are the TRUE counts, not the batch size")
check("f", "### Proposals" not in text, "no proposal block is printed")

# ---------------------------------------------------------------- g: 8-day-old proposal
memory(days_ago=8)
text, counts = run("g. proposal 8 days old -> re-proposed", path)
check("g", counts["dir2_proposed"] == 2 and counts["dir2_held"] == 0,
      "both refs are re-proposed after 7 days")

# ---------------------------------------------------------------- h: missing DB file
memory()
missing = os.path.join(TMP, "does-not-exist.db")
text, counts = run("h. missing DB file -> READ-FAILED, no batch", missing)
check("h", counts["dir2_result"] == "READ-FAILED" and counts["dir2_specialist"] == "READ-FAILED",
      "both counts are READ-FAILED, never 0")
check("h", "DIR2-GATE-ERROR db read failed for" in text, "the gate error is logged")
check("h", counts["dir2_proposed"] == 0 and "### Proposals" not in text, "no batch is written")
check("h", not os.path.exists(missing), "and the read did not create the file")

# ---------------------------------------------------------------- i: wrong schema
wrong = os.path.join(TMP, "wrong-schema.db")
con = sqlite3.connect(wrong)
con.execute("create table issues (id text primary key, title text)")   # no human_number, no journal
con.commit()
con.close()
memory()
text, counts = run("i. DB with the wrong schema -> READ-FAILED, not a traceback", wrong)
check("i", counts["dir2_result"] == "READ-FAILED" and counts["dir2_specialist"] == "READ-FAILED",
      "both counts are READ-FAILED")
check("i", "DIR2-GATE-ERROR db read failed for" in text, "the gate error names the schema failure")
check("i", counts["dir2_proposed"] == 0 and "### Proposals" not in text, "no batch is written")

print()
if FAILED:
    print(f"FAILED: {len(FAILED)}")
    for f in FAILED:
        print("  -", f)
    sys.exit(1)
# --- case (j): the EVIDENCE column reads result_json.summary, not semantic_json ---------------
# A result on this build keeps its payload in result_json and leaves semantic_json as '{}': reading
# semantic/mechanical alone reported 0 of 63 real results on 2026-11-13. This case pins the fix, and
# also pins the fallback for entries written before result_json existed.
import json as _json
_j = db_path("j_evidence")
if os.path.exists(_j):
    os.remove(_j)
_c = sqlite3.connect(_j)
_c.execute(ISSUES_DDL)
_c.execute(JOURNAL_DDL)
_c.execute("insert into issues (id, project_id, human_number, kind, title, lifecycle_state, created_at, "
           "updated_at) values ('iss_j1','prj_mmd',9001,'task','evidence probe','open',1,1)")
_c.execute("insert into issue_journal (id, issue_id, issue_revision, sequence, participant_id, kind, "
           "created_at, semantic_json, result_json) values (1,'iss_j1',1,1,'wed11-coord','result',1,?,?)",
           ('{}', _json.dumps({"resultVersion": 1, "summary": "result_json summary only"})))
_c.execute("insert into issue_journal (id, issue_id, issue_revision, sequence, participant_id, kind, "
           "created_at, semantic_json, result_json) values (2,'iss_j1',1,2,'wed11-coord','result',2,?,NULL)",
           (_json.dumps({"summary": "legacy semantic-only entry"}),))
_c.commit(); _c.close()
_t, _c2 = run("j_evidence", _j)
if _c2.get("dir2_evidence") != 1:
    FAILED.append("case j: dir2_evidence should be 1, got %r" % (_c2.get("dir2_evidence"),))
if "legacy semantic-only entry" not in _t:
    FAILED.append("case j: the newest entry's evidence (semantic fallback) is missing from the batch")
print("\n[j] evidence: dir2_evidence=%r, text carries the fallback=%r"
      % (_c2.get("dir2_evidence"), "legacy semantic-only entry" in _t))

if FAILED:
    print(f"FAILED: {len(FAILED)}")
    for f in FAILED:
        print("  -", f)
    sys.exit(1)
print("PASS: all ten cases (a-j)")
sys.exit(0)

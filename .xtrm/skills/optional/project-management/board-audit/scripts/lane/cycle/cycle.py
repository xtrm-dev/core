#!/usr/bin/env python3
"""Board helper lane cycle. Read-only against Jira, Substrate and GitHub (one repair: check 13).

Checks in the contract's order:
  1 hygiene filters (config key hygiene_filters), each run as its own saved JQL, each with a
    positive and a negative control taken from rows whose answer is known by eye
  2 window health: past-end windows, missing date/slot fields, no parent, date tokens in
    summaries (the saved predicate) with time tokens reported separately, zero-comment windows
  2b open PRs with no covering window and no no-window exception (Jira keys and Substrate refs)
  3 finished-not-closed backlog over EVERY post-cut-off row (operator 2026-10-28): a Jira row still
    not Done while delivery evidence exists (hygiene-1193's rank ladder: substrate_closed /
    deployed / substrate_result, with the shared-ref and pre-slot tiers kept visible), plus a
    merged PR whose Jira ticket sits on no window at all. Two controls (hygiene class-A rows must
    still be flagged; a row inside an unfinished slot must not) - a loose instrument reports a number,
    not a backlog.
  4 PR-link top-up: PRs merged today, formal link comment present or missing
  5 comment watch: comments newer than $PM_LANE_DIR/cycle/comment-cursor
  6 R2 verdict posts (optional, config key r2): staged verdict files vs the verdict lines
    already on the verdict ticket, with a glob-vs-scandir guard because a short glob is an
    incomplete answer, not a negative one

Settings: board-audit/references/setup-lane.md.

Writes nothing to Jira, Substrate or GitHub. Prints markdown; the caller saves CYCLE-<HHMM>Z.md.
"""
import glob
import importlib.util
import json
import os
import re
import resource
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import lanecfg  # noqa: E402  (lane settings; see board-audit/references/setup-lane.md)

JIRA_PY = str(lanecfg.pm_config.jira_py())
REPO = lanecfg.repo()
LANE = os.path.join(lanecfg.lane(), "cycle")
PROJECT = lanecfg.project()             # Jira project key
SB = lanecfg.sb_prefix()                # Substrate key prefix
SB_RE = re.escape(SB)
SB_PROJECT_ID = lanecfg.sb_project_id()
REPO_NAME = lanecfg.repo_name()
KEY_RE = lanecfg.jira_key_re()          # a Jira key of this project
KEY_NUM_RE = lanecfg.jira_key_re(group=True)
SLOT_START = lanecfg.custom_field("window_start")
SLOT_END = lanecfg.custom_field("window_end")
START_DATE = lanecfg.custom_field("start_date")
CF_START = lanecfg.cf_num("window_start")
CF_END = lanecfg.cf_num("window_end")
STATUSES = lanecfg.statuses()
CONTROLS = lanecfg.data("PM_CYCLE_CONTROLS", {}) or {}
# The ticket whose comments record the no-window exceptions (check 8). Unset means no exceptions.
EXCEPTIONS_EPIC = lanecfg.get("PM_EXCEPTIONS_EPIC")


def _deep_control_args():
    """--control/--control-expect for deep-dup-probe.py: a Substrate ref whose Jira duplicate is known."""
    ref, expect = CONTROLS.get("deep_probe_control"), CONTROLS.get("deep_probe_control_expect")
    if not ref:
        return []
    return ["--control", ref] + (["--control-expect", expect] if expect else [])
WATCH_WINDOW = "-2h"  # comment-watch lookback; must exceed the cycle leg (see the note at the JQL)
CURSOR = f"{LANE}/comment-cursor"
OWN_WRITES = f"{LANE}/own-writes.txt"
AGENT_HEADER = re.compile(r"^\[agent:[^\]]*\]\s*")
# Any comment that ENDS with this lane's agent tag is this lane's own write, whatever the posting path.
OWN_TAG = re.compile(r"\[agent:[^\]]*\|\s*run:[^\]]*\]\s*$")
# R2 verdict feed (optional; config key r2). Unset means check 6 reports "not configured".
R2 = lanecfg.data("PM_R2", {}) or {}
_x = lambda v: os.path.expanduser(v) if v else None  # noqa: E731
R2_ISSUE = R2.get("issue")
R2_POSTS = _x(R2.get("posts_dir"))
R2_WATERMARK = _x(R2.get("watermark")) or os.path.join(LANE, "r2-watermark.json")
R2_STATE = _x(R2.get("state"))
R2_LOG_GLOB = R2.get("log_glob") or "/var/tmp/background-*/background-bg_*.log"
R2_CONTROL = R2.get("control") or {}
VERDICT_LINE = re.compile(r"^(VERIFIED(?:-WITH-CAVEAT)?|FAIL) (\d{4}-\d{2}-\d{2})-(b\d+)-")
ORDERING_CAVEAT = "caveated on timestamp ordering (C3 monotonicity)"
STATE_DB = os.path.expanduser("~/.xtrm/state.db")
NEWTICKET_WATERMARK = f"{LANE}/newtickets-watermark.json"
# Check 7b (coordinator 2026-11-04 05:27Z): the DEEP duplicate pass runs in-cycle for rows the probe
# has not seen. The probe itself is deep-dup-probe.py, which carries its own positive control; this glue
# only decides which rows to feed it and reports what came back, as CANDIDATES and never as a verdict.
SLOT_LABEL_MAX = 10  # a cycle that repairs more than ten labelled rows is a sweep, not a repair
OPERATOR_ACCOUNT_ID = lanecfg.operator_account_id()  # "newest comment is the operator's" means the board owes an answer
DEEP_PROBE = str(lanecfg.SCRIPTS / "deep-dup-probe.py")
DEEP_SEEN = f"{LANE}/deep-dup-seen.json"
DEEP_MAX_PER_CYCLE = 8
DEEP_TIMEOUT_S = 420

# Drift accounting the coordinator ordered on 2026-11-04 (see the d/e lines in check_status_drift).
DRIFT_PARENTS = f"{LANE}/drift-parents.json"
THEME_EPICS = set(lanecfg.data("PM_THEME_EPICS", []))
CONTRACT_SECTIONS = ("problem", "success", "scope", "non_goals", "constraints", "validation", "output")
# Production-scope markers for check 8 (coordinator ruling 2026-10-28): a contract that changes what
# production serves or stores needs a window row on the board; a smoke test or a research sweep does not.
# The repository's own paths and service names come from config key prod_path_regex. Include the
# package that computes served values and the read path: a contract that changes either changes
# production even when no config, schema or service name appears in its scope (measured cost of that
# widening on one snapshot: 11 -> 16 unwindowed items, nothing lost).
PROD_PATH_RE = re.compile(lanecfg.get(
    "PM_PROD_PATH_REGEX",
    r"alembic/|migrations?/|create table|alter table|drop table"
    r"|docker compose|compose\.ya?ml|make (deploy|migrate|rollback)"), re.IGNORECASE)
# Horizon for check 8: a production-scope contract should carry a window row within a week of being
# attested READY. Calibrated 2026-10-28 on state.db: 3 days = 4 rows, 7 days = 18, 14 days = 29; the
# 14-day tail is mostly contracts that were already worked and closed their PRs, so 7 days is the
# point where a missing row is a defect rather than history.
UNMIRRORED_HORIZON_DAYS = 7
# An UMBRELLA is a contract whose SCOPE lists at least this many OTHER pieces of work
# (coordinator ruling 2026-10-28). One listed ref is a cross-reference, not a list: a contract that
# names two PRs about one other ref, or one ref as its root cause, is not a builder listing work, and
# keeps its plain verdict.
UMBRELLA_MIN_ITEMS = 2
ITEM_MMD_RE = re.compile(SB_RE + r"-\d{4,}")
# WINDOWED means a ref a window row CARRIES, not a ref it merely mentions (wed2-coord ruling 2026-10-28).
# Measured before the rule: of the refs appearing on the 96 open rows, 61 were in a summary or a label and
# 53 appeared only inside a description - one of them a junk token ("SB-2" truncated in PROJ-477). An
# unbound mention reads as coverage and hides a contract, the mirror of the SB-2955 defect. A binding is
# a sentence that says the row carries the work: "carries", "folded (in)", "precondition", "deploys",
# "rides". Unbound mentions are counted and printed, never silently dropped, and the loose count is
# reported beside the strict one while the rule bedded in, so the delta can never drift unknown.
WINDOW_REF_RE = re.compile(SB_RE + r"-\d{4,}")
BIND_VERBS = r"(carries|carrying|folded|deploys|deployed|binds|rides)"


def binds(ref, sentence):
    """How a sentence binds ref to a window row, or None.

    A keyword CO-OCCURRING with a ref is not a binding: measured on four candidate rows, the loose rule
    accepted "It depends on the infrastructure reload that SB-2322 carries" (the row depends on the
    contract, it does not carry it) and "The SB-2764 report in PR #1064 names the backfill as a
    precondition" (the precondition is the backfill's, not the row's). Both are the co-occurrence
    fallacy at sentence scale. So the ref must be the OBJECT of the binding ("carries ... SB-2701",
    "Binds Substrate SB-2913"), the subject of a passive one ("SB-2330 is carried by this window"),
    or the thing named as this row's precondition - never merely nearby.
    """
    r = re.escape(ref)
    # Clauses, not sentences: "...the reload that SB-2322 carries, and SB-2322 is still OPEN" puts a
    # verb and the same ref in one sentence across a comma, which read as a binding until this split.
    for clause in re.split(r"[,;:]", sentence):
        if re.search(rf"\b{BIND_VERBS}\b[^.;]{{0,40}}?{r}", clause, re.IGNORECASE):
            return "object"
        if re.search(rf"{r}[^.;]{{0,24}}\b(is|are)\b[^.;]{{0,14}}(carried|folded|deployed|bound)",
                     clause, re.IGNORECASE):
            return "passive"
        if re.search(rf"{r}[^.;]{{0,18}}\bprecondition\b", clause, re.IGNORECASE):
            return "precondition"
    return None
WINDOW_BINDING_RULE = True
# Refs a window row does NOT need, recorded once in a comment on the project Epic (SB-3017 batch B10:
# SB-2795 and SB-2914, ops and deploy tooling that go live with a promotion instead of a window).
# Parsed live from the newest comment carrying this heading rather than hard-coded: the comment is the
# record, and a change of wording makes the refs reappear as findings (fail loud) instead of staying
# silently exempt.
EXCEPTION_HEADING = "No-window exceptions recorded"
# Refs inside a class: "Substrate SB-nnnn" in the B10/B14 shape, a bare "SB-nnnn" in the B16 shape,
# several per line. Keyed on the ref form itself so a format change cannot silently exempt nothing.
EXCEPTION_REF_RE = re.compile(SB_RE + r"-\d{4,}")
EXCEPTION_CLASS_RE = re.compile(r"\(([a-z0-9]{1,2})\)\s+")
# A class body ENDS where the record stops talking about exemptions: "Bound instead of exempted: ...",
# "Bound in B16: ..." and "Ruling: ..." are bindings and provenance, not classes. Without the cut the last
# class swallowed them and SB-3019 / SB-2236 / SB-2764 were attributed to class (i) as provisional
# duplicates, and SB-2701 / SB-2913 / SB-3017 were read as exempt (measured 2026-10-28).
EXCEPTION_CLASS_END_RE = re.compile(r"\bBound (instead|in)\b|\bRuling:", re.IGNORECASE)
EXCEPTION_EXEMPT_RE = re.compile(
    r"no window needed|infra-owned|no service deploy|ops tooling|deploy tooling|post-11-05", re.IGNORECASE)
EXCEPTION_FINDING_RE = re.compile(r"no window yet|stale|duplicate|provisional|awaiting", re.IGNORECASE)
# A CLOSED class is neither an exemption nor a finding: the lane says the ref is done, so it should not be
# a candidate at all. It never exempts - if a claimed closure is wrong, the ref stays visible (safe direction).
EXCEPTION_CLOSED_RE = re.compile(r"\bclosed by the lane\b|\bcancelled\b", re.IGNORECASE)
# A PR reference in free text, in either accepted form: the legacy '#1126' (contracts and comments
# written before 2026-10-29 carry it) and the URL form '/pull/1126' the operator requires since then.
# The digits-then-not-a-digit tail keeps 11260 from matching 1126. One rule, every reader: this exact
# duplication is what let the URL rewrite silently expire the #1126 no-window exception on 2026-10-29.
PR_MENTION_RE = re.compile(r"#(\d+)(?!\d)|/pull/(\d+)(?!\d)")


def mentions_pr(body, number):
    """True when a body names this PR, in either accepted form (see PR_MENTION_RE)."""
    return any(int(a or b) == number for a, b in PR_MENTION_RE.findall(body))
# A contract whose SCOPE is a read-only review, an audit or coordination makes no production change, so it
# needs no window (wed2-coord ruling 2026-10-28, after SB-3017 audited this list: SB-2852, 2871, 2872 and
# 2944 were false positives). The exclusion is deliberately literal rather than inferred: a contract that
# reviews AND changes keeps its row, because none of these markers appears in its scope.
READONLY_SCOPE_RE = re.compile(
    r"\bread[\s-]only\b|\bpr-reviewer\b|\bzero production changes\b|\bno production changes\b"
    r"|\bAUDIT-[A-Z][A-Za-z-]+\.(md|json)\b|\bis coordination\b|\bcoordination task\b"
    # "re-run the audit" added on wed2-coord's ruling 2026-10-28 (SB-2330: a query re-run inside the
    # SB-2714 DST umbrella is an audit, not a production change; the excluded item is printed by name
    # every cycle, so an audit that DOES change something would show up as an exclusion, not vanish).
    r"|\bre-?runs? the audit\b", re.IGNORECASE)
# Standing negative control for check 8: a read-only review contract that was flagged before the exclusion
# existed. If SB-2852 is ever closed, the control falls back to "some contract was excluded" and says so.
READONLY_CONTROL_REF = CONTROLS.get("readonly_control_ref", "")
# A LANE contract drives other refs to merge-ready inside windows; it is real work but it makes no production
# change of its own, so it needs no window of its own - its items are judged on their own rows (wed2-coord
# ruling 2026-10-28: "EXCLUDE them like audits, by name, printed. Their items are counted on their own").
# Literal and narrow on purpose: every alternative needs a word that only a lane contract uses, so a
# production contract that happens to say "lane" (a feed lane, an ingest lane) keeps its row.
LANE_SCOPE_RE = re.compile(
    r"\bopen[\s-]pr lane\b|\blane contract\b|\bdrives? (other|feature) (refs|prs)\b"
    r"|\bto merge-ready\b|\bdrive " + re.escape(REPO_NAME) + r" feature PRs\b", re.IGNORECASE)
# Standing negative control for the lane rule: SB-3012 is the open-PR lane contract the ruling named. While it
# is open it must be excluded; if it closes, the line says so rather than silently reporting a clean zero.
LANE_CONTROL_REF = CONTROLS.get("lane_control_ref", "")

spec = importlib.util.spec_from_file_location("jira", JIRA_PY)
jira = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jira)

# Comment-text rules shared with the write paths (post-prlink.py, post-r2.py, go-post.py).
# The agent header is the first paragraph of every comment since 2026-10-28T14:00Z, so every
# detector that asks "what does this comment open with" must step over it (LANE-RULES 21).
def _robust_call(fn):
    """Retry the module's HTTP call on a transient failure.

    The 09:18Z cycle died with `URLError: [Errno 104] Connection reset by peer` inside one comment fetch, and
    a single reset cost a whole pass: no counts block, so the digest reported CYCLE-RUN-FAIL and every check
    in that cycle went unmeasured. Read-only monitoring must survive a reset, a timeout and a 5xx; it must NOT
    retry a 4xx, because that is an answer, not a failure.
    """
    import time as _time

    def call(method, path, body=None, *_a, **_kw):
        last = None
        for attempt in range(3):
            try:
                st, out = fn(method, path, body)
                if isinstance(st, int) and st >= 500 and attempt < 2:
                    last = (st, out)
                    _time.sleep(2 + 3 * attempt)
                    continue
                return st, out
            except Exception as exc:  # noqa: BLE001 - URL errors, resets, timeouts all land here
                last = exc
                if attempt == 2:
                    raise
                _time.sleep(2 + 3 * attempt)
        if isinstance(last, tuple):
            return last
        raise last
    return call


jira.call = _robust_call(jira.call)

_js = importlib.util.spec_from_file_location("jiratext", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                                     "jiratext.py"))
jiratext = importlib.util.module_from_spec(_js)
_js.loader.exec_module(jiratext)

# The three saved hygiene filters (config key hygiene_filters: role -> {"id", "name"}). The filter id is
# also the counts key, so the digest lines keep the board's own filter numbers.
_HF = lanecfg.data("PM_HYGIENE_FILTERS", required=True)
FID_NO_DATES = str(_HF["open_without_dates"]["id"])
FID_OVERDUE = str(_HF["overdue"]["id"])
FID_NEXT48 = str(_HF["next_48h"]["id"])
PREDICATES = {
    FID_NO_DATES: 'type in (Task, Story) AND statusCategory != Done AND duedate is EMPTY',
    FID_OVERDUE: f'labels = window AND cf[{CF_END}] < now() AND statusCategory != Done',
    FID_NEXT48: (f'labels = window AND cf[{CF_START}] >= now() AND cf[{CF_START}] <= 48h '
                 f'AND statusCategory != Done'),
}
FILTERS = {
    FID_NO_DATES: (_HF["open_without_dates"]["name"], f"project = {PROJECT} AND " + PREDICATES[FID_NO_DATES]),
    FID_OVERDUE: (_HF["overdue"]["name"], f"project = {PROJECT} AND " + PREDICATES[FID_OVERDUE]),
    FID_NEXT48: (_HF["next_48h"]["name"], f"project = {PROJECT} AND " + PREDICATES[FID_NEXT48]),
}
FIELDS = ["key", "summary", "status", "duedate", "parent", "labels", "assignee", "issuetype",
          START_DATE, SLOT_START, SLOT_END, "comment", "updated"]
# A folded row follows its target's slot, so its own slot fields stay empty (verification.md:72). That
# exemption is only valid while the target is a live window carrying a slot: a fold into a retired,
# Done or slotless target orphans the row, and nothing else on the board would say so.
FOLD_LABEL = re.compile(r"^folded-into:(" + KEY_RE + r")$", re.I)
DATE_TOKEN = re.compile(r"\b(\d{4}-\d{2}-\d{2}|\d{1,2}-\d{1,2})\b")
TIME_TOKEN = re.compile(r"\b\d{1,2}:\d{2}\b")


def stamp():
    return subprocess.run(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"],
                          capture_output=True, text=True).stdout.strip()


def jql(query, fields=None, limit=2000):
    rows, token = [], None
    while True:
        body = {"jql": query, "maxResults": 100, "fields": fields or FIELDS}
        if token:
            body["nextPageToken"] = token
        st, d = jira.call("POST", "/rest/api/3/search/jql", body)
        if st != 200:
            return rows, False
        rows.extend(d.get("issues") or [])
        token = d.get("nextPageToken")
        if d.get("isLast") or not token or len(rows) >= limit:
            return rows, bool(d.get("isLast"))


def row_of(i):
    f = i["fields"]
    st = f.get("status") or {}
    return {
        "key": i["key"],
        "summary": f.get("summary") or "",
        "status": st.get("name"),
        "category": (st.get("statusCategory") or {}).get("key"),
        "type": (f.get("issuetype") or {}).get("name"),
        "due": f.get("duedate"),
        "slotStart": f.get(SLOT_START),
        "slotEnd": f.get(SLOT_END),
        "parent": (f.get("parent") or {}).get("key"),
        "labels": f.get("labels") or [],
        "assignee": (f.get("assignee") or {}).get("displayName"),
        "comments": (f.get("comment") or {}).get("total"),
    }


def to_utc(stored):
    if not stored:
        return "-"
    try:
        return datetime.fromisoformat(stored).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    except ValueError:
        return stored


def gh(args, timeout=150):
    p = subprocess.run(["gh"] + args, capture_output=True, text=True, cwd=REPO, timeout=timeout)
    if p.returncode != 0:
        return p.stderr.strip()[:300]
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        return "non-JSON output"


def flat_body(comment):
    """Plain text of an ADF body, whatever its shape.

    Two defects taught this the hard way, both on operator comments:
    - a mention node was dropped, so a comment that opened with a real mention read as an untagged
      "ok." (PROJ-489 c16360, PROJ-198 c16361);
    - only paragraphs were walked, so an ordered list of answers rendered as nothing at all
      (PROJ-468 c16379: the operator answered all three questions in list items and the digest showed
      "@xtrm-bot " with an empty body).
    The walker is therefore shape-agnostic: every node is visited, text and mentions are kept, and block
    boundaries become newlines so a list does not run its items together.
    """
    BLOCK = {"paragraph", "heading", "listItem", "blockquote", "codeBlock", "panel", "rule", "tableRow"}
    out = []

    def walk(node):
        if isinstance(node, list):
            for n in node:
                walk(n)
            return
        if not isinstance(node, dict):
            return
        t = node.get("type")
        if t == "text":
            out.append(node.get("text", ""))
        elif t == "mention":
            txt = str((node.get("attrs") or {}).get("text") or "?")
            out.append(txt if txt.startswith("@") else "@" + txt)
        elif t == "hardBreak":
            out.append("\n")
        elif t in ("inlineCard", "mediaInline"):
            out.append(str((node.get("attrs") or {}).get("url") or ""))
        for child in node.get("content") or []:
            walk(child)
        if t in BLOCK:
            out.append("\n")
        if t in ("bulletList", "orderedList"):
            out.append("\n")

    walk((comment.get("body") or {}))
    text = "".join(out)
    return re.sub(r"\n{3,}", "\n\n", text)


def all_comments(key):
    comments, start = [], 0
    while True:
        st, d = jira.call("GET", f"/rest/api/3/issue/{key}/comment?startAt={start}&maxResults=100")
        if st != 200:
            return comments
        batch = d.get("comments") or []
        comments.extend(batch)
        start += len(batch)
        if not batch or start >= (d.get("total") or 0):
            return comments


def check_filters(out, counts):
    out.append("## 1. Hygiene filters (each run as its own saved JQL)\n")
    results = {}
    for fid, (name, where) in FILTERS.items():
        rows, complete = jql(where + " ORDER BY created DESC")
        parsed = [row_of(r) for r in rows]
        results[fid] = parsed
        flag = "" if complete else " **(INCOMPLETE PAGE — count is a lower bound)**"
        out.append(f"- **{fid} {name}** — {where}")
        out.append(f"  - rows: **{len(parsed)}**{flag}")
        counts[fid] = len(parsed)
        if fid == FID_NO_DATES:
            subset = [r for r in parsed if "window" in r["labels"]]
            counts[f"{FID_NO_DATES}_window"] = len(subset)
            out.append(f"  - of which carry `labels = window` (a missing date there is a defect, "
                       f"elsewhere it is a state): **{len(subset)}**")
            for r in subset:
                out.append(f"    - {r['key']} | {r['status']} | due missing | parent {r['parent'] or 'NONE'} "
                           f"| owner {r['assignee'] or '-'} | {r['summary'][:58]}")
        if fid == FID_OVERDUE:
            for r in parsed:
                out.append(f"    - {r['key']} | end {to_utc(r['slotEnd'])} | {r['status']} | {r['summary'][:55]}")
        if fid == FID_NEXT48:
            for r in parsed:
                out.append(f"    - {r['key']} | start {to_utc(r['slotStart'])} | {r['status']} | {r['summary'][:55]}")

    out.append("\n**Controls** (positive must match, negative must not):")
    # CONTROLS USE AN INDEPENDENT ORACLE, NOT THE RESULT SET UNDER TEST. Two revisions were needed
    # to get here, and the wrong one is recorded because it looked tidier:
    #   v1 (broken) pinned fixtures: the next-48h positive was pinned to one row, whose slot started
    #      at 07:50Z, so at 08:13Z it printed CONTROL FAILED while the predicate was correct.
    #   v2 (also broken) derived each pole from results[fid]: a predicate that is too NARROW empties
    #      its own result set, the pole vanishes, and the control downgrades to an INSTRUMENT GAP
    #      instead of failing. ctl-cycle-controls.py A2 proved it: a 48h window mutated to 1m
    #      reported failures=0 and gaps=2 - a control that fails open is worse than none.
    #   v3 (this) computes the expected membership in Python from the RAW field values and my own
    #      clock, over the unfiltered superset, then asks JQL whether it agrees. A wrong predicate
    #      cannot empty the oracle, so it fails the control as it should.
    now = datetime.now(timezone.utc)

    def dt_of(stored):
        try:
            return datetime.fromisoformat(stored).astimezone(timezone.utc)
        except (AttributeError, TypeError, ValueError):
            return None

    win_rows, _ = jql(f'project = {PROJECT} AND labels = window AND statusCategory != Done', limit=300)
    win = [row_of(r) for r in win_rows]
    task_rows, _ = jql(f'project = {PROJECT} AND type in (Task, Story) AND statusCategory != Done', limit=300)
    task = [row_of(r) for r in task_rows]
    inside48, before, past_end, end_ahead, no_due, has_due = [], [], [], [], [], []
    for r in win:
        s, e = dt_of(r["slotStart"]), dt_of(r["slotEnd"])
        if s and now <= s <= now + timedelta(hours=48):
            inside48.append(r["key"])
        if s and s < now:
            before.append(r["key"])
        if e and e < now:
            past_end.append(r["key"])
        if e and e >= now:
            end_ahead.append(r["key"])
    for r in task:
        (has_due if r["due"] else no_due).append(r["key"])

    poles = {
        f"{FID_NO_DATES} positive": no_due[-1] if no_due else None,
        f"{FID_NO_DATES} negative": has_due[0] if has_due else None,
        f"{FID_OVERDUE} positive": past_end[0] if past_end else None,
        f"{FID_OVERDUE} negative": end_ahead[0] if end_ahead else None,
        f"{FID_NEXT48} positive": inside48[-1] if inside48 else None,
        f"{FID_NEXT48} negative": before[0] if before else None,
    }
    predicates = {label: PREDICATES[label.split()[0]] + " AND key = {}" for label in poles}
    failed = gaps = 0
    for label, predicate in predicates.items():
        key = poles[label]
        if not key:
            gaps += 1
            out.append(f"- {label}: NO CANDIDATE on the board — **INSTRUMENT GAP** (not a control failure: "
                       f"an empty pole means the board holds no row of that shape right now)")
            continue
        rows, _ = jql(f'project = {PROJECT} AND ' + predicate.format(key), fields=["key"], limit=5)
        want_hit = "positive" in label
        ok = (len(rows) > 0) == want_hit
        failed += 0 if ok else 1
        out.append(f"- {label}: {len(rows)} row(s) on {key} — {'OK' if ok else '**CONTROL FAILED**'}")
    counts["control_failures"] = failed
    counts["control_gaps"] = gaps
    return results


def fold_orphan_scan(parsed):
    """(fold pairs, orphans) for one window snapshot. Extracted so the control can drive the same code
    with synthetic rows instead of asserting that the live board happens to look right."""
    by_key = {r["key"]: r for r in parsed}
    pairs = [(r, FOLD_LABEL.match(l).group(1)) for r in parsed for l in (r.get("labels") or [])
             if FOLD_LABEL.match(l)]
    orphans = []
    for r, target in pairs:
        t = by_key.get(target)
        if not t or not t.get("slotStart") or not t.get("slotEnd"):
            orphans.append((r["key"], target, "target is not an open window" if not t
                            else "target carries no slot"))
    return pairs, orphans


def check_windows(out, results, counts):
    out.append("\n## 2. Window health\n")
    rows, complete = jql(f'project = {PROJECT} AND labels = window AND statusCategory != Done')
    parsed = [row_of(r) for r in rows]
    no_parent = [r for r in parsed if not r["parent"]]
    no_slot = [r for r in parsed if not r["slotStart"] or not r["slotEnd"]]
    no_date = [r for r in parsed if not r["due"]]
    date_title = [r for r in parsed if DATE_TOKEN.search(r["summary"])]
    time_title = [r for r in parsed if not DATE_TOKEN.search(r["summary"]) and TIME_TOKEN.search(r["summary"])]
    zero_comments = [r for r in parsed if (r["comments"] or 0) == 0]

    out.append(f"- open windows (labels = window, not Done): **{len(parsed)}**"
               + ("" if complete else " — page incomplete"))
    out.append(f"- past its end slot ({FID_OVERDUE} predicate): **{len(results[FID_OVERDUE])}**")
    out.append(f"- missing a slot field: **{len(no_slot)}** {[r['key'] for r in no_slot][:14]}")
    fold_rows, fold_orphans = fold_orphan_scan(parsed)
    out.append(f"- folded rows: **{len(fold_rows)}**, fold targets live and slotted: "
               f"**{len(fold_rows) - len(fold_orphans)}**, **orphaned: {len(fold_orphans)}**"
               + (" — " + "; ".join(f"{k} -> {t} ({why})" for k, t, why in fold_orphans[:8]) if fold_orphans else ""))
    # self-control: the predicate must flag a fold into a key that is not on the board, and must not flag
    # a fold into a real slotted row. Without it an "0 orphaned" is indistinguishable from a dead loop.
    tgt = fold_rows[0][1] if fold_rows else f"{PROJECT}-1"
    live = [{"key": tgt, "labels": [], "slotStart": "a", "slotEnd": "b"},
            {"key": f"{PROJECT}-900001", "labels": [f"folded-into:{tgt}"], "slotStart": None, "slotEnd": None}]
    _p, pos = fold_orphan_scan(live)
    gone = [{"key": f"{PROJECT}-900002", "labels": [f"folded-into:{PROJECT}-999999"], "slotStart": None,
             "slotEnd": None}]
    _p2, pos2 = fold_orphan_scan(gone)
    nslot = [{"key": tgt, "labels": [], "slotStart": None, "slotEnd": None},
             {"key": f"{PROJECT}-900003", "labels": [f"folded-into:{tgt}"], "slotStart": None, "slotEnd": None}]
    _p3, pos3 = fold_orphan_scan(nslot)
    sc = (pos == [] and len(pos2) == 1 and len(pos3) == 1)
    out.append(f"- fold-liveness control: {'PASS' if sc else '**FAILED — the checker itself is broken**'}"
               f" (negative: a fold into a live slotted row is not flagged; positive: a fold into an absent "
               f"key is, and so is a fold into a target with no slot)")
    counts["fold_rows"] = len(fold_rows)
    counts["fold_orphans"] = len(fold_orphans)
    # A folded row follows its target's slot, so its own date is never the thing that raises it. Once the
    # target is slotted the fold is "healthy" and the row's own past due date is the only remaining signal
    # (B289: a row due 2026-10-29, folded into another). Counter kept separate from fold_orphans so
    # a healthy fold with a stale date cannot be read as a broken one.
    today = stamp()[:10]
    fold_stale = [r["key"] for r in parsed
                  if any(FOLD_LABEL.match(l) for l in (r.get("labels") or []))
                  and r.get("due") and r["due"] < today]
    out.append(f"- folded rows whose own due date is past (a healthy fold hides these): **{len(fold_stale)}**"
               f" {[(k, next((r['due'] for r in parsed if r['key'] == k), None)) for k in fold_stale][:10]}")
    counts["fold_stale"] = len(fold_stale)
    # B290: a folded row's date is cleared by ruling, so it must not be read as a missing-date defect in
    # the open-without-dates window subset. Counted separately so that subset stays an honest defect list.
    fold_dateless = [r["key"] for r in parsed
                     if any(FOLD_LABEL.match(l) for l in (r.get("labels") or [])) and not r.get("due")]
    out.append(f"- folded rows with NO date (by ruling B290, not a {FID_NO_DATES} defect): **{len(fold_dateless)}**"
               f" {fold_dateless[:10]}")
    counts["fold_dateless"] = len(fold_dateless)
    gate_rows = [(r, l) for r in parsed for l in (r.get("labels") or []) if l.lower().startswith("gate:")]
    gate_escalations = check_gates(out, gate_rows, today)
    counts["gate_rows"] = len(gate_rows)
    counts["gate_escalations"] = len(gate_escalations)
    out.append(f"- missing a due date: **{len(no_date)}** {[r['key'] for r in no_date][:14]}")
    out.append(f"- no parent: **{len(no_parent)}** {[r['key'] for r in no_parent][:14]}")
    out.append(f"- **date token in the summary** (the saved predicate `summary ~ \"10-*\"`): "
               f"**{len(date_title)}** {[(r['key'], DATE_TOKEN.search(r['summary']).group(1)) for r in date_title][:10]}")
    out.append(f"- time token only, no date (reported separately, not the saved predicate): "
               f"{[r['key'] for r in time_title][:10]}")
    out.append(f"- zero comments: **{len(zero_comments)}** {[r['key'] for r in zero_comments][:14]}")
    counts["windows_open"] = len(parsed)
    counts["date_in_title"] = len(date_title)
    counts["no_slot"] = len(no_slot)


# Other repositories a gate label may name: config key gate_repos, {"<short-name>": "<owner>/<repo>"}.
GATE_REPOS = lanecfg.data("PM_GATE_REPOS", {}) or {}
_GATE_ALT = "|".join(re.escape(k) for k in GATE_REPOS) or "(?!)"
GATE_PR = re.compile(r"^gate:(?:(" + _GATE_ALT + r")-)?(?:PR-)?(\d+)$", re.I)
GATE_ISSUE = re.compile(r"^gate:(" + KEY_RE + r")$", re.I)


def gate_state(label):
    """('resolved'|'open'|'unknown', detail) for one gate label. Measured, never inferred from the row.

    gate:PR-918            -> delivery repository PR 918
    gate:<repo>-62         -> PR 62 in GATE_REPOS[<repo>]
    gate:PROJ-604          -> Jira row status category
    """
    m = GATE_PR.match(label)
    if m:
        repo = next((v for k, v in GATE_REPOS.items() if k.lower() == m.group(1).lower()), None) if m.group(1) else None
        num = m.group(2)
        d = gh((["pr", "view", num] + (["--repo", repo] if repo else []) +
                ["--json", "state,mergedAt,isDraft"]))
        if not isinstance(d, dict):
            return "unknown", str(d)[:120]
        if d.get("state") == "MERGED":
            return "resolved", f"merged {str(d.get('mergedAt'))[:16]}"
        return "open", f"{d.get('state')}{' draft' if d.get('isDraft') else ''}"
    m = GATE_ISSUE.match(label)
    if m:
        st, d = jira.call("GET", f"/rest/api/3/issue/{m.group(1)}?fields=status")
        if st != 200:
            return "unknown", f"HTTP {st}"
        status = (d["fields"].get("status") or {})
        cat = (status.get("statusCategory") or {}).get("key")
        return ("resolved" if cat == "done" else "open"), str(status.get("name"))
    return "unknown", "label not understood"


def check_gates(out, gate_rows, today):
    """Gate watch (B289): a conditional row carries its gate as a label so the cycle can escalate the
    moment the gate moves, instead of leaving the condition in comment prose. Escalate when the gate has
    resolved (the row now owes a slot) or when the row's own deadline passed with the gate still open."""
    out.append("\n### 2b. Gate watch (conditional window rows)")
    if not gate_rows:
        out.append("- no row carries a `gate:` label")
        return []
    escalations = []
    tracked = []
    cache = {}
    for r, label in gate_rows:
        if label not in cache:
            cache[label] = gate_state(label)
        state, detail = cache[label]
        due = r.get("due")
        past = bool(due) and due < today
        if state == "resolved":
            # A slot the row already carries means nothing is owed. Until 2026-11-05 this fired the
            # "owes a slot now" line unconditionally, so two rows escalated every day
            # after they had been slotted by hand — a true gate state dressed as a live defect, which
            # is how a real escalation later gets ignored.
            if r.get("slotStart") or r.get("slotEnd"):
                out.append(f"- {r['key']} `{label}`: gate resolved ({detail}); the row already carries "
                           f"its slot ({r.get('slotStart')} -> {r.get('slotEnd')}) — nothing owed")
                continue
            # TRACKED BY DATE (lead ruling 2026-11-05T23:3xZ): a row with a FUTURE due date and no slot is
            # being tracked by that date, so it does not owe a slot yet. The case that set it: a row whose gate
            # resolved, its slot was deliberately cleared, and it waits for a real holiday session on
            # 11-26 with due 11-27. Without this the line was true but misleading once per cycle, and a
            # true line that repeats is how the next real escalation gets skimmed. Printed, not hidden.
            if due and not past:
                tracked.append((r["key"], label, due, detail))
                continue
            verdict = f"**ESCALATE: gate resolved ({detail}) — the row owes a slot now**"
        elif past:
            # A muted row still PRINTS its line, with the mute and its expiry in place of the verdict:
            # silencing the line entirely would make a live row look absent, which is worse than noise.
            muted = gate_mute(r["key"], datetime.now(timezone.utc).strftime("%Y-%m-%d"))
            if muted:
                verdict = f"muted until {muted[0]}: {muted[1]}"
            else:
                verdict = f"**ESCALATE: deadline {due} passed, gate still {state} — re-decide the row**"
        elif state == "unknown":
            verdict = f"gate state unknown ({detail}) — check it, do not assume open"
        else:
            verdict = f"open ({detail}), due {due or 'none'}"
        if verdict.startswith("**ESCALATE"):
            escalations.append((r["key"], label, verdict))
        out.append(f"- {r['key']} [{r['status']}] `{label}` -> {verdict}")
    if tracked:
        out.append(f"- tracked by date (future due, no slot, not escalated): **{len(tracked)}** "
                   + str([(k, lbl, d) for k, lbl, d, _ in tracked][:12]))
    out.append(f"- escalations: **{len(escalations)}**")
    return escalations


BINDING = re.compile(r"^Jira binding:\s*(" + KEY_RE + r")\s*$", re.M | re.I)


def gate_mute(key, today):
    """Muted key -> (until, reason) when the mute is still live, else None."""
    try:
        with open(GATE_MUTES) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split(None, 2)
                if len(parts) < 2 or parts[0] != key:
                    continue
                until, reason = parts[1], (parts[2] if len(parts) > 2 else "")
                if today <= until:
                    return until, reason
                return None
    except FileNotFoundError:
        return None
    return None


PR_DISPOSITIONS = f"{LANE}/pr-dispositions.txt"
# A gate mute is a coordinator decision with an EXPIRY, never an off switch. Format, one per line:
#   PROJ-365 2026-11-10 deferred to the sunset coordinator; morning batch will re-decide
# Past its date the mute lapses by itself, so a forgotten row starts escalating again instead of
# disappearing. WHY a file and not a label: the mute is about the WATCH, not about the ticket, and no
# label can express "stay quiet until 11-10".
GATE_MUTES = f"{LANE}/gate-mutes.txt"


def pr_disposition(number):
    """A coordinator's recorded disposition for one PR, e.g. 'draft, superseded by INFRA-1414'.
    That disposition is a HUMAN decision, not a field GitHub knows, so it lives in a lane file with
    its provenance and the cycle prints it verbatim instead of inventing a category for it."""
    try:
        with open(PR_DISPOSITIONS) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                num, _, reason = line.partition(" ")
                if num.isdigit() and int(num) == int(number):
                    return reason.strip()
    except FileNotFoundError:
        pass
    return None


def pr_bucket(pr, keys):
    """draft | no_ticket | ticket. A DRAFT is its own bucket, never an unmapped row: a held draft
    is a decision to write nothing yet, and counting it as unmapped manufactures an action item the
    coordinator then has to withdraw (a draft held and superseded by an infra ticket was reported as
    unmapped by cycle 0914Z and corrected by the coordinator the same hour)."""
    if pr.get("isDraft"):
        return "draft"
    return "ticket" if keys else "no_ticket"


def resolve_tickets(pr):
    """Jira keys, strongest evidence first: the explicit `Jira binding: <KEY>-<n>` line in the
    PR body, then the title/branch, then Substrate refs through the substrate:<ref> label.

    The binding line is parsed as a LINE, not as a body-wide key search: a body mentions other
    tickets in prose all the time ("depends on <key>", "the slot from <key>"), and
    treating those as the PR's own ticket mis-maps exactly the rows a coordinator would then act
    on. Only the declared line counts (found on a PR, 2026-10-28).
    """
    keys = []
    bound = BINDING.search(pr.get("body") or "")
    if bound:
        keys.append(bound.group(1).upper())
    text = (pr.get("title") or "") + " " + (pr.get("headRefName") or "")
    keys.extend(f"{PROJECT}-" + t for t in dict.fromkeys(re.findall(KEY_NUM_RE, text)))
    mmd = [f"{SB}-" + t for t in dict.fromkeys(re.findall(SB_RE + r"-(\d+)", text))]
    unresolved, failed = [], []
    for ref in mmd:
        rows, complete = jql(f'labels = "substrate:{ref}"', fields=["key", "labels"], limit=10)
        # A FAILED LOOKUP IS NOT AN ABSENT MIRROR. On 2026-10-28 under host load a transient Jira
        # failure made two PRs read as unmapped even though both labels
        # resolve to window-labelled rows - two false action items in one cycle, in the exact bucket
        # a coordinator acts on. Truncation is treated as failure too: the safe direction is
        # 'unknown', never 'no mirror'.
        if not complete:
            failed.append(ref)
            continue
        if rows:
            keys.extend(i["key"] for i in rows)
        else:
            unresolved.append(ref)
    return list(dict.fromkeys(keys)), unresolved, failed


def bound_windows(number):
    """Live-validate PR_BINDINGS[number]: keep only rows that exist, carry the `window` label and are not
    Done. A stale binding degrades to 'still a gap', never to silent coverage."""
    keep = []
    for key, why in PR_BINDINGS.get(number) or []:
        hits, _ = jql(f"key = {key}", fields=["key", "labels", "status"], limit=1)
        if not hits:
            continue
        f = hits[0]["fields"]
        if "window" not in (f.get("labels") or []):
            continue
        if ((f.get("status") or {}).get("statusCategory") or {}).get("key") == "done":
            continue
        keep.append((key, why, f["status"]["name"]))
    return keep


def no_window_exception(number):
    """Live-validate NO_WINDOW_EXCEPTIONS[number]: the cited ticket must still be open AND still carry a
    comment naming this PR as a no-window exception. Returns (ok, evidence-or-reason)."""
    entry = NO_WINDOW_EXCEPTIONS.get(number)
    if not entry:
        return False, ""
    key, why = entry
    hits, _ = jql(f"key = {key}", fields=["key", "status"], limit=1)
    if not hits:
        return False, f"{key} not found: exception expired, back to the gap list"
    f = hits[0]["fields"]
    status = (f.get("status") or {}).get("name", "?")
    if ((f.get("status") or {}).get("statusCategory") or {}).get("key") == "done":
        return False, f"{key} is {status}: exception expired, back to the gap list"
    for c in all_comments(key):
        body = flat_body(c).lower()
        if mentions_pr(body, number) and "no-window exception" in body:
            return True, f"{key} ({status}), ruling comment {c.get('id')}: {why}"
    return False, (f"{key} carries no comment naming PR {number} (#{number} or /pull/{number}) as a "
                   f"no-window exception: back to the gap list")


def check_pr_coverage(out, counts):
    out.append("\n## 2b. Open PRs with no covering window and no no-window exception\n")
    prs = gh(["pr", "list", "--state", "open", "--limit", "300", "--json",
              "number,title,headRefName,isDraft,labels,author,updatedAt,body"])
    if not isinstance(prs, list):
        out.append(f"- **gh failed**: {prs}")
        counts["pr_gap"] = "gh failed"
        return
    rows = {"no_ticket": [], "no_window": [], "draft": [], "lookup_failed": []}
    for p in prs:
        author = (p.get("author") or {}).get("login", "")
        if "dependabot" in author:
            continue
        names = [l.get("name") for l in (p.get("labels") or [])]
        if {"no-window", "dependencies"} & set(names):
            continue
        # drafts settle before any ticket lookup: no jql is spent on a PR that by definition is not
        # waiting on a window, and the bucket exists so it stops polluting pr_unmapped
        if pr_bucket(p, []) == "draft":
            rows["draft"].append((p["number"], pr_disposition(p["number"]) or "draft", p.get("title") or ""))
            continue
        keys, unresolved, failed = resolve_tickets(p)
        if failed:
            rows["lookup_failed"].append((p["number"], failed, bool(keys)))
            if not keys:
                continue          # unknown, not unmapped: never an action item until re-read
        if not keys:
            rows["no_ticket"].append((p["number"], unresolved))
            continue
        hits, _ = jql("key in (%s)" % ",".join(keys), fields=["key", "labels", "status"], limit=30)
        covered = any("window" in (i["fields"].get("labels") or []) for i in hits)
        if not covered and p["number"] in PR_BINDINGS:
            bound = bound_windows(p["number"])
            if bound:
                rows.setdefault("bound_by_comment", []).append((p["number"], keys, bound))
                continue
        if not covered:
            ok, ev = no_window_exception(p["number"])
            if ok:
                rows.setdefault("no_window_excepted", []).append((p["number"], keys, ev))
                continue
            rows["no_window"].append((p["number"], keys))
    out.append(f"- code PRs open: {sum(1 for p in prs if 'dependabot' not in (p.get('author') or {}).get('login',''))}"
               f" (plus {sum(1 for p in prs if 'dependabot' in (p.get('author') or {}).get('login',''))} dependabot, excluded)")
    for n, keys, bound in rows.get("bound_by_comment") or []:
        out.append(f"- bound to a window at COMMENT level, validated live, not a gap: #{n} "
                   f"({','.join(keys)} is the ref's own ticket) -> "
                   + "; ".join(f"{k} ({st})" for k, _why, st in bound))
        for k, why, _st in bound:
            out.append(f"    - {k}: {why}")
    for n, keys, ev in rows.get("no_window_excepted") or []:
        out.append(f"- NO-WINDOW EXCEPTION, validated live, not a gap: #{n} "
                   f"({','.join(keys)} deliberately carries no window) -> {ev}")
    out.append(f"- mapped to a ticket but the ticket carries no `window` label: **{len(rows['no_window'])}**")
    for n, keys in rows["no_window"][:12]:
        out.append(f"  - #{n} -> {','.join(keys)}")
    out.append(f"- no {PROJECT} key and no resolvable {SB} ref (unmapped): **{len(rows['no_ticket'])}**")
    for n, refs in rows["no_ticket"][:12]:
        out.append(f"  - #{n} {'(' + SB + ' refs without a Jira mirror: ' + ','.join(refs) + ')' if refs else ''}")
    out.append(f"- DRAFT, held on purpose (not an unmapped row, no action item): **{len(rows['draft'])}**")
    for n, why, title in rows["draft"][:12]:
        out.append(f"  - #{n} {why} | {title[:70]}")
    if rows["lookup_failed"]:
        out.append(f"- **LOOKUP FAILED** while resolving a ticket (INSTRUMENT GAP, not an unmapped row): "
                   f"**{len(rows['lookup_failed'])}**")
        for n, refs, partial in rows["lookup_failed"][:12]:
            out.append(f"  - #{n} {'partial' if partial else 'no keys'}: failed to resolve {','.join(refs)} - re-read next cycle")
    counts["pr_no_window"] = len(rows["no_window"])
    counts["pr_no_window_excepted"] = len(rows.get("no_window_excepted") or [])
    counts["pr_unmapped"] = len(rows["no_ticket"])
    counts["pr_draft"] = len(rows["draft"])
    counts["pr_lookup_failed"] = len(rows["lookup_failed"])


# The project cut-off (config key cutoff, "YYYY-MM-DD HH:MM", UTC): rows and merges before it are not
# this project's. Used verbatim in JQL, its date part in the GitHub merged: search.
CUTOFF = str(lanecfg.get("PM_CUTOFF", required=True))
CUTOFF_DAY = CUTOFF[:10]
CUTOFF_MS = int(datetime.strptime(CUTOFF, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp() * 1000)
HYGIENE_JSON = f"{LANE}/hygiene-1193.json"
DRIFT_REF = re.compile(SB_RE + r"-\d+|" + KEY_RE)

# The project epic carries a label on nearly every row, so an open PR naming it says nothing about a
# single row's step (the same reason `shared_only` exists). Excluded from the open-PR veto.
EPIC_REFS = {lanecfg.epic()}
# Coordinator ruling (2026-10-28 22:15Z): three exclusion classes leave drift A. They are printed by
# key EVERY cycle ("excluded (epic/umbrella): ...") because a silent exclusion is a backlog hiding
# behind a clean number, which is the one failure mode this check exists to prevent. Every exclusion is
# CONDITIONAL on the row's Substrate ref still being open: the moment that ref closes the row returns
# to drift A, because a closed ref is exactly the evidence this check reports.
# Each map is {jira-key: substrate-ref}. "Stories on open umbrella refs" carry the SAME substrate ref as
# the theme Epic above them, which is why they are umbrella progress and not a window row. Exclusion is
# key-based, NOT ref-based on purpose: many post-cut-off window tasks carry a theme ref and must keep
# counting. Config keys drift_exclude_epics, drift_exclude_umbrellas, drift_exclude_outside.
DRIFT_EXCLUDE_EPICS = lanecfg.data("PM_DRIFT_EXCLUDE_EPICS", {}) or {}
DRIFT_EXCLUDE_UMBRELLAS = lanecfg.data("PM_DRIFT_EXCLUDE_UMBRELLAS", {}) or {}
DRIFT_EXCLUDE_OUTSIDE = lanecfg.data("PM_DRIFT_EXCLUDE_OUTSIDE", {}) or {}
IGNORED_REF = lanecfg.epic()    # the project-epic label says nothing about a row's own step
A_RANKS = ("substrate_closed", "deployed", "substrate_result")
# A PR whose covering window was bound at COMMENT level, not by a label on the ref's own ticket
# (B29 rule: a lane's firm YES received before the window's cutoff binds the PR to that window).
# Every entry is validated LIVE before it is honoured: a cited row that is missing, Done, or carries no
# `window` label degrades to "still a gap". A binding that outlives its row must never hide one.
# Config key pr_bindings: {"<pr-number>": [["<jira-key>", "<why>"], ...]}.
PR_BINDINGS = {int(n): [tuple(x) for x in v]
               for n, v in (lanecfg.data("PM_PR_BINDINGS", {}) or {}).items()}

# A PR whose ticket deliberately carries NO window, ruled by the coordinator. Same doctrine as
# PR_BINDINGS: validated LIVE, and a stale entry degrades to "still a gap" rather than to silent
# coverage. The ruling must exist ON THE TICKET as a comment naming the PR, so the exception cannot
# outlive its own evidence: when that comment is gone, the PR returns to the gap list by itself.
# Config key no_window_exceptions: {"<pr-number>": ["<jira-key>", "<why>"]}.
NO_WINDOW_EXCEPTIONS = {int(n): tuple(v)
                        for n, v in (lanecfg.data("PM_NO_WINDOW_EXCEPTIONS", {}) or {}).items()}

# A row the coordinator has ruled open ON PURPOSE. It leaves A (so it stops reading as a defect) and is
# reported with its reason instead, never dropped: an exception that vanishes is indistinguishable
# from a fix. A row leaves this map the moment its holder lands, and A1 then reports it again if it is
# stale. Config key expected_open: {"<jira-key>": "<reason>"}.
EXPECTED_OPEN = lanecfg.data("PM_EXPECTED_OPEN", {}) or {}
# The Tabellone filter's JQL, verbatim (config key tabellone_jql). The cycle evaluates the JQL instead of
# GET /filter/<id> because a saved filter private to the operator account returns 404 to the agent token.
TABELLONE_JQL = lanecfg.get("PM_TABELLONE_JQL") or (
    f'project = {PROJECT} AND (labels = {lanecfg.get("PM_JIRA_LABEL", "window")} OR labels = window) '
    f'AND created >= "{CUTOFF}" AND statusCategory != Done')
# Board status names (config key statuses).
WAITING_PRODUCTION = STATUSES["waiting_production"]
ACTIVE_STATUSES = tuple(STATUSES["active"])
PARKED_STATUSES = tuple(STATUSES["parked"])


LIVE_CHECK = re.compile(
    r"(?:\bmake [a-z][\w-]+|\bSELECT |\bEXPLAIN |\bcurl |\bpsql\b|docker exec|\bsb [a-z]+|"
    r"sha256|count\(\)|\bPASS\b|\bverified\b|logged OK|OK at \d|\bOK,? \d{2}:\d{2})", re.I)
"""A journal RESULT entry counts as evidence only when it names a live check (coordinator, 2026-11-04).

WHY: an audit found the drift instrument treating build reports as verification. Read verbatim from rows that
were counted as finished: "Switch <FLAG> default OFF. Deviations from C1 listed", "PR 1003 all
checks green on 89c83c7; ready to merge", "PR #1101 open into master ... not merged". None of those says a step
ran or that anything was observed. So a result entry now counts only if its payload carries a command, a query,
or an explicit observed outcome; everything else increments results_build and proves nothing. The narrow pattern
is deliberate: "all checks green" is CI, not a live check, so `green` is NOT in the list.
"""


def substrate_state():
    """Substrate issue state, result counts and closures from one local read of the Substrate DB.

    Mirrors hygiene1193.py capture_substrate() so the cycle and the audit agree on what "finished"
    means. Read-only, local: no CLI round trip per ref.
    """
    con = sqlite3.connect(f"file://{STATE_DB}?mode=ro", uri=True, timeout=2.0)
    try:
        out, by_id = {}, {}
        for iid, hn, life in con.execute(
                "select id,human_number,lifecycle_state from issues where project_id=?", (SB_PROJECT_ID,)):
            rec = {"life": life, "results": 0, "results_live": 0, "results_build": 0,
                   "activation_results": 0, "closure": None}
            out[f"{SB}-{hn}"] = rec
            by_id[iid] = rec
        for iid, act, mech, sem, res in con.execute(
                "select issue_id,activation_id,mechanical_json,semantic_json,result_json "
                "from issue_journal where kind='result'"):
            rec = by_id.get(iid)
            if rec is not None:
                rec["results"] += 1
                rec["activation_results"] += 1 if act else 0
                blob = " ".join(x for x in (mech, sem, res) if x)
                if LIVE_CHECK.search(blob):
                    rec["results_live"] += 1
                else:
                    rec["results_build"] += 1
        for iid, term, outcome in con.execute(
                "select issue_id,terminal_state,outcome from issue_closures"):
            rec = by_id.get(iid)
            if rec is not None:
                rec["closure"] = {"terminal": term, "outcome": outcome}
        return out
    finally:
        con.close()


def drift_refs(row):
    refs = [x.split(":", 1)[1] for x in row.get("labels") or [] if x.startswith(f"substrate:{SB}-")]
    refs += DRIFT_REF.findall(row.get("summary") or "")
    return [r for r in dict.fromkeys(refs) if r != IGNORED_REF]


def stable_ancestors(shas):
    """{sha: bool} — is the merge commit on origin/stable? One fetch, then one merge-base per sha."""
    shas = [s for s in set(shas) if s]
    if not shas:
        return {}
    subprocess.run(["git", "fetch", "--quiet", "origin", "stable"], cwd=REPO,
                   capture_output=True, text=True, timeout=120)
    res = {}
    for sha in shas:
        rc = subprocess.run(["git", "merge-base", "--is-ancestor", sha, "origin/stable"],
                            cwd=REPO, capture_output=True, text=True).returncode
        res[sha] = rc == 0
    return res


def drift_class(pr_state, jstatus):
    """Split A into the two shapes the board actually has (thur-coord ruling 2026-10-29).

    `waiting promotion` is normal queueing: the row's newest merged PR has a merge commit that is NOT yet
    an ancestor of origin/stable, while the row already says Waiting Production. Keyed on the PR's deploy
    state, never on the strongest rank: a result entry outranks `merged`, and keying on the rank had put
    two rows (result entry + a PR merged on master, not on stable) back on the defect side. `status stale` is
    the defect: the work is live on origin/stable (or its Substrate ref is closed) and the row still
    reads as open work. Anything the ladder cannot place (a result entry with no merge) is stale, never
    queueing - unsure defaults to the defect side.
    """
    waiting = (pr_state == "merged_only"
               and (jstatus or "").strip().lower() == WAITING_PRODUCTION.lower())
    return "waiting promotion" if waiting else "status stale"


PAIR_LOOSE = re.compile(SB_RE + r"[-_ ]?(\d{3,})", re.I)


def pair_refs(text):
    """Every Substrate ref a blob names, exact (SB-2369) or loose (sb2369, SB_2369, branch names)."""
    out = set(DRIFT_REF.findall(text or ""))
    out |= {f"{SB}-{m}" for m in PAIR_LOOSE.findall(text or "")}
    return out


def pairing_ok(pr_refs, commit_text):
    """Does the merge commit itself name one of the refs the PR was bound by?

    WHY (coordinator correction 2026-10-29): I flagged "#807 delivered SB-2564" on the strength of a
    merge commit being an ancestor of origin/stable. Its subject named a different ref (SB-2225). Ancestry proves a commit is on stable, never WHICH work it
    carries: before calling a row delivered, match the issue key in the commit subject or body. GitHub
    merge commits put the key in the body ("SB-2369: Rust engine bar writer ..."), squash merges put
    the PR title in the subject, and branch names carry it loose (feat/mmd2369-bar-writer) - all three
    are accepted here, a different key or no key at all is not.
    """
    return bool(pair_refs(commit_text) & set(pr_refs))


def check_status_drift(out, counts):
    """The finished-not-closed backlog over EVERY post-cut-off row, not only today's closures.

    WHY (wed2-coord, 2026-10-28 16:25Z, relaying the operator): the old check queried only Substrate
    closures made today, so the 34 rows hygiene-1193 found sat outside its window and the cycle
    reported 0. A backlog cannot hide behind a zero.

    The rank ladder is hygiene1193.py's, ported rather than re-invented, because a merged PR is NOT
    proof that a row's own step ran: only `deployed` (merge commit on origin/stable) or a closed
    Substrate ref closes a window, and a `merged` PR alone means Waiting Production. The negative
    control below (C2) is the class of row that broke the first, looser version.
    """
    out.append("\n## 3. Finished-not-closed backlog (every post-cut-off row, not only today)\n")
    try:
        sub = substrate_state()
    except Exception as exc:  # noqa: BLE001
        out.append(f"- **instrument failed** (Substrate state): {exc}")
        counts["drift"] = "instrument failed"
        return
    out.append(f"- Substrate {SB} issues read: **{len(sub)}**")

    raw, complete = jql(f'project = {PROJECT} AND created >= "{CUTOFF}" ORDER BY created ASC',
                        fields=["key", "summary", "status", "labels", "parent", "issuetype",
                                SLOT_START, SLOT_END], limit=1000)
    if not complete or not raw:
        out.append(f"- **instrument failed** (Jira post-cut-off rows: {len(raw)} captured, "
                   f"complete={complete}) — drift is UNKNOWN this cycle, not zero")
        counts["drift"] = "instrument failed"
        return
    rows = [row_of(i) for i in raw]
    open_rows = [r for r in rows if r["category"] != "done"]
    out.append(f"- Jira post-cut-off rows: {len(rows)} (open {len(open_rows)})")

    dev = gh(["pr", "list", "--state", "merged", "--search", f"merged:>={CUTOFF_DAY}", "--limit", "1000",
              "--json", "number,title,headRefName,mergedAt,mergeCommit"])
    if not isinstance(dev, list):
        out.append(f"- **instrument failed** (merged PR list): {dev}")
        counts["drift"] = "instrument failed"
        counts["drift_merged"] = "instrument failed"
        return
    board_raw, board_ok = jql(TABELLONE_JQL, fields=["key"], limit=1000)
    board_keys = {i["key"] for i in board_raw}
    out.append(f"- Tabellone scope (the Tabellone filter's JQL, evaluated here): **{len(board_keys)} rows**"
               if board_ok else "- **instrument failed** (Tabellone scope) — the in/out split is unknown")

    strong = {}
    for p in sorted(dev, key=lambda x: x.get("mergedAt") or ""):
        blobs = f"{p.get('title') or ''} {p.get('headRefName') or ''}"
        for rf in set(DRIFT_REF.findall(blobs)):
            strong[rf] = p
    openpr = gh(["pr", "list", "--state", "open", "--limit", "400",
                 "--json", "number,title,headRefName,isDraft"])
    open_refs = None
    if not isinstance(openpr, list):
        out.append(f"- **instrument failed** (open PR list): {openpr} — the open-PR veto is UNKNOWN this cycle, "
                   f"so every 'finished' below is provisional")
    else:
        open_refs = {}
        for p_open in openpr:
            for rf in set(DRIFT_REF.findall(f"{p_open.get('title') or ''} {p_open.get('headRefName') or ''}")) - EPIC_REFS:
                open_refs.setdefault(rf, []).append(p_open)
        out.append(f"- open PRs read: {len(openpr)} (an open PR, draft included, naming a row's ref blocks "
                   f"'finished': a merged PR for one part of a step is not the step)")
    ref_rows = {}
    for r in rows:
        for rf in drift_refs(r):
            ref_rows[rf] = ref_rows.get(rf, 0) + 1
    pr_sha = lambda p: (p.get("mergeCommit") or {}).get("oid") if p else None
    sha_deployed = stable_ancestors([pr_sha(p) for p in strong.values()])

    def rank_of(r):
        ranks, used, pr = set(), set(), None
        for rf in drift_refs(r) + [r["key"]]:
            if rf.startswith(f"{SB}-"):
                s = sub.get(rf)
                if s:
                    used.add(rf)
                    if s["closure"] or s["life"] in ("closed", "cancelled", "done", "archived"):
                        ranks.add("substrate_closed")
                    elif s["results_live"]:
                        ranks.add("substrate_result")
            p = strong.get(rf)
            if p:
                used.add(rf)
                if pr is None or (p.get("mergedAt") or "") > (pr.get("mergedAt") or ""):
                    pr = p
        if pr:
            ranks.add("deployed" if sha_deployed.get(pr_sha(pr)) else "merged")
        why = []
        if "substrate_closed" in ranks:
            why.append("Substrate ref closed")
        elif "substrate_result" in ranks:
            why.append("Substrate ref carries a result entry that names a live check")
        if pr:
            why.append(f"PR #{pr['number']} " + ("on origin/stable" if sha_deployed.get(pr_sha(pr))
                                                 else "merged, not on origin/stable"))
        shared_only = (bool(used) and not (pr and r["key"] in (pr.get("title") or ""))
                       and all(ref_rows.get(rf, 0) >= 3 for rf in used))
        open_block = [p_open for rf in drift_refs(r) + [r["key"]]
                      for p_open in (open_refs or {}).get(rf, [])]
        rank = ("substrate_closed" if "substrate_closed" in ranks else
                "deployed" if "deployed" in ranks else
                "substrate_result" if "substrate_result" in ranks else
                "merged" if "merged" in ranks else None)
        pr_state = ("on_stable" if sha_deployed.get(pr_sha(pr)) else "merged_only") if pr else None
        return rank, why, pr, shared_only, open_block, pr_state

    def refs_open(r):
        """True while a Substrate ref of the row is open, False once all are closed, None if unreadable.

        None is not True: a row with no readable ref can never return to drift A on its own, so the
        cycle prints that in the exclusion line instead of letting it look like a live exclusion.
        """
        states = [sub.get(rf) for rf in drift_refs(r) + [r["key"]] if rf.startswith(f"{SB}-")]
        states = [st for st in states if st]
        if not states:
            return None
        return any(not (st["closure"] or st["life"] in ("closed", "cancelled", "done", "archived"))
                   for st in states)

    now_z = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    hits, withheld, excluded = [], [], []
    hit_pr = {}
    for r in open_rows:
        rank, why, pr, shared_only, open_block, pr_state = rank_of(r)
        if rank not in A_RANKS:
            continue
        exc = (f"theme Epic, umbrella ref {DRIFT_EXCLUDE_EPICS[r['key']]}"
               if r["key"] in DRIFT_EXCLUDE_EPICS else
               f"story on open umbrella ref {DRIFT_EXCLUDE_UMBRELLAS[r['key']]}"
               if r["key"] in DRIFT_EXCLUDE_UMBRELLAS else
               f"outside the Tabellone filter, umbrella ref {DRIFT_EXCLUDE_OUTSIDE[r['key']]}"
               if r["key"] in DRIFT_EXCLUDE_OUTSIDE else None)
        opens = refs_open(r) if exc else None
        if exc and opens is not False:
            excluded.append((r["key"], r["status"], exc if opens else
                             exc + " — no readable Substrate ref, cannot lift automatically"))
            continue
        if open_block:
            label = ", ".join(f"#{p_open['number']}{' DRAFT' if p_open.get('isDraft') else ''}"
                              for p_open in open_block[:2])
            withheld.append((r["key"], r["status"],
                             f"an OPEN PR names the ref ({label}): a merged PR for one part of the step is not "
                             f"the step (coordinator STOP-AND-FIX, 2026-10-28)"))
            continue
        if "window" in (r["labels"] or []) and not (r.get("slotEnd") and to_utc(r["slotEnd"]) < now_z):
            withheld.append((r["key"], r["status"], "window slot missing or not ended"))
            continue
        tier = "weak"
        if rank in ("substrate_closed", "deployed"):
            tier = "strong"
        if shared_only:
            # one Substrate ref labelled on three or more open rows proves the ref moved, not that
            # THIS row's step ran (one theme ref sat on four rows, two of them allowlist windows):
            # reported as its own tier, never silently dropped
            tier = "shared-ref"
        hits.append((r["key"], r["status"], tier, drift_class(pr_state, r["status"]), "; ".join(why)))
        hit_pr[r["key"]] = (pr, pr_state)

    expected = [h for h in hits if h[0] in EXPECTED_OPEN]
    hits[:] = [h for h in hits if h[0] not in EXPECTED_OPEN]

    def tier_n(name):
        return sum(1 for h in hits if h[2] == name)
    for k, st, tier, _klass, why in expected:
        out.append(f"- expected exception, NOT a defect ({k}, {st}, ruled by the coordinator): "
                   f"{EXPECTED_OPEN[k]} — still {tier} on the evidence ({why[:90]})")
    out.append("- excluded (epic/umbrella): "
               + (", ".join(f"{k} ({why})" for k, _s, why in excluded) if excluded else "none")
               + (" — not counted in A; each returns to A the moment its Substrate ref closes"
                  if excluded else ""))
    in_board = [h for h in hits if h[0] in board_keys]
    stale = [h for h in hits if h[3] == "status stale"]
    queue = [h for h in hits if h[3] == "waiting promotion"]
    out.append(f"- **A. finished-not-closed (Jira still not Done): {len(hits)}** split into "
               f"**A1 status stale {len(stale)}** (the defect: work live on origin/stable, or its Substrate "
               f"ref closed, row not Done) and **A2 waiting promotion {len(queue)}** (merged into master, "
               f"merge commit not yet on origin/stable, row already Waiting Production - queueing, NOT a "
               f"defect). Tiers: {tier_n('strong')} strong, {tier_n('weak')} weak, "
               f"{tier_n('shared-ref')} shared-ref; {len(in_board)} inside the Tabellone filter, "
               f"{len(hits) - len(in_board)} outside it")
    for key, jstatus, tier, klass, why in hits[:25]:
        out.append(f"  - {key} is `{jstatus}` [{tier}, {klass}] — {why}")
    if len(hits) > 25:
        dump = f"{LANE}/DRIFT-{now_z[11:16].replace(':', '')}Z.json"
        try:
            with open(dump, "w", encoding="utf-8") as fh:
                json.dump([{"key": k, "status": s, "tier": t, "class": c, "why": w,
                            "in_board": k in board_keys, "stamp": stamp()}
                           for k, s, t, c, w in hits], fh, indent=1)
            out.append(f"  - … {len(hits) - 25} more, full list in `{dump}`")
        except OSError as exc:  # noqa: BLE001
            out.append(f"  - … {len(hits) - 25} more (dump failed: {exc})")
    # pairing audit: only on the rows where "delivered" is asserted, and only where a PR is on stable
    mism, checked = [], 0
    for key, _js, _t, klass, _w in hits:
        pr, p_state = hit_pr.get(key, (None, None))
        if not pr or p_state != "on_stable":
            continue
        sha = pr_sha(pr)
        try:
            msg = subprocess.run(["git", "-C", REPO, "log", "-1", "--format=%B", sha],
                                 capture_output=True, text=True, timeout=30).stdout
        except Exception as exc:  # noqa: BLE001
            out.append(f"  - pairing audit skipped for {key}: {exc}")
            continue
        checked += 1
        pr_refs = pair_refs(f"{pr.get('title') or ''} {pr.get('headRefName') or ''}")
        if not pairing_ok(pr_refs, msg):
            mism.append((key, pr["number"], sorted(pair_refs(msg))[:3], sorted(pr_refs)[:3]))
    counts["pairing_mismatch"] = len(mism)
    # 0/0 must not read as a clean bill: an empty scope and a broken audit look identical, so the rule
    # proves itself on a synthetic pair every cycle and the line says which case it is.
    sc = (pairing_ok([f"{SB}-1234"], f"{SB}-1234: synthetic subject ({SB.lower()}1234)") is True
          and pairing_ok([f"{SB}-9999"], f"{SB}-1234: a different key") is False)
    scope = ("no A row rests on a PR sitting on origin/stable this cycle, so nothing was audited — "
             "the audit's scope, not a clean bill" if not checked
             else f"{checked - len(mism)}/{checked} match")
    out.append(f"- pairing audit (merge commit names the row's own key): {scope}"
               + ("" if sc else " — SELF-CONTROL FAILED, the checker itself is broken")
               + (" — MISMATCH " + "; ".join(f"{k}: PR #{n} merge commit names {c} but the PR is bound "
                                             f"by {t}" for k, n, c, t in mism) if mism else ""))
    counts["pairing_selfcontrol"] = "PASS" if sc else "FAIL"
    # A truncated list with no tail is how three rows vanished from a reader's view on 2026-11-04: they were
    # withheld, correctly, by the open-PR veto, but `withheld[:8]` printed the first eight and said nothing
    # about the rest, so the rows appeared to have been dropped by the metric. The count and the tail are now
    # explicit, and the full list goes to a file the moment it does not fit.
    for key, jstatus, why in withheld[:8]:
        out.append(f"  - not counted: {key} (`{jstatus}`) — {why}")
    if len(withheld) > 8:
        wdump = f"{LANE}/WITHHELD-{now_z[11:16].replace(':', '')}Z.json"
        try:
            with open(wdump, "w", encoding="utf-8") as fh:
                json.dump([{"key": k, "status": s, "why": w} for k, s, w in withheld], fh, indent=1)
            tail = f"; full list in `{wdump}`"
        except OSError as exc:  # noqa: BLE001
            tail = f" (dump failed: {exc})"
        out.append(f"  - … {len(withheld) - 8} more withheld (not counted, NOT clean){tail}")

    # B: a merged PR whose Jira ticket sits on no window at all and is still open
    iss_rows = {r["key"]: r for r in rows}
    b, orphan = [], 0
    for p in dev:
        refs = set(DRIFT_REF.findall(f"{p.get('title') or ''} {p.get('headRefName') or ''}"))
        if not refs:
            continue
        if not any(rf in ref_rows for rf in refs):
            orphan += 1
            continue
        keys = sorted(k for k in refs if k.startswith(f"{PROJECT}-"))
        cov = [iss_rows[k] for k in keys if k in iss_rows]
        if not cov:
            continue
        if any("window" in (r["labels"] or []) or r["category"] == "done" for r in cov):
            continue
        b.append((p["number"], keys))
    out.append(f"- **B. merged PR, ticket on no window, ticket still open: {len(b)}**")
    for number, keys in b[:15]:
        out.append(f"  - #{number} -> {','.join(keys)}")
    out.append(f"- C. merged PRs naming only refs with no Jira row ({orphan}) — the worker-task "
               f"class, expected (jira.md: worker tasks live in Substrate only)")

    # controls: the instrument must still say yes to a known row and no to a known-open one
    try:
        hyg = json.loads(open(HYGIENE_JSON, encoding="utf-8").read())
        known = {f["key"] for f in hyg.get("findings") or []
                 if any((c or {}).get("class") == "A" for c in f.get("classes") or [])}
    except Exception:  # noqa: BLE001
        known = set()
    flagged = {h[0] for h in hits}
    pos = sorted(known & flagged)
    pos_excluded = sorted(known & {k for k, _s, _w in excluded})
    pos_expected = sorted(known & set(EXPECTED_OPEN))
    out.append(f"- C1 drain (informational, not a control): hygiene-1193 class-A rows still flagged "
               f"{len(pos)}/{len(known)}"
               + (f" e.g. {pos[:3]}" if pos else "")
               + (f"; {len(pos_expected)} of the rest are expected exceptions ruled open "
                  f"({', '.join(pos_expected)})" if pos_expected else ""))
    # C1 sensitivity: drive the rank ladder with SYNTHETIC rows, the way the fold control does, instead of
    # trusting a fixture row. Two earlier attempts failed here and both failures are the reason for this
    # shape: (1) three pinned rows were taken from the B limb and could never appear in the A hit
    # set, so the pin read 0/3 on the run that introduced it; (2) a derived "open row + closed Substrate ref"
    # class reported INSTRUMENT GAP because the backlog had drained to A1=0, and a control that is empty
    # whenever the board is healthy proves nothing. A synthetic row depends on neither the board nor the
    # backfill: it asks only whether this cycle's Substrate snapshot still separates a closed ref from an open one.
    closed_refs = [k for k, v in sub.items()
                   if v["closure"] or v["life"] in ("closed", "cancelled", "done", "archived")]
    live_refs = [k for k, v in sub.items()
                 if not (v["closure"] or v["life"] in ("closed", "cancelled", "done", "archived"))]
    if closed_refs and live_refs:
        syn = lambda key, ref: {"key": key, "status": ACTIVE_STATUSES[0], "summary": "",
                                "labels": [f"substrate:{ref}"], "category": "open"}
        r_closed, *_ = rank_of(syn(f"{PROJECT}-900010", closed_refs[0]))
        r_live, *_ = rank_of(syn(f"{PROJECT}-900011", live_refs[0]))
        ok_closed = r_closed == "substrate_closed"
        ok_live = r_live is None
        syn_score = int(ok_closed) + int(ok_live)
        if not (ok_closed and ok_live):
            counts["control_failures"] = counts.get("control_failures", 0) + 1
        out.append(f"- control C1 synthetic (rank ladder, driven through rank_of with rows that exist only for "
                   f"this check): {'OK' if ok_closed and ok_live else '**CONTROL FAILED**'} — "
                   f"{closed_refs[0]} (closed) ranks {r_closed!r}, {live_refs[0]} (open) ranks {r_live!r}")
    else:
        syn_score = None
        out.append("- control C1 synthetic: **INSTRUMENT GAP** — the Substrate snapshot holds no closed or no "
                   "open ref, so the rank ladder cannot be exercised this cycle")
    if pos_excluded:
        out.append(f"- control C1 note: {len(pos_excluded)} known hygiene-1193 class-A rows are excluded by "
                   f"the epic/umbrella ruling this cycle ({', '.join(pos_excluded)}) — detected, not counted")
    # C2 negative must be an INVARIANT CLASS, never a fixture row. "<row>, its PRs merged before
    # its slot" was a valid negative until 23:50Z on 10-28; then that slot ended, the row legitimately
    # became finished-not-closed, and the fixture turned into a false alarm (cycle 00:32Z FAIL).
    # The class that stays negative is: every open window row whose slot end is still in the FUTURE —
    # nothing can have finished inside a slot that has not run (the coordinator's STOP-AND-FIX rule).
    cands, ends = [], {}
    for r in rows:
        if r["category"] == "done" or "window" not in (r["labels"] or []):
            continue
        if not (r.get("slotEnd") and to_utc(r["slotEnd"]) > now_z):
            continue
        cands.append(r["key"])
        ends.setdefault(r["key"], to_utc(r["slotEnd"]))
    cands = sorted(set(cands))
    neg_flagged = [k for k in cands if k in flagged]
    ok = None if not cands else (not neg_flagged)
    if ok is None:
        out.append("- control C2 negative (open window rows whose slot has NOT yet ended): "
                   "NONE-AVAILABLE — no such row this cycle, so the A count is unvalidated, not measured")
    elif ok:
        out.append(f"- control C2 negative (open window rows whose slot has NOT yet ended): PASS — "
                   f"0 of {len(cands)} flagged (e.g. {', '.join(f'{k} ends {ends[k]}' for k in cands[:3])})")
    else:
        out.append(f"- control C2 negative (open window rows whose slot has NOT yet ended): FAIL — "
                   f"flagged {', '.join(neg_flagged)} inside a slot that has not run; the instrument is "
                   f"too loose and its A count is not usable")
    counts["drift"] = len(hits)
    counts["drift_stale"] = len(stale)
    counts["drift_waiting_promotion"] = len(queue) if ok else ("control failed" if ok is False else "unvalidated (no negative control)")
    counts["drift_excluded"] = len(excluded)
    counts["drift_expected"] = len(expected)
    counts["drift_merged"] = len(b)
    # Two named counts the coordinator ordered on 2026-11-04, because both are ways a row leaves the drift
    # number WITHOUT anything being resolved, and a number that can fall for free is not a measurement.
    # (1) REPARENTED: a row whose parent became a theme Epic. Rows under an Epic are excluded as umbrella
    #     children, so re-parenting removes them from the count. It is detected by comparing this cycle's
    #     parent against the previous cycle's, never inferred from the drop itself.
    # (2) WINDOW-NO-SLOT: a window row with no slot at all can never be checked, because the drift check
    #     withholds any window row whose slot has not ended - and a missing slot never ends.
    try:
        with open(DRIFT_PARENTS, encoding="utf-8") as fh:
            prev_parents = json.load(fh).get("parents") or {}
    except Exception:  # noqa: BLE001
        prev_parents = {}
    hit_keys = {h[0] for h in hits}
    reparented = []
    for r in open_rows:
        pid = (r.get("parent") or "")
        if isinstance(pid, dict):
            pid = pid.get("key") or ""
        if pid and pid in THEME_EPICS and r["key"] not in hit_keys and prev_parents:
            # prev_parents empty = first run: everything looks new, so the honest answer is "no comparison
            # yet", not 158 rows. A baseline run that reports a number is the same false-zero trap inverted.
            was = prev_parents.get(r["key"])
            if was != pid:
                reparented.append(f"{r['key']}->{pid}")
    window_no_slot = [r["key"] for r in open_rows
                      if "window" in (r["labels"] or []) and not r.get("slotStart")]
    counts["drift_reparented"] = len(reparented)
    counts["drift_window_no_slot"] = len(window_no_slot)
    if not prev_parents:
        out.append("- **d. re-parented under a theme Epic: baseline written this cycle, no comparison yet** "
                   "(the next cycle reports only genuine parent changes)")
    elif reparented:
        out.append(f"- **d. left the count by re-parenting under a theme Epic: {len(reparented)}** "
                   f"({', '.join(sorted(reparented)[:6])}) - excluded as umbrella children, so they are NOT "
                   f"resolved and must not be read as drift falling")
    else:
        out.append("- **d. left the count by re-parenting under a theme Epic: 0** this cycle")
    if window_no_slot:
        out.append(f"- **e. window rows with NO slot at all: {len(window_no_slot)}** "
                   f"({', '.join(sorted(window_no_slot)[:8])}) - a missing slot never ends, so these can "
                   f"never be drift-checked until they are dated")
    try:
        cur_parents = {}
        for r in open_rows:
            pid = r.get("parent") or ""
            if isinstance(pid, dict):
                pid = pid.get("key") or ""
            cur_parents[r["key"]] = pid
        with open(DRIFT_PARENTS, "w", encoding="utf-8") as fh:
            json.dump({"parents": cur_parents, "set_at": stamp()}, fh, indent=1)
    except OSError:
        out.append("  - (re-parent state file not written; the re-parent count is relative to nothing next cycle)")
    counts["drift_control_pos"] = (
        "INSTRUMENT GAP (no closed or open ref to drive the ladder)" if syn_score is None else f"{syn_score}/2")
    counts["drift_drain"] = f"{len(pos)}/{len(known)}"


def check_pr_links(out, counts):
    out.append("\n## 4. PR-link top-up (merged today)\n")
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    prs = gh(["pr", "list", "--state", "merged", "--search", f"merged:>={day}", "--limit", "100",
              "--json", "number,title,headRefName,mergedAt,headRefOid"])
    if not isinstance(prs, list):
        out.append(f"- **gh failed**: {prs}")
        counts["pr_links_missing"] = "gh failed"
        return
    out.append(f"- merged today: **{len(prs)}**")
    missing = 0
    for p in prs:
        text = (p.get("title") or "") + " " + (p.get("headRefName") or "")
        keys = [f"{PROJECT}-" + t for t in dict.fromkeys(re.findall(KEY_NUM_RE, text))]
        if not keys:
            continue
        for key in keys:
            comments = all_comments(key)
            found = any(p["number"] in jiratext.prlink_numbers(flat_body(c)) for c in comments)
            if not found:
                missing += 1
                out.append(f"  - MISSING: {REPO_NAME}#{p['number']} (head {(p.get('headRefOid') or '')[:12]}, "
                           f"merged {p.get('mergedAt')}) -> {key}")
    out.append(f"- formal PR-link comments missing: **{missing}**")
    counts["pr_links_missing"] = missing


def check_comments(out, counts):
    out.append("\n## 5. Comment watch\n")
    labels = jira.call("GET", "/rest/api/3/label?maxResults=1000")
    prog = [v for v in ((labels[1].get("values") or []) if labels[0] == 200 else []) if v.startswith("prog:")]
    out.append(f"- prog: labels on the site: {prog}")
    coverage = {}
    for p in prog:
        hits, _ = jql(f'project = {PROJECT} AND labels = window AND labels = "{p}"', fields=["key"], limit=200)
        coverage[p] = len(hits)
    out.append(f"- of those labels, how many window rows carry each: {coverage}")
    # The watch window was 30 minutes, matched to the 25-minute cycle. That pairing has a hole: Jira's
    # `updated >= -Xh` is answered from the SEARCH INDEX, which lags the row state, so a comment can be
    # invisible to one poll and to the next, and then fall outside both windows - missed for good, with a
    # reassuring "0 new" each time. Measured 2026-10-29 ~03:0xZ: `updated >= -30m` returned 0 rows while a
    # row showed updated 02:38Z (24 minutes earlier) and another 02:56Z; minutes later `updated >= -3h`
    # returned 22. De-dup is by comment id above the high-water mark, so a wider window costs a few rows and
    # cannot re-report: widening is the cheap side of this trade.
    out.append(f"- scope used: `project = {PROJECT} AND updated >= {WATCH_WINDOW}` (wider than the cycle leg on "
               f"purpose: the search index lags `updated`, and a 30-minute window can miss a comment twice "
               f"and lose it) — the contract's prog-label scope would miss window rows carrying no prog: label, "
               f"which the line above measures")
    rows, complete = jql(f'project = {PROJECT} AND updated >= {WATCH_WINDOW} ORDER BY updated DESC', limit=300)
    narrow, _ = jql(f'project = {PROJECT} AND updated >= -30m', fields=["key"], limit=50)
    out.append(f"- rows updated in the last 2 hours: **{len(rows)}** (the same query at -30m: {len(narrow)} — "
               f"a -30m count well below the -2h count is the index lag this window exists to survive)"
               + ("" if complete else " — page incomplete"))

    try:
        with open(CURSOR) as fh:
            seen = {int(x) for x in json.load(fh)}
        first_run = False
    except (FileNotFoundError, json.JSONDecodeError, TypeError, ValueError):
        seen, first_run = set(), True
        out.append("- **cursor initialised this cycle**: the baseline is recorded and no comment is "
                   "reported as new, by design (a first poll must not dump the board as news)")

    new, own, own_verdict, highest, scanned = [], [], [], max(seen) if seen else 0, 0
    try:
        with open(OWN_WRITES) as fh:
            own_ids = {int(x.strip()) for x in fh if x.strip().isdigit()}
    except FileNotFoundError:
        own_ids = set()
    watermark = highest
    for i in rows:
        key = i["key"]
        for c in all_comments(key):
            cid = int(c["id"])
            highest = max(highest, cid)
            scanned += 1
            # a comment is new only above the high-water mark: an id set alone would report
            # every old comment on a row that merely became 'updated' this cycle as news
            if cid <= watermark or cid in seen:
                continue
            body = flat_body(c)
            if jiratext.is_prlink_comment(body):
                continue
            # this lane's own board writes are not board events: the marker identifies them,
            # and the cursor advances past them without reporting (never self-flag)
            if cid in own_ids:
                own.append((cid, key))
                continue
            if body.startswith("Board write (jira-batch:"):
                own.append((cid, key))
                continue
            # ...and anything this lane posts under its own actor header is its own write even when
            # the posting script forgot to record the id in own-writes.txt: relying on that file
            # alone self-flagged 15665 and 15682 (cycle 2136Z reported both as board events).
            if body.lstrip().startswith("[agent:wed2-helper]"):
                own.append((cid, key))
                continue
            # the startswith test above only knew the wed2 origin, so on 2026-11-02 c16644-c16646 were
            # reported as board events (cycle 0555Z listed c16644 as someone else's comment). The tag is
            # appended LAST, so test the end of the body, not the start.
            if OWN_TAG.search(body):
                own.append((cid, key))
                continue
            # ...and the lane's own R2 verdict posts are its own writes too. Without this branch they
            # were counted as board events (cycle 0113Z reported 5 new comments, 4 of them mine), which
            # makes the digest read as four operator events that never happened.
            if VERDICT_LINE.match(AGENT_HEADER.sub("", body.strip())):
                own_verdict.append((cid, key))
                continue
            new.append((cid, key, (c.get("author") or {}).get("displayName"), body.strip()[:300]))
    out.append(f"- comments scanned: {scanned}; newer than the cursor: **{len(new)}**; this lane's own "
               f"board writes skipped: {len(own)}; own R2 verdict posts skipped: {len(own_verdict)}")
    if own_verdict:
        out.append("  - own verdict posts, counted and not reported as board events: "
                   + ", ".join(f"{key} c{cid}" for cid, key in own_verdict[:6]))
    if first_run:
        out.append("  - nothing listed: this poll only wrote the baseline, so that the next poll's "
                   "first line means a real change rather than the whole board")
    for cid, key, author, body in ([] if first_run else new[:10]):
        out.append(f"  - {key} c{cid} ({author}): {body[:170]}")
    written = seen | {cid for cid, *_ in new}
    with open(CURSOR, "w") as fh:
        json.dump(sorted(written), fh)
    # the cursor's own max is NOT the highest id seen: this lane's own verdict posts are skipped and
    # never written, so reporting `highest` as the cursor max was a scope error in this very line.
    out.append(f"- cursor now holds {len(written)} ids (its own max {max(written) if written else 0}); "
               f"highest comment id seen this poll {highest} — the gap is this lane's own verdict posts, "
               f"which are skipped by design and never enter the cursor")
    counts["new_comments"] = 0 if first_run else len(new)


def r2_postable(cls, text):
    """POST-ON-SIGHT, or HOLD with the reason. The coordinator widened the seq 3 rule on
    2026-10-28 (lane contract seq 42): an ordering-only caveat posts like a plain VERIFIED.
    "Only C3" is CHECKED, not inferred - conjunctive conditions, so a future caveat class
    fails closed instead of passing silently. Condition 5 is the r2-watcher's seam test
    (lane contract seq 45): heading and body must AGREE, because the other conditions read the
    heading class and the body phrases separately and never against each other."""
    phrases = [c.strip() for c in re.findall(r"caveated on ([^\(;:\n]+)", text)]
    if cls == "VERIFIED":
        if phrases:
            return False, (f"heading says plain VERIFIED but the body carries caveat "
                           f"class(es) {sorted(set(phrases))} (class/body disagree)")
        return True, "plain VERIFIED, and the body carries no caveat phrase"
    if cls != "VERIFIED-WITH-CAVEAT":
        return False, f"{cls} stops at the coordinator"
    # the count form is a CONTRACT with the stager, and it is load-bearing: posttext2.py:106 emits
    # 'all %d files PASS' unconditionally plural, so b140 reads 'all 1 files PASS'. Accept BOTH number
    # forms (files?) so a grammatical fix on either side cannot strand valid batches, and fail closed
    # on any other wording - a held batch is a person looking, a silently posted one is not.
    all_pass = re.search(r"all \d+ files? PASS on C1/C2/C3", text) is not None
    ordering = ORDERING_CAVEAT in text
    other = [c for c in phrases if not c.startswith("timestamp ordering")]
    if all_pass and ordering and not other:
        return True, "ordering-only caveat with C1/C2/C3 passing on every file"
    why = []
    if not phrases:
        why.append("heading says VERIFIED-WITH-CAVEAT but the body carries no caveat phrase "
                   "(class/body disagree)")
    if not all_pass:
        why.append("no 'all <N> files PASS on C1/C2/C3'")
    if not ordering and phrases:
        why.append("caveat is not C3 timestamp ordering")
    if other:
        why.append(f"other caveat class(es) {sorted(set(other))}")
    return False, "; ".join(why)


def r2_stamps(text, created_str):
    """(verdict stamp, comment created) as aware datetimes, or (None, None). The verdict's own
    machine-readable time is the report stamp in the LAST line - `chain-<batch>-<YYYYMMDDTHHMMSSZ>.json`
    - not the date in the first line, which is the BATCH date, not the verdict time."""
    m = re.search(r"-(\d{8}T\d{6})Z\.json", text)
    if not m or not created_str:
        return None, None
    try:
        return (datetime.strptime(m.group(1), "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc),
                datetime.strptime(created_str, "%Y-%m-%dT%H:%M:%S.%f%z"))
    except ValueError:
        return None, None


def r2_verified_in_logs(limit=2):
    """limit=None scans every retained generation: use that for 'was this EVER verified',
    and the default two for 'has anything arrived recently that staging has not caught up with'."""
    """Batches the intake loop says it VERIFIED, read from the live head logs' BATCH-VERDICT lines.
    This is the layer above staged files: staging stops on a session rotation, so 'no new file' can
    mean 'staging is paused', and only the log knows a verdict arrived. Compares across the two most
    recent generations (r2-watcher, 2026-10-28T01:26Z)."""
    verified = {}
    logs = sorted(glob.glob(R2_LOG_GLOB),
                  key=lambda p: os.path.getmtime(p), reverse=True)
    seen = 0
    for path in logs:
        if limit is not None and seen >= limit:
            break
        try:
            with open(path, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            continue
        if "intake watch started" not in text:
            continue
        seen += 1
        for m in re.finditer(r"^BATCH-VERDICT (\S+) (\S*-b(\d+)\S*) ([A-Z][A-Z-]*)", text, re.M):
            verified.setdefault("b%d" % int(m.group(3)),
                                {"stamp": m.group(1), "class": m.group(4),
                                 "log": os.path.basename(path)})
    return verified


def r2_verified(limit=2):
    """verified(batch) = intake-state.json 'verified_batches'   (DURABLE, lags to cycle end)
                       OR a BATCH-VERDICT in a retained head log (IMMEDIATE, expires)
    Two sources because each is strongest where the other is weakest: head logs expire (673 on disk,
    retention decides which survive, which is how b107-b128 looked like orphans), and save_state runs
    only after the whole verify loop, so a batch verified inside a killed cycle is in the log and not
    yet in state. Union, with provenance kept (r2-watcher, 2026-10-28T01:31Z)."""
    merged = {}
    try:
        with open(R2_STATE or "", encoding="utf-8") as fh:
            state = json.load(fh)
        for bid in state.get("verified_batches") or []:
            m = re.search(r"-b(\d+)-|^b(\d+)$", str(bid))
            if m:
                merged.setdefault("b%d" % int(m.group(1) or m.group(2)),
                                  {"source": "state", "class": None, "stamp": None,
                                   "log": "intake-state.json"})
    except (OSError, json.JSONDecodeError, AttributeError):
        merged = {}
    for batch, rec in r2_verified_in_logs(limit).items():
        if batch in merged:
            merged[batch].update({"source": "state+log", "class": rec["class"],
                                  "stamp": rec["stamp"], "log": rec["log"]})
        else:
            merged[batch] = dict({"source": "log"}, **rec)
    return merged


def r2_actionable(not_staged, held_batches, max_posted):
    """Which file-less verified batches still need a look. Two disjuncts, because a batch number is
    not a status: a batch NEWER than the last posted one needs the staging lane to catch up, and a
    batch CURRENTLY HELD needs the coordinator's ruling - a hold is an open decision with a
    timestamp, not history, and it must not drop below the line when a later batch posts past it
    (r2-watcher, 2026-10-28T01:32Z)."""
    return [(b, v) for b, v in not_staged
            if int(b[1:]) > max_posted or b in held_batches]


def check_r2_posts(out, counts):
    out.append(f"\n## 6. R2 verdict posts ({R2_ISSUE or 'not configured'})\n")
    if not (R2_ISSUE and R2_POSTS):
        out.append("- R2 verdict feed not configured (config key r2): check skipped")
        counts["r2_pending"], counts["r2_need_ok"] = "not configured", "not configured"
        return
    if not os.path.isdir(R2_POSTS):
        out.append(f"- **posts dir absent**: {R2_POSTS} — ABSENT is not EMPTY; the check stops here")
        counts["r2_pending"], counts["r2_need_ok"] = -1, -1
        return

    # posts/ holds THREE populations and therefore three answers to "how many files": this scan's
    # pattern is b<N>.txt only, and the older 2026-<batch-id>.txt convention plus non-.txt markers sit
    # in the same directory. Every count this section prints names its pattern (r2-watcher, 01:02Z).
    entries = os.listdir(R2_POSTS)
    n_entries, n_txt = len(entries), sum(1 for n in entries if n.endswith(".txt"))
    globbed = sorted(os.path.basename(p) for p in glob.glob(f"{R2_POSTS}/b*.txt"))
    scanned = sorted(e.name for e in os.scandir(R2_POSTS)
                     if e.is_file() and e.name.startswith("b") and e.name.endswith(".txt"))
    if globbed != scanned:
        out.append(f"- **GLOB-VS-EXISTS DISAGREEMENT**: glob {len(globbed)} vs scandir {len(scanned)}; "
                   f"glob-only {sorted(set(globbed) - set(scanned))}, "
                   f"scandir-only {sorted(set(scanned) - set(globbed))} — a short or empty glob is an "
                   f"INCOMPLETE answer, not a negative one (r2-watcher finding 2026-10-28T00:45Z); "
                   f"the scandir set is what this section reports")

    staged = {}
    for name in scanned:
        batch = "b%d" % int(name[1:-4])
        try:
            with open(f"{R2_POSTS}/{name}", encoding="utf-8") as fh:
                text = fh.read()
        except OSError as exc:
            staged[batch] = ("UNREADABLE", str(exc)[:60], 0, "")
            continue
        head = text.split("\n", 1)[0].strip()
        m = VERDICT_LINE.match(head)
        staged[batch] = (m.group(1) if m else "NON-VERDICT-FIRST-LINE", head[:80],
                         len(text.rstrip()), text)

    # A comment this lane posts carries a `[agent:<name> | run:<id>]` attribution line ABOVE the
    # verdict. Comparing it to the staged file flagged every batch this lane posted itself as
    # 'content changed without a newer verdict stamp' (9 rows on 2026-10-28: b165-b173) - a
    # comparison artefact, not an edit, and the kind of false alarm a coordinator would act on.
    def posted_body(text):
        lines = (text or "").split("\n")
        if lines and AGENT_HEADER.match(lines[0].strip()):
            return "\n".join(lines[1:]).lstrip("\n")
        return text

    comments = all_comments(R2_ISSUE)
    posted = {}
    for c in comments:
        for ln in flat_body(c).split("\n"):
            m = VERDICT_LINE.match(ln)
            if m and m.group(3) not in posted:
                posted[m.group(3)] = (c["id"], c.get("created", ""), flat_body(c))

    # controls (config r2.control): a batch known to be posted in a known comment, and a batch that never was
    pb, pc = R2_CONTROL.get("posted_batch"), R2_CONTROL.get("posted_comment")
    ab = R2_CONTROL.get("absent_batch", "b999")
    ctrl_pos = posted.get(pb, (None,))[0] if pb else None
    ctrl_neg = posted.get(ab)
    if not pb or ctrl_pos != str(pc) or ctrl_neg is not None:
        out.append(f"- **CONTROL FAILURE**: posted-control {pb} -> {ctrl_pos} (expect {pc}), "
                   f"absent-control {ab} -> {ctrl_neg} (expect None); the map is suspect, no rows below")
        counts["r2_pending"], counts["r2_need_ok"] = -1, -1
        return

    # a listing that regresses is incomplete, not empty: batch numbers only ever grow. The watermark is
    # advanced by VERDICT files only - a stray non-verdict file (a SKIP marker, a probe) must not move a
    # monotone counter, or its removal later manufactures a false WATERMARK REGRESS.
    verdict_like = {"VERIFIED", "VERIFIED-WITH-CAVEAT", "FAIL"}
    anomalies = [b for b in staged if staged[b][0] not in verdict_like]
    highest = max([int(n[1:-4]) for n in scanned
                   if n[1:-4].isdigit() and staged.get(n[:-4], ("",))[0] in verdict_like], default=0)
    try:
        with open(R2_WATERMARK) as fh:
            mark = int(json.load(fh).get("max", 0))
    except (FileNotFoundError, json.JSONDecodeError, TypeError, ValueError):
        mark = 0
    if highest < mark:
        out.append(f"- **WATERMARK REGRESS**: this scan reaches b{highest} but the lane has seen b{mark} — "
                   f"the listing is INCOMPLETE, so 'no pending' below is not a measurement (r2-watcher case)")
        counts["r2_incomplete"] = 1
    if highest != mark:
        with open(R2_WATERMARK, "w") as fh:
            json.dump({"max": highest, "stamp": stamp()}, fh)

    pending = [(b, *staged[b]) for b in sorted(staged, key=lambda s: int(s[1:]) if s[1:].isdigit() else 0)
               if b not in posted and b not in anomalies]
    need_ok = [p for p in pending if not r2_postable(p[1], p[4])[0]]
    out.append(f"- staged files, pattern `b<N>.txt`: **{len(scanned)}** "
               f"({scanned[0][:-4] if scanned else '-'}..{scanned[-1][:-4] if scanned else '-'}) "
               f"of {n_txt} .txt and {n_entries} entries in posts/ (older `2026-*.txt` and non-.txt "
               f"markers are out of scope by construction) · already on {R2_ISSUE}: "
               f"**{len([b for b in staged if b in posted])}**"
               f" · pending: **{len(pending)}** (of which need the coordinator's OK: {len(need_ok)})"
               f" · non-verdict files: {len(anomalies)}")
    out.append(f"- {R2_ISSUE} comments: {len(comments)}")
    if anomalies:
        out.append("  - **NOT A VERDICT — no action taken**, reported because a file in posts/ that is not a "
                   "verdict must be visible, not skipped: "
                   + ", ".join(f"{b} ({staged[b][0]}: {staged[b][1][:50]})" for b in anomalies))
        counts["r2_anomaly"] = len(anomalies)
    for batch, cls, head, chars, body in pending:
        ok, why = r2_postable(cls, body)
        flag = f"POST-ON-SIGHT ({why})" if ok else f"HOLD — {why} — stops at the coordinator"
        out.append(f"  - **{batch}** {chars} chars | {flag} | {head}")

    # verdict -> post latency: the lane's own responsiveness, measured from the report stamp
    # inside the verdict file to the comment's server created time. Both ends are artefacts.
    lat, lat_fail = [], []
    for batch in sorted(staged, key=lambda s: int(s[1:]) if s[1:].isdigit() else 0):
        if batch not in posted:
            continue
        v, p = r2_stamps(staged[batch][3], posted[batch][1])
        if v is None:
            lat_fail.append(batch)
            continue
        lat.append(((p - v).total_seconds() / 60.0, batch, v.strftime("%Y-%m-%d")))
    if lat:
        # TWO POPULATIONS, never one median: a verdict posted in a batch (an older wave, awaited an
        # operator turn) and a verdict posted per-verdict (this lane watching) are different regimes,
        # and a single median is dominated by whichever is larger. Split on the verdict's own date.
        groups = {}
        for x, batch, day in lat:
            groups.setdefault(day, []).append(x)
        parts = []
        for day in sorted(groups):
            xs = sorted(groups[day])
            parts.append(f"{day}: n={len(xs)} median **{xs[len(xs) // 2]:.1f} min** "
                         f"({xs[0]:.1f}-{xs[-1]:.1f})")
        last = ", ".join(f"{b} {x:.1f}m" for x, b, _ in lat[-3:])
        out.append("- verdict→post latency by verdict-day (two populations, never one number): "
                   + " · ".join(parts) + f"; last three: {last}")
        if len(groups) > 1:
            out.append("  - quote the population that matches the question: the older day covers batched "
                       "posting, the current day is per-verdict responsiveness")
    if lat_fail:
        out.append(f"- latency not computable for {len(lat_fail)} batch(es) {lat_fail[:5]}: the parse failed, "
                   f"so the missing number is an instrument fault, not a missing measurement")

    # Three states for a batch already on the issue, all of them REPORTED and none of them posted again:
    # identical re-stage (nothing to do), re-verification (a NEWER verdict exists - the coordinator decides),
    # and content changed without a newer verdict stamp (the dangerous one: an edit that claims no new
    # verification). The dup test would have skipped all three silently (r2-watcher, lane contract seq 45/46).
    same, reverify, changed = [], [], []
    for batch in sorted(staged, key=lambda s: int(s[1:]) if s[1:].isdigit() else 0):
        if batch not in posted:
            continue
        v, p = r2_stamps(staged[batch][3], posted[batch][1])
        body = staged[batch][3]
        if body.rstrip() == posted_body(posted[batch][2]).rstrip():
            same.append(batch)
        elif v is not None and p is not None and v > p:
            reverify.append((batch, v, p, posted[batch][0]))
        else:
            changed.append(batch)
    counts["r2_restaged_identical"] = len(same)
    if reverify:
        out.append(f"- **RE-VERIFICATION, not posted** ({len(reverify)}): the staged file is NEWER than the "
                   f"verdict already on the issue, so a second verdict is the coordinator's call, not this check's")
        for batch, v, p, cid in reverify:
            out.append(f"  - {batch}: file verdict {v.strftime('%Y-%m-%dT%H:%M:%SZ')} > c{cid} created "
                       f"{p.strftime('%Y-%m-%dT%H:%M:%SZ')} (+{(v - p).total_seconds() / 60:.1f} min)")
    if changed:
        out.append(f"- **CONTENT CHANGED WITHOUT A NEWER VERDICT STAMP** ({len(changed)}): {changed[:5]} — "
                   f"the file on disk differs from the posted text but its own stamp is not newer, so it "
                   f"cannot be called a re-verification; the coordinator decides")
    counts["r2_reverify"] = len(reverify)
    counts["r2_changed"] = len(changed)
    for batch, cid, created in [(b, posted[b][0], posted[b][1]) for b in
                                sorted(posted, key=lambda s: int(s[1:]) if s[1:].isdigit() else 0)][-3:]:
        out.append(f"  - posted {batch} → c{cid} created {created}")
    if not pending:
        out.append(f"  - nothing pending: every staged verdict is already on {R2_ISSUE}")

    # the layer above the files: a verdict that arrived while staging was paused has NO file here
    verified = r2_verified()          # recent: state + this generation and the one before
    verified_all = r2_verified(None)  # ever: state + every retained generation
    # 'not staged' must be measured over BOTH naming conventions: a batch whose file is named
    # 2026-10-25-b01-rec-metals.txt IS staged, and testing only the b<N>.txt pattern reported 101
    # verified batches as unstaged — the pattern-vs-population error for the third time tonight.
    staged_any = set()
    for name in entries:
        m = re.search(r"b(\d+)", name)
        if m:
            staged_any.add("b%d" % int(m.group(1)))
    not_staged = [(b, v) for b, v in sorted(verified.items()) if b not in staged_any]
    # 'never logged' must be measured against ALL generations: b107-b128 were verified by older ones
    # whose logs are no longer the two most recent, so a two-generation test reports them as orphans
    no_verdict = [b for b in staged if b not in verified_all]
    srcs = {}
    for v in verified_all.values():
        srcs[v["source"]] = srcs.get(v["source"], 0) + 1
    out.append(f"- verified verdicts (state ∪ logs): **{len(verified)}** recent, "
               f"**{len(verified_all)}** overall by source {srcs} · staged-but-never-verified: "
               f"{len(no_verdict)}")
    # the scope belongs beside the number: 'log-only' is only comparable across lanes if both count
    # the same population. This one is ALL retained head logs x absent-from-state, which is the same
    # definition the R2 watcher uses - if one lane scoped to the two most recent generations and the
    # other to all retained, both could read 18 for different reasons and each be right.
    out.append(f"  - `log-only` scope: every retained head log, verdict present, absent from "
               f"intake-state.json verified_batches (n={srcs.get('log', 0)}); compare only against a "
               f"count using the same population")
    if not_staged:
        # Only batches NEWER than the highest one posted are actionable: b1-b13 were verified days ago
        # and their files were never retained, so they are history, not a paused staging lane. Without
        # this split the row reports 13 permanent entries and stops being read - a standing alarm.
        max_posted = max([int(b[1:]) for b in posted if b[1:].isdigit()], default=0)
        held_batches = {b for b, *_ in pending}
        recent_unstaged = r2_actionable(not_staged, held_batches, max_posted)
        out.append(f"- verified with no file in posts/: **{len(not_staged)}** total, of which "
                   f"**{len(recent_unstaged)}** actionable — newer than the last posted batch "
                   f"(b{max_posted}) OR currently held for the coordinator, since a hold is an open "
                   f"decision and must not drop below the line when a later batch posts past it; "
                   f"the rest are older batches whose staging file was never retained")
        if recent_unstaged:
            out.append(f"- **VERIFIED BUT NOT STAGED, ACTIONABLE** ({len(recent_unstaged)}): the loop "
                       f"verified these and no file exists — staging is paused (session rotation) or was "
                       f"interrupted, so 'no new files' does NOT mean nothing arrived; the owner stages on "
                       f"its next turn")
            for b, v in recent_unstaged:
                out.append(f"  - {b} {v['class']} at {v['stamp']} ({v['log']})")
        counts["r2_verified_not_staged"] = len(recent_unstaged)
    if no_verdict:
        out.append(f"- **STAGED WITH NO BATCH-VERDICT LINE** ({len(no_verdict)}): {sorted(no_verdict)[:6]} — "
                   f"a file whose verification is not in either live log; check the generation before "
                   f"concluding anything about it")
        counts["r2_staged_without_verdict"] = len(no_verdict)
    counts["r2_staged"] = len(scanned)
    counts["r2_pending"] = len(pending)
    counts["r2_need_ok"] = len(need_ok)


def state_db_readonly(path=STATE_DB, timeout=2.0):
    """Open Substrate's state.db STRICTLY read-only.

    Coordinator hard rule, 2026-10-28T12:1xZ: state.db is a live database held open by several
    processes, so this opens through a `file:` URI with `mode=ro` and a short busy timeout - never a
    plain connect (which creates the file if absent and takes write locks), never a write, never a
    migration. The busy timeout is deliberately short: a cycle that blocks on the board database is
    worse than a cycle that reports it could not read.
    """
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=timeout)


def new_tickets_since(watermark_ms, db_path=STATE_DB):
    """Substrate issues created after `watermark_ms`, compared as INTEGER MILLISECONDS.

    The comparison type is the whole point and has its own control (ctl-newtickets.py C1):
    `created_at` is an integer of epoch milliseconds, so a text cut-off silently returns nothing -
    three confident zeros were produced that way on 2026-10-28 before the column type was read.
    """
    if not isinstance(watermark_ms, int):
        raise TypeError(f"watermark must be integer ms, got {watermark_ms!r}")
    with state_db_readonly(db_path) as con:
        return list(con.execute(
            "select human_number, kind, lifecycle_state, created_at, title from issues "
            "where project_id = ? and created_at > ? order by created_at", (SB_PROJECT_ID, watermark_ms)))


def contract_sections(ref):
    """The contract's section names for one issue, or None when the read fails.

    oracle-free by design: this asks the Substrate issue, not the ticket text, so a THIN verdict is about what
    the contract carries, not about how long a description looks.
    """
    res = subprocess.run([lanecfg.sb_bin(), "issue", "show", ref, "--json"], capture_output=True, text=True,
                         timeout=60)
    if res.returncode != 0:
        return None
    try:
        data = json.loads(res.stdout)["data"]
    except (ValueError, KeyError):
        return None
    contract = data.get("contract")
    return set(contract.keys()) if isinstance(contract, dict) else set()


def _deep_save(seen, pending):
    with open(DEEP_SEEN, "w") as fh:
        json.dump({"refs": sorted(seen), "pending": sorted(set(pending)), "set_at": stamp()}, fh, indent=1)


def deep_dup_pass(out, refs, counts):
    """Run the deep duplicate probe for rows it has not seen, and print CANDIDATES only.

    WHY in-cycle (coordinator, 2026-11-04 05:27Z): the filing rate beat the manual batch — 20 rows in ~45
    minutes, every one THIN no — so the duty had to move to the instrument that already runs every 15
    minutes. WHY it prints candidates and not a verdict: "same symptom + same code site + same fix" is a
    human judgement; a probe that announced "no duplicates" would be claiming one it cannot make.

    Fail-closed discipline, the same as the drift instrument: a non-zero exit (the probe's control failed,
    or its snapshot is missing) prints CONTROL FAILED and marks NO row as seen, so the next cycle retries
    instead of silently forgetting.
    """
    try:
        with open(DEEP_SEEN) as fh:
            state = json.load(fh)
    except Exception:
        state = {}
    seen = set(state.get("refs") or [])
    # PENDING closes the loop the watermark would otherwise open: a row the probe failed on is behind the
    # watermark next cycle, so it never comes back through check_new_tickets. Without this list a failed
    # probe silently forgets the row, which is the "zero means unseen, not clean" trap in another shape.
    pending = [r for r in (state.get("pending") or []) if r not in seen]
    fresh = pending + [r for r in refs if r not in seen and r not in pending]
    counts["deep_dup_pending"] = len(fresh)
    if not fresh:
        out.append("  - DEEP duplicate probe: every row of this batch was already probed")
        return
    batch = fresh[:DEEP_MAX_PER_CYCLE]
    out.append(f"  - DEEP duplicate probe on {len(batch)} row(s) "
               f"({len(fresh) - len(batch)} held for a later cycle), candidates only:")
    try:
        proc = subprocess.run(
            [sys.executable, DEEP_PROBE, *_deep_control_args(), *batch],
            capture_output=True, text=True, timeout=DEEP_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001
        out.append(f"    - CONTROL FAILED: probe did not run ({exc}); no row is called clean")
        counts["deep_dup_ok"] = False
        _deep_save(seen, sorted(set(pending) | set(batch)))
        return
    if proc.returncode != 0:
        out.append(f"    - CONTROL FAILED (exit {proc.returncode}): the probe refuses to grade; "
                   "no row is called clean and the batch is held as pending")
        counts["deep_dup_ok"] = False
        _deep_save(seen, sorted(set(pending) | set(batch)))
        return
    counts["deep_dup_ok"] = True
    cur, hits = None, {"jira": 0, "sb": 0, "first": ""}
    done = []
    def flush():
        if cur is None:
            return
        out.append(f"    - {cur}: jira={hits['jira']} sb={hits['sb']}"
                   + (f" | nearest {hits['first']}" if hits["first"] else " | no candidate on any term"))
    for line in proc.stdout.splitlines():
        m = re.match(r"^(" + SB_RE + r"-\d+) \[", line)
        if m:
            flush()
            cur, hits = m.group(1), {"jira": 0, "sb": 0, "first": ""}
            done.append(cur)
            continue
        if cur is None:
            continue
        s = line.strip()
        if s.startswith("JIRA"):
            hits["jira"] += 1
            if not hits["first"]:
                hits["first"] = s[5:80]
        elif s.startswith("SB "):
            hits["sb"] += 1
    flush()
    _deep_save(seen | set(done), [r for r in pending if r not in done])


def check_new_tickets(out, counts):
    """Check 7 of the board-audit skill, wired into the cycle (coordinator ruling 2026-10-28T12:1xZ).

    This is the one check that had NO instrument: checks 1-6 lived in cycle.py and check 7 lived only
    as a skill section, so "all checks always" was false for it until an operator asked for an
    accounting. The cycle now reports every Substrate issue filed since the previous cycle's high-water
    mark, with the THIN verdict; the DEEP duplicate pass stays a separate duty because it needs
    semantic comparison across the whole board and cannot be done mechanically here.
    """
    out.append("\n## 7. New tickets since the previous cycle\n")
    try:
        with open(NEWTICKET_WATERMARK) as fh:
            wm = json.load(fh)["watermark_ms"]
        first_run = False
    except (FileNotFoundError, ValueError, KeyError, TypeError) as exc:
        wm, first_run = None, True
        out.append(f"- **watermark initialised this cycle** ({exc.__class__.__name__}): the baseline is "
                   f"recorded and nothing is reported as new, so a first poll cannot dump the board as news")
    try:
        if first_run:
            with state_db_readonly() as con:
                top = list(con.execute("select coalesce(max(created_at), 0) from issues "
                                       "where project_id = ?", (SB_PROJECT_ID,)))[0][0]
            rows = []
        else:
            rows = new_tickets_since(wm)
    except (sqlite3.Error, TypeError) as exc:
        out.append(f"- **INSTRUMENT GAP, not a clean board**: state.db unreadable ({exc.__class__.__name__}: "
                   f"{exc}) - read-only connect, short busy timeout; the watermark is NOT advanced")
        counts["new_tickets_gap"] = str(exc)
        return
    if first_run:
        with open(NEWTICKET_WATERMARK, "w") as fh:
            json.dump({"watermark_ms": int(top), "set_at": stamp()}, fh)
        counts["new_tickets"] = 0
        return
    out.append(f"- watermark {wm} ms (epoch) · {SB} issues filed after it: **{len(rows)}**")
    thin_n = 0
    new_refs = []
    for human_number, kind, state, created_ms, title in rows:
        ref = f"{SB}-{human_number}"
        new_refs.append(ref)
        created = datetime.fromtimestamp(created_ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
        sections = contract_sections(ref)
        if sections is None:
            verdict = "THIN unknown (contract unreadable)"
        else:
            have = {k.lower().replace("_", "") for k in sections}
            missing = [s for s in CONTRACT_SECTIONS if s.replace("_", "").lower() not in have]
            verdict = "THIN yes" if missing else "THIN no"
            if missing:
                thin_n += 1
                verdict += f" (missing {', '.join(missing)})"
        out.append(f"  - {ref} | {created} | {state} | {kind} | {verdict} | {(title or '')[:70]}")
    if not rows:
        out.append("  - nothing filed since the previous cycle")
    else:
        # r[0] is human_number, an INT: the first run passed ints to argv and the probe refused.
        deep_dup_pass(out, new_refs, counts)
    new_wm = max([r[3] for r in rows], default=wm)
    with open(NEWTICKET_WATERMARK, "w") as fh:
        json.dump({"watermark_ms": int(new_wm), "set_at": stamp()}, fh)
    counts["new_tickets"] = len(rows)
    counts["new_tickets_thin"] = thin_n


_PR_REFS_CACHE = {}


def pr_item_refs(number):
    """Refs one PR resolves to (Substrate then Jira), or None when the lookup failed.

    A failed lookup is UNKNOWN, never 'windowed': the safe direction for this check is to report,
    and a PR whose title carries no ref is also unknown, because a silent clean is the one answer
    this instrument must never invent.
    """
    if number in _PR_REFS_CACHE:
        return _PR_REFS_CACHE[number]
    d = gh(["pr", "view", str(number), "--json", "title,headRefName"])
    if not isinstance(d, dict):
        _PR_REFS_CACHE[number] = None
        return None
    text = (d.get("title") or "") + " " + (d.get("headRefName") or "")
    refs = list(dict.fromkeys(ITEM_MMD_RE.findall(text)))
    refs += [f"{PROJECT}-{t}" for t in dict.fromkeys(re.findall(KEY_NUM_RE, text))]
    _PR_REFS_CACHE[number] = refs
    return refs


def contract_items(scope, self_ref, named, window_keys):
    """Map each distinct piece of work named in the scope to True (windowed) / False / None (unknown).

    Items are keyed by identity: a PR collapses to the first ref it carries, so a contract naming
    #808/#809 - both carrying one ref - counts that ref as ONE item, not three.
    """
    items = {}
    scope = re.sub(r"promotion\s+#\d+", "promotion", scope, flags=re.IGNORECASE)
    for ref in dict.fromkeys(ITEM_MMD_RE.findall(scope)):
        if ref == self_ref:
            continue
        items[ref] = ref in named
    for a, b in dict.fromkeys(PR_MENTION_RE.findall(scope)):
        num = a or b
        refs = pr_item_refs(num)
        if not refs:
            items[f"#{num}"] = None
            continue
        key = refs[0]
        if key == self_ref:
            continue
        items[key] = any(r in named or r in window_keys for r in refs)
    return items


def item_info(refs):
    """kind, title, created_at and scope for each Substrate ref, in one read-only pass.

    An umbrella's items are the units the coordinator acts on, so a report that shows the umbrella's
    title against an item's ref is unreadable: each item is described by its own row.
    """
    refs = [r for r in dict.fromkeys(refs) if r.startswith(f"{SB}-")]
    if not refs:
        return {}
    nums = [int(r.split("-")[1]) for r in refs]
    q = ("select i.human_number, i.kind, i.title, i.created_at, r.contract_json from issues i "
         "join issue_revisions r on r.issue_id = i.id and r.revision = i.current_revision "
         "where i.project_id = ? and i.human_number in (" + ",".join("?" * len(nums)) + ")")
    out = {}
    try:
        with state_db_readonly() as con:
            for n, kind, title, created, cj in con.execute(q, [SB_PROJECT_ID] + nums):
                try:
                    contract = json.loads(cj) if isinstance(cj, str) else (cj or {})
                except ValueError:
                    contract = {}
                scope = " ".join(str(contract.get(k) or "") for k in ("scope", "success")) \
                    if isinstance(contract, dict) else ""
                out[f"{SB}-{n}"] = (kind, title, created, scope)
    except sqlite3.Error:
        return out
    return out


def adf_text(node):
    """Every text string inside a Jira ADF document, in document order."""
    parts = []

    def walk(n):
        if isinstance(n, dict):
            if n.get("type") == "text":
                parts.append(n.get("text") or "")
            for v in n.values():
                walk(v)
        elif isinstance(n, list):
            for v in n:
                walk(v)

    walk(node)
    return " ".join(parts)


def window_named(rows):
    """(binding, mentions, junk, window_keys) over the open window rows.

    binding = the ref sits in the row's summary or labels, or in a sentence that binds it to the row
    ("carries", "folded", "precondition", "deploys", "rides"). mentions = the ref appears in a
    description without such a sentence: reported, never counted as covered. junk = a token shorter than
    four digits, which is a truncated number rather than a ref.
    """
    binding, mentions, junk, keys = set(), set(), set(), set()
    for r in rows:
        f = r.get("fields") or {}
        keys.add(r.get("key"))
        strong = f"{f.get('summary') or ''} " + " ".join(f.get("labels") or [])
        strong_refs = set(WINDOW_REF_RE.findall(strong))
        binding |= strong_refs
        junk |= set(re.findall(SB_RE + r"-\d+", strong)) - strong_refs
        text = adf_text(f.get("description"))
        for sentence in re.split(r"(?<=[.!?;])\s+|\n+", text):
            for ref in set(WINDOW_REF_RE.findall(sentence)):
                if binds(ref, sentence):
                    binding.add(ref)
                else:
                    mentions.add(ref)
        junk |= set(re.findall(SB_RE + r"-\d+", text)) - set(WINDOW_REF_RE.findall(text))
    mentions -= binding
    junk -= binding | mentions
    return binding, mentions, junk, keys


def comment_bindings(refs, max_rows=4):
    """{ref: (row_key, comment_id)} for refs bound by a COMMENT on an open window row.

    A binding does not have to be in the description: a lane batch wrote "[<lane>-B10] Binds
    Substrate SB-2913" as the only comment on a window row, and reading only summary/labels/description
    would report a correctly bound contract as unwindowed. The record is read rather than assumed, and
    bounded: one JQL per ref (Jira `text ~` searches comments) and the few rows it returns, so a ref no
    row names costs one query and stops.
    """
    covered = {}
    for ref in refs:
        rows, ok = jql(f'project = {PROJECT} AND labels = window AND statusCategory != Done AND text ~ "{ref}"',
                       fields=["key", "summary", "labels", "description", "status"])
        if not ok:
            continue
        for r in rows[:max_rows]:
            for c in all_comments(r.get("key")):
                txt = flat_body(c)
                for sentence in re.split(r"(?<=[.!?;])\s+|\n+", txt):
                    if ref in sentence and binds(ref, sentence):
                        covered[ref] = (r.get("key"), c.get("id"))
                        break
                if ref in covered:
                    break
            if ref in covered:
                break
    return covered


def window_exceptions(epic=None):
    """(exempt_refs, entries) for the no-window-exception record; every class is classified.

    The record is a comment on the exceptions epic (config key exceptions_epic). It grows by ADDENDUM
    and its class shape changed mid-flight - "(a) Substrate SB-nnnn" became "(e) no window needed:
    SB-nnnn; SB-nnnn" - so a parse keyed on the old shape silently exempted NOTHING from addendum 2 and
    would have reported eleven sound exemptions as findings (measured 2026-10-28 on comment 15649).

    Each class is classified by its own text, never by its letter, and the vocabulary is printed:
      exemption  - "no window needed", "infra-owned", "no service deploy", "ops tooling",
                   "deploy tooling", "post-11-05" (a deferral the operator ruled on)
      FINDING    - "no window yet", "stale", "duplicate", "provisional": these are open items with an
                   owner, not exemptions (the lane's own rule for (g) and (h)); (i) is a provisional
                   duplicate, so it stays visible until the duplicate is closed.
    FINDING wins over exemption, and an unclassified class is KEPT VISIBLE: an exemption nobody
    can name is not an exemption.
    """
    entries = []
    epic = epic or EXCEPTIONS_EPIC
    if not epic:
        return set(), entries
    for c in all_comments(epic):
        txt = flat_body(c)
        if EXCEPTION_HEADING not in txt:
            continue
        starts = list(EXCEPTION_CLASS_RE.finditer(txt))
        for i, m in enumerate(starts):
            end = starts[i + 1].start() if i + 1 < len(starts) else len(txt)
            body = txt[m.end():end]
            cut = EXCEPTION_CLASS_END_RE.search(body)
            if cut:
                body = body[:cut.start()]
            body = body.strip()
            refs = sorted(set(EXCEPTION_REF_RE.findall(body)))
            if not refs:
                continue
            find = EXCEPTION_FINDING_RE.search(body)
            exc = EXCEPTION_EXEMPT_RE.search(body)
            closed = EXCEPTION_CLOSED_RE.search(body)
            if find:
                entries.append((c.get("id"), m.group(1), False, find.group(0).lower(), refs))
            elif closed:
                entries.append((c.get("id"), m.group(1), False, "closed by the lane", refs))
            elif exc:
                entries.append((c.get("id"), m.group(1), True, exc.group(0).lower(), refs))
            else:
                entries.append((c.get("id"), m.group(1), False, "unclassified", refs))
    exempt_refs = {r for _cid, _l, ok, _why, refs in entries if ok for r in refs}
    return exempt_refs, entries


def check_unmirrored_contracts(out, counts):
    """Check 8: an open READY Substrate contract with PRODUCTION scope and no open window row.

    WHY THIS EXISTS (coordinator ruling 2026-10-28): the cycle counted only the reverse
    direction - a Substrate ref on a merged PR with no Jira row - so a READY contract that changes
    config, schema or serving and has no window row was invisible to every check, including the
    Tabellone filter. One contract sat READY, rev 2, with an operator decision, and with no
    Jira row at all. The coordinator narrowed the 38-unmirrored finding to this class: worker tasks,
    smoke tests, pr-reviewer evals and lane issues stay in Substrate only, by rule.

    SCOPE TEST reads only the SCOPE and SUCCESS sections of the contract against PROD_PATH_RE. Reading
    the whole contract JSON flagged 425 rows on the first run, because hundreds of pr-reviewer, smoke and
    audit contracts merely MENTION a production path in their constraints or evidence; a mention is not a
    scope. A smoke test whose scope names no production path is not flagged - that is the negative
    control. A contract whose scope is unreadable is reported as UNKNOWN, never counted clean.
    """
    out.append("\n## 8. Production contracts with no window row\n")
    fields = ["key", "summary", "description", "labels", "status"]
    rows, complete = jql(f'project = {PROJECT} AND labels = window AND statusCategory != Done', fields=fields)
    if not complete and not rows:
        out.append("- **INSTRUMENT GAP, not a clean board**: window-row query failed, so whether a contract "
                   "has a row is UNKNOWN this cycle")
        counts["unmirrored_gap"] = "window query failed"
        return
    binding, mentions, junk, window_keys = window_named(rows)
    exempt, exempt_classes = window_exceptions()
    named = binding | exempt
    if not WINDOW_BINDING_RULE:
        # The old rule, kept measurable: any ref anywhere in the row's fields counts as covered.
        named = binding | mentions | junk | exempt
    out.append(f"- open window rows read: {len(rows)}; they bind {len(binding)} {SB} ref(s) "
               f"(summary/labels or a binding sentence)")
    if mentions:
        out.append(f"- {len(mentions)} ref(s) appear only as an UNBOUND mention in a description, so they do NOT "
                   f"count as covered: {', '.join(sorted(mentions)[:8])}"
                   f"{f' +{len(mentions) - 8} more' if len(mentions) > 8 else ''} (counts key "
                   f"`unmirrored_mention_only`)")
    if junk:
        out.append(f"- junk refs dropped (fewer than 4 digits, truncated numbers rather than refs): "
                   f"{', '.join(sorted(junk))}")
    exc_ok = [(cid, l, refs) for cid, l, ok, _w, refs in exempt_classes if ok]
    exc_no = [(cid, l, why, refs) for cid, l, ok, why, refs in exempt_classes if not ok]
    exc_src = (", ".join(f"{cid}({l}: {', '.join(refs)})" for cid, l, refs in exc_ok)
               if exc_ok else "MISSING")
    out.append(f"- no-window exceptions (union over every addendum on {EXCEPTIONS_EPIC or 'no epic configured'}, classified by class TEXT, "
               f"not by letter): {', '.join(sorted(exempt)) if exempt else 'none'} [{exc_src}]")
    if exc_no:
        findings_only = [e for e in exc_no if e[2] != "closed by the lane"]
        closed_only = [e for e in exc_no if e[2] == "closed by the lane"]
        if findings_only:
            out.append("- classes KEPT VISIBLE because they are findings, not exemptions (a ref here is still "
                       "reported): " + "; ".join(
                           f"({l}) {why}: {', '.join(refs)} [comment {cid}]"
                           for cid, l, why, refs in findings_only))
        if closed_only:
            out.append("- classes recording a LANE CLOSURE (not a finding, and never an exemption - if a claimed "
                       "closure is wrong the ref stays visible): " + "; ".join(
                           f"({l}) {', '.join(refs)} [comment {cid}]" for cid, l, _w, refs in closed_only))
    cutoff = int((datetime.now(timezone.utc) - timedelta(days=UNMIRRORED_HORIZON_DAYS)).timestamp() * 1000)
    # issues.created_at is epoch MILLISECONDS, not an ISO string: an ISO cutoff compares '1777...' against
    # '2026-...' as text and silently selects nothing (caught by the positive control 2026-10-28: the
    # instrument reported zero rows while the calibration probe reported 18).
    try:
        with state_db_readonly() as con:
            cand = list(con.execute(
                """select distinct i.human_number, i.kind, i.title, i.created_at, r.contract_json
                   from issues i
                   join issue_revisions r on r.issue_id = i.id and r.revision = i.current_revision
                   join readiness_attestations a on a.issue_id = i.id and a.issue_revision = i.current_revision
                   left join issue_closures c on c.issue_id = i.id
                   where i.project_id = ? and c.terminal_state is null
                     and i.created_at >= ?
                     and not exists (select 1 from issue_claims k where k.issue_id = i.id
                                     and k.released_at is null)""", (SB_PROJECT_ID, cutoff)))
    except sqlite3.Error as exc:
        out.append(f"- **INSTRUMENT GAP, not a clean board**: state.db unreadable ({exc.__class__.__name__}: {exc})")
        counts["unmirrored_gap"] = str(exc)
        return
    flagged, unknown = [], 0
    readonly_excluded, readonly_control = 0, []
    lane_excluded, lane_control = [], []
    umbrellas_seen, umbrellas_clean, umbrella_rows, umbrellas_nonprod = 0, [], [], []
    readonly_item_refs = []
    seen = set()
    for n, kind, title, created, cj in cand:
        ref = f"{SB}-{n}"
        if ref in seen:
            continue
        seen.add(ref)
        try:
            contract = json.loads(cj) if isinstance(cj, str) else (cj or {})
        except ValueError:
            unknown += 1
            continue
        if not isinstance(contract, dict):
            unknown += 1
            continue
        scope = " ".join(str(contract.get(k) or "") for k in ("scope", "success"))
        if not scope.strip():
            unknown += 1
            continue
        if ref in named:
            continue
        # An umbrella is judged by its items BEFORE the production-path gate: a builder contract's
        # scope is a list of refs and describes its items, so the production paths live in the items'
        # own contracts, not here (one umbrella named no path of its own; its items did, and the first
        # version of this rule missed it for exactly that reason, 2026-10-28).
        items = contract_items(scope, ref, named, window_keys)
        if len(items) >= UMBRELLA_MIN_ITEMS:
            # NOT every ref-list is a production umbrella. A review or coordination task also lists
            # its subject, and the lane's audit called exactly that class a false positive. So an
            # umbrella counts as production work only when one of its items is production-scoped:
            # the paths live in the items' contracts, and an umbrella whose own scope names none
            # is the row that proved the rule must look there.
            if READONLY_SCOPE_RE.search(scope):
                umbrellas_nonprod.append(ref)
                continue
            info = item_info(list(items))
            if not PROD_PATH_RE.search(scope) and not any(
                    PROD_PATH_RE.search(v[3]) and not READONLY_SCOPE_RE.search(v[3])
                    for v in info.values()):
                umbrellas_nonprod.append(ref)
                continue
            umbrellas_seen += 1
            # An ITEM that is itself a read-only review or audit never needs a window, so the same
            # exclusion applies to items as to whole contracts. Without it a DST ruling umbrella
            # surfaced two audit items as production gaps - one whose own scope says "infra repo ...
            # ONLY", and a query re-run - purely because a sibling item was
            # analytics-scoped (measured 2026-10-28 on the widened PROD_PATH_RE).
            readonly_items = [k for k, v in items.items()
                              if v is False and k in info and READONLY_SCOPE_RE.search(info[k][3])]
            for k in readonly_items:
                items.pop(k)
                readonly_item_refs.append(k)
            # A LANE contract listed as an umbrella ITEM gets the same exclusion as a top-level one. Without
            # this the lane rule read zero while the lane contract sat in the report: it was flagged as an item of
            # another umbrella, a path that never reached the top-level lane test (caught 2026-10-28 by the
            # lane control itself).
            lane_items = [k for k, v in items.items()
                          if v is False and k in info and LANE_SCOPE_RE.search(info[k][3])]
            for k in lane_items:
                items.pop(k)
                lane_excluded.append(k)
                if k == LANE_CONTROL_REF:
                    lane_control.append(k)
            gaps = [k for k, v in items.items() if v is False]
            unknown_items = [k for k, v in items.items() if v is None]
            if not gaps and not unknown_items:
                umbrellas_clean.append(ref)
                continue
            umbrella_rows.append((ref, kind, title, created, gaps, unknown_items, len(items)))
            for g in gaps:
                ik, it, ic, _ = info.get(g, (kind, title, created, ""))
                flagged.append((g, ik, it or f"(item of {ref})", ic))
            for u in unknown_items:
                flagged.append((u, "unknown", f"(PR of {ref}; lookup failed or carried no ref)", created))
            continue
        if not PROD_PATH_RE.search(scope):
            continue
        if READONLY_SCOPE_RE.search(scope):
            readonly_excluded += 1
            if ref == READONLY_CONTROL_REF:
                readonly_control.append(ref)
            continue
        if LANE_SCOPE_RE.search(scope):
            lane_excluded.append(ref)
            if ref == LANE_CONTROL_REF:
                lane_control.append(ref)
            continue
        flagged.append((ref, kind, title, created))
    # ONE ROW PER REF. The same contract can arrive twice - as an umbrella's item and as a plain
    # candidate whose own scope now matches the production paths - and counting it twice inflates the
    # number a coordinator acts on (measured 2026-10-28 on the widened PROD_PATH_RE: two refs were each
    # reported by an umbrella and by their own scope, 20 rows for 18 refs).
    deduped = {}
    for entry in flagged:
        deduped.setdefault(entry[0], entry)
    flagged = list(deduped.values())
    # A binding can live in a comment on the window row rather than on the row itself, so before
    # reporting a row as unwindowed the record is read. Only the refs that would otherwise be reported
    # are looked up, so the cost is proportional to the findings, not to the board.
    bound_in_comment = comment_bindings([r[0] for r in flagged
                                         if WINDOW_REF_RE.fullmatch(str(r[0]))])
    if bound_in_comment:
        flagged = [r for r in flagged if r[0] not in bound_in_comment]
        out.append(f"- covered by a BINDING COMMENT on an open window row (read, not assumed): "
                   + ", ".join(f"{k} ({v[0]} comment {v[1]})"
                               for k, v in sorted(bound_in_comment.items())))
        # The umbrella lines are written from the gaps found BEFORE the comment check, so they must be
        # recomputed or the report contradicts itself: it would list a ref as both covered and missing.
        still_flagged = {r[0] for r in flagged}
        rebuilt = []
        for ref, kind, title, created, gaps, unknown_items, total in umbrella_rows:
            g2 = [g for g in gaps if g in still_flagged]
            u2 = [u for u in unknown_items if u in still_flagged]
            if g2 or u2:
                rebuilt.append((ref, kind, title, created, g2, u2, total))
            else:
                umbrellas_clean.append(ref)
        umbrella_rows = rebuilt
    flagged.sort(key=lambda r: r[3] or 0)
    if flagged:
        out.append(f"- **{len(flagged)} unwindowed work item(s)** (a READY production contract with no row; an umbrella is "
                   f"reported by its items, never as one row):")
        for ref, kind, title, created in flagged[:20]:
            when = datetime.fromtimestamp((created or 0) / 1000, timezone.utc).strftime("%Y-%m-%d")
            out.append(f"  - {ref} | {kind} | {when} | {(title or '')[:70]}")
        if len(flagged) > 20:
            out.append(f"  - ... {len(flagged) - 20} more (counts key `unmirrored_prod_contracts`)")
    else:
        out.append("- every open production contract is named by an open window row")
    if umbrella_rows:
        out.append(f"- umbrellas seen this cycle: {len(umbrella_rows) + len(umbrellas_clean)} "
                   f"(their unwindowed items are counted above, not the umbrella):")
        for ref, kind, title, created, gaps, unknown_items, total in umbrella_rows:
            parts = []
            if gaps:
                parts.append(f"no window row for {', '.join(gaps)}")
            if unknown_items:
                parts.append(f"UNKNOWN (PR lookup failed or carried no ref): {', '.join(unknown_items)}")
            out.append(f"  - {ref} umbrella, {total} item(s): " + "; ".join(parts))
    if readonly_item_refs:
        out.append(f"- read-only audit/review ITEMS excluded from umbrella gaps (same rule as whole "
                   f"contracts): {len(readonly_item_refs)} ({', '.join(readonly_item_refs[:6])})")
    if umbrellas_nonprod:
        out.append(f"- ref-lists excluded as non-production coordination/review (control: none of their items "
                   f"is production-scoped): {len(umbrellas_nonprod)}")
    if umbrellas_clean:
        out.append(f"- umbrellas whose every listed item is windowed (not flagged): "
                   f"{', '.join(umbrellas_clean)}")
    out.append(f"- read-only review/audit/coordination contracts excluded: {readonly_excluded}"
               f" (standing negative control {READONLY_CONTROL_REF}: "
               f"{'excluded as required' if readonly_control else 'not in this cycle\'s candidate set'})")
    out.append(f"- lane/coordinator contracts excluded (no window of their own; their items are judged on "
               f"their own rows): {len(lane_excluded)}"
               + (f" ({', '.join(sorted(lane_excluded)[:6])})" if lane_excluded else "")
               + f" (standing negative control {LANE_CONTROL_REF}: "
               + ("excluded as required" if lane_control else "not in this cycle's candidate set") + ")")
    out.append(f"- controls this cycle: positive = an unfiled READY production contract is flagged until a "
               f"window row names it; negative audit = a read-only review contract is excluded, never flagged "
               f"({READONLY_CONTROL_REF or 'no standing control configured'}); negative smoke = a contract whose "
               f"scope names no production path is never flagged; non-umbrella guard = a contract listing only "
               f"ONE other ref keeps its plain verdict (two PRs resolving to one ref are one item); "
               f"umbrella rule = {UMBRELLA_MIN_ITEMS}+ distinct item refs in scope, each item judged on its own "
               f"window row; horizon {UNMIRRORED_HORIZON_DAYS}d, contracts unreadable: {unknown}")
    counts["unmirrored_prod_contracts"] = len(flagged)
    counts["unmirrored_umbrellas"] = len(umbrella_rows)
    counts["unmirrored_umbrellas_clean"] = len(umbrellas_clean)
    counts["unmirrored_ref_lists_nonprod"] = len(umbrellas_nonprod)
    counts["unmirrored_readonly_items"] = len(readonly_item_refs)
    counts["unmirrored_readonly_excluded"] = readonly_excluded
    counts["unmirrored_lane_excluded"] = len(lane_excluded)
    counts["unmirrored_unreadable"] = unknown
    counts["unmirrored_mention_only"] = len(mentions)
    counts["unmirrored_junk"] = len(junk)
    counts["unmirrored_exempt"] = len(exempt & {f"{SB}-{n}" for n, *_ in cand})
    counts["unmirrored_binding_refs"] = len(binding)
    counts["unmirrored_bound_in_comment"] = len(bound_in_comment)


def check_slot_label(out, counts):
    """Rows that carry a slot but not the `window` label — and FIX them in this cycle.

    WHY (lead-approved 2026-11-05): a slot is a scheduling fact; the `window`
    label is what makes that fact visible to every label-filtered instrument (the tabellone keeper's
    assert, this cycle's window count, the staleness list, the wp-audit). Three times on 2026-11-05 a
    row got a slot and no label — the tabellone streak row, the composer window, and
    three rows I wrote myself and which kept the keeper failing for ~55 minutes. The
    write path never enforced the pair, so nothing noticed until a dashboard went red.

    WHY IT WRITES: the defect is mechanical and the repair is mechanical — add one label, keep the
    rest. A detector that only reported would leave the same rows broken until a human read the
    report, which is the failure it exists to end. Safety: only `window` is ever ADDED, existing
    labels are preserved byte-for-byte, at most SLOT_LABEL_MAX rows are touched per cycle, and each
    fix is re-read and printed with its before/after labels.
    """
    import urllib.parse
    # ONLY Tasks are repaired (lead ruling, 2026-11-05): some Epics
    # that hold slots, and labelling an Epic `window` breaks the window health check that every window
    # hangs under a theme Epic. Non-Task rows with a slot are LISTED and left alone, so the anomaly is
    # visible without the instrument silently deciding what an Epic's slot means.
    jql = (f'project = {PROJECT} AND cf[{CF_START}] is not EMPTY AND labels != window AND issuetype = Task '
           'ORDER BY key')
    url = '/rest/api/3/search/jql?jql=' + urllib.parse.quote(jql) + f'&maxResults={SLOT_LABEL_MAX + 1}&fields=labels,summary'
    st, b = jira.call('GET', url)
    out.append("\n## 13. Slot without the `window` label\n")
    if st >= 300:
        out.append(f"  - **INSTRUMENT GAP**: the slot-label query failed (HTTP {st}); no repair attempted")
        counts['slot_no_label'] = None
        return
    hits = [(i['key'], i['fields'].get('labels') or []) for i in b.get('issues') or []]
    counts['slot_no_label'] = len(hits)
    other_jql = (f'project = {PROJECT} AND cf[{CF_START}] is not EMPTY AND labels != window '
                 'AND issuetype != Task ORDER BY key')
    ost, ob = jira.call('GET', '/rest/api/3/search/jql?jql=' + urllib.parse.quote(other_jql)
                        + '&maxResults=20&fields=issuetype,summary')
    others = [(i['key'], (i['fields'].get('issuetype') or {}).get('name')) for i in (ob.get('issues') or [])]
    counts['slot_no_label_nontask'] = len(others)
    for k, t in others:
        art = "an" if (t or "").lower()[:1] in "aeiou" else "a"
        out.append(f"  - **listed, not repaired**: {k} is {art} {t} holding a slot and no `window` label "
                   "(only Tasks are labelled)")
    if not hits:
        out.append("  - rows with a slot and no `window` label: **0** (Tasks)")
        return
    out.append(f"  - rows with a slot and no `window` label: **{len(hits)}** — repaired in this cycle:")
    dry = os.environ.get('CYCLE_NO_WRITES') == '1'
    fixed = 0
    for key, labels in hits[:SLOT_LABEL_MAX]:
        if dry:
            out.append(f"    - {key} | PLAN only (CYCLE_NO_WRITES=1): would add `window` to {labels}")
            continue
        want = list(labels) + ['window']
        wst, _ = jira.call('PUT', f'/rest/api/3/issue/{key}', {'fields': {'labels': want}})
        got = (jira.call('GET', f'/rest/api/3/issue/{key}?fields=labels')[1].get('fields') or {}).get('labels') or []
        ok = ('window' in got) and all(l in got for l in labels)
        out.append(f"    - {key} | PUT {wst} | labels {labels} -> {got} | {'OK' if ok else 'MISMATCH'}")
        fixed += 1 if ok else 0
    counts['slot_no_label_fixed'] = fixed
    if len(hits) > SLOT_LABEL_MAX:
        out.append(f"    - … {len(hits) - SLOT_LABEL_MAX} more held for the next cycle (cap {SLOT_LABEL_MAX})")


def check_window_no_slot(out, counts):
    """The mirror of check_slot_label: a `window` label with NO slot (lead ruling 2026-11-06).

    WHY it is a separate function: the first version was appended inside check_slot_label, which returns
    early when the repair set is empty — so the mirror check never ran on a clean board, which is exactly
    when it matters. A check that only runs when a different defect is present is not a check.

    A row with a FUTURE due date is tracked by that date (printed with "tracked by date"); everything else
    is LISTED so a human chooses a slot or declares it dates-only. Never repaired: only a person can choose.
    """
    import urllib.parse

    # MIRROR CHECK (lead ruling 2026-11-06): a row that carries the `window` label with NO slot
    # is invisible to the repair above, which looks for slots without labels. One row sat in exactly that
    # state for a day — dates 11-09/11-13, no window, label present — until the operator spotted it by eye. A row with a FUTURE due date is tracked
    # by that date and belongs with "tracked by date"; everything else is listed so a human decides between
    # giving it a slot and declaring it dates-only. Listed, never repaired: only a person can choose.
    mirror_jql = (f'project = {PROJECT} AND labels = window AND cf[{CF_START}] is EMPTY '
                  'AND statusCategory != Done ORDER BY duedate ASC, key')
    mst, mb = jira.call('GET', '/rest/api/3/search/jql?jql=' + urllib.parse.quote(mirror_jql)
                        + '&maxResults=40&fields=status,duedate,summary')
    if mst >= 300:
        out.append(f"  - **INSTRUMENT GAP**: the mirror query failed (HTTP {mst}); nothing listed")
        counts['window_no_slot'] = None
        return
    today = stamp()[:10]
    # "Open" here means OPEN FOR WORK, not merely statusCategory != Done: Deferred and Blocked rows are
    # parked with a reason (the staleness section excludes them for the same reason — parked is not
    # forgotten). The first run without this filter listed 32 rows, 24 of them Deferred or Blocked, which
    # is the wallpaper that teaches a reader to skim. Counted, not hidden: the excluded number is printed.
    PARKED = PARKED_STATUSES
    listed, tracked, parked = [], [], []
    for i in (mb.get('issues') or []):
        f = i.get('fields') or {}
        due = f.get('duedate')
        stt = (f.get('status') or {}).get('name') or '?'
        row = (i['key'], stt, due, (f.get('summary') or '')[:56])
        if stt in PARKED:
            parked.append(row)
        elif due and due >= today:
            tracked.append(row)
        else:
            listed.append(row)
    counts['window_no_slot_parked'] = len(parked)
    counts['window_no_slot'] = len(listed)
    counts['window_no_slot_tracked'] = len(tracked)
    out.append(f"  - **`window` label, no slot, open for work** (a slot or \"dates only\" needed): "
               f"**{len(listed)}**  · parked and excluded ({'/'.join(PARKED)}): {len(parked)}")
    for k, stt, due, summ in listed:
        out.append(f"    - {k} [{stt}] due {due or 'none'} :: {summ}")
    if tracked:
        out.append(f"  - of those, tracked by a future due date: **{len(tracked)}** "
                   + str([(k, d) for k, _, d, _ in tracked][:12]))


def check_staleness(out, counts):
    """Rows that look dead: open windows and checks with no update in 48 h, and rows whose newest
    comment is the operator's with no answer after it (coordinator order, 2026-11-05 19:25Z).

    WHY: on 2026-11-05 the operator asked "is this actually alive?" about five separate things (the
    writer, FDAX and three rows) because the board could not tell him
    from its own text. A row nobody has touched for two days is not a secret; it should be on the page.
    The second line is separate on purpose: "stale" and "waiting on the operator" look identical in
    Jira's updated field but need opposite actions, and mixing them is how an unanswered question
    gets read as an abandoned row.
    """
    import urllib.parse
    out.append("\n## 12. Staleness: rows nobody has touched, and rows waiting on the operator\n")
    out.append(f"  ({' and '.join(PARKED_STATUSES)} rows are excluded: parked is not forgotten.)")
    # Deferred and Blocked are PARKED states: a row nobody touched there is being left alone on purpose,
    # and listing it as stale would bury the rows that are actually forgotten. Excluded, and said so in
    # the header, because a hidden filter is how a "0 stale" claim stops meaning anything.
    parked = ", ".join(f'"{s}"' for s in PARKED_STATUSES)
    jql = (f'project = {PROJECT} AND statusCategory != Done AND status not in ({parked}) '
           f'AND (labels = "window" OR summary ~ "\\"{SB} check:\\"") '
           'AND updated <= -48h ORDER BY updated ASC')
    url = '/rest/api/3/search/jql?jql=' + urllib.parse.quote(jql) + '&maxResults=60&fields=summary,status,updated,labels'
    st, b = jira.call('GET', url)
    stale = []
    if st >= 300:
        out.append(f"  - **INSTRUMENT GAP**: the staleness query failed (HTTP {st}); no zeros claimed")
    else:
        now = datetime.now(timezone.utc)
        for i in b.get('issues') or []:
            f = i['fields']
            try:
                upd = datetime.fromisoformat((f.get('updated') or '').replace('Z', '+00:00'))
            except ValueError:
                continue
            stale.append((round((now - upd).total_seconds() / 86400, 1), i['key'], f['status']['name'],
                          (f.get('summary') or '')[:62]))
        stale.sort(reverse=True)
    counts['stale_48h'] = len(stale)
    if stale:
        out.append(f"  - open window/check rows with no update in 48 h: **{len(stale)}**")
        for days, key, status, summary in stale[:15]:
            out.append(f"    - {key} | {days:.1f}d | {status} | {summary}")
        if len(stale) > 15:
            out.append(f"    - … {len(stale) - 15} more, oldest first above")
    elif st < 300:
        out.append("  - open window/check rows with no update in 48 h: **0** — nothing is silent")

    # Rows whose NEWEST comment is the operator's: the board owes an answer.
    jql2 = (f'project = {PROJECT} AND statusCategory != Done AND updated >= -7d ORDER BY updated DESC')
    url2 = '/rest/api/3/search/jql?jql=' + urllib.parse.quote(jql2) + '&maxResults=60&fields=summary,status,comment'
    st2, b2 = jira.call('GET', url2)
    awaiting = []
    if st2 >= 300:
        out.append(f"  - **INSTRUMENT GAP**: the operator-wait query failed (HTTP {st2})")
    else:
        for i in b2.get('issues') or []:
            cs = ((i['fields'].get('comment') or {}).get('comments') or [])
            if not cs:
                continue
            last = cs[-1]
            au = last.get('author') or {}
            if au.get('accountId') == OPERATOR_ACCOUNT_ID:
                awaiting.append((last.get('created', '')[:16], i['key'], i['fields']['status']['name'],
                                 (i['fields'].get('summary') or '')[:56]))
        awaiting.sort(reverse=True)
    counts['awaiting_operator'] = len(awaiting)
    if awaiting:
        out.append(f"  - rows whose newest comment is the operator's, with no answer after it: **{len(awaiting)}**")
        for at, key, status, summary in awaiting[:12]:
            out.append(f"    - {key} | operator {at} | {status} | {summary}")
    elif st2 < 300:
        out.append("  - rows whose newest comment is the operator's: **0** — every operator comment is answered")


def main():
    started = datetime.now(timezone.utc)
    cpu0 = resource.getrusage(resource.RUSAGE_SELF)
    counts = {}
    lines = [f"# CYCLE {stamp()} — wed2-helper, read-only checks", "",
             f"Lane {LANE} · project {PROJECT} / {SB} · generated by cycle.py", ""]
    r1 = check_filters(lines, counts)
    check_windows(lines, r1, counts)
    check_pr_coverage(lines, counts)
    check_status_drift(lines, counts)
    check_pr_links(lines, counts)
    check_comments(lines, counts)
    check_r2_posts(lines, counts)
    check_new_tickets(lines, counts)
    check_unmirrored_contracts(lines, counts)
    check_slot_label(lines, counts)
    check_window_no_slot(lines, counts)
    check_staleness(lines, counts)
    elapsed = (datetime.now(timezone.utc) - started).total_seconds()
    # WHY CPU IS RECORDED: the load gate (load1 <= 11, coordinator rule) decides whether this cycle may
    # run, but the only cost figure on record was wall time (15s, CYCLE-0921Z) - and wall time on a
    # network-bound cycle is mostly WAITING, so it cannot say whether the cycle adds to the load it
    # is gated on. A gate that never measures the thing it gates is not evidence. Measured 2026-10-28
    # on the comment-watch subset: 2.37s wall, 0.13 CPU-s.
    cpu1 = resource.getrusage(resource.RUSAGE_SELF)
    lines += ["", "## Counts", "", "```", json.dumps(counts, indent=1), "```",
              "", f"wall time {elapsed:.0f}s · cpu user={cpu1.ru_utime - cpu0.ru_utime:.2f}s "
              f"sys={cpu1.ru_stime - cpu0.ru_stime:.2f}s (wall minus cpu is network wait)"]
    print("\n".join(lines))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Tabellone auto-sync (upstream MMD-3173). Stdlib only.

Instance settings come from pm_config (env, then the pack config file); names are in
../references/setup.md and ../../project-management/references/setup.md.

Every run (systemd --user timer, 5 min) does four mechanical jobs against the
here.now Site $PM_TABELLONE_SITE (data API, key in $PM_TABELLONE_KEY_FILE):

(a) The operator's 'waiting for me' list (MMD-3291; rule replaced 11-01 by the
    operator's ruling, MMD-3353 delta): ONLY the ticket's latest comment counts.
    It mentions the operator (ADF mention of $PM_OPERATOR_ACCOUNT_ID or the
    text @$PM_OPERATOR_HANDLE) -> the run sets op-waiting and writes one row. It mentions or
    tags xtrm-bot (the operator's answer) -> the run removes op-waiting and the
    row. Any other latest comment, including the operator writing in person,
    leaves the label and the row exactly as they are; a ticket in statusCategory
    Done never waits and loses both. Doc questions/operator-waiting carries one
    row per waiting ticket {id: w-<key>-<qualifying commentId>, ref, q, rec, why,
    at}, so a Jira filter on op-waiting is the live list. This run is the only
    label writer; the questions/operator-mentions doc is retired (deleted once,
    after its content is written to $TABELLONE_STATE_DIR/retired-*.json).

(b) Workers view: every workers/<name> doc is rewritten from live state.
    tmux list-panes -a gives name (pane title match), where (pane id) and
    status live|gone; sb issue show <issue> gives the issue lifecycle and
    claim expiry; context % comes from the pane status line when present.
    Pane gone and issue closed -> status done.
    Only status, where, ctxPct, claimUntil, updatedAt, updatedBy change;
    milestone, note, task, reportsTo, order stay owned by the coordinator.
    A done worker updated more than 24 h ago leaves workers/ (MMD-3374): the
    whole doc is copied into archive/workers-<utc date> first and only then is
    workers/<name> deleted, so the page stays live, gone and done < 24 h. A
    delete is skipped when its archive write failed. A done doc whose issue is
    still open stays (it is a 'gone' worker with an open thread, not history).
    The archive doc is split into archive/workers-<date>-2, -3, ... when it
    would cross 16 KB.

(d) Merged PRs as timeline events (MMD-3289): one bulk `gh pr list --state merged
    --search merged:>=<today-1>` for $PM_REPO_SLUG. One event
    per PR in schedule/<mergedAt date>. An existing row for that PR number is
    adopted (url, kind=pr, base, status=done, title, src added; its key, at,
    label and note kept); otherwise e_<HHMM>_PR-<n> is created with
    ref 'PR #<n>' and label = the PR title, scrubbed. Rows are matched by
    number, not only by key, because the keeper already writes PR-<n> rows.
    Rows it did not create are never deleted; only the fields above are added
    to an adopted row, and only to rows it created are all fields refreshed.

(c) Answer routing: every answers/* row with an 'at' newer than last routed
    is appended to answers-inbox.jsonl and delivered once to the coordinator
    that owns the row (questions/<owner> doc -> owner name -> pane address from
    PM_TABELLONE_OWNER_ADDR; unknown -> PM_TABELLONE_FALLBACK_OWNER).
    FILE-ONLY owners (FILE_ONLY_OWNERS) are never typed into: the inbox line
    IS the delivery, because typing into a Claude pane corrupts the input the
    operator is tailing (coordinator ruling 2026-10-30). Other owners
    get `xtmux message-send`, falling back to tmux send-keys ONLY on a pi pane
    (a Claude pane is never typed into, whatever the fallback).
    Message: question id, answer, comment, time. Seed: answers since
    PM_TABELLONE_ANSWER_SEED_AT only (empty: all answers).

(f) Run assertions (MMD-3382), read-only, after every write and the read-back:
    each Jira window row placed for today..today+7 must have a kind=window event
    whose ref is its key in the schedule/<date> doc the run published, and that
    doc's record updatedAt must not predate the Jira slot write (changelog of the
    window start/end fields, else created; an unchanged event is not stale).
    ASSERT-FAIL missing-doc|missing-event|stale-doc <ref> ... gives exit 1 once
    all writes are done; ASSERT-UNKNOWN (changelog or expected-set unreadable)
    is reported only. The expected set is a second Jira search of the window
    start field for today..today+7 with no label filter: a key in it that the
    run did not place gives ASSERT-FAIL unplaced-row. The search is narrowed to
    the sync's project and skips Subtasks (steps of a window, not windows).
    Publish age is in the ASSERT-COUNT line only (publish= is the site
    currentVersionCreatedAt), never a separate line: it moves on explicit
    publishes only. ASSERT-COUNT is the one summary line per run. A crash in
    the check prints ASSERT-ERROR and exit 1; the writes are already done.
    Keyed on ref and write times, never on rendered text. --dry runs the same
    check on the planned view. Tests: test_tabellone_sync.py.

Never touches questions/* rows other than its own docs, answers/*, notes/*,
status/*, lanes/*, board/*, proposals/*, schedule/*, followups/*.
The Jira token and the here.now key are never printed.

Usage: tabellone_sync.py --dry   (plan only, no writes, no delivery)
       tabellone_sync.py         (write, then read-back verify)
State: $TABELLONE_STATE_DIR/state.json (default $PM_STATE_DIR/tabellone/) (routed answer ids, last run, waiting backfill flag).
"""
import base64
import importlib.util
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "project-management" / "scripts"))
import pm_config  # noqa: E402

# ---- instance settings (names: ../references/setup.md)
JIRA_PROJECT = pm_config.get("PM_JIRA_PROJECT", required=True)
SB_PREFIX = pm_config.get("PM_SB_PREFIX", required=True)
JIRA_BROWSE = str(pm_config.get("JIRA_SITE", required=True)).rstrip("/") + "/browse/"
# other issue-key prefixes that may appear in event refs (other Substrate projects)
EXTRA_REF_PREFIXES = list(pm_config.get_data("PM_EXTRA_REF_PREFIXES", []))
KEY_ALT = "|".join(re.escape(x) for x in [JIRA_PROJECT, SB_PREFIX] + EXTRA_REF_PREFIXES)
OPERATOR_ACCOUNT = pm_config.get("PM_OPERATOR_ACCOUNT_ID", "")
OPERATOR_HANDLE = pm_config.get("PM_OPERATOR_HANDLE", "operator")
REPO_NAME = pm_config.get("PM_REPO_NAME", required=True)
SITE = pm_config.get("PM_TABELLONE_SITE", required=True)
HN_KEY_FILE = os.path.expanduser(pm_config.get("PM_TABELLONE_KEY_FILE", "~/.herenow/credentials"))
HERE = "https://here.now/api/v1/publishes/%s/data/docs" % SITE
MAX_BYTES = 16 * 1024
BY = "tabellone-sync"
SELF_ISSUE = pm_config.get("PM_TABELLONE_SELF_ISSUE", required=True)  # Substrate issue the sync runs under
SELF_NAME = "%s-tabellone-sync" % SELF_ISSUE
PM_STATE_ROOT = os.path.expanduser(pm_config.get("PM_STATE_DIR", "~/.xtrm/product/%s" % REPO_NAME))
STATE_DIR = os.path.expanduser(os.environ.get("TABELLONE_STATE_DIR")
                               or pm_config.get("PM_TABELLONE_STATE_DIR", os.path.join(PM_STATE_ROOT, "tabellone")))
BOT_WATCH_DIR = os.path.expanduser(os.environ.get("XTRM_BOT_WATCH_DIR", os.path.join(PM_STATE_ROOT, "xtrm-bot-watch")))
INBOX = os.path.join(STATE_DIR, "answers-inbox.jsonl")
ANSWER_SEED_AT = pm_config.get("PM_TABELLONE_ANSWER_SEED_AT", "")
# questions/<owner> name -> pane address (xt session name) that receives routed answers
OWNER_ADDR = dict(pm_config.get_data("PM_TABELLONE_OWNER_ADDR", {}))
FALLBACK_OWNER = pm_config.get("PM_TABELLONE_FALLBACK_OWNER", "")
# owners whose answers are delivered by the inbox line alone, with no keystrokes
FILE_ONLY_OWNERS = set(pm_config.get_data("PM_TABELLONE_FILE_ONLY_OWNERS", []))
PI_GLYPH = "\u03c0"   # pi pane titles start with pi; Claude panes use the asterisk glyph
CACHEDIR = STATE_DIR
STATE_FILE = os.path.join(CACHEDIR, "state.json")
SB = pm_config.get("PM_SB_BIN") or shutil.which("sb") or "sb"
TMUX = "/usr/bin/tmux"
JIRA_MOD = str(pm_config.jira_py())
GH = "/usr/bin/gh"
GH_REPO = pm_config.get("PM_REPO_SLUG", required=True)
PR_SRC = "tabellone-sync"
PR_REF_RE = re.compile(r"^PR[- ]?#?(\d+)$")
PR_KEY_RE = re.compile(r"_PR-(\d+)$")

# ---- Jira window Tasks -> schedule events (MMD-3290)
JIRA_SRC = "sync-jira"
PROFILE_FILE = os.path.join(CACHEDIR, "jira-profile.json")
DRIFT_FILE = os.path.join(CACHEDIR, "drift.jsonl")
WINDOW_LABEL = "window"
# Issue types that can never be placed as a window row: a Subtask is a step of a window,
# an Epic is a theme or a calendar marker. Anything else carrying a slot must be placed
# or it fails the check (defect, not narrowing).
NON_PLACEABLE_TYPES = ("Subtask", "Epic")
RANGE_BACK, RANGE_FWD = 2, 7
RECENT_UPD = "30m"
SWEEP_UPD = "20d"          # widened discovery window, used once per SWEEP_EVERY
SWEEP_EVERY = 55 * 60      # seconds between widened discovery runs
PROFILE_MAP = {"new": "scheduled", "indeterminate": "running", "done": "done"}
SLOT_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:([+-])(\d{2}):?(\d{2}))?")
REF_TOK_RE = re.compile(r"(?:%s)-\d+" % KEY_ALT)
NOTE_RE = re.compile(r"\b(GO|DRY|NO-GO|PASS|FAIL|result|Done|deployed)\b", re.I)
FOLDED_RE = re.compile(r"fold(?:ed)?\s+(?:in)?to\s+((?:%s)-\d+)" % KEY_ALT, re.I)
WAITING_LABEL = "op-waiting"
WAITING_LABELS = ("op-mentioned", "op-asked", WAITING_LABEL)
WAITING_DOC = "questions/operator-waiting"
RETIRED_DOC = "questions/operator-mentions"
ARM_FILE = os.path.join(STATE_DIR, "waiting-armed")
WAITING_MAX_BYTES = 12 * 1024
WAITING_Q = 1000  # the ask usually sits at the end of the comment; the 12 KB shrink loop below still caps the doc
WAITING_Q_MIN = 60
BOT_CONFIG = os.path.join(BOT_WATCH_DIR, "config.json")
OPERATOR_TEXT_RE = re.compile(r"@%s\b" % re.escape(OPERATOR_HANDLE), re.I)
BOT_TEXT_RE = re.compile(r"@xtrm-bot\b", re.I)
DROPPED = []
ASSERT_ROWS = []          # MMD-3382: the window rows build_jira_schedule placed this run

NOW = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
DRY = "--dry" in sys.argv

HN_KEY = None
SECRETS = []


def scrub(text):
    for s in SECRETS:
        if s and len(s) > 4:
            text = text.replace(s, "<KEY>")
    return text


def read_hn_key():
    global HN_KEY
    if HN_KEY is None:
        with open(HN_KEY_FILE) as fh:
            HN_KEY = fh.read().strip()
        SECRETS.append(HN_KEY)
    return HN_KEY


def load_jira():
    spec = importlib.util.spec_from_file_location("tab_jira", JIRA_MOD)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    try:
        SECRETS.append(mod.creds()[1])
    except Exception:
        pass
    return mod


# ---------------------------------------------------------------- memory gate
def mem_gate():
    try:
        with open("/proc/pressure/memory") as fh:
            m = re.search(r"full\s+avg10=([0-9.]+)", fh.read())
        psi = float(m.group(1)) if m else 0.0
    except OSError:
        psi = 0.0
    avail_gb = 0.0
    try:
        with open("/proc/meminfo") as fh:
            m = re.search(r"MemAvailable:\s+(\d+)", fh.read())
        avail_gb = int(m.group(1)) / 1048576 if m else 0.0
    except OSError:
        pass
    if psi > 10:
        return False, "PSI full avg10 %.2f > 10" % psi
    if avail_gb < 4:
        return False, "MemAvailable %.1f GB < 4" % avail_gb
    return True, "PSI full avg10 %.2f, MemAvailable %.1f GB" % (psi, avail_gb)


# ---------------------------------------------------------------- here.now api
def hn_call(method, url, body=None, idem=None, tries=4):
    headers = {"Authorization": "Bearer " + read_hn_key(),
               "User-Agent": "tabellone-sync/%s" % SELF_ISSUE.lower(),
               "Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    if idem:
        headers["Idempotency-Key"] = idem
    for attempt in range(tries):
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = scrub(e.read().decode("utf-8", "replace"))
            if e.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                time.sleep(float(e.headers.get("Retry-After") or 2 * (attempt + 1)))
                continue
            return e.code, raw[:400]
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt < tries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            return "ERR", scrub(str(e))[:400]
    return "ERR", "exhausted"


def hn_list():
    recs, cursor = [], None
    while True:
        url = HERE + "?limit=100"
        if cursor:
            url += "&cursor=" + urllib.parse.quote(cursor)
        st, body = hn_call("GET", url)
        if st != 200:
            raise SystemExit("LIST failed: %s %s" % (st, body))
        recs.extend(body.get("records") or [])
        cursor = body.get("nextCursor")
        if not cursor:
            return recs


def doc_of(rec):
    d = rec.get("data") or {}
    x = d.get("doc")
    if isinstance(x, str):
        try:
            x = json.loads(x)
        except ValueError:
            x = None
    return d.get("path"), x


def norm(x):
    return json.loads(json.dumps(x, ensure_ascii=False, sort_keys=True))


def doc_body(x):
    """A doc without its run stamps, for a change test that must not fire on itself.

    updatedAt is NOW on every planned doc, so comparing whole docs marks every run
    as a change and rewrites identical docs forever (one here.now write and a page
    version bump every five minutes).
    """
    x = dict(x or {})
    x.pop("updatedAt", None)
    x.pop("updatedBy", None)
    return norm(x)


# ---------------------------------------------------------------- jira reads
def jira_search(mod, jql, fields="key,updated"):
    issues, token = [], None
    while True:
        q = {"jql": jql, "fields": fields, "maxResults": "100"}
        if token:
            q["nextPageToken"] = token
        st, out = mod.call("GET", "/rest/api/3/search/jql?" + urllib.parse.urlencode(q))
        if st != 200:
            raise SystemExit("Jira search failed: %s %s" % (st, scrub(str(out))[:300]))
        issues.extend(out.get("issues") or [])
        if out.get("isLast", True):
            return issues
        token = out.get("nextPageToken")
        if not token:
            return issues


def jira_comments(mod, key):
    out, start = [], 0
    while True:
        path = "/rest/api/3/issue/%s/comment?orderBy=created&maxResults=100&startAt=%d" % (key, start)
        st, body = mod.call("GET", path)
        if st != 200:
            print("  comment fetch %s: HTTP %s (skipped)" % (key, st))
            return out
        got = body.get("comments") or []
        out.extend(got)
        if len(got) < 100:
            return out
        start += 100


def mentions_account(node, account):
    if not account:
        return False
    if isinstance(node, dict):
        if node.get("type") == "mention" and (node.get("attrs") or {}).get("id") == account:
            return True
        return any(mentions_account(v, account) for v in node.values())
    if isinstance(node, list):
        return any(mentions_account(v, account) for v in node)
    return False


def mentions_operator(node):
    return mentions_account(node, OPERATOR_ACCOUNT)


BOT_ACCOUNT = None


def bot_account():
    """The xtrm-bot accountId from the watcher config; '' when the file is unreadable."""
    global BOT_ACCOUNT
    if BOT_ACCOUNT is None:
        try:
            with open(BOT_CONFIG) as fh:
                BOT_ACCOUNT = json.load(fh).get("accountId") or ""
        except (OSError, ValueError):
            BOT_ACCOUNT = ""
    return BOT_ACCOUNT


def mention_kind(body):
    """How a comment calls the operator: 'operator' (mentions him) or 'bot' (asks the bot), else None."""
    if mentions_operator(body):
        return "operator"
    if mentions_account(body, bot_account()):
        return "bot"
    text = adf_text(body)
    if OPERATOR_TEXT_RE.search(text):
        return "operator"
    if BOT_TEXT_RE.search(text):
        return "bot"
    return None


def adf_text(node):
    if isinstance(node, dict):
        if node.get("type") == "text":
            return node.get("text", "")
        if node.get("type") == "mention":
            return (node.get("attrs") or {}).get("text", "@operator")
        if node.get("type") == "hardBreak":
            return "\n"
        return "".join(adf_text(v) for v in node.values())
    if isinstance(node, list):
        parts = [adf_text(v) for v in node]
        return "\n\n".join(p for p in parts if p) if node and isinstance(node[0], dict) and node[0].get("type") == "paragraph" else "".join(parts)
    return ""


def holder_of(body):
    try:
        first = (body.get("content") or [])[0]
        text = adf_text(first)
    except (IndexError, AttributeError):
        return None
    m = re.search(r"\[agent:([^\s|\]]+)", text)
    return m.group(1) if m else None


def jira_ts(s):
    """Aware UTC datetime from a Jira timestamp ('2026-10-31T21:42:47.375+0100'), or None.

    Ordering has to use this, not the minute-truncated display string: an operator
    reply at 21:33:36 and a mention at 21:33:50 share a minute, and a string compare
    would read the mention as older than the reply.
    """
    v = (s or "").strip()
    if not v:
        return None
    v = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", v)
    try:
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def jira_dt(s):
    dt = jira_ts(s)
    return dt.strftime("%Y-%m-%dT%H:%MZ") if dt else s


# ---------------------------------------------------------------- live state
def live_panes():
    r = subprocess.run([TMUX, "list-panes", "-a", "-F", "#{pane_id}\t#{pane_title}"],
                       capture_output=True, text=True, timeout=30)
    panes = []
    for line in (r.stdout or "").splitlines():
        parts = line.split("\t", 1)
        if len(parts) == 2 and parts[0].startswith("%"):
            panes.append((parts[0], parts[1]))
    return panes


def pane_ctx(pane_id):
    try:
        r = subprocess.run([TMUX, "capture-pane", "-p", "-t", pane_id, "-S", "-12"],
                           capture_output=True, text=True, timeout=30)
    except subprocess.SubprocessError:
        return None
    # context meter renders as "37.0%/1.0M" when it fits and "37.0%…" when truncated;
    # the cache counter ("99% cache") must not match, so a /1.0M or ellipsis is required
    m = re.findall(r"(\d+(?:\.\d+)?)%(?:\s*/\s*\d|\s*…|\s*\.\.\.)", r.stdout or "")
    return float(m[-1]) if m else None


SB_CACHE = {}


def sb_show(issue):
    if issue in SB_CACHE:
        return SB_CACHE[issue]
    try:
        r = subprocess.run([SB, "issue", "show", issue, "--json"],
                           capture_output=True, text=True, timeout=60)
        data = json.loads(r.stdout[r.stdout.index("{"):])["data"]
        out = (data.get("lifecycleState"),
               (data.get("claim") or {}).get("expiresAt"))
    except (subprocess.SubprocessError, ValueError, KeyError):
        out = (None, None)
    SB_CACHE[issue] = out
    return out


def claim_iso(ms):
    try:
        return datetime.fromtimestamp(int(ms) / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- build
def waiting_label_write(mod, key, add=(), remove=()):
    """Add and/or remove labels on one ticket with a raw PUT.

    Not mod.call(): that helper appends `actor=agent` to every issue edit made by an
    agent process, and this run may only ever touch the op-waiting label.
    """
    ops = [{"add": l} for l in add] + [{"remove": l} for l in remove]
    if not ops:
        return True
    email, token = mod.creds()
    body = json.dumps({"update": {"labels": ops}}).encode("utf-8")
    req = urllib.request.Request(mod.site() + "/rest/api/3/issue/" + key, data=body, method="PUT")
    req.add_header("Authorization", "Basic " + base64.b64encode(("%s:%s" % (email, token)).encode()).decode())
    req.add_header("Accept", "application/json")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status in (200, 204)
    except urllib.error.HTTPError as e:
        detail = scrub(e.read().decode("utf-8", "replace"))[:200]
        print("  label write %s on %s: HTTP %s %s" % (json.dumps(ops), key, e.code, detail))
        return False


def waiting_size(rows):
    doc = {"from": "Jira", "rows": rows, "updatedAt": NOW, "updatedBy": BY}
    return len(json.dumps({"path": WAITING_DOC, "doc": doc}, ensure_ascii=False).encode("utf-8"))


def operator_author(comment):
    return (comment.get("author") or {}).get("accountId") == OPERATOR_ACCOUNT


def waiting_of(comments):
    """How the ticket's LATEST comment decides its op-waiting label, or None.

    Operator ruling 2026-11-01 (MMD-3353 delta): only the latest comment counts.
    It mentions the operator -> the ticket waits ({"kind": "operator"}). It
    mentions or tags xtrm-bot, the operator's answer -> it does not
    ({"kind": "bot"}). Any other latest comment, the operator writing in person
    included, decides nothing: None, and the label stays as it is. Ordering uses
    full timestamps, so a reply and a mention in the same minute stay ordered.
    """
    seq = []
    for c in comments:
        cid = str(c.get("id"))
        seq.append((jira_ts(c.get("created") or ""), int(cid) if cid.isdigit() else 0, cid, c))
    if not seq:
        return None
    seq.sort(key=lambda x: (x[0] or datetime(1970, 1, 1, tzinfo=timezone.utc), x[1]))
    at, _n, cid, c = seq[-1]
    kind = mention_kind(c.get("body") or {})
    if not kind:
        return None
    return {"cid": cid, "at": at, "kind": kind, "comment": c}


def waiting_row(key, hit):
    """One Tabellone row for a waiting ticket. `by` stays empty on purpose: the page
    reads a row's `by` as a deadline, so the author belongs in `rec`."""
    body = hit["comment"].get("body") or {}
    by = holder_of(body) or (hit["comment"].get("author") or {}).get("displayName") or "unknown"
    at = hit["at"].strftime("%Y-%m-%dT%H:%MZ") if hit["at"] else ""
    return {
        "id": "w-%s-%s" % (key, hit["cid"]),
        "ref": key,
        "q": re.sub(r"\s*\[agent:[^\]]*\]\s*$", "", adf_text(body).strip())[:WAITING_Q],
        "rec": "%s · rispondi in Jira" % by[:80],
        "why": JIRA_BROWSE + "%s?focusedCommentId=%s" % (key, hit["cid"]),
        "at": at,
    }


def fit_rows(rows):
    """Shrink row text, then drop the oldest rows, until the doc fits WAITING_MAX_BYTES.

    Rows are newest first. A dropped row keeps its label, so the ticket stays in the JQL
    filter; only the page row is lost, and the drift report records which one.
    """
    rows = [dict(r) for r in rows]
    qcap = WAITING_Q
    while waiting_size(rows) >= WAITING_MAX_BYTES and qcap > WAITING_Q_MIN:
        qcap -= 20
        rows = [dict(r, q=str(r.get("q") or "")[:qcap]) for r in rows]
    dropped = []
    while len(rows) > 1 and waiting_size(rows) >= WAITING_MAX_BYTES:
        dropped.append(rows.pop())
    return rows, dropped


def build_waiting(mod, live, state):
    """(a) Label op-waiting on every ticket that waits for the operator, and write
    questions/operator-waiting with exactly one row per such ticket."""
    ops = []
    # A live label write and the retirement of the old doc unlock only when the file
    # $TABELLONE_STATE_DIR/waiting-armed exists (MMD-3291: the first live run waits for a
    # --dry diff the coordinator has read). Until then every timer run only plans.
    armed = (not DRY) and os.path.exists(ARM_FILE)
    backfill = not state.get("waiting_backfill_done")
    if not DRY and not armed:
        print("NOT ARMED: create %s to enable label writes and the doc retirement" % ARM_FILE)
    # One widened run per SWEEP_EVERY seconds: the steady window is 30 minutes and the
    # label set is written only by this run, so a first mention on an unlabelled ticket
    # is otherwise lost the moment it is half an hour old (upstream incident).
    sweep = False
    if not backfill:
        last = jira_ts(state.get("waiting_sweep_at") or "")
        now = jira_ts(NOW)
        sweep = last is None or now is None or (now - last).total_seconds() >= SWEEP_EVERY
        if sweep:
            state["waiting_sweep_at"] = NOW
    jql = ("project = %s AND (labels in (%s) OR updated >= -%s%s) ORDER BY updated DESC"
           % (JIRA_PROJECT, ", ".join(WAITING_LABELS), RECENT_UPD,
              (" OR updated >= -%s" % SWEEP_UPD) if (backfill or sweep) else ""))
    print("JQL: %s" % jql)
    if sweep:
        print("discovery sweep: widened to -%s, once per %d minutes" % (SWEEP_UPD, SWEEP_EVERY // 60))
    issues = jira_search(mod, jql, fields="key,updated,labels,status")
    print("waiting candidates: %d" % len(issues))
    existing = {}
    for old_row in ((live.get(WAITING_DOC) or (None, {}))[1] or {}).get("rows") or []:
        if isinstance(old_row, dict) and old_row.get("ref"):
            existing.setdefault(old_row["ref"], []).append(old_row)
    rows, add, drop, kept = [], [], [], []
    for iss in issues:
        key = iss["key"]
        labels = set((iss.get("fields") or {}).get("labels") or [])
        cat = (((iss.get("fields") or {}).get("status") or {}).get("statusCategory") or {}).get("key")
        if cat == "done":
            # a Done ticket never waits: the label and its row come off if there
            if WAITING_LABEL in labels:
                drop.append(key)
            continue
        hit = waiting_of(jira_comments(mod, key))
        if hit and hit["kind"] == "operator":
            rows.append(waiting_row(key, hit))
            if WAITING_LABEL not in labels:
                add.append((key, hit["cid"]))
        elif hit and hit["kind"] == "bot":
            if WAITING_LABEL in labels:
                drop.append(key)
        elif WAITING_LABEL in labels:
            # the latest comment decides nothing: the label stays, and so does the
            # row the page already shows for this ticket
            rows.extend(existing.get(key) or [])
            kept.append(key)
    rows.sort(key=lambda r: str(r.get("at") or ""), reverse=True)
    print("waiting tickets: %d; label +%d -%d unchanged %d%s"
          % (len(rows), len(add), len(drop), len(kept), " (backfill run)" if backfill else ""))
    for key, cid in add:
        print("  LABEL + %s %s (w-%s-%s)" % (WAITING_LABEL, key, key, cid))
    for key in drop:
        print("  LABEL - %s %s" % (WAITING_LABEL, key))
    for key in kept:
        print("  KEEP %s (latest comment decides nothing)" % key)
    for r in rows:
        print("  row %s at=%s q=%r" % (r["id"], r["at"], r["q"][:80]))
    if armed:
        for key, _cid in add:
            waiting_label_write(mod, key, add=[WAITING_LABEL])
        for key in drop:
            waiting_label_write(mod, key, remove=[WAITING_LABEL])
    rows, dropped = fit_rows(rows)
    for victim in dropped:
        DROPPED.append({"at": NOW, "kind": "waiting-row-dropped", "id": victim.get("id"),
                        "ref": victim.get("ref"), "q": victim.get("q")})
        print("  dropped row %s (over cap; its label stays)" % victim.get("id"))
    path = WAITING_DOC
    rid = live[path][0] if path in live else None
    doc = live[path][1] if path in live else None
    new = {"from": "Jira", "rows": rows, "updatedAt": NOW, "updatedBy": BY}
    if rid:
        old_ids = {o.get("id") for o in ((doc or {}).get("rows") or [])}
        kept = {r["id"] for r in rows}
        changed = doc_body(new) != doc_body(doc)
        if changed and armed:
            ops.append(("PATCH", path, rid, new))
        print("operator-waiting: %d rows, +%d -%d, %d B (%s)"
              % (len(rows), len(kept - old_ids), len(old_ids - kept), waiting_size(rows),
                 "PATCH" if changed and armed else ("unplanned, not armed" if changed else "unchanged")))
    else:
        if armed:
            ops.append(("POST", path, None, new))
        print("operator-waiting: %s with %d rows, %d B"
              % ("CREATE" if armed else "PLAN CREATE, not armed", len(rows), waiting_size(rows)))
    if RETIRED_DOC in live:
        old_rid = live[RETIRED_DOC][0]
        old = live[RETIRED_DOC][1] or {}
        backup = os.path.join(CACHEDIR, "retired-operator-mentions-%s.json" % NOW.replace(":", ""))
        print("RETIRE %s (%d rows) -> %s%s"
              % (RETIRED_DOC, len(old.get("rows") or []), backup,
                 "" if armed else " [nothing written: not armed]"))
        if armed:
            try:
                with open(backup, "w") as fh:
                    json.dump(old, fh, ensure_ascii=False, indent=1)
            except OSError as e:
                print("  backup write failed: %s" % e)
            st, _body = hn_call("DELETE", "%s/%s" % (HERE, old_rid))
            DROPPED.append({"at": NOW, "kind": "doc-retired", "path": RETIRED_DOC,
                            "id": old_rid, "http": st})
            print("  DELETE %s: %s" % (old_rid, st))
    if armed:
        state["waiting_backfill_done"] = True
        state["last_run"] = NOW
    return ops


PROG_RE = re.compile(r"(%s-xt-(?:claude|pi))-([A-Za-z0-9][^\s]*)" % re.escape(REPO_NAME))


def pane_name(title):
    """Project worker name from a pane title, anchored at the title start.

    Titles carry a leading glyph and separator ("✳ <repo>-xt-claude-X",
    "π - <repo>-xt-pi-X"). Anchoring keeps shell panes whose tty title is a
    filesystem path from ever matching, so a worktree called <repo>-xt-*
    cannot invent a worker.
    """
    t = (title or "").strip()
    t = re.sub(r"^[^\x00-\x7f]+\s*", "", t)
    t = re.sub(r"^-\s*", "", t)
    m = PROG_RE.match(t)
    if not m:
        return None, None
    return m.group(1), m.group(2).strip("-")


ARCHIVE_PREFIX = "archive/workers-"
ARCHIVE_KEEP_H = 24
TERMINAL_STATES = ("done", "closed", "cancelled", "archived")
ARCHIVE_NOTE = ("Worker finiti, tolti da workers/ dopo %d h. Ogni documento "
                "di worker e conservato intero sotto workers/<nome>." % ARCHIVE_KEEP_H)


def older_than(ts, hours):
    """True when an ISO minute stamp is older than the window, or unreadable."""
    try:
        dt = datetime.strptime(str(ts), "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return True
    now = datetime.strptime(NOW, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
    return now - dt > timedelta(hours=hours)


def build_workers(live):
    ops = []
    planned = {}
    lifecycle = {}
    panes = live_panes()
    print("live panes: %d" % len(panes))
    wdocs = sorted(p for p in live if p.startswith("workers/"))
    print("workers docs: %d" % len(wdocs))
    by_pane, used = {}, set()
    for path in sorted(wdocs, key=lambda p: -len(p.split("/", 1)[1])):
        name = path.split("/", 1)[1]
        for pid, title in panes:
            if pid in used:
                continue
            if name and name in title:
                by_pane[path] = (pid, title)
                used.add(pid)
                break
    for path in wdocs:  # fallback: the only doc whose issue names an unmatched pane
        if path in by_pane:
            continue
        issue = (live[path][1] or {}).get("issue")
        if not issue:
            continue
        cands = [(pid, t) for pid, t in panes if pid not in used and issue in t]
        if len(cands) == 1:
            by_pane[path] = cands[0]
            used.add(cands[0][0])
    self_path = "workers/" + SELF_NAME
    if self_path not in live:
        for pid, t in panes:
            if pid not in used and SELF_NAME in t:
                by_pane[self_path] = (pid, t)
                used.add(pid)
                break
    for pid, title in panes:
        if pid not in used:
            print("  pane %s unmatched (no workers doc): %s" % (pid, title[:80]))
    for path in wdocs:
        rid, doc = live[path][0], dict(live[path][1] or {})
        issue = doc.get("issue")
        life, exp = sb_show(issue) if issue else (None, None)
        lifecycle[path] = life
        new = dict(doc)
        if path in by_pane:
            pid, _ = by_pane[path]
            new["status"] = "live"
            new["where"] = pid
            ctx = pane_ctx(pid)
            new["ctxPct"] = ctx
        else:
            new["where"] = None
            new["ctxPct"] = None
            if life in ("done", "closed", "cancelled", "archived"):
                new["status"] = "done"
            elif doc.get("status") == "live":
                new["status"] = "gone"
        new["claimUntil"] = claim_iso(exp)
        planned[path] = new
        if norm(new) != norm(doc):
            new["updatedAt"] = NOW
            new["updatedBy"] = BY
            ops.append(("PATCH", path, rid, new))
            print("  %s: %s/%s -> %s/%s" % (path, doc.get("status"), doc.get("where"),
                                            new["status"], new["where"]))
    if self_path in by_pane and self_path not in live:
        pid, _ = by_pane[self_path]
        life, exp = sb_show(SELF_ISSUE)
        doc = {"name": SELF_NAME, "kind": "pi", "runtime": "xt pi",
               "issue": SELF_ISSUE, "task": "Tabellone auto-sync (5-min timer).",
               "status": "live", "where": pid, "ctxPct": pane_ctx(pid),
               "claimUntil": claim_iso(exp), "reportsTo": FALLBACK_OWNER or None,
               "order": 99, "milestone": "sync live", "milestoneAt": NOW,
               "updatedAt": NOW, "updatedBy": BY}
        ops.append(("POST", self_path, None, doc))
        print("  %s: CREATE live/%s" % (self_path, pid))
    # Panes with no workers doc at all (MMD-3184): a live project worker that the
    # coordinator has not written a doc for is invisible in the operator's workers view.
    # Only <PM_REPO_NAME>-xt-{claude,pi}-* titles qualify; core-* and shell panes never do.
    made = set()
    for pid, title in panes:
        if pid in used:
            continue
        prefix, name = pane_name(title)
        if not name:
            continue
        path = "workers/" + name
        if path in live or path in made:
            continue
        kind = "pi" if prefix.endswith("-pi") else (
            "coordinator" if "coord" in name.lower() else "builder")
        m = re.match(r"((?:%s|%s)-\d+)" % (re.escape(SB_PREFIX), re.escape(JIRA_PROJECT)), name)
        issue = m.group(1) if m else None
        _, exp = sb_show(issue) if issue else (None, None)
        doc = {"name": name, "kind": kind,
               "runtime": "xt pi" if kind == "pi" else "xt claude",
               "issue": issue, "task": None, "status": "live", "where": pid,
               "ctxPct": pane_ctx(pid), "claimUntil": claim_iso(exp) if issue else None,
               "reportsTo": None, "order": None, "milestone": None,
               "milestoneAt": None, "note": None,
               "updatedAt": NOW, "updatedBy": BY}
        ops.append(("POST", path, None, doc))
        made.add(path)
        print("  %s: CREATE live/%s (kind %s, issue %s)" % (path, pid, kind, issue))
    print("workers updates: %d of %d (+%d create)" % (
        len([o for o in ops if o[0] == "PATCH"]), len(wdocs),
        len([o for o in ops if o[0] == "POST" and o[1].startswith("workers/")])))
    deletes = archive_done(planned, lifecycle, live, ops)
    if deletes:
        print("workers archived: %d doc(s) -> %s" % (
            len(deletes), ", ".join(sorted({a for _p, _r, a in deletes}))))
    return ops


def archive_done(planned, lifecycle, live, ops):
    """Move done workers older than 24 h out of workers/ into archive/workers-<date>.

    A worker whose issue is still open is not archived even when its doc says done:
    it belongs to the 'gone' group of the view (pane gone, issue open), and hiding an
    open thread is worse than a longer list. An unknown lifecycle keeps the doc too.
    The archive write is queued before the delete, and main() skips a delete whose
    archive write failed, so a worker document never leaves the store without a copy.
    Returns [(workers path, record id, archive path)].
    """
    day = NOW[:10]
    olds = sorted((p, d) for p, d in planned.items()
                  if d.get("status") == "done"
                  and (not d.get("issue") or lifecycle.get(p) in TERMINAL_STATES)
                  and older_than(d.get("updatedAt"), ARCHIVE_KEEP_H))
    if not olds:
        return []
    buckets, order = {}, []
    for p in sorted(live):
        if p == ARCHIVE_PREFIX + day or p.startswith(ARCHIVE_PREFIX + day + "-"):
            doc = dict(live[p][1] or {})
            buckets[p] = {"rid": live[p][0], "workers": dict(doc.get("workers") or {}),
                          "bytes": len(json.dumps({"path": p, "doc": doc},
                                                  ensure_ascii=False).encode("utf-8")),
                          "dirty": False}
            order.append(p)
    if not order:
        p = ARCHIVE_PREFIX + day
        buckets[p] = {"rid": None, "workers": {}, "bytes": 256, "dirty": True}
        order.append(p)
    deletes = []
    for path, doc in olds:
        name = path.split("/", 1)[1]
        n = len(json.dumps({name: doc}, ensure_ascii=False).encode("utf-8")) + 8
        target = next((p for p in order if buckets[p]["bytes"] + n < MAX_BYTES - 64), None)
        if target is None:
            i = len(order) + 1
            while "%s%s-%d" % (ARCHIVE_PREFIX, day, i) in live or \
                    "%s%s-%d" % (ARCHIVE_PREFIX, day, i) in buckets:
                i += 1
            target = "%s%s-%d" % (ARCHIVE_PREFIX, day, i)
            buckets[target] = {"rid": None, "workers": {}, "bytes": 256, "dirty": True}
            order.append(target)
        b = buckets[target]
        b["workers"][name] = doc
        b["bytes"] += n
        b["dirty"] = True
        deletes.append((path, live[path][0], target))
    for p in order:
        b = buckets[p]
        if not b["dirty"]:
            continue
        doc = {"date": day, "note": ARCHIVE_NOTE, "workers": b["workers"],
               "updatedAt": NOW, "updatedBy": BY}
        ops.append(("PATCH" if b["rid"] else "POST", p, b["rid"], doc))
        print("  %s: %d archived worker doc(s), %d bytes" % (p, len(b["workers"]), b["bytes"]))
    for path, rid, arch in deletes:
        ops.append(("DELETE", path, rid, arch))
        print("  %s: DELETE (archived in %s)" % (path, arch))
    return deletes


def owner_of(qid, live):
    for p in live:
        if not p.startswith("questions/"):
            continue
        doc = live[p][1] or {}
        for r in (doc.get("rows") or []):
            if r.get("id") == qid:
                return p.split("/", 1)[1]
    return None


def is_pi_pane(title):
    t = (title or "").lstrip()
    if t.startswith(PI_GLYPH):
        return True
    tok = re.sub(r"^[^\w]+", "", t).split(" ", 1)[0]
    return tok.startswith(REPO_NAME + "-xt-pi-") or tok.startswith("core-xt-pi-")


def deliver(owner, text):
    addr = OWNER_ADDR.get(owner, FALLBACK_OWNER)
    if addr in FILE_ONLY_OWNERS:
        return "file-only"
    try:
        r = subprocess.run(["xtmux", "message-send", "--to", addr, "--text", text],
                           capture_output=True, text=True, timeout=60)
        if r.returncode == 0:
            return "xtmux:" + addr
    except (subprocess.SubprocessError, OSError):
        pass
    panes = live_panes()
    for pid, title in panes:
        if not is_pi_pane(title):
            continue
        if addr in title or owner in title:
            try:
                subprocess.run([TMUX, "send-keys", "-t", pid, text, "Enter"],
                               capture_output=True, text=True, timeout=30)
                return "send-keys:" + pid
            except (subprocess.SubprocessError, OSError):
                return "FAILED-send-keys:" + pid
    return "FAILED-no-pane:" + addr


def gh_merged_prs():
    """One bulk read: PRs merged since yesterday (UTC). Returns None on failure."""
    since = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
    cmd = [GH, "pr", "list", "-R", GH_REPO, "--state", "merged",
           "--search", "merged:>=%s" % since, "--limit", "100",
           "--json", "number,title,url,mergedAt,baseRefName,mergeCommit"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except (subprocess.SubprocessError, OSError) as e:
        print("PR list failed: %s" % scrub(str(e))[:200])
        return None, since
    if r.returncode != 0:
        print("PR list failed: gh exit %d: %s"
              % (r.returncode, scrub((r.stderr or "").strip())[:200]))
        return None, since
    try:
        return json.loads(r.stdout or "[]"), since
    except ValueError:
        print("PR list failed: unparsable gh output")
        return None, since


def pr_merged_dt(s):
    try:
        return datetime.strptime(str(s), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def pr_number_index(events):
    """PR number -> event key, for rows the keeper or an earlier run already wrote."""
    idx = {}
    for k, e in events.items():
        m = PR_REF_RE.match(str(((e or {}).get("ref") if isinstance(e, dict) else "") or ""))
        if m:
            idx.setdefault(int(m.group(1)), k)
        m = PR_KEY_RE.search(str(k))
        if m:
            idx.setdefault(int(m.group(1)), k)
    return idx


def build_prs(live):
    """Part (d): merged PRs as schedule events, interleaved by merge minute."""
    ops = []
    prs, since = gh_merged_prs()
    if prs is None:
        return ops
    print("merged PRs since %s: %d" % (since, len(prs)))
    by_day = {}
    for p in prs:
        dt = pr_merged_dt(p.get("mergedAt"))
        if dt is None:
            print("  PR #%s: unparsable mergedAt %r (skipped)"
                  % (p.get("number"), p.get("mergedAt")))
            continue
        by_day.setdefault(dt.strftime("%Y-%m-%d"), []).append((dt, p))
    changed_docs = 0
    for day in sorted(by_day):
        path = "schedule/" + day
        rec = live.get(path)
        doc = dict(rec[1] or {}) if rec else {"date": day, "events": {}}
        rid = rec[0] if rec else None
        old = doc.get("events") or {}
        events = dict(old)
        idx = pr_number_index(events)
        changed = 0
        for dt, p in sorted(by_day[day], key=lambda x: x[0]):
            n = int(p.get("number") or 0)
            if not n:
                continue
            at = dt.strftime("%Y-%m-%dT%H:%MZ")
            key = "e_%02d%02d_PR-%d" % (dt.hour, dt.minute, n)
            title = scrub(" ".join(str(p.get("title") or "").split()))[:160]
            url = str(p.get("url") or "")
            base = str(p.get("baseRefName") or "")
            keyed = idx.get(n)
            if keyed is None:
                events[key] = {"at": at, "ref": "PR #%d" % n, "label": title,
                               "url": url, "kind": "pr", "base": base,
                               "status": "done", "note": "", "src": PR_SRC}
                idx[n] = key
                changed += 1
                print("  + %s %s PR #%d %s" % (path, key, n, title[:60]))
                continue
            before = dict(events.get(keyed) or {})
            now_ev = dict(before)
            now_ev["url"] = url
            now_ev["kind"] = "pr"
            now_ev["base"] = base
            now_ev["status"] = "done"
            now_ev["title"] = title
            now_ev["src"] = PR_SRC
            if not now_ev.get("ref"):
                now_ev["ref"] = "PR #%d" % n
            if not now_ev.get("at"):
                now_ev["at"] = at
            if norm(now_ev) != norm(before):
                events[keyed] = now_ev
                changed += 1
                print("  ~ %s %s PR #%d %s" % (path, keyed, n,
                                               "adopted" if before.get("src") != PR_SRC else "refreshed"))
            else:
                print("  = %s %s PR #%d unchanged" % (path, keyed, n))
        if not changed or norm(events) == norm(old):
            continue
        new = dict(doc)
        new["events"] = events
        if not new.get("date"):
            new["date"] = day
        new["updatedAt"] = NOW
        new["updatedBy"] = BY
        size = len(json.dumps({"path": path, "doc": new}, ensure_ascii=False).encode("utf-8"))
        if size >= MAX_BYTES:
            print("  SKIP %s: %d bytes >= %d gate" % (path, size, MAX_BYTES))
            continue
        ops.append(("PATCH" if rid else "POST", path, rid, new))
        changed_docs += 1
        print("  %s %s: %d events total, %d changed, %d bytes"
              % ("PATCH" if rid else "POST", path, len(events), changed, size))
    print("PR schedule docs to write: %d" % changed_docs)
    return ops


# --------------------------------------------------- jira window tasks (MMD-3290)
def jira_day(day):
    try:
        return datetime.strptime(day, "%Y-%m-%d").date()
    except ValueError:
        return None


def jira_slot(value):
    """Jira datetime (with offset) -> aware UTC datetime, or None."""
    m = SLOT_RE.match(str(value or ""))
    if not m:
        return None
    y, mo, d, h, mi, sec, sign, oh, om = m.groups()
    off = 0
    if sign:
        off = (int(oh) * 60 + int(om)) * (1 if sign == "+" else -1)
    try:
        dt = datetime(int(y), int(mo), int(d), int(h), int(mi), int(sec or 0),
                      tzinfo=timezone(timedelta(minutes=off)))
    except ValueError:
        return None
    return dt.astimezone(timezone.utc)


# recorded window field ids, used when /field has no "window start"/"window end" field
CUSTOM_FIELDS = dict(pm_config.get_data("PM_CUSTOM_FIELDS", {}))
# Jira status name -> page status, applied before the category map
STATUS_OVERRIDES = dict(pm_config.get_data(
    "PM_TABELLONE_STATUS_OVERRIDES", {"Deferred": "blocked", "Won't Do": "blocked", "Won't do": "blocked"}))


def load_profile(mod):
    """Board profile: window field ids + status map, discovered once from Jira.

    Nothing here is assumed: the two window fields come from the field list,
    the status CJK categories from the project status list, and the category ->
    page status map from PROFILE_MAP. Rebuilt only when the file is missing or
    a lookup fails; the README records the mapping table.
    """
    try:
        with open(PROFILE_FILE) as fh:
            prof = json.load(fh)
        if (prof.get("fields") or {}).get("windowStart"):
            return prof
    except (OSError, ValueError):
        pass
    print("profile: building from the Jira API")
    fields_ok, fields = mod.call("GET", "/rest/api/3/field")
    ws = we = None
    for f in (fields if fields_ok == 200 else []) or []:
        name = (f.get("name") or "").lower()
        if "window start" in name:
            ws = f.get("id")
        if "window end" in name:
            we = f.get("id")
    st_ok, sts = mod.call("GET", "/rest/api/3/project/%s/statuses" % JIRA_PROJECT)
    cats = {}
    for typ in (sts if st_ok == 200 else []) or []:
        for s in typ.get("statuses") or []:
            cats[s.get("name")] = ((s.get("statusCategory") or {}).get("key") or "?")
    prof = {
        "project": JIRA_PROJECT,
        "fields": {"windowStart": ws or CUSTOM_FIELDS.get("window_start"),
                   "windowEnd": we or CUSTOM_FIELDS.get("window_end")},
        "statusCategory": cats,
        "statusMap": dict(PROFILE_MAP),
        "statusOverrides": dict(STATUS_OVERRIDES),
        "builtAt": NOW,
        "builtBy": BY,
    }
    if not ws or not we:
        print("profile: window fields not found in /field, using recorded ids")
    try:
        with open(PROFILE_FILE, "w") as fh:
            json.dump(prof, fh, indent=1, sort_keys=True)
        print("profile: written to %s" % PROFILE_FILE)
    except OSError as e:
        print("profile: write failed %s" % e)
    return prof


def status_of(prof, st):
    """Jira status -> page status. (status, known_name)."""
    st = st or {}
    name = st.get("name") or ""
    over = prof.get("statusOverrides") or {}
    if name in over:
        return over[name], True
    cat = ((st.get("statusCategory") or {}).get("key")
           or (prof.get("statusCategory") or {}).get(name))
    return (prof.get("statusMap") or {}).get(cat) or "scheduled", cat is not None


def note_from_comments(comments):
    """First line of the latest GO/DRY/result comment; else the latest comment."""
    best = ""
    for c in comments or []:
        text = adf_text(c.get("body") or {}).strip()
        head = text.splitlines()[0].strip() if text else ""
        if head and (NOTE_RE.search(head) or NOTE_RE.search(text[:300])):
            best = head
    if not best and comments:
        text = adf_text((comments[-1].get("body") or {})).strip()
        best = text.splitlines()[0].strip() if text else ""
    return " ".join(best.split())[:200]


def folded_target(summary, comments):
    """'folded into <KEY>-xxx' target, from the summary or a comment."""
    for text in [summary] + ["\n".join(adf_text(c.get("body") or {}).split("\n")[:6]) for c in comments or []]:
        m = FOLDED_RE.search(str(text or ""))
        if m:
            return m.group(1)
    return ""


def ref_tokens(event, key):
    toks = REF_TOK_RE.findall(str((event or {}).get("ref") or ""))
    km = re.search(r"_((?:%s)-\d+)$" % KEY_ALT, str(key))
    if km and km.group(1) not in toks:
        toks.append(km.group(1))
    return toks


def desired_event(row):
    start, end = row["start"], row["end"]
    bits = []
    if end:
        bits.append("%s-%sZ" % (start.strftime("%H:%M"), end.strftime("%H:%M")))
    if row["folded"]:
        bits.append("folded into %s" % row["folded"])
    if row["note_src"]:
        bits.append(row["note_src"])
    ev = {
        "at": start.strftime("%Y-%m-%dT%H:%MZ"),
        "ref": row["key"],
        "label": row["summary"][:160],
        "status": row["status"],
        "note": scrub(" · ".join(bits))[:300],
        "note_src": row["note_src"][:200],
        "kind": "window",
        "created_by": JIRA_SRC,
        "url": JIRA_BROWSE + row["key"],
    }
    if end:
        ev["end"] = end.strftime("%Y-%m-%dT%H:%MZ")
    if row["folded"]:
        ev["folded"] = row["folded"]
    prev = row.get("prev") or {}
    if len(ref_tokens(prev, row["key"])) > 1:
        # keeper row covering several keys: keep its ref/label, refresh the rest
        ev["ref"] = prev.get("ref")
        ev["label"] = prev.get("label") or ev["label"]
    return ev


def build_jira_schedule(mod, live, prof):
    """Part (e): Jira window Tasks become schedule events, mechanically.

    Mechanical: placement (slot date/time), key, label, status (category map),
    slot range, folded target, latest GO/DRY/result comment line, Jira link.
    Manual: every event without created_by 'sync-jira' (handover, incidents,
    reports) is never touched. Owned events whose Jira slot moved are removed
    from the old date.
    """
    ops, drift = [], []
    flds = prof.get("fields") or {}
    f_start, f_end = flds.get("windowStart"), flds.get("windowEnd")
    if not (f_start and f_end):
        print("jira schedule: profile has no window fields, skipped")
        drift.append({"at": NOW, "kind": "profile-incomplete"})
        return ops, drift
    cf = lambda f: "cf[%s]" % re.sub(r"\D", "", str(f))
    today = datetime.now(timezone.utc).date()
    lo = today - timedelta(days=RANGE_BACK)
    hi = today + timedelta(days=RANGE_FWD)
    jql = ('project = %s AND labels = %s AND ((%s >= "%s" AND %s <= "%s") OR updated >= -%s)'
           ' ORDER BY %s ASC'
           % (JIRA_PROJECT, WINDOW_LABEL, cf(f_start), lo.isoformat(), cf(f_start), hi.isoformat(),
              RECENT_UPD, cf(f_start)))
    print("JQL windows: %s" % jql)
    issues = jira_search(mod, jql, fields="key,summary,status,created,updated,%s,%s" % (f_start, f_end))
    print("window rows: %d (slot range %s..%s)" % (len(issues), lo, hi))

    recent_after = datetime.now(timezone.utc) - timedelta(minutes=int(RECENT_UPD.rstrip("m")))
    rows, seen = [], set()
    for iss in issues:
        f = iss.get("fields") or {}
        key = iss.get("key")
        if not key or key in seen:
            continue
        seen.add(key)
        start, end = jira_slot(f.get(f_start)), jira_slot(f.get(f_end))
        status, known = status_of(prof, f.get("status"))
        if not known:
            drift.append({"at": NOW, "kind": "status-unknown", "ref": key,
                          "jira": (f.get("status") or {}).get("name") or ""})
        if start is None:
            print("  %s: no %s, not placed" % (key, f_start))
            drift.append({"at": NOW, "kind": "jira-no-slot", "ref": key})
            continue
        if not (lo <= start.date() <= hi):
            print("  %s: slot %s outside range, not placed" % (key, start.strftime("%Y-%m-%dT%H:%MZ")))
            continue
        upd = jira_slot(f.get("updated"))
        rows.append({
            "key": key, "start": start, "end": end, "status": status,
            "summary": " ".join(str(f.get("summary") or "").split()),
            "day": start.strftime("%Y-%m-%d"),
            "recent": bool(upd and upd >= recent_after),
            "updated": upd, "updated_raw": str(f.get("updated") or ""),
            "created": jira_slot(f.get("created")),
        })
    ASSERT_ROWS[:] = rows

    tok_index = []
    for p in sorted(live):
        if not p.startswith("schedule/"):
            continue
        day = p.split("/", 1)[1]
        for k, e in ((live[p][1] or {}).get("events") or {}).items():
            if not isinstance(e, dict):
                continue
            toks = ref_tokens(e, k)
            if toks:
                tok_index.append((day, k, toks, e))

    placed = {}
    for row in sorted(rows, key=lambda r: (r["start"], r["key"])):
        key = row["key"]
        cand = [t for t in tok_index if key in t[2]]
        # a keeper row covering several keys describes the combined window: keep it
        cand.sort(key=lambda t: (t[0] != row["day"], -len(t[2]), t[0], t[1]))
        adopt = cand[0][:2] if cand else None
        row["adopt"] = adopt
        row["evkey"] = adopt[1] if adopt else "e_%s_%s" % (row["start"].strftime("%H%M"), key)
        placed[(row["day"], row["evkey"])] = row

    fetched = 0
    for row in rows:
        prev = {}
        if row["adopt"]:
            prev = dict(((live.get("schedule/" + row["adopt"][0]) or (None, None))[1] or {})
                        .get("events", {}).get(row["adopt"][1]) or {})
        row["prev"] = prev
        if row["adopt"] is None or row["recent"] or not prev.get("note_src") or not prev.get("label"):
            cs = jira_comments(mod, row["key"])
            fetched += 1
            row["note_src"] = note_from_comments(cs)
            row["folded"] = folded_target(row["summary"], cs)
        else:
            row["note_src"] = prev.get("note_src") or ""
            row["folded"] = prev.get("folded") or ""
    print("comment fetches: %d of %d rows" % (fetched, len(rows)))

    by_day = {}
    for row in rows:
        by_day.setdefault(row["day"], {}).setdefault(row["evkey"], desired_event(row))

    window_keys = {r["key"] for r in rows}
    # a keeper row is only re-dated when it is the one row for that window: a key
    # split over several keeper rows (phases, retries) or one with a key suffix
    # (e_1629_PROJ-542-api) is keeper detail the sync must not fold away
    keep_rows = {}
    for p in sorted(live):
        if not p.startswith("schedule/"):
            continue
        for k, e in ((live[p][1] or {}).get("events") or {}).items():
            if not isinstance(e, dict) or (e.get("created_by") or "") == JIRA_SRC:
                continue
            toks = ref_tokens(e, k)
            if len(toks) == 1 and re.search(r"_(?:%s)-\d+$" % KEY_ALT, str(k)):
                kk = (toks[0], p.split("/", 1)[1])
                keep_rows[kk] = keep_rows.get(kk, 0) + 1
    stale = []
    for p in sorted(live):
        if not p.startswith("schedule/"):
            continue
        day = p.split("/", 1)[1]
        d = jira_day(day)
        if d is None or not (lo <= d <= hi):
            continue
        for k, e in ((live[p][1] or {}).get("events") or {}).items():
            if not isinstance(e, dict) or (day, k) in placed:
                continue
            toks = ref_tokens(e, k)
            if (e.get("created_by") or "") == JIRA_SRC:
                stale.append((day, k, "owned"))
            elif (d >= today and re.search(r"_(?:%s)-\d+$" % KEY_ALT, str(k))
                  and len(toks) == 1 and toks[0] in window_keys
                  and keep_rows.get((toks[0], day)) == 1):
                # the only keeper row for this window key, on a date that is not its
                # Jira slot: the row moved, so the plan doc must lose it
                stale.append((day, k, "moved"))
    print("events to remove (slot moved / row gone): %d" % len(stale))
    for day, k, why in stale:
        print("  stale %s %s (%s)" % (day, k, why))

    for day in sorted(set(by_day) | {d for d, k, w in stale}):
        path = "schedule/" + day
        rec = live.get(path)
        doc = dict(rec[1] or {}) if rec else {"date": day, "events": {}}
        rid = rec[0] if rec else None
        old = doc.get("events") or {}
        events = {k: v for k, v in old.items() if (day, k, "owned") not in stale and (day, k, "moved") not in stale}
        gone = sorted(k for k in old if k not in events)
        changed = 0
        for k, want in sorted(by_day.get(day, {}).items()):
            prev = events.get(k)
            if prev is None:
                events[k] = want
                changed += 1
                print("  + %s %s (%s)" % (day, k, "adopted" if (placed.get((day, k)) or {}).get("adopt") else "new"))
                continue
            merged = dict(prev)
            merged.update(want)
            if norm(merged) != norm(prev):
                events[k] = merged
                changed += 1
        for k in gone:
            print("  - %s %s (slot moved or row gone)" % (day, k))
        if not changed and not gone:
            continue
        new = dict(doc)
        new["events"] = events
        new.setdefault("date", day)
        new["updatedAt"] = NOW
        new["updatedBy"] = BY
        size = len(json.dumps({"path": path, "doc": new}, ensure_ascii=False).encode("utf-8"))
        if size >= MAX_BYTES:
            print("  SKIP %s: %d bytes >= %d" % (path, size, MAX_BYTES))
            drift.append({"at": NOW, "kind": "doc-over-limit", "path": path, "bytes": size})
            continue
        ops.append(("PATCH" if rid else "POST", path, rid, new))

    effective = {p: dict(live[p][1] or {}) for p in live if p.startswith("schedule/")}
    for m, p, rid, d in ops:
        if p.startswith("schedule/"):
            effective[p] = d
    for row in rows:
        doc = effective.get("schedule/" + row["day"]) or {}
        ev = (doc.get("events") or {}).get(row["evkey"])
        want = by_day.get(row["day"], {}).get(row["evkey"]) or desired_event(row)
        if not isinstance(ev, dict):
            drift.append({"at": NOW, "kind": "missing-event", "ref": row["key"],
                          "date": row["day"], "evkey": row["evkey"]})
            continue
        for fld in ("at", "status", "ref", "label", "end", "url"):
            if fld in want and str(ev.get(fld)) != str(want.get(fld)):
                drift.append({"at": NOW, "kind": "field-mismatch", "ref": row["key"],
                              "date": row["day"], "field": fld,
                              "jira": want.get(fld), "tab": ev.get(fld)})
    placed_dates = sorted(by_day)
    for day in placed_dates:
        evs = ((effective.get("schedule/" + day) or {}).get("events") or {})
        print("  %s: %d events" % (day, len(evs)))
        for at, k, v in sorted((str(v.get("at") or ""), k, v) for k, v in evs.items() if isinstance(v, dict)):
            print("    %s %-28s %-11s %s%s" % (at, k, v.get("status"), v.get("ref") or "",
                                               (" src=" + str(v["created_by"])) if v.get("created_by") else ""))
    print("jira schedule: rows %d on %d date doc(s); drift %d"
          % (len(rows), len(placed_dates), len(drift)))
    for d in drift:
        print("  DRIFT %s" % json.dumps(d, ensure_ascii=False, sort_keys=True))
    return ops, drift


def route_answers(live, state):
    done = set(state.get("routed_answer_ids") or [])
    fresh = []
    for p in sorted(live):
        if not p.startswith("answers/"):
            continue
        qid = p[len("answers/"):]
        doc = live[p][1] or {}
        at = str(doc.get("at") or "")
        if qid in done or at < ANSWER_SEED_AT:
            continue
        owner = owner_of(qid, live)
        fresh.append((qid, owner or "unknown", at, doc))
    print("answers fresh since %s: %d" % (ANSWER_SEED_AT, len(fresh)))
    n = 0
    for qid, owner, at, doc in fresh:
        text = ("Tabellone answer %s -> owner %s: answer=%r comment=%r at=%s by=%s" %
                (qid, owner, doc.get("answer"), (doc.get("comment") or "")[:200],
                 at, doc.get("by")))
        if DRY:
            print("  DRY route %s" % text[:200])
            continue
        where = deliver(owner, text)
        entry = {"qid": qid, "owner": owner, "at": at, "answer": doc.get("answer"),
                 "comment": (doc.get("comment") or "")[:500], "by": doc.get("by"),
                 "delivered": where, "run": NOW}
        with open(INBOX, "a") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        done.add(qid)
        n += 1
        print("  routed %s -> %s" % (qid, where))
    state["routed_answer_ids"] = sorted(done)
    return n


# ---------------------------------------------------------------- run assertions (MMD-3382)
ASSERT_CACHE_FILE = os.path.join(CACHEDIR, "assert-cache.json")
PUBLISH_API = "https://here.now/api/v1/publish/%s" % SITE


def parse_ts(value):
    """Stamp -> aware UTC datetime, or None. jira_slot takes 'Z', ms, +hhmm and minute precision."""
    return jira_slot(value)


def iso_min(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ") if dt else "unknown"


def window_event_for(doc, key):
    """(event key, kind=window event) of a schedule doc that carries the Jira key as its ref."""
    for k, e in ((doc or {}).get("events") or {}).items():
        if isinstance(e, dict) and e.get("kind") == "window" and key in ref_tokens(e, k):
            return k, e
    return None, None


def expected_window_keys(mod, prof, today, hi):
    """{key: {start}} for every Jira issue whose window start is in today..hi.

    A second search that does not use the run's own list and has no label filter, so a
    row that lost its window label is seen here and missing from the run's placed rows.
    Same project and date bounds as the run's JQL, so both searches cut the range the same way.
    Narrowing: Subtasks and Epics are skipped. Unlabelled Subtasks (for example PROJ-606/607) are
    the steps of a window (PROJ-358) and their parent may sit outside the run's rows. An Epic is never
    a placeable window row: the board uses Epics as themes and as calendar markers (an Epic carried the
    coordinator handover slot), and a slot on an Epic is a calendar entry, not a window to place.
    Every placeable type (Task, Story, Bug, ...) that carries a slot and is not placed still fails.
    """
    f_start = (prof.get("fields") or {}).get("windowStart")
    if not f_start:
        return None
    num = re.sub(r"\D", "", str(f_start))
    jql = ('project = %s AND cf[%s] >= "%s" AND cf[%s] <= "%s" ORDER BY cf[%s] ASC'
           % (JIRA_PROJECT, num, today.isoformat(), num, hi.isoformat(), num))
    out = {}
    for iss in jira_search(mod, jql, fields="key,issuetype,%s" % f_start):
        f = iss.get("fields") or {}
        start = jira_slot(f.get(f_start))
        if not iss.get("key") or start is None or not (today <= start.date() <= hi):
            continue
        it = f.get("issuetype") or {}
        if it.get("subtask") or it.get("name") in NON_PLACEABLE_TYPES or it.get("hierarchyLevel") == 1:
            continue
        out[iss["key"]] = {"start": start}
    return out


def assert_lines(rows, docs, version, today, hi, write_of, expected=None):
    """Read-only checks of one run. Keyed on the event ref and the doc write time, never on rendered text.

    rows    window rows the run placed (key, day, start, end, updated)
    docs    {path: (record updatedAt datetime or None, doc dict)} as published
    version (site version datetime or None, id)
    expected {key: {start}} from expected_window_keys, or None when unreadable
    write_of(row) -> datetime of the Jira slot write, or None when unknown; called only
            for a row whose Jira issue changed after its doc was written
    Returns (lines, failed). Unknown values are reported, never a failure.
    """
    lines, failed = [], False
    placed_keys = {r["key"] for r in rows}
    if expected is None:
        lines.append("ASSERT-UNKNOWN expected-set unreadable (second Jira search not run)")
    for key, x in sorted((expected or {}).items()):
        if key in placed_keys:
            continue
        lines.append("ASSERT-FAIL unplaced-row ref=%s slot=%s (in the Jira window-start search, not placed by this run)"
                     % (key, x["start"].strftime("%Y-%m-%dT%H:%MZ")))
        failed = True
    for r in sorted(rows, key=lambda r: (r["day"], r["key"])):
        d = jira_day(r["day"])
        if d is None or d < today or d > hi:
            continue
        path = "schedule/" + r["day"]
        wrote, doc = docs.get(path, (None, None))
        if doc is None:
            lines.append("ASSERT-FAIL missing-doc ref=%s date=%s doc=%s" % (r["key"], r["day"], path))
            failed = True
            continue
        evkey, ev = window_event_for(doc, r["key"])
        if ev is None:
            lines.append("ASSERT-FAIL missing-event ref=%s date=%s doc=%s jira-slot=%s"
                         % (r["key"], r["day"], path, r["start"].strftime("%Y-%m-%dT%H:%MZ")))
            failed = True
            continue
        if len(ref_tokens(ev, evkey)) > 1:
            continue    # a keeper row covering several keys holds the combined window, not this slot
        wrote = wrote or parse_ts(doc.get("updatedAt"))
        if wrote is None or not r.get("updated") or r["updated"] <= wrote:
            continue
        sw = write_of(r)
        if sw is None:
            lines.append("ASSERT-UNKNOWN slot-write ref=%s date=%s (changelog unreadable)" % (r["key"], r["day"]))
            continue
        want = {"at": r["start"].strftime("%Y-%m-%dT%H:%MZ")}
        if r["end"]:
            want["end"] = r["end"].strftime("%Y-%m-%dT%H:%MZ")
        stale = wrote < sw and any(str(ev.get(f)) != v for f, v in want.items())
        if stale:
            lines.append("ASSERT-FAIL stale-doc ref=%s date=%s doc=%s doc-write=%s jira-slot-write=%s"
                         % (r["key"], r["day"], path, iso_min(wrote), iso_min(sw)))
            failed = True

    placed, refs, newest, newest_path = 0, set(), None, ""
    for path, (wrote, doc) in docs.items():
        if not path.startswith("schedule/"):
            continue
        wrote = wrote or parse_ts((doc or {}).get("updatedAt"))
        if wrote and (newest is None or wrote > newest):
            newest, newest_path = wrote, path
        d = jira_day(path.split("/", 1)[1])
        if d is None or d < today or d > hi:
            continue
        for k, e in ((doc or {}).get("events") or {}).items():
            if isinstance(e, dict) and e.get("kind") == "window":
                placed += 1
                refs.update(ref_tokens(e, k))
    pub = version[0]
    fails = sum(1 for ln in lines if ln.startswith("ASSERT-FAIL"))
    lines.append("ASSERT-COUNT window-events-placed=%d distinct-refs=%d latest-doc-write=%s publish=%s result=%s"
                 % (placed, len(refs), iso_min(newest), iso_min(pub), "FAIL(%d)" % fails if failed else "OK"))
    return lines, failed


def slot_write_time(mod, fields, row, cache):
    """When the Jira slot (window start or end) of this row was last written: changelog, else created.

    Cached per (key, Jira updated stamp), so a quiet board costs no call. None when unreadable.
    """
    hit = cache.get(row["key"])
    if hit and hit.get("updated") == row["updated_raw"]:
        return parse_ts(hit.get("write"))
    latest, start_at = None, 0
    while True:
        st, body = mod.call("GET", "/rest/api/3/issue/%s/changelog?startAt=%d&maxResults=100"
                            % (row["key"], start_at))
        if st != 200 or not isinstance(body, dict):
            return None
        vals = body.get("values") or []
        for v in vals:
            if any(i.get("fieldId") in fields for i in v.get("items") or []):
                t = jira_slot(v.get("created"))
                if t and (latest is None or t > latest):
                    latest = t
        if body.get("isLast", True) or not vals:
            break
        start_at += len(vals)
    write = latest or row.get("created")
    if write is None:
        return None
    cache[row["key"]] = {"updated": row["updated_raw"], "write": iso_min(write)}
    return write


def run_assertions(mod, prof, docs, dry):
    """Print the run's assertion lines. Returns True when a check failed or could not run.

    Called after every write and the read-back, so a failure here never stops or reorders
    the sync's work; an exception inside it is reported, not raised.
    """
    try:
        flds = prof.get("fields") or {}
        fields = {flds.get("windowStart"), flds.get("windowEnd")} - {None}
        try:
            with open(ASSERT_CACHE_FILE) as fh:
                cache = json.load(fh)
        except (OSError, ValueError):
            cache = {}
        if not isinstance(cache, dict):
            cache = {}
        socket.setdefaulttimeout(30)    # last stage of the run: a hung Jira read must not hold the unit
        today = datetime.now(timezone.utc).date()
        hi = today + timedelta(days=RANGE_FWD)
        st, body = hn_call("GET", PUBLISH_API)
        version = (parse_ts(body.get("currentVersionCreatedAt")), body.get("currentVersionId")) \
            if st == 200 and isinstance(body, dict) else (None, None)

        def write_of(row):
            try:
                return slot_write_time(mod, fields, row, cache)
            except (Exception, SystemExit) as e:  # one unreadable changelog must not hide the other rows
                print("  changelog %s: %s" % (row["key"], scrub(str(e))[:120]))
                return None

        try:
            expected = expected_window_keys(mod, prof, today, hi)
        except (Exception, SystemExit) as e:
            print("  expected-set search: %s" % scrub(str(e))[:160])
            expected = None
        lines, failed = assert_lines(ASSERT_ROWS, docs, version, today, hi, write_of, expected)
        for ln in lines:
            print(ln)
        if not dry:
            try:
                with open(ASSERT_CACHE_FILE, "w") as fh:
                    json.dump(cache, fh, sort_keys=True)
            except OSError as e:
                print("assert cache write failed: %s" % e)
        return failed
    except Exception as e:
        print("ASSERT-ERROR check could not run: %s" % scrub(repr(e))[:300])
        return True


def main():
    global HN_KEY
    os.makedirs(CACHEDIR, exist_ok=True)
    ok, gate = mem_gate()
    print("memory gate: %s" % gate)
    if not ok:
        print("SKIP: memory gate failed, no work done")
        return 0
    try:
        with open(STATE_FILE) as fh:
            state = json.load(fh)
    except (OSError, ValueError):
        state = {}
    HN_KEY = read_hn_key()
    mod = load_jira()
    recs = hn_list()
    live, dupes = {}, []
    for r in recs:
        p, x = doc_of(r)
        if p is None:
            continue
        if p in live:
            dupes.append(p)
            if (r.get("updatedAt") or "") < live[p][2]:
                continue
        live[p] = (r.get("id"), x, r.get("updatedAt") or "")
    print("live records %d; duplicate paths: %s" % (len(recs), sorted(set(dupes)) or "none"))

    ops = []
    ops.extend(build_waiting(mod, live, state))
    ops.extend(build_workers(live))
    pr_ops = build_prs(live)
    ops.extend(pr_ops)
    # part (e) chains on the PR plan, so a day doc touched by both keeps both
    view = dict(live)
    for _m, _p, _rid, _d in pr_ops:
        view[_p] = (_rid, _d, "")
    prof = load_profile(mod)
    jops, drift = build_jira_schedule(mod, view, prof)
    ops.extend(jops)
    drift = list(DROPPED) + list(drift)
    print("drift lines this run: %d" % len(drift))
    routed = route_answers(live, state)

    over = []
    kept = []
    for m, p, rid, d in ops:
        n = len(json.dumps({"path": p, "doc": d}, ensure_ascii=False).encode("utf-8"))
        if n >= MAX_BYTES:
            over.append((p, n))
            continue
        kept.append((m, p, rid, d))
    ops = kept
    # per-doc gate (README "Safety"): the oversized doc aborts its own write and is
    # reported; it must not block every other doc. MMD-3289: a 16754-byte
    # questions/operator-mentions aborted the whole run on every mention.
    print("planned %d writes; over-16KB skipped: %s" % (len(ops), over or "none"))
    for m, p, rid, _ in ops:
        print("  %s %s%s" % (m, p, (" (%s)" % rid) if rid else ""))
    if DRY:
        print("DRY RUN: no writes, state not saved; %d drift line(s) not recorded" % len(drift))
        planned = {p: (parse_ts(u), x) for p, (_i, x, u) in live.items()}
        for _m, p, _rid, d in ops:
            planned[p] = (datetime.now(timezone.utc), d)
        print("assertions on the PLANNED view (live docs plus the planned writes):")
        return 1 if run_assertions(mod, prof, planned, True) else 0
    if drift:
        try:
            with open(DRIFT_FILE, "a") as fh:
                for line in drift:
                    fh.write(json.dumps(line, ensure_ascii=False, sort_keys=True) + "\n")
            print("drift appended to %s: %d line(s)" % (DRIFT_FILE, len(drift)))
        except OSError as e:
            print("drift write failed: %s" % e)
    with open(STATE_FILE, "w") as fh:
        json.dump(state, fh, indent=1, sort_keys=True)

    created = updated = deleted = 0
    errors = []
    written = {}
    deletes = []
    for m, p, rid, d in ops:
        if m == "DELETE":
            deletes.append((p, rid, d))
            continue
        if m == "PATCH":
            st, body = hn_call("PATCH", "%s/%s" % (HERE, rid), {"doc": d})
            okw = st == 200
            updated += okw
        else:
            st, body = hn_call("POST", HERE, {"path": p, "doc": d}, idem=str(uuid.uuid4()))
            okw = st in (200, 201)
            created += okw
        written[p] = bool(okw)
        if not okw:
            errors.append((p, m, st, scrub(str(body))[:200]))
    # MMD-3374: the archive write that precedes a delete must have landed, or the
    # worker doc would vanish from the store with no copy to fall back on.
    for p, rid, arch in deletes:
        if not written.get(arch):
            errors.append((p, "DELETE", "skipped", "archive %s not written" % arch))
            continue
        st, body = hn_call("DELETE", "%s/%s" % (HERE, rid))
        okw = st in (200, 204)
        deleted += okw
        if not okw:
            errors.append((p, "DELETE", st, scrub(str(body))[:200]))
    print("created %d, updated %d, deleted %d, errors %d"
          % (created, updated, deleted, len(errors)))
    for e in errors:
        print("ERROR", e)

    after = hn_list()
    seen = {}
    for r in after:
        p, x = doc_of(r)
        if p:
            seen.setdefault(p, []).append(x)
    missing, multi, unequal, still, unarchived = [], [], [], [], []
    marked = 0
    for m, p, rid, d in ops:
        if m == "DELETE":
            name = p.split("/", 1)[1]
            if seen.get(p):
                still.append(p)
            arch = [x for x in (seen.get(d) or []) if isinstance(x, dict)]
            if not any(name in ((x.get("workers") or {})) for x in arch):
                unarchived.append(p)
            continue
        marked += 1
        got = seen.get(p, [])
        if not got:
            missing.append(p)
        elif len(got) > 1:
            multi.append(p)
        elif norm(got[0]) != norm(d):
            unequal.append(p)
    print("read-back: wrote %d; deleted %d; missing %s; duplicated %s; unequal %s; "
          "still present %s; not in archive %s"
          % (marked, len(ops) - marked, missing or "none", multi or "none", unequal or "none",
             still or "none", unarchived or "none"))
    print("answers routed this run: %d" % routed)
    print("answers/*: %s" % (", ".join(sorted(p for p in seen if p.startswith("answers/"))) or "none"))
    okf = not (missing or multi or unequal or still or unarchived or errors)
    # MMD-3382: read-only assertions on what the run published; every write is done.
    published = {}
    for r in after:
        p, x = doc_of(r)
        if p and isinstance(x, dict) and (p not in published or (r.get("updatedAt") or "") >= published[p][2]):
            published[p] = (parse_ts(r.get("updatedAt")), x, r.get("updatedAt") or "")
    asserted_bad = run_assertions(mod, prof, {p: (w, x) for p, (w, x, _u) in published.items()}, False)
    print("RESULT", "OK" if okf and not asserted_bad else "FAILED")
    return 0 if okf and not asserted_bad else 1


if __name__ == "__main__":
    sys.exit(main())

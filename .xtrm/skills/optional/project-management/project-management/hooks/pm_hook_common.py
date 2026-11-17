"""Shared plumbing for the project-management session hooks (post_compact, action_gate, checkpoint_warn).

- Settings come from scripts/pm_config.py (env > config file > default). A config error never crashes a hook: the
  setting helpers below fall back to the default.
- The role comes from scripts/pm_role.py (role file `.pm-role`, else the launch role, else route_roles name patterns, else worker). Only
  the manager and the leads are acted on.
- Project scope: a hook acts only in a session of a configured project (see project_scope).
- Errors are appended to $XDG_STATE_HOME/xtrm-pm-hooks/errors.log (default ~/.local/state; PM_HOOK_STATE_DIR overrides); hooks fail open.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import sqlite3
import sys
from datetime import datetime, timezone

HOOKS = pathlib.Path(__file__).resolve().parent
SCRIPTS = HOOKS.parent / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
import pm_config  # noqa: E402
import pm_role  # noqa: E402

GATED_ROLES = ("manager", "lead")
REF_RE = re.compile(r"^[A-Z][A-Z0-9]*-[0-9]+$")
DEFAULT_REFREAD = [
    "project-management/references/manager.md",
    "project-management/references/lead.md",
    "project-management/references/launching.md",
]
DEFAULT_CLAIM_TTL_MS = 3600000


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def cache_dir() -> pathlib.Path:
    explicit = os.environ.get("PM_HOOK_STATE_DIR")
    if explicit:
        return pathlib.Path(explicit).expanduser()
    base = os.environ.get("XDG_STATE_HOME") or str(pathlib.Path.home() / ".local" / "state")
    return pathlib.Path(base) / "xtrm-pm-hooks"


def log_error(hook: str, where: str, exc) -> None:
    try:
        d = cache_dir()
        d.mkdir(parents=True, exist_ok=True)
        with open(d / "errors.log", "a", encoding="utf-8") as fh:
            fh.write("%s %s (%s) error: %r\n" % (utc_now(), hook, where, exc))
    except Exception:
        pass


def read_payload() -> dict:
    """The hook JSON on stdin; {} when there is none (run by hand on a terminal) or it is empty."""
    try:
        if sys.stdin is None or sys.stdin.isatty():
            return {}
        raw = sys.stdin.read()
    except (OSError, ValueError):
        return {}
    data = json.loads(raw) if raw.strip() else {}
    if not isinstance(data, dict):
        raise ValueError("hook payload is not a JSON object")
    return data


# ---------------------------------------------------------------- settings (never raise on a config error)
def setting(name: str, default=None):
    try:
        value = pm_config.get(name, None)
    except SystemExit:
        value = None
    return default if value in (None, "") else value


def setting_data(name: str, default=None):
    try:
        value = pm_config.get_data(name, None)
    except (SystemExit, ValueError):
        value = None
    return default if value is None else value


def setting_bool(name: str, default: bool = False) -> bool:
    value = setting(name, None)
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def setting_int(name: str, default: int) -> int:
    try:
        return int(setting(name, default))
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------- scope, role, identity
def project_scope(cwd: str) -> tuple[str, str]:
    """Is this session inside a configured project?

    ('ok', project or '')  the config selects a project for ``cwd`` (PM_PROJECT, or cwd inside a project's
                           repo_dir/match_dirs; a flat config without dirs applies everywhere). PM_PROJECT is set
                           for the rest of the process so pm_config resolves the same project.
    ('none', '')           no config, or cwd outside every project: the hook stays silent.
    ('error', message)     unreadable config, unknown PM_PROJECT, or cwd inside several projects.
    """
    try:
        raw = pm_config.raw_config()
    except SystemExit as exc:
        return "error", str(exc)
    if not raw:
        return "none", ""
    try:
        here = pathlib.Path(cwd or os.getcwd()).resolve()
    except OSError:
        here = pathlib.Path(cwd or "/")
    projects = raw.get("projects")
    explicit = os.environ.get("PM_PROJECT")
    if not projects:
        dirs = [d for d in [raw.get("repo_dir"), *(raw.get("match_dirs") or [])] if d]
        if explicit or not dirs:
            return "ok", ""
        return ("ok", "") if any(pm_config._under(here, d) >= 0 for d in dirs) else ("none", "")
    if explicit:
        if explicit in projects:
            return "ok", explicit
        return "error", "PM_PROJECT=%s is not in %s" % (explicit, pm_config.config_path())
    defaults = raw.get("defaults") or {}
    best, best_len, tied = None, -1, set()
    for name, prof in projects.items():
        merged = {**defaults, **(prof or {})}
        for d in [merged.get("repo_dir"), *(merged.get("match_dirs") or [])]:
            n = pm_config._under(here, d) if d else -1
            if n > best_len:
                best, best_len, tied = name, n, {name}
            elif n == best_len and n >= 0:
                tied.add(name)
    if len(tied) > 1:
        return "error", "the current directory belongs to several projects (%s); set PM_PROJECT" % ", ".join(sorted(tied))
    if best is None:
        return "none", ""
    os.environ["PM_PROJECT"] = best
    return "ok", best


def role() -> str:
    """This session's role: pm_role.current() (role file, else launch role, else name patterns, else worker)."""
    return pm_role.current()


def project_dir(cwd: str = "") -> str:
    return os.environ.get("CLAUDE_PROJECT_DIR") or cwd or os.getcwd()


def session_names(cwd: str = "") -> list[str]:
    """Names this session answers to: holder, session name, worktree directory name."""
    names = [os.environ.get("SUBSTRATE_HOLDER"), os.environ.get("XTRM_SESSION_NAME"),
             os.path.basename(project_dir(cwd).rstrip("/"))]
    return [n for n in names if n]


def holder() -> str:
    return os.environ.get("SUBSTRATE_HOLDER") or "<your holder>"


def claim_ttl_ms() -> int:
    ttl = setting_int("PM_CLAIM_TTL_MS", DEFAULT_CLAIM_TTL_MS)
    return ttl if ttl > 0 else DEFAULT_CLAIM_TTL_MS


def bound_ref(cwd: str = "") -> str | None:
    """The issue this worktree is bound to: SUBSTRATE_ISSUE_REF, else the first line of .substrate-issue in the
    current directory or the worktree root."""
    ref = (os.environ.get("SUBSTRATE_ISSUE_REF") or "").strip()
    if ref:
        return ref
    here = pathlib.Path(cwd or os.getcwd())
    candidates = [here / ".substrate-issue"]
    root = pm_role.worktree_root(here)
    if root is not None:
        candidates.append(root / ".substrate-issue")
    for f in candidates:
        try:
            line = f.read_text().splitlines()[0].strip()
        except (OSError, IndexError):
            continue
        if line:
            return line
    return None


def manager_ref() -> tuple[str | None, str]:
    """(ref, source) for an unbound manager: manager_issue (PM_MANAGER_ISSUE), else epic (PM_EPIC)."""
    for name, key in (("PM_MANAGER_ISSUE", "manager_issue"), ("PM_EPIC", "epic")):
        value = str(setting(name, "") or "").strip()
        if value and REF_RE.match(value):
            return value, "%s (%s)" % (key, name)
    return None, ""


# ---------------------------------------------------------------- goal and promises (XTRM-804)
# The store is large (MMD-2331 alone holds 3.5k entries, 2.7 MB of JSON) and a hook has a 2 s budget, so every read
# is filtered in SQL and only the rows a check needs are parsed.
GOAL_MARK_RE = re.compile(r"\bGOAL[ _-]?PROMPT\b", re.I)
# After the marker comes a stamp, not the goal: "GOAL PROMPT 2026-11-16T10:17:38Z ..." or "GOAL PROMPT (refreshed 07:46Z): ...".
GOAL_STAMP_RE = re.compile(r"^(?:\s*\([^)\n]{0,60}\))?\s*(?:\d{4}-\d{2}-\d{2}T[\d:.]+Z?|\d{1,2}:\d{2}(?::\d{2})?\s*(?:Z|UTC)?)?"
                           r"[\s:()\-\u2013.]*", re.I)
# A handoff carries the goal prompt: the marker in its summary, or a goal key.
GOAL_WHERE = ("kind='handoff' and (upper(semantic_json) like '%GOAL PROMPT%'"
              " or semantic_json like '%\"goal\":%' or semantic_json like '%\"goal_prompt\":%'"
              " or semantic_json like '%\"goalPrompt\":%')")


def state_db_path() -> pathlib.Path:
    """Substrate's store: $SUBSTRATE_DB, else ~/.xtrm/state.db (the same store ``sb`` reads)."""
    return pathlib.Path(os.path.expanduser(os.environ.get("SUBSTRATE_DB") or "~/.xtrm/state.db"))


def _db(timeout: float = 1.2) -> sqlite3.Connection:
    """Read-only handle on state.db. ``mode=ro``: a hook never creates, migrates or writes the live store."""
    path = state_db_path()
    if not path.is_file():
        raise FileNotFoundError(str(path))
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=timeout)


def _issue_id(con: sqlite3.Connection, ref: str) -> str | None:
    """The issues.id of a ref: a locator (MMD-2331) through its project prefix, else an alias, the locator history,
    else issues.id."""
    ref = str(ref or "").strip()
    if not ref:
        return None
    m = re.match(r"^([A-Z][A-Z0-9]*)-([0-9]+)$", ref)
    if m:
        row = con.execute("select i.id from issues i join projects p on p.id=i.project_id"
                          " where p.prefix=? and i.human_number=?", (m.group(1), int(m.group(2)))).fetchone()
        if row:
            return row[0]
    row = con.execute("select issue_id from issue_aliases where lower(alias)=lower(?)", (ref,)).fetchone()
    if row:
        return row[0]
    row = con.execute("select issue_id from issue_locator_history where upper(locator)=upper(?)"
                      " order by created_at desc limit 1", (ref,)).fetchone()
    if row:
        return row[0]
    row = con.execute("select id from issues where id=?", (ref,)).fetchone()
    return row[0] if row else None


def _rows(where: str, ref: str, extra: tuple = (), desc: bool = False, limit: int = 0) -> list[dict]:
    """Journal rows of the bound issue matching ``where``, oldest first: [{seq, kind, utc, semantic}].

    [] on any read error, so every caller fails open. ``created_at`` is epoch MILLISECONDS in state.db, so stamps are
    built from it, never compared as text.
    """
    if not ref or "<" in str(ref):
        return []
    try:
        con = _db()
    except (OSError, sqlite3.Error):
        return []
    try:
        issue_id = _issue_id(con, str(ref).split()[0])
        if not issue_id:
            return []
        sql = ("select sequence, kind, created_at, semantic_json from issue_journal"
               " where issue_id=? and " + where + " order by sequence" + (" desc" if desc else ""))
        if limit:
            sql += " limit %d" % int(limit)
        rows = con.execute(sql, (issue_id, *extra)).fetchall()
    except sqlite3.Error:
        return []
    finally:
        con.close()
    out = []
    for seq, kind, created_ms, sem in rows:
        try:
            stamp = datetime.fromtimestamp((created_ms or 0) / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
        except (OSError, ValueError, OverflowError):
            stamp = ""
        try:
            semantic = json.loads(sem) if sem else {}
        except ValueError:
            semantic = {}
        out.append({"seq": seq, "kind": kind, "utc": stamp, "at_ms": int(created_ms or 0),
                    "semantic": semantic if isinstance(semantic, dict) else {}})
    return out


def issue_known(ref: str | None) -> bool | None:
    """Does the bound issue exist in the store? None when the store itself is unreadable (fail open).

    Separate from the journal reads because an issue with no entries is readable and *missing* its goal, not unknown.
    """
    if not ref or "<" in str(ref):
        return None
    try:
        con = _db()
    except (OSError, sqlite3.Error):
        return None
    try:
        return _issue_id(con, str(ref).split()[0]) is not None
    except sqlite3.Error:
        return None
    finally:
        con.close()


def journal_rows(ref: str) -> list[dict]:
    """The whole journal of the bound issue, oldest first: [{seq, kind, utc, semantic}]. [] on any read error."""
    return _rows("1=1", str(ref or ""))


def goal_rows(ref: str, desc: bool = False, limit: int = 0) -> list[dict]:
    """The bound issue's handoffs that carry the goal prompt: [{seq, kind, utc, semantic}]."""
    return _rows(GOAL_WHERE, str(ref or ""), desc=desc, limit=limit)


def newest_decision(ref: str) -> int | None:
    """Seq of the issue's newest ``decision`` entry, or None when it has none (or the read fails)."""
    rows = _rows("kind='decision'", str(ref or ""), desc=True, limit=1)
    return rows[0]["seq"] if rows else None


def goal_body(row: dict) -> str:
    """The goal prompt text of one journal row: the ``goal`` value, else the summary after its GOAL PROMPT marker."""
    sem = row.get("semantic") or {}
    for key in ("goal", "goal_prompt", "goalPrompt"):
        value = sem.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    summary = str(sem.get("summary") or "")
    m = GOAL_MARK_RE.search(summary)
    if m:
        return GOAL_STAMP_RE.sub("", summary[m.end():], count=1).strip()
    return ""


def is_goal_row(row: dict) -> bool:
    """A handoff that carries the goal prompt: a GOAL PROMPT marker in its summary or a goal key."""
    if row.get("kind") != "handoff":
        return False
    sem = row.get("semantic") or {}
    if any(isinstance(sem.get(k), str) and sem[k].strip() for k in ("goal", "goal_prompt", "goalPrompt")):
        return True
    return bool(GOAL_MARK_RE.search(str(sem.get("summary") or "")))


def goal_check(ref: str | None) -> dict:
    """State of the bound issue's goal prompt against its journal (read-only, fail open).

    {"state": "satisfied" | "stale" | "missing" | "unknown", "goal_seq", "goal_utc", "newest_decision",
     "promises": [the open_promises entries of the newest GOAL PROMPT handoff]} — ``unknown`` when the store or the
    issue is unreadable, which the hooks report as unverified instead of blocking. A goal prompt is satisfied when the
    newest GOAL PROMPT handoff is NEWER than the newest ``decision`` entry: the goal must be refreshed while the
    context that produced the decisions is still present, not after the compaction.
    """
    result = {"state": "unknown", "goal_seq": None, "goal_utc": "", "newest_decision": None, "promises": []}
    known = issue_known(ref)
    if not known:
        return result                                            # unreadable store or unknown issue: 'unknown'
    result["newest_decision"] = newest_decision(str(ref))
    goals = goal_rows(str(ref), desc=True, limit=1)
    if not goals:
        result["state"] = "missing"
        return result
    newest = goals[0]
    result["goal_seq"], result["goal_utc"] = newest["seq"], newest["utc"]
    dseq = result["newest_decision"]
    result["state"] = "satisfied" if dseq is None or newest["seq"] > dseq else "stale"
    promises = (newest.get("semantic") or {}).get("open_promises")
    if isinstance(promises, list):
        result["promises"] = promises
    return result


def goal_check_line(ref: str | None, check: dict | None = None) -> str:
    """One line stating whether the goal part is satisfied now, with the seqs it was decided from."""
    check = check if check is not None else goal_check(ref)
    state, dseq = check["state"], check["newest_decision"]
    d = "none" if dseq is None else "seq %s" % dseq
    if state == "satisfied":
        return "GOAL: satisfied now — GOAL PROMPT handoff seq %s (%s) is newer than the newest decision (%s)." % (
            check["goal_seq"], check["goal_utc"] or "time unknown", d)
    if state == "stale":
        return ("GOAL: NOT satisfied — the newest GOAL PROMPT handoff is seq %s (%s) but the newest decision is seq %s: "
                "rewrite the goal prompt in the checkpoint handoff below." % (
                    check["goal_seq"], check["goal_utc"] or "time unknown", dseq))
    if state == "missing":
        return ("GOAL: NOT satisfied — no GOAL PROMPT handoff on this issue; the newest decision is %s. Store the goal "
                "prompt as the checkpoint handoff (key 'goal', <=4000 chars incl. '/goal ')." % d)
    return "GOAL: unverified — state.db or the bound issue is unreadable right now; run the check by hand."


def promises_line(check: dict) -> str:
    """The open promises the newest GOAL PROMPT handoff carries, or a reminder that the list must be there."""
    items = [p for p in (check.get("promises") or []) if isinstance(p, dict)]
    if not items:
        return ("OPEN PROMISES: none recorded in the goal handoff. The handoff MUST carry "
                "open_promises[{promise,due_utc,timer_id}] (empty list = none): every promise made to the operator "
                "in chat belongs there with its timer.")
    parts = ["%s (due %s, timer %s)" % (str(p.get("promise") or "?")[:120], p.get("due_utc") or "?",
                                        p.get("timer_id") or "none") for p in items]
    return "OPEN PROMISES carried: " + "; ".join(parts)


def goal_reload(ref: str | None, cwd: str = "") -> list[dict]:
    """What to re-inject after a compaction: [{"source", "seq", "utc", "text"}], newest goal prompt first.

    Order: the newest GOAL PROMPT handoff of the bound issue (the goal is refreshed BEFORE the compaction, so the
    newest one is current), then .goal-file in the session directory. [] when neither exists or the read fails.
    """
    out: list[dict] = []
    if ref and "<" not in str(ref):
        for r in goal_rows(str(ref), desc=True, limit=1):
            body = goal_body(r)
            if body:
                out.append({"source": "journal handoff seq %s" % r["seq"], "seq": r["seq"], "utc": r["utc"],
                            "at_ms": r.get("at_ms") or 0, "text": body})
    gf = goal_file(cwd)
    if gf:
        try:
            text = pathlib.Path(gf).read_text().strip()
            mtime_ms = int(pathlib.Path(gf).stat().st_mtime * 1000)
        except OSError:
            text, mtime_ms = "", 0
        if text:
            out.append({"source": "goal file %s" % gf, "seq": None, "utc": _stamp(mtime_ms), "at_ms": mtime_ms,
                        "text": text})
    out.sort(key=lambda g: g.get("at_ms") or 0, reverse=True)   # the newer of journal and file wins
    return out


PROMISE_FIELDS = ("due_utc", "timer_id", "promise", "summary")
# A `summary` match is weak: many unrelated entries mention a window time. It counts only when the summary is itself
# promise-shaped ("promise: ask about E1 due 18:00Z"), which is exactly the form the reminder asks for.
PROMISE_SUMMARY_RE = re.compile(r"\bpromise\b", re.I)


def promise_records(ref: str | None, since_ms: int | None) -> list[dict] | None:
    """The promise-shaped journal entries newer than ``since_ms``: [{"at_ms", "fields": {field: lower text}}].

    ONE read for a whole Stop: matching keys in memory beats one SQL scan per promise (40 unresolved promises cost
    1.3 s CPU and 9.6 s wall on a loaded host, against a 2 s hook budget). ``None`` when the store or the issue cannot
    be read, so a caller never reports "no journal entry" from an unreadable store.
    """
    if not ref or "<" in str(ref) or not since_ms:
        return None
    ref = str(ref).split()[0]
    if not issue_known(ref):
        return None
    where = "(" + " or ".join("lower(semantic_json) like ?" for _ in PROMISE_FIELDS) + ") and created_at > ?"
    extra: tuple = tuple('%%"%s"%%' % f for f in PROMISE_FIELDS) + (int(since_ms),)
    out = []
    for row in _rows(where, ref, extra):
        sem = row.get("semantic") or {}
        fields = {}
        for field in PROMISE_FIELDS:
            value = sem.get(field)
            if isinstance(value, str):
                if field == "summary" and not PROMISE_SUMMARY_RE.search(value):
                    continue                   # a plain summary that happens to name the time keeps nothing
                fields[field] = value.lower()
        if fields:
            out.append({"at_ms": row.get("at_ms") or 0, "fields": fields})
    return out


def promise_durable(ref: str | None, key: str, at_ms: int | None = None,
                    records: list[dict] | None = None) -> bool | None:
    """Is a promise's key time recorded on the bound issue by a LATER promise-shaped journal entry?

    True/False when the store could be read, None when it could not (or the issue is unknown, or the promise has no
    timestamp): a caller must never report "no journal entry" from an unreadable store. Only entries NEWER than
    ``at_ms`` (the promise's own transcript timestamp) count — an old entry that happens to mention a window time does
    not keep a new promise — and only the promise-shaped fields (due_utc, timer_id, promise, a summary that says
    "promise") are searched, never the whole entry text. ``records`` takes a read from ``promise_records`` so a caller
    with several promises pays for one read.
    """
    key = str(key or "").strip().lower()
    if not key or not ref or "<" in str(ref) or not at_ms:
        return None                       # no promise timestamp: "later" is unknowable, so the check is unverified
    if records is None:
        records = promise_records(ref, int(at_ms))
        if records is None:
            return None
    for record in records:
        if (record.get("at_ms") or 0) <= int(at_ms):
            continue
        for value in (record.get("fields") or {}).values():
            if key in value:
                return True
    return False


def _stamp(ms: int) -> str:
    try:
        return datetime.fromtimestamp(int(ms or 0) / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    except (OSError, ValueError, OverflowError):
        return ""


def goal_file(cwd: str = "") -> str:
    """Path in .goal-file (one line, ``~`` expanded), else ""."""
    try:
        line = (pathlib.Path(cwd or os.getcwd()) / ".goal-file").read_text().splitlines()[0].strip()
    except (OSError, IndexError):
        return ""
    return os.path.expanduser(line) if line else ""


def refread_files(for_role: str) -> list[str]:
    """Reference files a role must Read in full: setting refread_files ({role: [paths]} or one list for every role).
    Relative paths resolve against the pack root (pm_config.PACK_ROOT)."""
    conf = setting_data("PM_REFREAD_FILES", None)
    if isinstance(conf, dict):
        paths = conf.get(for_role, DEFAULT_REFREAD)
    elif isinstance(conf, list):
        paths = conf
    else:
        paths = DEFAULT_REFREAD
    if isinstance(paths, str):
        paths = [paths]
    out = []
    for p in paths or []:
        q = pathlib.Path(os.path.expanduser(str(p)))
        out.append(str(q if q.is_absolute() else pm_config.PACK_ROOT / q))
    return out

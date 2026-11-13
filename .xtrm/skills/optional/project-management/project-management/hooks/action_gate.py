#!/usr/bin/env python3
"""Action gate for project-management manager and lead sessions: references read, pending messages seen.

  --event start  SessionStart(startup|compact): arm the reference gate (write the pending list) and print one line.
  --event post   PostToolUse(Read): a Read that covers a whole pending file clears it.
  --event pre    PreToolUse(Bash|Agent|*specialist_dispatch): before a GATED action, two checks:
                 a) reference gate: every file in setting refread_files for this role must have been Read in full
                    this session. Arms lazily when no state exists yet (a role file written after SessionStart
                    still arms it). Emergency override: touch the session `.override` file named in the deny.
                 b) pending-message guard: items pending for THIS session and younger than pending_max_age_s
                    (undelivered rows of the board lane's pending-routes.jsonl addressed to it, and its open
                    operator questions) deny the action ONCE with the list; a retry with the same items or a subset
                    passes. The deny is the delivery: it puts the items in context at commit time.

GATED: a Bash command matching a regex in gated_commands, or a tool name matching an fnmatch pattern in gated_tools.
Only role manager or lead (scripts/pm_role.py), only in a configured project. A listed reference file that does not
exist never gates (warning at start, systemMessage at pre). Any internal error fails open (exit 0) and is appended to
the hook state dir (pm_hook_common.cache_dir).log.
"""
from __future__ import annotations

import fnmatch
import hashlib
import importlib.util
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pm_hook_common as common  # noqa: E402

HOOK = "action_gate"
DEFAULT_GATED_COMMANDS = [r"\bgh\s+pr\s+merge\b", r"\bxt\s+(claude|pi)\b", r"\bsb\s+issue\s+attest\b"]
DEFAULT_GATED_TOOLS = ["Agent", "*specialist_dispatch"]
DEFAULT_MAX_AGE_S = 3600
ROUTES_TAIL_BYTES = 1 << 20
MAX_LISTED = 10
DENY_REASON = (
    "Reference gate (project-management): Read these files in full first: {paths}. "
    "Emergency in a live window only: touch {override} and journal why."
)


def state_dir():
    return common.cache_dir() / "gate"


def safe_session_id(raw) -> str:
    sid = re.sub(r"[^A-Za-z0-9._-]", "_", str(raw or ""))
    if not sid or sid in (".", ".."):
        raise ValueError("missing usable session_id in hook payload")
    return sid


def state_paths(sid: str):
    d = state_dir()
    return d / (sid + ".json"), d / (sid + ".override"), d / (sid + ".guard.json")


def read_state(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return None
    if not isinstance(data, dict):
        raise ValueError("state file is not a JSON object: %s" % path)
    return {"pending": [str(p) for p in (data.get("pending") or [])], "since": data.get("since")}


def write_json(path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp%d" % os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def split_missing(paths):
    return [p for p in paths if os.path.isfile(p)], [p for p in paths if not os.path.isfile(p)]


def as_int(value):
    if value is None or value == "":
        return None
    return int(value)


def line_count(path) -> int:
    with open(path, "rb") as fh:
        data = fh.read()
    if not data:
        return 0
    return data.count(b"\n") + (0 if data.endswith(b"\n") else 1)


def covers_whole_file(tool_input, path) -> bool:
    """No offset (or offset <= 1) and no limit (or a limit at least the file's line count)."""
    offset, limit = as_int(tool_input.get("offset")), as_int(tool_input.get("limit"))
    if offset is not None and offset > 1:
        return False
    if limit is not None and limit < line_count(path):
        return False
    return True


def arm(sid: str, role: str, announce: bool, out) -> dict:
    present, missing = split_missing(common.refread_files(role))
    state = {"pending": present, "since": common.utc_now()}
    write_json(state_paths(sid)[0], state)
    if missing:
        common.log_error(HOOK, "arm", "listed reference file missing, not gated: " + ", ".join(missing))
        if announce:
            out.write("REFERENCE GATE WARNING: listed file(s) missing, not gated (fix refread_files or the pack): "
                      + ", ".join(missing) + "\n")
    if present and announce:
        out.write("REFERENCE GATE: read in full before any merge, launch or dispatch: "
                  + ", ".join(os.path.basename(p) for p in present) + "\n")
    return state


# ---------------------------------------------------------------- gating
def is_gated(payload: dict) -> bool:
    tool = str(payload.get("tool_name") or "")
    if tool == "Bash":
        command = str((payload.get("tool_input") or {}).get("command") or "")
        for pat in common.setting_data("PM_GATED_COMMANDS", DEFAULT_GATED_COMMANDS) or []:
            try:
                if re.search(str(pat), command):
                    return True
            except re.error as exc:
                common.log_error(HOOK, "gated_commands", "bad regex %r: %s" % (pat, exc))
        return False
    return any(fnmatch.fnmatchcase(tool, str(p)) for p in common.setting_data("PM_GATED_TOOLS", DEFAULT_GATED_TOOLS) or [])


def deny(out, reason: str) -> None:
    out.write(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                                 "permissionDecisionReason": reason}}) + "\n")


# ---------------------------------------------------------------- pending items
def parse_ts(value) -> float | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return float(value) / (1000.0 if value > 1e11 else 1.0)
    try:
        t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return t.timestamp()


def item_id(prefix: str, *parts) -> str:
    raw = "|".join(str(p) for p in parts if p not in (None, ""))
    return "%s:%s" % (prefix, hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12])


def addressed_to(target: str, names: list[str]) -> bool:
    t = str(target).strip()
    return any(t == n or n.endswith("-" + t) or t.endswith("-" + n) for n in names)


def route_items(role: str, cwd: str, now: float, max_age: int) -> list[dict]:
    """Undelivered rows of $PM_LANE_DIR/pending-routes.jsonl for this session.

    The lane writers (route-watch.py, route-jira.py) store no target in a row: the board helper forwards to the
    live manager by default (route-forward.py; --to picks a lead at send time). So a row without a `to`/`target`
    field counts for the manager only; a row that names one counts for the session of that name. Age: `seen_at`
    (when the lane recorded it), else `at` (when the operator wrote it)."""
    lane = common.setting("PM_LANE_DIR", None)
    if not lane:
        return []
    path = os.path.join(os.path.expanduser(str(lane)), "pending-routes.jsonl")
    if not os.path.isfile(path):
        return []
    with open(path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        size = fh.tell()
        fh.seek(max(0, size - ROUTES_TAIL_BYTES))
        lines = fh.read().decode("utf-8", "replace").splitlines()
    names = common.session_names(cwd)
    out = []
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict) or row.get("delivered"):
            continue
        target = row.get("to") or row.get("target")
        if target:
            if not addressed_to(target, names):
                continue
        elif role != "manager":
            continue
        ts = parse_ts(row.get("seen_at")) or parse_ts(row.get("at"))
        if ts is None or now - ts > max_age:
            continue
        text = re.sub(r"\s+", " ", str(row.get("text") or "")).strip()[:300]
        out.append({"id": "route:%s" % (row.get("id") or row.get("cid") or item_id("t", text)),
                    "text": "routed operator message %s (%s, %s, at %s): %s"
                            % (row.get("id") or row.get("cid") or "?", row.get("key") or "-", row.get("author") or "-",
                               row.get("at") or "?", text)})
    return out


_OQ = None


def oq_module():
    """hooks/operator-questions.py, for its blocker scan and question refs."""
    global _OQ
    if _OQ is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "operator-questions.py")
        spec = importlib.util.spec_from_file_location("pm_operator_questions", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _OQ = mod
    return _OQ


def scan_blockers(refs: list[str]) -> list[dict]:
    """Open for=operator blockers on refs (operator-questions.blocker_questions), with their creation time."""
    import pm_question
    times = {}

    def journal(ref, kind):
        entries = pm_question.journal_entries(ref, kind)
        if kind == "blocker":
            for e in entries:
                sem = e.get("semantic") or {}
                if isinstance(sem, dict):
                    qid = str(sem.get("qid") or pm_question.qid_of(str(e.get("id") or "")))
                    times[(ref, qid)] = parse_ts(e.get("createdAt"))
        return entries

    return [{**q, "at": times.get((q["ref"], q["qid"]))} for q in oq_module().blocker_questions(refs, journal)]


def question_items(role: str, cwd: str, now: float, max_age: int) -> list[dict]:
    """Open operator questions owned by this session (read-only, cached pm_question.DOC_TTL seconds):
    rows of its Status board doc questions/<owner> (when a Status board site is configured), and open for=operator
    journal blockers on its bound issue (plus operator_question_refs, default the epic, for the manager)."""
    import pm_question
    names = common.session_names(cwd)
    owner = pm_question.owner_of(names[0] if names else "", role)
    found: dict[str, dict] = {}
    if common.setting("PM_STATUS_BOARD_SITE", None):
        got = pm_question.read_rows(owner, now=now)
        for row in (got[0] if got else []):
            if isinstance(row, dict) and row.get("id"):
                found[str(row["id"])] = {"qid": str(row["id"]), "q": str(row.get("q") or ""),
                                         "ref": str(row.get("ref") or ""), "at": pm_question.parse_ts(row.get("at"))}
    refs = []
    bound = common.bound_ref(cwd)
    if bound:
        refs.append(bound)
    if role == "manager":
        refs += [r for r in oq_module().question_refs() if r not in refs]
    if refs:
        cache = pm_question.gate_questions_file(owner)
        items = None
        try:
            c = json.loads(cache.read_text())
            if now - float(c["at"]) < pm_question.DOC_TTL and c.get("refs") == refs:
                items = c.get("items") or []
        except (OSError, ValueError, KeyError, TypeError):
            pass
        if items is None:
            try:
                items = scan_blockers(refs)
            except Exception as exc:  # sb missing or slow: the doc rows still count
                common.log_error(HOOK, "blockers", exc)
                items = []
            try:
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_text(json.dumps({"at": now, "refs": refs, "items": items}))
            except OSError:
                pass
        for q in items:
            found.setdefault(q["qid"], q)
    out = []
    for q in found.values():
        ts = q.get("at")
        if ts is None or now - float(ts) > max_age:
            continue
        out.append({"id": "question:%s" % q["qid"],
                    "text": "open operator question %s on %s: %s" % (q["qid"], q.get("ref") or "-", q.get("q") or "")})
    return out


def pending_items(role: str, cwd: str, now: float) -> list[dict]:
    max_age = common.setting_int("PM_PENDING_MAX_AGE_S", DEFAULT_MAX_AGE_S)
    items = []
    for name, source in (("routes", route_items), ("questions", question_items)):
        try:
            items += source(role, cwd, now, max_age)
        except Exception as exc:  # one broken source never blocks the other, nor the action
            common.log_error(HOOK, name, exc)
    return items


def pending_guard(sid: str, role: str, cwd: str, out, now: float) -> bool:
    """Deny once per new set of pending items. True when it denied."""
    items = pending_items(role, cwd, now)
    if not items:
        return False
    gpath = state_paths(sid)[2]
    try:
        seen = set(json.loads(gpath.read_text()).get("delivered") or [])
    except (OSError, ValueError, AttributeError):
        seen = set()
    current = {i["id"] for i in items}
    if current <= seen:
        return False
    write_json(gpath, {"delivered": sorted(seen | current)[-500:], "at": common.utc_now()})
    lines = ["Pending-message guard (project-management): %d item(s) for this session are not handled yet. Read them "
             "and act on them first; retrying this action passes (this deny is the delivery):" % len(items)]
    for n, i in enumerate(items[:MAX_LISTED], 1):
        lines.append("%d. %s%s" % (n, "" if i["id"] in seen else "[new] ", i["text"]))
    if len(items) > MAX_LISTED:
        lines.append("(+%d more)" % (len(items) - MAX_LISTED))
    deny(out, "\n".join(lines))
    return True


# ---------------------------------------------------------------- events
def event_post(payload: dict, sid: str, cwd: str) -> None:
    spath = state_paths(sid)[0]
    state = read_state(spath)
    if not state or not state["pending"]:
        return
    tool_input = payload.get("tool_input") or {}
    raw = tool_input.get("file_path") or ""
    if not raw:
        return
    target = os.path.realpath(raw if os.path.isabs(raw) else os.path.join(cwd, raw))
    pending = [p for p in state["pending"] if os.path.realpath(p) != target]
    if len(pending) == len(state["pending"]) or not covers_whole_file(tool_input, target):
        return
    state["pending"] = pending
    write_json(spath, state)


def event_pre(payload: dict, sid: str, role: str, cwd: str, out) -> None:
    if not is_gated(payload):
        return
    spath, override, _guard = state_paths(sid)
    state = read_state(spath)
    if state is None:  # lazy arming: no SessionStart for this role (role file written later, hook added mid-session)
        state = arm(sid, role, announce=False, out=out)
    if state["pending"] and not override.exists():
        present, missing = split_missing(state["pending"])
        if missing:
            common.log_error(HOOK, "pre", "listed reference file missing, not gated: " + ", ".join(missing))
            state["pending"] = present
            write_json(spath, state)
            if not present:
                out.write(json.dumps({"systemMessage": "Reference gate: listed file(s) missing, gate open: "
                                      + ", ".join(missing)}) + "\n")
        if present:
            deny(out, DENY_REASON.format(paths=", ".join(present), override=override))
            return
    pending_guard(sid, role, cwd, out, time.time())


def parse_event(argv: list[str]) -> str:
    event, i = "", 0
    while i < len(argv):
        if argv[i] == "--event" and i + 1 < len(argv):
            event, i = argv[i + 1], i + 2
            continue
        if argv[i].startswith("--event="):
            event = argv[i].split("=", 1)[1]
        i += 1
    return event


def run(argv: list[str], out=None) -> None:
    out = out or sys.stdout
    event = parse_event(argv)
    if event not in ("start", "pre", "post"):
        return
    payload = common.read_payload()
    cwd = str(payload.get("cwd") or os.getcwd())
    scope, why = common.project_scope(cwd)
    if scope == "none":
        return
    role = common.role()
    if role not in common.GATED_ROLES:
        return
    sid = safe_session_id(payload.get("session_id"))
    if event == "start":
        if scope == "error":
            out.write("PM HOOK WARNING: project config not resolved (%s); the gate uses its defaults.\n" % why.strip())
        arm(sid, role, announce=True, out=out)
    elif event == "pre":
        event_pre(payload, sid, role, cwd, out)
    else:
        event_post(payload, sid, cwd)


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    try:
        run(argv)
    except BaseException as exc:  # fail open: never block a session on a hook bug
        common.log_error(HOOK, " ".join(argv), exc)
    return 0


if __name__ == "__main__":
    sys.exit(main())

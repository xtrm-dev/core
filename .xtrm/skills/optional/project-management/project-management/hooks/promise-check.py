#!/usr/bin/env python3
"""Stop hook: a promise to the operator with a time or event word must have a timer or a journal entry (XTRM-804).

    python3 promise-check.py --event stop    (hook JSON on stdin)
    python3 promise-check.py --event prompt  (optional UserPromptSubmit wiring: an operator turn restarts the counter)

A manager or lead says "I will ask you after the 18:00Z acceptance", the window passes, the session compacts, and the
promise exists only in a context that no longer exists (MMD-2331 seq 3525; operator 2026-11-16). Rule: a promise with a
time or an event word is durable in the SAME turn it is made — a ``CronCreate`` that fires it, or a journal entry on the
bound issue naming its key time. This hook enforces it:

  Stop   one silent turn. Detect the promises in the recent assistant text. When ``promise_check_turns`` turns have
         passed and a promise has no LATER CronCreate in the transcript and no journal entry on the bound issue
         naming its key time, emit ONE reminder (``decision=block`` reason, the only Stop output the model sees)
         naming every missing promise, its key time, and the two durable forms. Once per promise, never repeated.
         ``stop_hook_active`` true emits nothing (no loop), and ``promise_check_turns`` 0 disables the hook.

Only the manager and the leads are gated (scripts/pm_role.py: role file, else launch role, else name patterns, else
worker), and only in a session of a configured project. The issue is the session's BOUND issue (SUBSTRATE_ISSUE_REF,
else .substrate-issue, pm_hook_common.bound_ref), never a hardcoded ref: a lead gets its workstream epic.

Both reads are local and read-only: the transcript tail (bounded: the last TRANSCRIPT_WINDOW bytes) and one
ONE ``mode=ro`` state.db read per Stop (pm_hook_common.promise_records). Every internal error fails open (exit
0, no output) and is appended to the hook state dir's errors.log. Settings come from pm_config: ``promise_check_turns``
(PM_PROMISE_CHECK_TURNS, default 15, 0 = off).
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import sys
import time
from datetime import datetime, timezone

HOOKS = pathlib.Path(__file__).resolve().parent
SCRIPTS = HOOKS.parent / "scripts"
sys.path.insert(0, str(HOOKS))
sys.path.insert(0, str(SCRIPTS))
import pm_config  # noqa: E402
import pm_hook_common as common  # noqa: E402

HOOK = "promise-check"
DEFAULT_TURNS = 15  # operator 2026-11-19: every reminder costs a full extra turn; 3 fired on background wakes alone
MAX_REPORTED = 3
PROMISE_KEEP = 40                    # only the newest promises are tracked: older ones are kept or lost already
P_CAP = 200
TRANSCRIPT_WINDOW = 8 * 1024 * 1024  # the tail scanned for promises and CronCreate calls (a later cron is inside it too)
COORDINATOR_ROLES = ("manager", "lead")

# A first-person commitment (English or Italian).
PROMISE_RE = re.compile(
    r"\b(?:I(?:'ll| will| am going to| shall|'m going to)|we(?:'ll| will| shall))\b"
    r"|\b(?:ti|vi)\s+(?:chiedo|dico|avviso|confermo|scrivo|aggiorno|faccio sapere)\b"
    r"|\bti aggiorno\b|\bvi aggiorno\b", re.I)
# ... plus a time or an event word: the promise is bound to a moment, so it can be missed.
TIME_WORD_RE = re.compile(
    r"\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:Z|UTC)\b"
    r"|\b(?:by|at|after|before|entro|dopo|alle|verso)\s+(?:the\s+)?\d{1,2}(?::\d{2})?\b"
    r"|\bafter\s+(?:the\s+)?[\w:.'-]+|\bbefore\s+(?:the\s+)?[\w:.'-]+"
    r"|\bwhen\s+\w+|\bonce\s+\w+|\bas soon as\b"
    r"|\btonight\b|\btomorrow\b|\bnext\s+\w+|\bthis\s+(?:evening|afternoon|morning)\b"
    r"|\bdopo\s+(?:le?\s+)?[\w:.'-]+|\bquando\s+\w+", re.I)
CLOCK_RE = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:Z|UTC)\b", re.I)
SENT_SPLIT_RE = re.compile(r"(?<=[.!?;])\s+|\n+")
CRON_TOOLS = ("CronCreate", "cron_create")


def state_root() -> pathlib.Path:
    try:
        return pm_config.state_dir() / "promise-check"
    except SystemExit:
        return common.cache_dir() / "promise-check"


def safe_sid(raw) -> str:
    sid = re.sub(r"[^A-Za-z0-9._-]", "_", str(raw or ""))
    if not sid or sid in (".", ".."):
        raise ValueError("no usable session_id")
    return sid


def qid_of(text: str) -> str:
    norm = re.sub(r"[^\w]+", " ", str(text).lower()).strip()
    return "p-" + hashlib.sha1(norm.encode("utf-8")).hexdigest()[:8]


def load_state(sid: str) -> dict:
    try:
        st = json.loads((state_root() / ("%s.json" % sid)).read_text())
        if isinstance(st, dict):
            return st
    except (OSError, ValueError):
        pass
    return {}


def save_state(sid: str, st: dict) -> None:
    p = state_root() / ("%s.json" % sid)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp%d" % os.getpid())
    tmp.write_text(json.dumps(st, ensure_ascii=False))
    os.replace(tmp, p)


# ---------------------------------------------------------------- transcript
def _assistant_text(obj: dict) -> str:
    content = (obj.get("message") or {}).get("content")
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text")


def _tool_names(obj: dict) -> list[str]:
    content = (obj.get("message") or {}).get("content")
    if not isinstance(content, list):
        return []
    return [str(b.get("name") or "") for b in content if isinstance(b, dict) and b.get("type") == "tool_use"]


def line_ms(obj: dict) -> int | None:
    """The transcript line's own timestamp in epoch ms ("created_at" is ms in state.db, so comparisons match)."""
    raw = obj.get("timestamp") or obj.get("created_at")
    if isinstance(raw, (int, float)) and raw > 0:
        return int(raw if raw > 10 ** 11 else raw * 1000)
    if isinstance(raw, str) and raw:
        try:
            return int(datetime.strptime(raw.replace("Z", "+0000"), "%Y-%m-%dT%H:%M:%S.%f%z").timestamp() * 1000)
        except ValueError:
            try:
                return int(datetime.strptime(raw[:19] + "Z", "%Y-%m-%dT%H:%M:%SZ").replace(
                    tzinfo=timezone.utc).timestamp() * 1000)
            except ValueError:
                return None
    return None


def scan_transcript(path: str) -> tuple[list[dict], list[int]]:
    """(promises, CronCreate line numbers) from the transcript tail, the newest PROMISE_KEEP promises.

    One streaming pass over the last TRANSCRIPT_WINDOW bytes: a promise is an assistant text mentioning a commitment and
    a time/event word; its key is the clock time it names, else the event phrase. Chronology is the line number, so a
    CronCreate on a later line satisfies a promise on an earlier one.
    """
    promises: list[dict] = []
    crons: list[int] = []
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            if size > TRANSCRIPT_WINDOW:
                fh.seek(size - TRANSCRIPT_WINDOW)
                fh.readline()  # drop the partial first line
            for n, raw in enumerate(fh):
                if b'"assistant"' not in raw:
                    continue  # only assistant entries carry a promise or a CronCreate tool call
                try:
                    obj = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(obj, dict):
                    continue
                for name in _tool_names(obj):
                    if name in CRON_TOOLS:
                        crons.append(n)
                if obj.get("type") != "assistant":
                    continue
                text = _assistant_text(obj)
                if text:
                    at_ms = line_ms(obj)
                    promises += [{"line": n, "at_ms": at_ms, **p} for p in extract_promises(text)]
    except OSError:
        return [], []
    if len(promises) > PROMISE_KEEP:
        promises = sorted(promises, key=lambda p: p["line"])[-PROMISE_KEEP:]
    return promises, crons


def promise_key(sentence: str, m: "re.Match") -> str:
    """The moment a promise is bound to: the clock time it names, else the event phrase with up to four words after it.

    A two-word fragment ("when the") would match almost any journal entry, so the phrase is widened to the event it
    names ("when the E1 options flip") and quoted as a unit in the reminder.
    """
    clock = CLOCK_RE.search(sentence)
    if clock:
        return clock.group(0).strip()
    tail = re.findall(r"[\w:.'\u2019-]+", sentence[m.end():])[:4]
    return " ".join([m.group(0).strip(), *tail]).strip().rstrip(".,;:)'\"")


def extract_promises(text: str) -> list[dict]:
    """[{text, key}] — one per sentence that carries a commitment AND a time/event word."""
    out = []
    for chunk in SENT_SPLIT_RE.split(re.sub(r"```.*?```", " ", text, flags=re.S)):
        s = re.sub(r"\s+", " ", chunk).strip(" >*#-\t")
        if len(s) < 12 or not PROMISE_RE.search(s):
            continue
        m = TIME_WORD_RE.search(s)
        if not m:
            continue
        key = promise_key(s, m)
        out.append({"text": s[:P_CAP], "key": key, "qid": qid_of(s)})
    return out


# ---------------------------------------------------------------- journal side
def bound_issue(cwd: str) -> str | None:
    """The session's issue: .substrate-issue / SUBSTRATE_ISSUE_REF, else the config's manager_issue / epic for a
    manager (the same fallback checkpoint_warn.handoff_ref uses; a lead binds its own epic)."""
    ref = common.bound_ref(cwd)
    if ref:
        return ref
    if common.role() == "manager":
        ref, _source = common.manager_ref()
        return ref
    return None


def unresolved(promises: list[dict], crons: list[int], ref: str | None,
               records: list[dict] | None = None) -> list[dict]:
    """Promises with no later CronCreate and no later journal entry naming their key time.

    Durability on the journal side is tri-state: a promise is kept only by an entry NEWER than its own transcript
    timestamp that carries its key in a promise field (due_utc/timer_id/promise/summary). ``None`` means the store could
    not be read — the promise is then flagged on its MISSING TIMER alone and the reminder says the journal was not
    checked, never that it has no entry.
    """
    store_ok = True
    if records is None and ref and "<" not in str(ref):
        stamps = [p.get("at_ms") or 0 for p in promises]
        records = common.promise_records(ref, min(stamps) if stamps and min(stamps) > 0 else 1)
        store_ok = records is not None       # ONE read for the whole Stop; a failed read is reported, not retried per promise
        records = records or []
    out, seen = [], set()
    for p in promises:
        qid = p.get("qid") or qid_of(p["text"])
        if qid in seen:
            continue
        seen.add(qid)
        if any(c > p["line"] for c in crons):
            continue
        durable = common.promise_durable(ref, p["key"], p.get("at_ms"), records) if store_ok else None
        if durable:
            continue
        if durable is False:
            reason = "missing"
        elif not p.get("at_ms"):
            reason = "no_timestamp"
        elif not ref or "<" in str(ref):
            reason = "no_issue"                # nothing was looked up, so the store is not to blame
        else:
            reason = "unreadable"
        out.append({**p, "qid": qid, "journal": reason})
    return out


def reminder(items: list[dict], turns: int, ref: str | None) -> str:
    lines = ["[promise-check] %d turn(s) ago you promised the operator something bound to a moment, and it has no timer and "
             "no journal entry on %s:" % (turns, ref or "the bound issue")]
    causes = {None: "no later journal entry on it", "missing": "no later journal entry on it",
              "no_issue": "no journal was checked (no bound issue: .substrate-issue or SUBSTRATE_ISSUE_REF)",
              "no_timestamp": "the journal could not be checked (this transcript line carries no timestamp)",
              "unreadable": "the journal could not be checked (state.db unreadable)"}
    for n, p in enumerate(items, 1):
        journal = causes.get(p.get("journal"), causes["unreadable"])
        lines.append('%d. "%s"\n   key: %s — no later CronCreate in this transcript, %s'
                     % (n, p["text"], p["key"], journal))
    lines.append("A promise in chat is lost at compaction. In this turn, for EACH one: CronCreate a timer that fires it "
                 "(or confirm the existing timer's id), AND sb journal append %s --kind decision --semantic "
                 "'{\"summary\":\"promise: <text> due <key>\",\"due_utc\":\"<UTC>\",\"timer_id\":\"<cron id>\"}'. The "
                 "next GOAL PROMPT handoff then carries it in open_promises. If the promise is already kept or dropped, "
                 "say so in one line. This repeats at most once per %d turns." % (ref or "<ref>", turns))
    return "\n".join(lines)


def applies(cwd: str) -> bool:
    """The hook's domain: a coordinator (manager or lead) of a configured project, not a worker."""
    scope, _why = common.project_scope(cwd)
    return scope != "none" and common.role() in COORDINATOR_ROLES


def on_prompt(payload: dict) -> None:
    """UserPromptSubmit (optional wiring): an operator turn closes the window, so the turn counter restarts."""
    if not applies(payload.get("cwd") or os.getcwd()):
        return
    sid = safe_sid(payload.get("session_id"))
    st = load_state(sid)
    st["turns"] = -1  # the Stop that ends this turn increments it back to 0
    save_state(sid, st)


def on_stop(payload: dict, now: float) -> dict | None:
    if payload.get("stop_hook_active"):
        return None
    if not applies(payload.get("cwd") or os.getcwd()):
        return None
    sid = safe_sid(payload.get("session_id"))
    n_turns = common.setting_int("PM_PROMISE_CHECK_TURNS", DEFAULT_TURNS)
    if n_turns <= 0:
        return None
    st = load_state(sid)
    turns = int(st.get("turns", 0)) + 1
    st["turns"] = turns
    path = payload.get("transcript_path")
    if not path or not os.path.exists(path):
        save_state(sid, st)
        return None
    ref = bound_issue(payload.get("cwd") or os.getcwd())
    promises, crons = scan_transcript(path)
    seen = dict(st.get("seen") or {})
    for p in promises:
        seen.setdefault(p["qid"], {"text": p["text"], "key": p["key"], "turn": turns})
    open_now = unresolved(promises, crons, ref)
    reminded = dict(st.get("reminded") or {})
    due = [p for p in open_now
           if turns - int(seen.get(p["qid"], {}).get("turn", turns)) >= n_turns
           and p["qid"] not in reminded]  # once per promise: a repeat re-sends the whole context for one line
    result = None
    if due:
        for p in due:
            reminded[p["qid"]] = turns
            seen.setdefault(p["qid"], {"text": p["text"], "key": p["key"], "turn": turns})
        result = {"decision": "block", "reason": reminder(due[:MAX_REPORTED], n_turns, ref)}
    # keep the state bounded: only promises still unresolved, and only the newest 40
    live = {p["qid"] for p in open_now}
    st["seen"] = {k: v for k, v in list(seen.items())[-40:] if k in live}
    st["reminded"] = {k: v for k, v in reminded.items() if k in live and k in st["seen"]}
    save_state(sid, st)
    return result


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    event = argv[argv.index("--event") + 1] if "--event" in argv and argv.index("--event") + 1 < len(argv) else "stop"
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if event == "prompt":                 # on_prompt/on_stop own the role and project gate (one place, tested)
            on_prompt(payload)
            return 0
        if event != "stop":
            return 0
        out = on_stop(payload, time.time())
        if out:
            sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    except SystemExit:
        pass
    except Exception as exc:  # fail open: a reminder hook never blocks a turn on its own bug
        common.log_error(HOOK, event, exc)
    return 0


if __name__ == "__main__":
    sys.exit(main())

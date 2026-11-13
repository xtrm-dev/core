#!/usr/bin/env python3
"""Operator-question reminder for coordinator sessions, the manager and the leads (project-management rule 15, XTRM-763).

A coordinator asks the operator a question in chat and forgets it: rule 15 says a pending
operator item is a Status board ``questions`` row, refreshed when N turns pass without an answer.
This hook enforces it:

  UserPromptSubmit  classify the prompt. A real operator turn stamps the time, resets the silent-turn
                    counter and drops chat-detected questions. Injected prompts (cross-session messages,
                    task notifications, cron prompts, goal check-ins, Stop-hook nudges) change nothing.
                    No network, no subprocess.
  Stop              count one silent turn. When N have passed and an operator question is open with no
                    current Status board row, emit ONE reminder (decision=block reason, the only Stop output
                    the model sees) naming the question, the exact ``pm_question.py`` command, and the
                    hand-off to the board helper: one ``@operator`` Jira comment per open question (exact
                    text + ticket key), which the board helper posts with ``post-guard.py --mention-first``.
                    Once per question per N turns. ``stop_hook_active`` true emits nothing (no loop).

Open questions come from (a) Substrate journal blockers with ``for=operator`` and no later decision that
references them, on the refs in ``operator_question_refs`` (default: ``epic``); (b) a heuristic over the last
assistant message (a direct question to the operator, or an A/B/C choice block; Italian or English).

Only the manager and the leads are gated: the role comes from the pack's one resolver, scripts/pm_role.py
(``.pm-role`` file in the worktree root, else the ``route_roles`` name patterns, else worker). The board helper and
workers are untouched.

Config (pm_config, ~/.config/xtrm/project-management.json): ``operator_question_turns`` (default 5, 0 = off),
``operator_injected_patterns`` (extra regexes for injected prompts, e.g. your cron prompt prefix),
``operator_question_refs``.
Non-coordinator sessions and sessions outside a configured project are untouched. Every internal error fails
open (exit 0, no output) and is appended to $PM_STATE_DIR/operator-questions/errors.log.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import shlex
import sys
import time

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import pm_config  # noqa: E402
import pm_question  # noqa: E402
import pm_role  # noqa: E402

DEFAULT_TURNS = 5
COORDINATOR_ROLES = ("manager", "lead")  # pm_role roles that get the reminder; board_helper and worker do not
MAX_REPORTED = 3
Q_CAP = 300

# Prompts that arrive as user turns but are not the operator speaking (case-insensitive, after strip).
INJECTED_PREFIXES = (
    "<cross-session-message", "<task-notification", "<system-reminder", "<channel", "<local-command",
    "<user-prompt-submit-hook", "[cross-session delivery notice]", "[system notification",
    "[cron", "<<autonomous-loop", "stop hook feedback", "[stop hook", "stop hook:",
)
INJECTED_RES = (
    re.compile(r"^\[?goal[\s-]*(check-?in|condition|not (yet )?met|reminder)", re.I),
    re.compile(r"^/goal\b", re.I),
    re.compile(r"^(scheduled|cron)[\s-]*(task|prompt|trigger)\b", re.I),
)

ADDRESS_RE = re.compile(
    r"\b(operator|"
    r"do you (?:want|prefer|agree|approve)|would you (?:like|prefer|rather)|will you\b|should (?:we|i)\b|shall (?:we|i)\b|may i\b|can i\b|"
    r"want me|would you like|ok to|okay to|go ahead|thoughts|approve|confirm|proceed|prefer|authori[sz]e|"
    r"is (?:that|this|it) (?:ok|okay|fine|good)|ok for you|your (?:call|ok|go|decision|ruling|word)|"
    r"what do you (?:think|prefer|want)|which (?:one|option)|"
    r"vuoi|puoi|preferisci|confermi|approvi|autorizzi|posso|procedo|procediamo|dimmi|scegli|ti va|decidi|"
    r"decidiamo|che ne dici|cosa ne pensi|va bene (?:così|se|per te)|ti va bene|lo faccio|devo|ok per te|tuo ok|tuo via|tua parola|mi dai|dammi)\b", re.I)
NOT_A_DECISION_RE = re.compile(r"\b(anything else|something else|else you need|let me know|altro da|altro che)\b", re.I)
CHOICE_WORDS_RE = re.compile(r"\?|\b(choose|pick|which|decide|option|scegli|quale|decid\w+|opzion\w+|rec\b)", re.I)
OPTION_RE = re.compile(r"^\s*(?:[-*]\s*)?[\(\*\[]*([A-Ca-c1-3])[\)\]\.:\*]+\s+\S")
FENCE_RE = re.compile(r"```.*?```", re.S)
SENT_RE = re.compile(r"[^.?!\n]*\?")


def classify_prompt(prompt, extra_patterns=()) -> str:
    """'operator' or 'injected'. Empty prompts are not the operator."""
    text = str(prompt or "").lstrip()
    if not text:
        return "injected"
    low = text.lower()
    if low.startswith(INJECTED_PREFIXES):
        return "injected"
    if any(r.search(text) for r in INJECTED_RES):
        return "injected"
    for pat in extra_patterns:
        try:
            if re.search(pat, text):
                return "injected"
        except re.error:
            continue
    return "operator"


def _squash(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


_NAME_RE = None


def operator_name_re():
    """Names that address the operator, from config (operator_names, operator_handle); never from the pack."""
    global _NAME_RE
    if _NAME_RE is None:
        names = list(pm_config.get_data("PM_OPERATOR_NAMES", []) or []) + [pm_config.get("PM_OPERATOR_HANDLE", "")]
        names = [str(n) for n in names if n and len(str(n)) > 2]
        _NAME_RE = re.compile(r"\b(%s)\b" % "|".join(re.escape(n) for n in names), re.I) if names else re.compile(r"(?!x)x")
    return _NAME_RE


def detect_questions(text) -> list[tuple[str, str]]:
    """[(qid, question text)] directed at the operator in one assistant message (heuristic, at most MAX_REPORTED)."""
    body = FENCE_RE.sub(" ", str(text or ""))
    lines = [ln for ln in body.splitlines() if not ln.lstrip().startswith(">")][-80:]
    found: list[str] = []
    leads: list[str] = []
    # A/B/C (or 1/2/3) choice block: >=2 consecutive option lines, a '?' or choice word right around it.
    i = 0
    while i < len(lines):
        m = OPTION_RE.match(lines[i])
        j = i
        while m and j < len(lines) and OPTION_RE.match(lines[j]):
            j += 1
        if m and j - i >= 2:
            around = lines[max(0, i - 3):i] + lines[j:j + 2]
            lead = next((ln for ln in reversed(lines[max(0, i - 3):i]) if ln.strip()), "")
            if any(CHOICE_WORDS_RE.search(ln) for ln in around):
                opts = " | ".join(_squash(ln) for ln in lines[i:j])
                leads.append(lead)
                found.append(_squash(lead.strip("*# ") + " " + opts)[:Q_CAP])
            i = j
        else:
            i += 1
    for ln in lines:
        if OPTION_RE.match(ln):
            continue
        for sent in SENT_RE.findall(ln):
            s = _squash(re.sub(r"^[\s>*#\-\d.)]+", "", sent))
            if len(s) > 8 and (ADDRESS_RE.search(s) or operator_name_re().search(s)) and not NOT_A_DECISION_RE.search(s) \
                    and not any(s in ld for ld in leads):
                found.append(s[:Q_CAP])
    out, seen = [], set()
    for q in found:
        qid = pm_question.qid_of(q)
        if qid not in seen:
            seen.add(qid)
            out.append((qid, q))
    return out[:MAX_REPORTED]


# ---------------------------------------------------------------- gating and settings
def _setting_int(name: str, default: int) -> int:
    try:
        return int(pm_config.get(name, default))
    except (TypeError, ValueError):
        return default


def project_applies(cwd: str) -> bool:
    """True only for a session of a configured project (explicit PM_PROJECT, or cwd inside its dirs)."""
    raw = pm_config.raw_config()
    projects = raw.get("projects")
    if not projects:
        dirs = [raw.get("repo_dir"), *(raw.get("match_dirs") or [])]
        dirs = [d for d in dirs if d]
        if not dirs or os.environ.get("PM_PROJECT"):
            return bool(raw)  # flat single-project config: the file's existence is the opt-in
        here = pathlib.Path(cwd or os.getcwd()).resolve()
        return any(pm_config._under(here, d) >= 0 for d in dirs)
    if os.environ.get("PM_PROJECT"):
        return os.environ["PM_PROJECT"] in projects
    here = pathlib.Path(cwd or os.getcwd())
    defaults = raw.get("defaults") or {}
    best, best_len = None, -1
    for name, prof in projects.items():
        merged = {**defaults, **prof}
        for d in [merged.get("repo_dir"), *(merged.get("match_dirs") or [])]:
            n = pm_config._under(here.resolve(), d) if d else -1
            if n > best_len:
                best, best_len = name, n
    if best is None:
        return False
    os.environ["PM_PROJECT"] = best  # pm_config resolves the same project from here on
    return True


def session_ident(cwd: str) -> str:
    return (os.environ.get("SUBSTRATE_HOLDER") or os.environ.get("XTRM_SESSION_NAME")
            or os.path.basename(os.environ.get("CLAUDE_PROJECT_DIR") or cwd or ""))


def is_coordinator() -> bool:
    """True for the manager and the leads (pm_role.current(): role file, else name patterns, else worker)."""
    return pm_role.current() in COORDINATOR_ROLES


# ---------------------------------------------------------------- state
def safe_sid(raw) -> str:
    sid = re.sub(r"[^A-Za-z0-9._-]", "_", str(raw or ""))
    if not sid or sid in (".", ".."):
        raise ValueError("no usable session_id")
    return sid


def state_path(sid: str) -> pathlib.Path:
    return pm_question.state_root() / ("%s.json" % sid)


def load_state(sid: str) -> dict:
    try:
        st = json.loads(state_path(sid).read_text())
        if isinstance(st, dict):
            return st
    except (OSError, ValueError):
        pass
    return {}


def save_state(sid: str, st: dict) -> None:
    p = state_path(sid)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp%d" % os.getpid())
    tmp.write_text(json.dumps(st, ensure_ascii=False))
    os.replace(tmp, p)


log_error = pm_question.log_error


# ---------------------------------------------------------------- events
def on_prompt(payload: dict, now: float) -> None:
    """UserPromptSubmit: a real operator turn resets the counter. Local files only."""
    sid = safe_sid(payload.get("session_id"))
    extra = pm_config.get_data("PM_OPERATOR_INJECTED_PATTERNS", []) or []
    if classify_prompt(payload.get("prompt"), extra) != "operator":
        return
    st = load_state(sid)
    st.update(turns=0, last_operator_ts=now, stops=[], chat={}, reminded={}, answering=now)
    save_state(sid, st)


def last_assistant_text(payload: dict) -> str:
    """Last assistant message: the payload field when present, else the tail of the transcript."""
    msg = payload.get("last_assistant_message")
    if isinstance(msg, str) and msg.strip():
        return msg
    path = payload.get("transcript_path")
    if not path:
        return ""
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            fh.seek(max(0, fh.tell() - 262144))
            lines = fh.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return ""
    for line in reversed(lines):
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if obj.get("type") != "assistant":
            continue
        content = (obj.get("message") or {}).get("content")
        if isinstance(content, str):
            return content
        text = "\n".join(b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text")
        if text.strip():
            return text
    return ""


def blocker_questions(refs: list[str], journal=None) -> list[dict]:
    """Open for=operator blockers: {qid, q, rec, ref}. Open = no later decision references its qid or entry id."""
    journal = journal or pm_question.journal_entries
    out = []
    for ref in refs:
        blockers = journal(ref, "blocker")
        if not blockers:
            continue
        decisions = journal(ref, "decision")
        for b in blockers:
            sem = b.get("semantic") or {}
            if not isinstance(sem, dict) or str(sem.get("for", "")).lower() != "operator":
                continue
            bid = str(b.get("id") or "")
            qid = str(sem.get("qid") or pm_question.qid_of(bid))
            seq = b.get("sequence") or 0
            answered = any((d.get("sequence") or 0) > seq and (qid in json.dumps(d.get("semantic") or {}) or
                                                                (bid and bid in json.dumps(d.get("semantic") or {})))
                           for d in decisions)
            if not answered:
                out.append({"qid": qid, "q": _squash(str(sem.get("q") or sem.get("summary") or bid))[:Q_CAP],
                            "rec": str(sem.get("rec") or ""), "ref": ref})
    return out


def question_refs() -> list[str]:
    refs = pm_config.get_data("PM_OPERATOR_QUESTION_REFS", None)
    if refs is None:
        epic = pm_config.get("PM_EPIC")
        refs = [epic] if epic else []
    return [str(r) for r in refs if r]


def row_status(rows: list, q: dict, window_start: float | None, upd: str) -> str:
    """'current' | 'stale' | 'missing' for one question against the doc rows."""
    row = next((r for r in rows if isinstance(r, dict) and r.get("id") == q["qid"]), None)
    if row is None:
        return "missing"
    ts = pm_question.parse_ts(row.get("at")) or pm_question.parse_ts(upd)
    if window_start is None or (ts is not None and ts >= window_start):
        return "current"
    return "stale"


def command_for(q: dict, status: str, ref_default: str) -> str:
    script = str(SCRIPTS / "pm_question.py")
    base = "python3 %s %%s --id %s" % (script, q["qid"])
    if status == "stale":
        return base % "refresh"
    ref = q.get("ref") or ref_default or "<issue-ref>"
    rec = q.get("rec") or "<your recommendation>"
    return (base % "add") + " --ref %s --q %s --rec %s" % (shlex.quote(ref), shlex.quote(q["q"]), shlex.quote(rec))


def close_hint(q: dict) -> str:
    if not q.get("ref"):
        return ""
    return "\n   already answered? python3 %s close --id %s --ref %s --answer 'THE ANSWER'" % (
        SCRIPTS / "pm_question.py", q["qid"], shlex.quote(q["ref"]))


def jira_hint(q: dict, ref_default: str) -> str:
    """The board-helper hand-off for one question: exact text and the ticket it goes on."""
    ref = q.get("ref") or ref_default or "<issue-ref>"
    return ("\n   Jira: hand the board helper an @operator comment for the Jira ticket of %s (give its key), exact text: %s"
            % (ref, json.dumps(q["q"], ensure_ascii=False)))


def build_reminder(items: list[tuple[dict, str]], owner: str, turns: int, ref_default: str, more: int = 0) -> str:
    lines = ["[operator-questions] %d turns without an operator reply. Open question(s) with no current Status board row "
             "(doc questions/%s, rule 15):" % (turns, owner)]
    for n, (q, status) in enumerate(items, 1):
        verb = "refresh the stale row" if status == "stale" else "file the row"
        lines.append("%d. %s  (id %s)\n   %s: %s%s%s" % (n, q["q"], q["qid"], verb, command_for(q, status, ref_default),
                                                        jira_hint(q, ref_default), close_hint(q)))
    if more:
        lines.append("(+%d more open question(s); they are reminded after the next %d turns.)" % (more, turns))
    lines.append("For each open question, also send the board helper the @operator Jira comment above (exact text and "
                 "ticket key); the board helper alone posts it, with post-guard.py --mention-first.")
    lines.append("Run it once (fill in any <placeholder>), then continue your task. If the question is no longer open, "
                 "ignore this: it repeats at most once per %d turns." % turns)
    return "\n".join(lines)


def on_stop(payload: dict, now: float, fetch=None, journal=None) -> dict | None:
    """Stop: count a silent turn; return the hook output (a block decision) when a reminder is due."""
    if payload.get("stop_hook_active"):
        return None
    sid = safe_sid(payload.get("session_id"))
    n_turns = _setting_int("PM_OPERATOR_QUESTION_TURNS", DEFAULT_TURNS)
    if n_turns <= 0:
        return None
    st = load_state(sid)
    ans_ts = float(st.pop("answering", 0) or 0)
    answering = bool(ans_ts) and now - ans_ts < 3600  # the Stop that ends the operator's own turn is not a silent turn
    if not answering:
        st["turns"] = int(st.get("turns", 0)) + 1
    st["stops"] = (list(st.get("stops") or []) + [now])[-(n_turns + 1):]  # the answering Stop is the window's lower bound
    chat = dict(st.get("chat") or {})
    for qid, q in detect_questions(last_assistant_text(payload)):
        chat.setdefault(qid, {"q": q, "turn": st.get("turns", 0)})
    st["chat"] = chat
    reminded = dict(st.get("reminded") or {})
    result = None
    if not answering and st["turns"] >= n_turns:
        result = _due_reminder(st, chat, reminded, n_turns, now, fetch, journal, payload)
    st["reminded"] = reminded
    save_state(sid, st)
    return result


def cached_blockers(owner, refs, now, journal):
    """Open for=operator blockers, cached DOC_TTL seconds in a file shared by the sessions of one coordinator
    (pm_question add/close drop it). A failed scan is cached as empty so a dead ``sb`` costs one try per 5 minutes."""
    f = pm_question.blockers_file(owner)
    try:
        c = json.loads(f.read_text())
        if now - float(c["at"]) < pm_question.DOC_TTL:
            return c.get("items", [])
    except (OSError, ValueError, KeyError):
        pass
    try:
        items = blocker_questions(refs, journal)
    except Exception as exc:  # sb missing or slow: chat questions still work
        log_error("blockers", exc)
        items = []
    try:
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({"at": now, "items": items}))
    except OSError:
        pass
    return items


def _due_reminder(st, chat, reminded, n_turns, now, fetch, journal, payload):
    turns = st["turns"]
    owner = pm_question.owner_of(session_ident(payload.get("cwd") or ""), pm_role.current())
    refs = question_refs()
    cands = list(cached_blockers(owner, refs, now, journal))
    known = {b["qid"] for b in cands}
    # a chat question is due N turns after it was asked (rule 15: "5 turns after the ask")
    cands += [{"qid": qid, "q": c["q"], "rec": "", "ref": ""} for qid, c in chat.items()
              if qid not in known and turns - int(c.get("turn", 0)) >= n_turns]
    cands = [q for q in cands if turns - int(reminded.get(q["qid"], -10**9)) >= n_turns]
    if not cands:
        return None
    got = pm_question.read_rows(owner, fetch=fetch, now=now)
    if got is None:
        return None  # here.now unreachable (cached as failed for 5 minutes): fail open
    rows, upd = got
    stops = st.get("stops") or []
    window_start = stops[0] if len(stops) > n_turns else None  # the Stop before the window's first turn
    items = [(q, s) for q in cands if (s := row_status(rows, q, window_start, upd)) != "current"]
    if not items:
        return None
    for q, _ in items:
        reminded[q["qid"]] = turns  # every due question, reported or not: once per N turns
    ref_default = refs[0] if refs else ""
    return {"decision": "block", "reason": build_reminder(items[:MAX_REPORTED], owner, turns, ref_default,
                                                        len(items) - MAX_REPORTED if len(items) > MAX_REPORTED else 0)}


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    event = argv[argv.index("--event") + 1] if "--event" in argv and argv.index("--event") + 1 < len(argv) else ""
    where = event or "?"
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        cwd = payload.get("cwd") or os.getcwd()
        if event not in ("prompt", "stop") or not project_applies(cwd) or not is_coordinator():
            return 0
        now = time.time()
        if event == "prompt":
            on_prompt(payload, now)
        else:
            out = on_stop(payload, now)
            if out:
                sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
    except SystemExit:
        pass
    except Exception as exc:  # fail open: a reminder hook never blocks a turn on its own bug
        log_error(where, exc)
    return 0


if __name__ == "__main__":
    sys.exit(main())

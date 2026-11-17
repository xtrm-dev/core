#!/usr/bin/env python3
"""Warn a project-management manager or lead to checkpoint before compaction (PostToolUse / UserPromptSubmit).

    python3 checkpoint_warn.py     (hook JSON on stdin)

Role manager or lead only (scripts/pm_role.py), only in a configured project. Reads the newest assistant usage from
the transcript tail and compares it with the compaction window: env CLAUDE_CODE_AUTO_COMPACT_WINDOW first, then the
per-model autoCompactWindow in ~/.claude/settings.json, else 200k. Emits additionalContext once per threshold
(setting checkpoint_thresholds, default [0.70, 0.85]; the last one is FINAL); re-arms after a compaction.

Tools reminder (same hook, no extra wiring): at each fraction in setting tools_reminder_thresholds (default [0.35, 0.60]; [] turns
it off) the role's tool cards (scripts/pm_tools.py) are added once, for the manager, the leads and the workers. Both re-arm when the
context drops by REARM_MARGIN or more, which is what a compaction does.

The handoff entry goes on the bound issue (SUBSTRATE_ISSUE_REF or .substrate-issue); an unbound manager uses the
config's manager_issue, else epic; an unbound lead is told to bind its own epic. Setting checkpoint_fold_hint
(true, false or "auto": on when ANTHROPIC_BASE_URL points at a local folding proxy; default false) adds a step that
folds transport chatter before the handoff. Never blocks: any error exits 0 (logged to the hook state dir (pm_hook_common.cache_dir)).
"""
from __future__ import annotations

import json
import os
import pathlib
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pm_hook_common as common  # noqa: E402

HOOK = "checkpoint_warn"
DEFAULT_THRESHOLDS = [0.70, 0.85]
DEFAULT_TOOLS_THRESHOLDS = [0.35, 0.60]
TOOLS_ROLES = ("manager", "lead", "worker")
REARM_MARGIN = 0.15
# A session compacts itself: a detached shell types /compact into its own pane once the current turn has ended.
SELF_COMPACT = ("(setsid sh -c 'sleep 20; tmux send-keys -t \"$TMUX_PANE\" -l /compact; sleep 1; "
                "tmux send-keys -t \"$TMUX_PANE\" Enter' >/dev/null 2>&1 &)")


def thresholds() -> list[float]:
    raw = common.setting_data("PM_CHECKPOINT_THRESHOLDS", DEFAULT_THRESHOLDS)
    try:
        vals = sorted({float(x) for x in (raw if isinstance(raw, list) else [raw]) if 0 < float(x) < 1.5})
    except (TypeError, ValueError):
        vals = []
    return vals or list(DEFAULT_THRESHOLDS)


def tools_thresholds() -> list[float]:
    raw = common.setting_data("PM_TOOLS_REMINDER_THRESHOLDS", DEFAULT_TOOLS_THRESHOLDS)
    if raw == []:
        return []
    try:
        return sorted({float(x) for x in (raw if isinstance(raw, list) else [raw]) if 0 < float(x) < 1.5})
    except (TypeError, ValueError):
        return list(DEFAULT_TOOLS_THRESHOLDS)


def tools_message(role: str, frac: float) -> str:
    import pm_tools
    lines = pm_tools.block(role, head="TOOLS CHECK at %d%% context" % round(frac * 100))
    return "\n".join(lines + ["Use the one that fits your next step; no reply needed."])


def handoff_ref(role: str, cwd: str, scope_ok: bool) -> str:
    ref = common.bound_ref(cwd)
    if ref:
        return ref
    if role == "manager":
        mref, source = common.manager_ref() if scope_ok else (None, "")
        if mref:
            return "%s (the manager issue from the project config, %s; no .substrate-issue here: echo %s > " \
                   ".substrate-issue)" % (mref, source, mref)
        return ("<ref> (no .substrate-issue here, and the config gives no manager_issue or epic: find your issue in "
                "the latest handoff, then echo <ref> > .substrate-issue)")
    return "<your epic> (no .substrate-issue here: bind your own epic first: echo <epic-ref> > .substrate-issue)"


def fold_hint() -> bool:
    value = common.setting("PM_CHECKPOINT_FOLD_HINT", False)
    if isinstance(value, str) and value.strip().lower() == "auto":
        base = os.environ.get("ANTHROPIC_BASE_URL", "")
        return "/bili/" in base or "127.0.0.1" in base or "localhost" in base
    return common.setting_bool("PM_CHECKPOINT_FOLD_HINT", False)


def usage_from_transcript(tpath: str):
    with open(tpath, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - 400_000))
        lines = f.read().decode("utf-8", "replace").splitlines()
    for line in reversed(lines):
        try:
            m = json.loads(line).get("message") or {}
        except (ValueError, AttributeError):
            continue
        u = m.get("usage") if isinstance(m, dict) else None
        if u and m.get("role") == "assistant":
            used = sum(int(u.get(k) or 0) for k in ("input_tokens", "cache_read_input_tokens",
                                                     "cache_creation_input_tokens", "output_tokens"))
            return used, m.get("model")
    return None, None


def compact_window(model) -> int:
    try:
        s = json.loads(pathlib.Path.home().joinpath(".claude/settings.json").read_text())
    except (OSError, ValueError):
        s = {}
    return int(os.environ.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW") or 0) \
        or int((((s.get("modelSettings") or {}).get(model or "", {}) or {}).get("autoCompactWindow") or 0)) \
        or int(s.get("autoCompactWindow") or 0) or 200_000


def message(used: int, window: int, frac: float, final: bool, ref: str, fold: bool) -> str:
    step0 = ("0. Context folding is active: first fold transport chatter (dispatch/report traffic, raw command output, "
             "audited worker reports) with ONE batched `compress` call at a boundary; keep verbatim in each summary: "
             "Jira keys and comment ids, SHAs, transition/sprint/field ids, window ids and UTC times, contract "
             "SUCCESS/SCOPE/VALIDATION lines, file paths, open questions. Never fold an unapplied WORD or a contract "
             "you work against. If still above this level after folding, do steps 1-4.\n") if fold else ""
    return (f"CONTEXT CHECKPOINT ({'FINAL' if final else 'EARLY'}): {used:,}/{window:,} tokens ({frac:.0%}). "
            "A manager or lead compacts; it does not hand off by context percentage. Finish the current atomic step, "
            "then:\n" + step0 +
            f"1. Write ONE handoff entry on {ref}: sb journal append <ref> --kind handoff --semantic '<json>' with "
            "these keys (empty list = none, never omit a key): utc (from date -u), shas{<branch>: <sha>} for each "
            "branch you ship from (from git output), windows[{id, jira, utc, state, go_comment}], "
            "workers[{pane, name, issue, state, reap_when}], specialists[{activation, issue, state}], "
            "crons[{prompt_head, schedule}], monitors_to_rearm[], pending_replies[{from_or_to, about, due}], "
            "operator_questions[{ref, q, status_board_row}], open_prs[{n, head, state, next}], decisions_today[seq], "
            "non_actions[], next_action. The entry IS the handover: no separate handover file.\n"
            "2. Verify each list against live state, not memory: CronList, tmux list-panes -s, ListAgents, "
            "specialist_status, gh pr list.\n"
            "3. Refresh the goal file (.goal-file) if the work moved on (<=4000 chars).\n"
            "4. Compact at a quiet point, never within 20 min of a window: compact yourself by typing /compact into your own "
            "pane, then end the turn: " + SELF_COMPACT + (" NOW (auto-compact is close)." if final else " when the current "
            "step ends.") + " The post-compact hook and nudge resume you.")


def run(out=None) -> None:
    out = out or sys.stdout
    inp = common.read_payload()
    cwd = str(inp.get("cwd") or os.getcwd())
    scope, _why = common.project_scope(cwd)
    if scope == "none":
        return
    role = common.role()
    if role not in common.GATED_ROLES and role not in TOOLS_ROLES:
        return
    tpath = inp.get("transcript_path")
    if not tpath or not os.path.exists(tpath):
        return
    used, model = usage_from_transcript(tpath)
    if not used:
        return
    window = compact_window(model)
    frac = used / window
    ths = thresholds() if role in common.GATED_ROLES else []
    tths = tools_thresholds() if role in TOOLS_ROLES else []
    sid = "".join(c if c.isalnum() or c in "._-" else "_" for c in str(inp.get("session_id") or "x"))
    state = common.cache_dir() / "ctx-warn" / f"{sid}.json"
    try:
        st = json.loads(state.read_text())
        st["fired"] = [float(x) for x in st.get("fired") or []]
        st["tools"] = [float(x) for x in st.get("tools") or []]
        last = float(st.get("last") or 0.0)
    except (OSError, ValueError, AttributeError, TypeError):
        st, last = {"fired": [], "tools": []}, 0.0
    dropped = frac < last - REARM_MARGIN  # compacted or folded since the last call
    if dropped or (ths and frac < min(ths) - REARM_MARGIN):
        st["fired"] = []
    if dropped or (tths and frac < min(tths) - REARM_MARGIN):
        st["tools"] = []
    due = [t for t in ths if frac >= t and t not in st["fired"]]
    tdue = [t for t in tths if frac >= t and t not in st["tools"]]
    st["fired"] += due
    st["tools"] += tdue
    st["last"] = frac
    state.parent.mkdir(parents=True, exist_ok=True)
    state.write_text(json.dumps(st))
    parts = []
    if due:
        parts.append(message(used, window, frac, max(due) >= ths[-1], handoff_ref(role, cwd, scope == "ok"), fold_hint()))
    if tdue and not due:  # a checkpoint warning already asks for the handoff; one message per turn
        parts.append(tools_message(role, frac))
    if not parts:
        return
    event = inp.get("hook_event_name", "PostToolUse")
    out.write(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": "\n\n".join(parts)}}) + "\n")


def main() -> int:
    try:
        run()
    except BaseException as exc:  # never block a turn on a hook bug
        common.log_error(HOOK, "run", exc)
    return 0


if __name__ == "__main__":
    sys.exit(main())

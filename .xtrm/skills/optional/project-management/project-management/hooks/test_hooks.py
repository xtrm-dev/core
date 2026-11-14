"""Tests for hooks/post_compact.py, hooks/action_gate.py and hooks/checkpoint_warn.py. No network, no sb, no tmux."""
import io
import json
import os
import pathlib
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

import pytest

HOOKS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HOOKS))
sys.path.insert(0, str(HOOKS.parent / "scripts"))
import pm_config  # noqa: E402
import pm_question  # noqa: E402
import pm_hook_common as common  # noqa: E402
import post_compact  # noqa: E402
import action_gate  # noqa: E402
import checkpoint_warn  # noqa: E402

CLEARED = ("PM_PROJECT", "XTMUX_AGENT_ROLE", "PM_GOAL_DOC", "PM_JIRA_EPIC", "PM_GOAL_REFS", "PM_LAUNCH_ROLES",
           "SUBSTRATE_HOLDER", "XTRM_SESSION_NAME", "SUBSTRATE_ISSUE_REF", "TMUX_PANE", "XTRM_ROLE",
           "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "ANTHROPIC_BASE_URL", "PM_CLAIM_TTL_MS", "PM_EPIC", "PM_MANAGER_ISSUE",
           "PM_LANE_DIR", "PM_REFREAD_FILES", "PM_GATED_COMMANDS", "PM_GATED_TOOLS", "PM_POST_COMPACT_EXTRA",
           "PM_POST_COMPACT_NUDGE", "PM_POST_COMPACT_NUDGE_TEXT", "PM_PENDING_MAX_AGE_S", "PM_CHECKPOINT_THRESHOLDS",
           "PM_STATUS_BOARD_SITE", "PM_QUESTION_OWNER", "PM_ROUTE_ROLES", "PM_OPERATOR_QUESTION_REFS")


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


class Env:
    def __init__(self, tmp, monkeypatch):
        self.tmp, self.mp = tmp, monkeypatch
        self.home = tmp / "home"
        self.wt = tmp / "wt"
        self.lane = tmp / "lane"
        for d in (self.home, self.wt, self.lane):
            d.mkdir()
        self.refs = []
        for name in ("manager.md", "lead.md", "launching.md"):
            f = tmp / "refs" / name
            f.parent.mkdir(exist_ok=True)
            f.write_text("line 1\nline 2\nline 3\n")
            self.refs.append(str(f))
        self.cfg = {"repo_dir": str(self.wt), "state_dir": str(tmp / "state"), "lane_dir": str(self.lane),
                    "epic": "EP-1", "refread_files": {"manager": self.refs, "lead": self.refs}}
        self.cfg_path = tmp / "pm.json"
        self.write_cfg()

    def write_cfg(self, data=None):
        self.cfg_path.write_text(json.dumps(self.cfg if data is None else data))
        pm_config._RAW = pm_config._CACHE = None

    def set(self, **kw):
        self.cfg.update(kw)
        self.write_cfg()

    def role_file(self, role):
        (self.wt / ".pm-role").write_text(role + "\n")


@pytest.fixture
def env(tmp_path, monkeypatch):
    for k in CLEARED:
        monkeypatch.setenv(k, "_")  # so monkeypatch restores the original (absent) value after a hook sets it
        monkeypatch.delenv(k)
    e = Env(tmp_path, monkeypatch)
    monkeypatch.setenv("HOME", str(e.home))
    monkeypatch.setenv("PM_CONFIG", str(e.cfg_path))
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(e.wt))
    monkeypatch.setenv("PM_SB_BIN", "false")  # any sb call returns no JSON
    monkeypatch.setattr(action_gate, "_OQ", None)
    pm_config._RAW = pm_config._CACHE = None
    yield e
    pm_config._RAW = pm_config._CACHE = None


def feed(monkeypatch, payload):
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload)))


def compact(env, mode="compact", **payload):
    feed(env.mp, {"cwd": str(env.wt), "session_id": "s1", **payload})
    out = io.StringIO()
    post_compact.run(["--mode", mode], out)
    pm_config._RAW = pm_config._CACHE = None
    return out.getvalue()


def gate(env, event, **payload):
    feed(env.mp, {"cwd": str(env.wt), "session_id": "s1", **payload})
    out = io.StringIO()
    action_gate.run(["--event", event], out)
    pm_config._RAW = pm_config._CACHE = None
    return out.getvalue()


def pre(env, command="gh pr merge 12 --squash", tool="Bash"):
    return gate(env, "pre", tool_name=tool, tool_input={"command": command} if tool == "Bash" else {})


def denied(out):
    return json.loads(out)["hookSpecificOutput"]["permissionDecisionReason"] if out.strip() else None


def read_all(env, files=None):
    for f in files or env.refs:
        gate(env, "post", tool_name="Read", tool_input={"file_path": f})


# ---------------------------------------------------------------- role gating
@pytest.mark.parametrize("role,acts", [("manager", True), ("lead", True), ("board_helper", False), ("worker", False)])
def test_role_file_gates_every_hook(env, role, acts):
    env.role_file(role)
    assert bool(compact(env)) is acts
    assert bool(compact(env, "startup")) is acts
    assert bool(gate(env, "start")) is acts
    assert bool(denied(pre(env))) is acts


@pytest.mark.parametrize("launch,acts", [("manager", True), ("lead", True), ("worker", False),
                                         ("board-audit-runner", False)])
def test_launch_role_gates_without_a_file(env, launch, acts, monkeypatch):
    monkeypatch.setenv("XTMUX_AGENT_ROLE", launch)
    assert bool(compact(env)) is acts
    assert bool(denied(pre(env))) is acts


def test_common_goal_in_both_modes(env):
    env.role_file("lead")
    (env.wt / "PRD.md").write_text("# Product\n\nThe product answers every market question in one place.\n")
    env.set(goal_doc="PRD.md", epic="SB-1", jira_epic="PROJ-9")
    for mode in ("compact", "startup"):
        out = compact(env, mode)
        assert "COMMON GOAL" in out
        assert "answers every market question" in out
        assert "Jira epic: PROJ-9" in out


@pytest.mark.parametrize("name,acts", [("p-xt-claude-thu13-manager", True), ("EP-1-api-lead", True),
                                       ("p-xt-pi-board-helper", False), ("EP-1-fix-parser", False)])
def test_name_patterns_gate(env, name, acts, monkeypatch):
    monkeypatch.setenv("SUBSTRATE_HOLDER", name)
    assert bool(compact(env)) is acts
    assert bool(denied(pre(env))) is acts


def test_xtrm_role_is_not_a_role_source(env, monkeypatch):
    monkeypatch.setenv("XTRM_ROLE", "manager")
    monkeypatch.setenv("SUBSTRATE_HOLDER", "plain")
    assert compact(env) == "" and pre(env) == ""


# ---------------------------------------------------------------- project scope
def test_no_project_is_silent(env, tmp_path):
    env.role_file("manager")
    env.set(repo_dir=str(tmp_path / "elsewhere"))
    assert compact(env) == "" and gate(env, "start") == "" and pre(env) == ""
    env.mp.setenv("PM_CONFIG", str(tmp_path / "missing.json"))
    pm_config._RAW = pm_config._CACHE = None
    assert compact(env) == "" and pre(env) == ""


def test_no_project_subprocess_exits_zero_silently(env, tmp_path):
    env.role_file("manager")
    e = {**os.environ, "PM_CONFIG": str(tmp_path / "missing.json")}
    for script, args in (("post_compact.py", ["--mode", "compact"]), ("action_gate.py", ["--event", "pre"]),
                         ("checkpoint_warn.py", [])):
        r = subprocess.run([sys.executable, str(HOOKS / script), *args], input=json.dumps({"cwd": str(env.wt)}),
                           text=True, capture_output=True, env=e, cwd=str(env.wt), timeout=30)
        assert r.returncode == 0 and r.stdout == "" and r.stderr == "", (script, r)


def test_ambiguous_project_warns_then_generic_steps(env):
    env.role_file("manager")
    prof = {"repo_dir": str(env.wt), "epic": "EP-1", "manager_issue": "EP-2"}
    env.write_cfg({"projects": {"a": prof, "b": dict(prof)}})
    out = compact(env)
    assert out.splitlines()[0].startswith("PM HOOK WARNING: project config not resolved")
    assert "POST-COMPACTION RESUME" in out and "EP-2" not in out and "gives no manager_issue" in out


def test_multi_project_selects_by_cwd(env, tmp_path):
    env.role_file("manager")
    env.write_cfg({"defaults": {"claim_ttl_ms": 999},
                   "projects": {"a": {"repo_dir": str(env.wt), "manager_issue": "AA-7"},
                                "b": {"repo_dir": str(tmp_path / "other"), "manager_issue": "BB-7"}}})
    out = compact(env)
    assert "AA-7" in out and "BB-7" not in out and "--ttl-ms 999" in out


# ---------------------------------------------------------------- post_compact
def test_compact_output_renew_ttl_and_extra(env, monkeypatch):
    env.role_file("manager")
    extra = env.tmp / "extra.md"
    extra.write_text("FLEET RULES:\n1. private rule\n")
    env.set(claim_ttl_ms=1234, post_compact_extra=str(extra))
    monkeypatch.setenv("SUBSTRATE_HOLDER", "h1")
    (env.wt / ".substrate-issue").write_text("EP-9\n")
    out = compact(env)
    assert "sb issue renew EP-9 --holder h1 --ttl-ms 1234" in out
    assert "Claim again only if renew reports the lease expired" in out
    assert out.endswith("FLEET RULES:\n1. private rule\n")
    for f in env.refs:
        assert f in out
    start = compact(env, "startup")
    assert "SESSION START" in start and "sb issue renew" not in start and "FLEET RULES" not in start


def test_bound_manager_renews_manager_issue(env, monkeypatch):
    # The epic is bound to the worktree but carries no claim; the manager's claim lives on manager_issue.
    env.role_file("manager")
    env.set(manager_issue="EP-5")
    monkeypatch.setenv("SUBSTRATE_HOLDER", "h1")
    (env.wt / ".substrate-issue").write_text("EP-1\n")
    out = compact(env)
    assert "sb issue resume EP-1" in out and "sb issue renew EP-5 --holder h1" in out
    env.role_file("lead")
    out = compact(env)
    assert "sb issue renew EP-1 --holder h1" in out


def test_unbound_manager_uses_manager_issue_then_epic(env):
    env.role_file("manager")
    env.set(manager_issue="EP-4")
    out = compact(env)
    assert "manager_issue (PM_MANAGER_ISSUE), is EP-4" in out and "sb issue renew EP-4" in out
    del env.cfg["manager_issue"]
    env.write_cfg()
    out = compact(env)
    assert "epic (PM_EPIC), is EP-1" in out and "--ttl-ms 3600000" in out


def test_unbound_lead_is_told_to_bind_its_epic(env):
    env.role_file("lead")
    out = compact(env)
    step1 = next(line for line in out.splitlines() if line.startswith("1. "))
    assert "A lead binds its own epic" in step1 and "EP-1" not in step1
    assert "Substrate epic: EP-1" in out  # the project epic appears only as the common goal


def test_missing_extra_file_is_ignored(env):
    env.role_file("lead")
    env.set(post_compact_extra=str(env.tmp / "nope.md"))
    assert "POST-COMPACTION RESUME" in compact(env)


def test_default_refread_files_resolve_to_the_pack(env):
    del env.cfg["refread_files"]
    env.write_cfg()
    files = common.refread_files("manager")
    assert [pathlib.Path(f).name for f in files] == ["manager.md", "lead.md", "launching.md"]
    assert all(pathlib.Path(f).is_file() for f in files)


def test_nudge_off_by_default_on_when_set(env, monkeypatch):
    env.role_file("manager")
    calls = []
    monkeypatch.setattr(post_compact, "nudge", lambda pane, text: calls.append((pane, text)))
    monkeypatch.setenv("TMUX_PANE", "%7")
    compact(env)
    assert calls == []
    env.set(post_compact_nudge=True)
    compact(env, "startup")
    assert calls == []                      # never in startup mode
    compact(env)
    assert calls == [("%7", post_compact.DEFAULT_NUDGE)]
    env.set(post_compact_nudge_text="/x go")
    monkeypatch.delenv("TMUX_PANE")
    compact(env)
    assert len(calls) == 1                  # no pane, no keystroke


# ---------------------------------------------------------------- action_gate: reference gate
def test_reference_gate_denies_until_all_read_in_full(env):
    env.role_file("manager")
    out = gate(env, "start")
    assert "REFERENCE GATE" in out and "manager.md" in out
    reason = denied(pre(env))
    assert reason and all(f in reason for f in env.refs)
    assert pre(env, "ls -la") == ""                                     # not gated
    gate(env, "post", tool_name="Read", tool_input={"file_path": env.refs[0], "limit": 2})   # partial: still pending
    assert env.refs[0] in denied(pre(env))
    read_all(env)
    assert pre(env) == ""


def test_gated_tools_and_commands_from_config(env):
    env.role_file("lead")
    gate(env, "start")
    assert denied(pre(env, tool="mcp__plugin_x__specialist_dispatch"))
    assert denied(pre(env, tool="Agent"))
    assert pre(env, tool="Read") == ""
    assert denied(pre(env, "xt claude --role pr-reviewer"))
    assert pre(env, "make deploy") == ""
    env.set(gated_commands=[r"\bmake\s+deploy\b"])
    assert denied(pre(env, "make deploy"))
    assert pre(env, "gh pr merge 3") == ""


def test_lazy_arming_without_session_start(env):
    env.role_file("worker")
    assert pre(env) == ""                       # a worker never arms
    env.role_file("manager")                    # role file written after SessionStart
    reason = denied(pre(env))
    assert reason and env.refs[0] in reason
    read_all(env)
    assert pre(env) == ""


def test_override_file_opens_the_reference_gate(env):
    env.role_file("manager")
    gate(env, "start")
    override = action_gate.state_paths("s1")[1]
    override.touch()
    assert pre(env) == ""


def test_missing_reference_file_never_gates(env):
    env.role_file("manager")
    env.set(refread_files={"manager": [str(env.tmp / "gone.md")]})
    assert "missing, not gated" in gate(env, "start")
    assert pre(env) == ""


def test_corrupt_state_fails_open(env):
    env.role_file("manager")
    spath = action_gate.state_paths("s1")[0]
    spath.parent.mkdir(parents=True, exist_ok=True)
    spath.write_text("{not json")
    feed(env.mp, {"cwd": str(env.wt), "session_id": "s1", "tool_name": "Bash",
                  "tool_input": {"command": "gh pr merge 1"}})
    buf = io.StringIO()
    monkey_out = sys.stdout
    sys.stdout = buf
    try:
        assert action_gate.main(["--event", "pre"]) == 0
    finally:
        sys.stdout = monkey_out
    assert buf.getvalue() == ""
    assert "action_gate" in (env.home / ".local" / "state" / "xtrm-pm-hooks" / "errors.log").read_text()


# ---------------------------------------------------------------- action_gate: pending-message guard
def write_routes(env, rows):
    with open(env.lane / "pending-routes.jsonl", "w") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")


def route(rid, age_s, delivered=False, **kw):
    t = datetime.now(timezone.utc) - timedelta(seconds=age_s)
    return {"id": rid, "channel": "jira", "key": "EP-5", "cid": rid.split(":")[-1], "author": "Op", "at": iso(t),
            "trigger": "x", "text": "do it %s" % rid, "seen_at": iso(t), "delivered": delivered, **kw}


def test_pending_guard_denies_once_then_passes(env):
    env.role_file("manager")
    env.set(refread_files={"manager": []})
    write_routes(env, [route("jira:1", 60), route("jira:2", 60, delivered=True), route("jira:3", 7200)])
    reason = denied(pre(env))
    assert reason and "jira:1" in reason and "jira:2" not in reason and "jira:3" not in reason
    assert pre(env) == ""                                    # same set: passes
    write_routes(env, [route("jira:1", 60)])
    assert pre(env) == ""                                    # subset: passes
    write_routes(env, [route("jira:1", 60), route("jira:4", 30)])
    reason = denied(pre(env))
    assert "[new]" in reason and "jira:4" in reason
    assert pre(env) == ""


def test_pending_guard_max_age_setting(env):
    env.role_file("manager")
    env.set(refread_files={"manager": []}, pending_max_age_s=10)
    write_routes(env, [route("jira:1", 60)])
    assert pre(env) == ""


def test_untargeted_rows_are_the_managers_targeted_rows_go_to_their_session(env, monkeypatch):
    env.role_file("lead")
    env.set(refread_files={"lead": []})
    monkeypatch.setenv("SUBSTRATE_HOLDER", "p-xt-claude-EP-1-api-lead")
    write_routes(env, [route("jira:1", 60)])
    assert pre(env) == ""                                    # no target: the manager's
    write_routes(env, [route("jira:1", 60), route("jira:2", 60, to="EP-1-api-lead"),
                       route("jira:3", 60, to="EP-2-ui-lead")])
    reason = denied(pre(env))
    assert "jira:2" in reason and "jira:1" not in reason and "jira:3" not in reason


def test_pending_guard_without_lane_dir_passes(env):
    env.role_file("manager")
    del env.cfg["lane_dir"]
    env.set(refread_files={"manager": []})
    assert pre(env) == ""


def test_pending_guard_lists_open_operator_questions(env, monkeypatch):
    env.role_file("lead")
    env.set(refread_files={"lead": []})
    (env.wt / ".substrate-issue").write_text("EP-7\n")
    now_ms = int(time.time() * 1000)
    journal = {("EP-7", "blocker"): [
        {"id": "j1", "sequence": 3, "createdAt": now_ms - 60_000,
         "semantic": {"for": "operator", "qid": "q-new", "q": "Merge PR 12 now?"}},
        {"id": "j2", "sequence": 4, "createdAt": now_ms - 7_200_000,
         "semantic": {"for": "operator", "qid": "q-old", "q": "Old question?"}}]}
    monkeypatch.setattr(pm_question, "journal_entries", lambda ref, kind, limit=40: journal.get((ref, kind), []))
    reason = denied(pre(env))
    assert "q-new" in reason and "Merge PR 12 now?" in reason and "q-old" not in reason
    assert pre(env) == ""


def test_pending_guard_source_error_fails_open(env, monkeypatch):
    env.role_file("manager")
    env.set(refread_files={"manager": []})
    write_routes(env, [route("jira:1", 60)])
    monkeypatch.setattr(action_gate, "route_items", lambda *a: 1 / 0)
    assert pre(env) == ""


# ---------------------------------------------------------------- checkpoint_warn
def transcript(env, used, model="m1"):
    p = env.tmp / "t.jsonl"
    p.write_text(json.dumps({"message": {"role": "assistant", "model": model,
                                         "usage": {"input_tokens": used, "output_tokens": 0}}}) + "\n")
    return str(p)


def warn(env, used, event="PostToolUse"):
    feed(env.mp, {"cwd": str(env.wt), "session_id": "s1", "hook_event_name": event,
                  "transcript_path": transcript(env, used)})
    out = io.StringIO()
    checkpoint_warn.run(out)
    pm_config._RAW = pm_config._CACHE = None
    return json.loads(out.getvalue())["hookSpecificOutput"]["additionalContext"] if out.getvalue() else ""


def test_checkpoint_thresholds_fire_once_and_rearm(env, monkeypatch):
    env.role_file("manager")
    monkeypatch.setenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "100000")
    assert warn(env, 50_000) == ""
    early = warn(env, 72_000)
    assert "CONTEXT CHECKPOINT (EARLY)" in early
    assert warn(env, 74_000) == ""
    assert "CONTEXT CHECKPOINT (FINAL)" in warn(env, 86_000)
    assert warn(env, 90_000) == ""
    assert warn(env, 20_000) == ""                       # compacted: re-armed
    assert "EARLY" in warn(env, 71_000)


def test_checkpoint_thresholds_from_config(env, monkeypatch):
    env.role_file("lead")
    env.set(checkpoint_thresholds=[0.5])
    monkeypatch.setenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "100000")
    assert "FINAL" in warn(env, 55_000)


def test_checkpoint_ref_fallback(env, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "100000")
    env.role_file("manager")
    env.set(manager_issue="EP-3")
    assert "handoff entry on EP-3 (the manager issue from the project config" in warn(env, 80_000)
    env.role_file("lead")
    msg = warn(env, 99_000)
    assert "bind your own epic first" in msg and "EP-3" not in msg
    (env.wt / ".substrate-issue").write_text("EP-8\n")
    (env.home / ".local" / "state" / "xtrm-pm-hooks" / "ctx-warn" / "s1.json").unlink()
    assert "handoff entry on EP-8:" in warn(env, 80_000)


def test_checkpoint_skips_workers_and_no_project(env, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "100000")
    env.role_file("worker")
    assert warn(env, 90_000) == ""
    env.role_file("manager")
    env.set(repo_dir=str(env.tmp / "elsewhere"))
    assert warn(env, 90_000) == ""

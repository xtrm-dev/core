"""Tests for hooks/promise-check.py (XTRM-804). No network, no sb, no tmux.

Run: python3 -m pytest hooks/test_promise_check.py
"""
import importlib.util
import io
import json
import pathlib
import sqlite3
import sys

import pytest

HOOKS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HOOKS.parent / "scripts"))
import pm_config  # noqa: E402

HOOK = HOOKS / "promise-check.py"
spec = importlib.util.spec_from_file_location("promise_check", HOOK)
pc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pc)

CLEARED = ("PM_PROJECT", "XTMUX_AGENT_ROLE", "SUBSTRATE_HOLDER", "XTRM_SESSION_NAME", "SUBSTRATE_ISSUE_REF",
           "CLAUDE_PROJECT_DIR", "SUBSTRATE_DB", "PM_PROMISE_CHECK_TURNS", "PM_STATE_DIR", "TMUX_PANE",
           "XTRM_ROLE", "PM_EPIC", "PM_MANAGER_ISSUE")

# The state.db columns these tests read (the real schema's shape, not a re-creation of it).
SCHEMA = """
CREATE TABLE projects (id TEXT PRIMARY KEY, prefix TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INT);
CREATE TABLE issues (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, human_number INT NOT NULL, kind TEXT,
                     title TEXT, lifecycle_state TEXT, created_at INT, updated_at INT);
CREATE TABLE issue_journal (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, sequence INT NOT NULL, kind TEXT NOT NULL,
                            semantic_json TEXT, created_at INT, UNIQUE (issue_id, sequence));
CREATE TABLE issue_aliases (alias TEXT PRIMARY KEY, issue_id TEXT NOT NULL, kind TEXT, created_at INT);
CREATE TABLE issue_locator_history (project_id TEXT, locator TEXT, issue_id TEXT, created_at INT,
                                    PRIMARY KEY (project_id, locator));
"""


# The transcript's own timestamp: a promise made at this instant is kept only by an entry created after it.
PROMISE_AT = "2026-11-16T12:00:00.000Z"
PROMISE_MS = 1_794_830_400_000          # date -u -d 2026-11-16T12:00:00Z +%s%3N


def make_db(path, journal=(), issue_id="iss_ep7", prefix="EP", number=7, created=()):
    """A fake state.db: one project prefix, one issue, and the given journal rows (seq, kind, semantic) or
    (seq, kind, semantic, created_ms)."""
    con = sqlite3.connect(str(path))
    con.executescript(SCHEMA)
    con.execute("insert into projects values (?,?,?,0)", ("prj_test", prefix, "test"))
    con.execute("insert into issues values (?,?,?,?,?,?,0,0)", (issue_id, "prj_test", number, "task", "t", "open"))
    for n, row in enumerate(journal):
        seq, kind, semantic = row[:3]
        created_ms = row[3] if len(row) > 3 else (created[n] if n < len(created) else 1_764_000_000_000 + seq)
        con.execute("insert into issue_journal values (?,?,?,?,?,?)",
                    ("j%d" % seq, issue_id, seq, kind, json.dumps(semantic), created_ms))
    con.commit()
    con.close()
    return str(path)


@pytest.fixture(autouse=True)
def env(tmp_path, monkeypatch):
    cfg = tmp_path / "pm.json"
    cfg.write_text(json.dumps({"repo_dir": str(tmp_path / "wt"), "epic": "EP-7", "state_dir": str(tmp_path / "state")}))
    (tmp_path / "wt").mkdir()
    for k in CLEARED:
        monkeypatch.setenv(k, "_")  # so monkeypatch restores the original (absent) value after a test sets it
        monkeypatch.delenv(k)
    monkeypatch.setenv("PM_CONFIG", str(cfg))
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path / "wt"))
    monkeypatch.setattr(pm_config, "_RAW", None)
    monkeypatch.setattr(pm_config, "_CACHE", None)
    yield tmp_path
    pm_config._RAW = pm_config._CACHE = None


def assistant_text(text, tools=(), at=None):
    content = [{"type": "text", "text": text}]
    content += [{"type": "tool_use", "name": t, "input": {}} for t in tools]
    return json.dumps({"type": "assistant", "timestamp": at or PROMISE_AT,
                       "message": {"role": "assistant", "content": content}})


def operator(text):
    return json.dumps({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}})


def transcript(tmp, lines):
    p = tmp / "t.jsonl"
    p.write_text("\n".join(lines) + "\n")
    return str(p)


def stop(tmp, env, path, session="s1", **kw):
    return pc.on_stop({"session_id": session, "cwd": str(tmp / "wt"), "hook_event_name": "Stop",
                       "transcript_path": path, **kw}, 1000.0)


PROMISE = "Merci. I will ask you after the 18:00Z acceptance whether to flip the E1 options."
BARE = "Done: the suite is green and all 12 tests pass."


def role_lead(tmp):
    (tmp / "wt" / ".pm-role").write_text("lead\n")


# ---------------------------------------------------------------- detection
@pytest.mark.parametrize("text", [
    "I will ask you after the 18:00Z acceptance.",
    "By 12:30Z I will merge #1580 once the gate is green.",
    "I will tell you at the 14:00Z look-ahead.",
    "I will merge when the promote-merge run ends.",
    "Ti chiedo dopo la finestra delle 18:00Z se procedere.",
])
def test_extracts_a_bound_promise(text):
    got = pc.extract_promises(text)
    assert got and got[0]["key"], text
    assert pc.extract_promises(text)[0]["key"] in text


@pytest.mark.parametrize("text", [
    BARE,
    "I will keep the monitor armed.",                      # a commitment with no time or event word
    "The merge went in at 12:30Z.",                        # a time but no commitment
    "```\nI will ask you after the 18:00Z acceptance.\n```",
])
def test_ignores_unbound_text(text):
    assert pc.extract_promises(text) == []


# ---------------------------------------------------------------- Stop behaviour
def test_untracked_promise_blocks_stop(env, monkeypatch):
    role_lead(env)
    make_db(env / "state.db")
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    (env / "wt" / ".substrate-issue").write_text("EP-7\n")
    path = transcript(env, [operator("status?"), assistant_text(PROMISE)])
    assert stop(env, None, path) is None      # turn 1: the promise is recorded, not yet due (default 3 turns)
    assert stop(env, None, path) is None
    assert stop(env, None, path) is None
    out = stop(env, None, path)               # turn 4: 3 turns since the promise, nothing durable
    assert out and out["decision"] == "block"
    assert "18:00Z" in out["reason"] and "EP-7" in out["reason"] and "CronCreate" in out["reason"]
    assert "no later CronCreate" in out["reason"]


def test_later_croncreate_passes(env, monkeypatch):
    role_lead(env)
    make_db(env / "state.db")
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    (env / "wt" / ".substrate-issue").write_text("EP-7\n")
    path = transcript(env, [assistant_text(PROMISE), assistant_text("Armed.", tools=["CronCreate"])])
    for _ in range(5):
        assert stop(env, None, path) is None


def test_later_journal_entry_naming_the_key_time_passes(env, monkeypatch):
    role_lead(env)
    make_db(env / "state.db", journal=[(9, "decision", {"summary": "promise: ask the operator at 18:00Z",
                                                       "due_utc": "2026-11-16T18:00Z", "timer_id": "4d01d735"},
                                        PROMISE_MS + 60_000)])
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    (env / "wt" / ".substrate-issue").write_text("EP-7\n")
    path = transcript(env, [assistant_text(PROMISE)])
    for _ in range(5):
        assert stop(env, None, path) is None


def test_an_older_entry_mentioning_the_time_does_not_keep_a_new_promise(env, monkeypatch):
    """The reviewer's HIGH finding: any old entry mentioning 18:00Z used to keep every new 18:00Z promise."""
    role_lead(env)
    make_db(env / "state.db", journal=[(9, "decision", {"summary": "promise: ask the operator at 18:00Z",
                                                       "due_utc": "2026-11-16T18:00Z"},
                                        PROMISE_MS - 3_600_000)])
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    (env / "wt" / ".substrate-issue").write_text("EP-7\n")
    path = transcript(env, [assistant_text(PROMISE)])
    for _ in range(3):
        assert stop(env, None, path) is None
    out = stop(env, None, path)
    assert out["decision"] == "block" and "18:00Z" in out["reason"]


def test_a_plain_summary_naming_the_time_does_not_keep_a_promise(env, monkeypatch):
    """A later entry that merely mentions the window ('window 18:00Z opens') is not a promise record."""
    role_lead(env)
    make_db(env / "state.db", journal=[(9, "decision", {"summary": "window 18:00Z opens, nothing to check"},
                                        PROMISE_MS + 60_000)])
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    (env / "wt" / ".substrate-issue").write_text("EP-7\n")
    path = transcript(env, [assistant_text(PROMISE)])
    for _ in range(3):
        assert stop(env, None, path) is None
    assert stop(env, None, path)["decision"] == "block"


def test_a_promise_shaped_later_entry_keeps_it(env, monkeypatch):
    role_lead(env)
    make_db(env / "state.db", journal=[(9, "decision", {"summary": "promise: ask the operator at 18:00Z"},
                                        PROMISE_MS + 60_000)])
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    (env / "wt" / ".substrate-issue").write_text("EP-7\n")
    path = transcript(env, [assistant_text(PROMISE)])
    for _ in range(5):
        assert stop(env, None, path) is None


def test_a_free_text_mention_outside_the_promise_fields_does_not_count(env, monkeypatch):
    role_lead(env)
    make_db(env / "state.db", journal=[(9, "note", {"context": "promise-ish window 18:00Z went fine"},
                                        PROMISE_MS + 60_000)])
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    (env / "wt" / ".substrate-issue").write_text("EP-7\n")
    path = transcript(env, [assistant_text(PROMISE)])
    for _ in range(3):
        assert stop(env, None, path) is None
    assert stop(env, None, path)["decision"] == "block"


def test_an_event_promise_keeps_the_whole_phrase(env, monkeypatch):
    got = pc.extract_promises("I will merge when the E1 options flip and the board is green.")
    assert got[0]["key"].startswith("when the E1 options")
    assert got[0]["key"] != "when the"


def test_cron_before_the_promise_does_not_count(env, monkeypatch):
    role_lead(env)
    make_db(env / "state.db")
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    (env / "wt" / ".substrate-issue").write_text("EP-7\n")
    path = transcript(env, [assistant_text("Armed.", tools=["CronCreate"]), assistant_text(PROMISE)])
    for _ in range(3):
        assert stop(env, None, path) is None
    assert stop(env, None, path)["decision"] == "block"


def test_zero_turns_disables_the_hook(env, monkeypatch):
    role_lead(env)
    make_db(env / "state.db")
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    monkeypatch.setenv("PM_PROMISE_CHECK_TURNS", "0")
    (env / "wt" / ".substrate-issue").write_text("EP-7\n")
    path = transcript(env, [assistant_text(PROMISE)])
    for _ in range(6):
        assert stop(env, None, path) is None


def test_settings_turns_from_the_config_file(env, monkeypatch):
    role_lead(env)
    make_db(env / "state.db")
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    (env / "pm.json").write_text(json.dumps({"repo_dir": str(env / "wt"), "epic": "EP-7",
                                             "state_dir": str(env / "state"), "promise_check_turns": 1}))
    monkeypatch.setattr(pm_config, "_RAW", None)
    monkeypatch.setattr(pm_config, "_CACHE", None)
    (env / "wt" / ".substrate-issue").write_text("EP-7\n")
    path = transcript(env, [assistant_text(PROMISE)])
    pc_cfg = json.loads((env / "pm.json").read_text())
    assert pc_cfg["promise_check_turns"] == 1
    assert stop(env, None, path) is None
    out = stop(env, None, path)               # one turn later
    assert out and out["decision"] == "block"


def test_stop_hook_active_emits_nothing(env, monkeypatch):
    role_lead(env)
    make_db(env / "state.db")
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    (env / "wt" / ".substrate-issue").write_text("EP-7\n")
    path = transcript(env, [assistant_text(PROMISE)])
    outs = [stop(env, None, path) for _ in range(4)]
    assert outs[:3] == [None, None, None] and outs[3]          # due on the 4th Stop
    assert stop(env, None, path, stop_hook_active=True) is None


def test_reminder_repeats_at_most_once_per_n_turns(env, monkeypatch):
    role_lead(env)
    make_db(env / "state.db")
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    (env / "wt" / ".substrate-issue").write_text("EP-7\n")
    path = transcript(env, [assistant_text(PROMISE)])
    outs = [stop(env, None, path) for _ in range(8)]
    fired = [i for i, o in enumerate(outs) if o]
    assert fired == [3, 6]                    # turn 4, then 3 turns later


def test_workers_and_unknown_projects_are_untouched(env, monkeypatch):
    make_db(env / "state.db")
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    path = transcript(env, [assistant_text(PROMISE)])
    (env / "wt" / ".pm-role").write_text("worker\n")
    assert all(stop(env, None, path) is None for _ in range(6))
    role_lead(env)
    (env / "pm.json").write_text(json.dumps({"repo_dir": str(env / "elsewhere"), "epic": "EP-7",
                                             "state_dir": str(env / "state")}))
    monkeypatch.setattr(pm_config, "_RAW", None)
    monkeypatch.setattr(pm_config, "_CACHE", None)
    assert all(stop(env, None, path) is None for _ in range(6))


def test_unreadable_state_db_does_not_claim_a_missing_journal_entry(env, monkeypatch):
    """The reviewer's MEDIUM finding: an unreadable store must not be reported as 'no journal entry'."""
    role_lead(env)
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "missing.db"))
    (env / "wt" / ".substrate-issue").write_text("EP-7\n")
    path = transcript(env, [assistant_text(PROMISE)])
    outs = [stop(env, None, path) for _ in range(4)]
    assert outs[-1]["decision"] == "block"          # a missing timer still stands
    assert "could not be checked (state.db unreadable)" in outs[-1]["reason"]
    assert "no later journal entry on it" not in outs[-1]["reason"]


def test_one_journal_read_per_stop(env, monkeypatch):
    """A Stop with many promises must not pay one SQL scan per promise (measured 1.3 s CPU for 40 before the fix)."""
    role_lead(env)
    make_db(env / "state.db", journal=[(9, "decision", {"summary": "promise: ask at 18:00Z", "due_utc": "18:00Z"},
                                        PROMISE_MS + 60_000)])
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    (env / "wt" / ".substrate-issue").write_text("EP-7\n")
    reads = []
    real = pc.common.promise_records

    def counted(ref, since_ms):
        reads.append(since_ms)
        return real(ref, since_ms)

    monkeypatch.setattr(pc.common, "promise_records", counted)
    lines = [assistant_text("I will ask you after the %d:00Z acceptance." % h) for h in range(10, 20)]
    path = transcript(env, lines)
    for _ in range(4):
        stop(env, None, path)
    assert len(reads) == 4                    # one read per Stop (4 Stops), NOT one per promise (10 promises each)
    assert len(reads) < 40


def test_an_unbound_issue_is_not_blamed_on_the_store(env, monkeypatch):
    """The last LOW: no bound issue must not read as "state.db unreadable"."""
    role_lead(env)
    make_db(env / "state.db")
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    path = transcript(env, [assistant_text(PROMISE)])          # no .substrate-issue, no PM_MANAGER_ISSUE (role lead)
    outs = [stop(env, None, path) for _ in range(4)]
    assert outs[-1]["decision"] == "block"
    assert "no bound issue" in outs[-1]["reason"]
    assert "state.db unreadable" not in outs[-1]["reason"]


def test_a_line_without_a_timestamp_says_so(env, monkeypatch):
    """A transcript line with no timestamp cannot prove "later", and the reminder must not blame state.db."""
    role_lead(env)
    make_db(env / "state.db")
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    (env / "wt" / ".substrate-issue").write_text("EP-7\n")
    line = assistant_text(PROMISE).replace('"timestamp": "%s"' % "2026-11-16T12:00:00.000Z", '"no_timestamp": 1')
    path = transcript(env, [line])
    outs = [stop(env, None, path) for _ in range(4)]
    assert outs[-1]["decision"] == "block"
    assert "no timestamp" in outs[-1]["reason"] and "state.db unreadable" not in outs[-1]["reason"]


def test_an_unbound_manager_falls_back_to_the_configured_manager_issue(env, monkeypatch):
    role_file = env / "wt" / ".pm-role"
    role_file.write_text("manager\n")
    make_db(env / "state.db", prefix="EP", number=7)
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    monkeypatch.setenv("PM_MANAGER_ISSUE", "EP-7")
    path = transcript(env, [assistant_text(PROMISE)])
    outs = [stop(env, None, path) for _ in range(4)]
    assert outs[-1]["decision"] == "block" and "EP-7" in outs[-1]["reason"]


def test_read_only_handle_refuses_a_write(env, monkeypatch):
    """The reviewer's mutation: mode=ro -> mode=rw survived every test."""
    make_db(env / "state.db")
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    con = pc.common._db()
    try:
        with pytest.raises(sqlite3.OperationalError):
            con.execute("delete from issue_journal")
    finally:
        con.close()


# ---------------------------------------------------------------- process boundary
def run_main(monkeypatch, payload, argv=()):
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload)))
    monkeypatch.setattr(sys, "stdout", out)
    code = pc.main(list(argv))
    return code, out.getvalue()


def test_main_writes_nothing_for_a_worker(env, monkeypatch):
    """Two Stops at turns=1: a worker must still be silent, and must leave no state file behind."""
    make_db(env / "state.db")
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    monkeypatch.setenv("PM_PROMISE_CHECK_TURNS", "1")
    (env / "wt" / ".pm-role").write_text("worker\n")
    path = transcript(env, [assistant_text(PROMISE)])
    payload = {"session_id": "s9", "cwd": str(env / "wt"), "transcript_path": path}
    assert [run_main(monkeypatch, payload) for _ in range(2)] == [(0, ""), (0, "")]
    assert not list((env / "state").rglob("s9.json"))     # the applies() gate, now observable
    assert run_main(monkeypatch, payload, ["--event", "prompt"]) == (0, "")
    assert not list((env / "state").rglob("s9.json"))


def test_main_emits_the_block_json_for_a_lead(env, monkeypatch):
    role_lead(env)
    make_db(env / "state.db")
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    monkeypatch.setenv("PM_PROMISE_CHECK_TURNS", "1")
    (env / "wt" / ".substrate-issue").write_text("EP-7\n")
    path = transcript(env, [assistant_text(PROMISE)])
    payload = {"session_id": "s8", "cwd": str(env / "wt"), "transcript_path": path}
    assert run_main(monkeypatch, payload) == (0, "")      # first turn: not yet due
    code, out = run_main(monkeypatch, payload)
    assert code == 0 and json.loads(out)["decision"] == "block"


def test_prompt_event_restarts_the_counter_for_a_lead_but_not_a_worker(env, monkeypatch):
    role_lead(env)
    make_db(env / "state.db")
    monkeypatch.setenv("SUBSTRATE_DB", str(env / "state.db"))
    (env / "wt" / ".substrate-issue").write_text("EP-7\n")
    path = transcript(env, [assistant_text(PROMISE)])
    payload = {"session_id": "s7", "cwd": str(env / "wt"), "transcript_path": path}
    assert run_main(monkeypatch, payload) == (0, "")          # turn 1
    state = json.loads(next((env / "state").rglob("s7.json")).read_text())
    assert state["turns"] == 1
    assert run_main(monkeypatch, payload, ["--event", "prompt"]) == (0, "")
    assert json.loads(next((env / "state").rglob("s7.json")).read_text())["turns"] == -1
    (env / "wt" / ".pm-role").write_text("worker\n")          # a worker's prompt writes nothing
    assert run_main(monkeypatch, {**payload, "session_id": "s6"}, ["--event", "prompt"]) == (0, "")
    assert not list((env / "state").rglob("s6.json"))


def test_main_is_silent_without_stdin(env, monkeypatch):
    monkeypatch.setattr(sys, "stdin", io.StringIO("{}"))
    assert pc.main([]) == 0

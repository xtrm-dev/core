"""Tests for hooks/operator-questions.py (XTRM-763). Run: python3 -m pytest hooks/test_operator_questions.py"""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import time

import pytest

HOOKS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HOOKS.parent / "scripts"))
import pm_config  # noqa: E402
import pm_question  # noqa: E402

HOOK = HOOKS / "operator-questions.py"
spec = importlib.util.spec_from_file_location("operator_questions", HOOK)
oq = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oq)

OWNER = "EP-1-api-lead"
IDENT = "proj-xt-claude-EP-1-api-lead"
QUESTION = "Vuoi che proceda con il merge della PR 12 prima della finestra?"


@pytest.fixture(autouse=True)
def env(tmp_path, monkeypatch):
    cfg = tmp_path / "pm.json"
    cfg.write_text(json.dumps({"state_dir": str(tmp_path / "state"), "status_board_site": "site-x", "epic": "EP-1",
                               "operator_question_turns": 5}))
    for k in ("PM_PROJECT", "XTRM_ROLE", "PM_STATE_DIR", "PM_OPERATOR_QUESTION_TURNS", "PM_QUESTION_OWNER"):
        monkeypatch.setenv(k, "_")   # so monkeypatch restores the original (absent) value after a test sets it directly
        monkeypatch.delenv(k)
    monkeypatch.setenv("PM_CONFIG", str(cfg))
    monkeypatch.setenv("SUBSTRATE_HOLDER", IDENT)
    pm_config._RAW = pm_config._CACHE = oq._NAME_RE = None
    yield tmp_path
    pm_config._RAW = pm_config._CACHE = oq._NAME_RE = None


def stop(session="s1", **kw):
    return {"session_id": session, "cwd": "/x", "hook_event_name": "Stop", **kw}


def no_row(_path):
    return None


def run_stops(n, fetch=no_row, text=QUESTION, t0=1000.0, journal=lambda ref, kind: [], session="s1"):
    """The operator speaks, the model answers (the answering Stop carries ``text``), then n silent Stops. Returns the n outputs."""
    oq.on_prompt({"session_id": session, "prompt": "ciao"}, t0 - 1)
    oq.on_stop(stop(session, last_assistant_message=text), t0 - 0.5, fetch=fetch, journal=journal)
    return [oq.on_stop(stop(session, last_assistant_message="working"), t0 + i, fetch=fetch, journal=journal)
            for i in range(n)]


# ---------------------------------------------------------------- classifier
@pytest.mark.parametrize("prompt", [
    '<cross-session-message message-id="m1" from="peer-session">hi</cross-session-message>',
    "<task-notification><task-id>b1</task-id></task-notification>",
    "[Cross-session delivery notice] message m1 delivered",
    "[SYSTEM NOTIFICATION] context 80%",
    "  <system-reminder>x</system-reminder>",
    "Stop hook feedback: keep going",
    "[cron] daily report 22:17Z",
    "<<autonomous-loop-dynamic>>",
    "Goal check-in: condition not met yet",
    "/goal keep the window alive",
    "",
    "   ",
])
def test_injected_prompts_are_not_operator(prompt):
    assert oq.classify_prompt(prompt) == "injected"


@pytest.mark.parametrize("prompt", [
    "ok vai pure con la scelta A",
    "yes, merge it",
    "/compact",
    "What is the state of the window?",
    "Pat: <cross-session-message in the middle is still the operator typing",
])
def test_operator_prompts(prompt):
    assert oq.classify_prompt(prompt) == "operator"


def test_extra_injected_patterns_from_config():
    assert oq.classify_prompt("WINDOW CRON fire: run pre-check", [r"^WINDOW CRON"]) == "injected"
    assert oq.classify_prompt("WINDOW CRON fire", ["("]) == "operator"  # bad regex is ignored


# ---------------------------------------------------------------- detection
@pytest.mark.parametrize("text", [
    "Vuoi che proceda con il merge della PR 12?",
    "Posso cancellare il worktree vecchio?",
    "Do you want me to merge PR 12 before the window?",
    "Should I discard the uncommitted edit in the primary checkout?",
    "Hai tre strade. Quale preferisci?\nA) merge ora\nB) merge dopo la finestra\nC) chiudi la PR",
    "Choose one:\n1. rollback\n2. forward fix",
])
def test_detects_operator_questions(text):
    assert oq.detect_questions(text), text


@pytest.mark.parametrize("text", [
    "Why is the test failing? Because the fixture leaks state.",
    "Done. All 12 tests pass.",
    "```\nDo you want this?\n```\nNo question outside the fence.",
    "> Vuoi proceder? (quoted from the operator)\nOk.",
    "- A) first item of a plain list\n- B) second item, no question anywhere\nDone.",
    "",
])
def test_ignores_non_questions(text):
    assert oq.detect_questions(text) == []


def test_question_id_is_stable_and_matches_cli():
    (qid, q), = oq.detect_questions(QUESTION)
    assert qid == pm_question.qid_of(q) == pm_question.qid_of(q.upper() + "  ")


def test_abc_block_is_one_question_with_options():
    (qid, q), = oq.detect_questions("Quale preferisci?\nA) merge ora\nB) dopo la finestra")
    assert "merge ora" in q and "dopo la finestra" in q


# ---------------------------------------------------------------- counter and reminder
def test_operator_turn_resets_counter_injected_does_not(env):
    oq.on_stop(stop(last_assistant_message="x"), 1.0)
    oq.on_stop(stop(), 2.0)
    assert oq.load_state("s1")["turns"] == 2
    oq.on_prompt({"session_id": "s1", "prompt": "<task-notification>x</task-notification>"}, 3.0)
    assert oq.load_state("s1")["turns"] == 2
    oq.on_prompt({"session_id": "s1", "prompt": "ok procedi"}, 4.0)
    st = oq.load_state("s1")
    assert st["turns"] == 0 and st["last_operator_ts"] == 4.0 and st["chat"] == {} and st["reminded"] == {}
    oq.on_stop(stop(last_assistant_message="risposta"), 5.0)   # the Stop ending the operator's own turn is not silent
    assert oq.load_state("s1")["turns"] == 0
    oq.on_stop(stop(), 6.0)
    assert oq.load_state("s1")["turns"] == 1


def test_no_reminder_before_n_turns_then_exactly_one(env):
    outs = run_stops(5)
    assert outs[:4] == [None] * 4
    block = outs[4]
    assert block["decision"] == "block"
    reason = block["reason"]
    assert QUESTION in reason and "pm_question.py add" in reason and "--ref EP-1" in reason
    assert pm_question.qid_of(QUESTION) in reason and "questions/%s" % OWNER in reason
    # the board-helper hand-off: one @operator Jira comment per open question, exact text and ticket key
    assert "hand the board helper an @operator comment for the Jira ticket of EP-1" in reason
    assert json.dumps(QUESTION, ensure_ascii=False) in reason and "post-guard.py --mention-first" in reason


def test_reminder_once_per_n_turns(env):
    outs = run_stops(5 + 4 + 1)            # turns 6..9 silent, turn 10 due again
    assert [i + 1 for i, o in enumerate(outs) if o] == [5, 10]


def test_operator_turn_resets_the_clock(env):
    run_stops(4)
    oq.on_prompt({"session_id": "s1", "prompt": "ancora niente"}, 2000.0)
    outs = [oq.on_stop(stop(), 2001.0 + i, fetch=no_row, journal=lambda r, k: []) for i in range(6)]
    assert outs == [None] * 6   # the chat question was dropped by the operator turn


def test_stop_hook_active_emits_nothing_and_does_not_count(env):
    run_stops(4)
    assert oq.on_stop(stop(stop_hook_active=True), 9.0, fetch=no_row) is None
    assert oq.load_state("s1")["turns"] == 4


def test_current_row_suppresses_reminder_stale_row_asks_refresh(env):
    qid = pm_question.qid_of(QUESTION)
    fresh = lambda _p: ("rid", {"rows": [{"id": qid, "q": QUESTION, "at": "2026-11-13T03:00:04Z"}]}, "")
    stale = lambda _p: ("rid", {"rows": [{"id": qid, "q": QUESTION, "at": "2020-01-01T00:00Z"}]}, "")
    t0 = pm_question.parse_ts("2026-11-13T03:00:00Z")
    assert run_stops(5, fetch=fresh, t0=t0, session="a") == [None] * 5
    pm_question.invalidate(OWNER)   # the doc cache is shared by sessions of one coordinator
    out = run_stops(5, fetch=stale, t0=t0, session="b")[4]
    assert "pm_question.py refresh --id %s" % qid in out["reason"] and "stale row" in out["reason"]


def test_hn_unreachable_fails_open_and_retries(env):
    def boom(_p):
        raise RuntimeError("here.now down")
    assert run_stops(5, fetch=boom) == [None] * 5
    assert oq.load_state("s1")["reminded"] == {}   # nothing marked reminded: next Stop retries


def test_blocker_question_open_until_decision(env):
    blk = {"id": "jrn_1", "sequence": 3, "kind": "blocker", "semantic": {"for": "operator", "q": "Which window?", "rec": "A"}}
    other = {"id": "jrn_2", "sequence": 4, "kind": "blocker", "semantic": {"for": "worker", "q": "x"}}
    dec = {"id": "jrn_3", "sequence": 5, "kind": "decision", "semantic": {"answers": pm_question.qid_of("jrn_1")}}
    entries = {("EP-1", "blocker"): [blk, other], ("EP-1", "decision"): []}
    j = lambda ref, kind: entries.get((ref, kind), [])
    (q,) = oq.blocker_questions(["EP-1"], j)
    assert q["q"] == "Which window?" and q["ref"] == "EP-1" and q["rec"] == "A"
    entries[("EP-1", "decision")] = [dec]
    assert oq.blocker_questions(["EP-1"], j) == []
    blk["semantic"]["qid"] = "q-custom"
    entries[("EP-1", "decision")] = [{"sequence": 5, "semantic": {"answers": "q-custom"}}]
    assert oq.blocker_questions(["EP-1"], j) == []
    entries[("EP-1", "decision")] = [{"sequence": 2, "semantic": {"answers": "q-custom"}}]  # earlier decision: still open
    assert len(oq.blocker_questions(["EP-1"], j)) == 1


def test_blocker_reminder_prefills_ref_and_rec(env):
    blk = {"id": "jrn_1", "sequence": 3, "kind": "blocker", "semantic": {"for": "operator", "q": "Which window?", "rec": "go A"}}
    j = lambda ref, kind: [blk] if kind == "blocker" else []
    out = run_stops(5, text="working", journal=j)[4]
    assert "--ref EP-1" in out["reason"] and "'go A'" in out["reason"]


def test_turns_setting_and_off_switch(env, monkeypatch):
    monkeypatch.setenv("PM_OPERATOR_QUESTION_TURNS", "2")
    assert run_stops(2)[1]["decision"] == "block"
    monkeypatch.setenv("PM_OPERATOR_QUESTION_TURNS", "0")
    assert run_stops(6, session="off") == [None] * 6


# ---------------------------------------------------------------- gating (main)
def call_main(event, payload, monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO(json.dumps(payload)))
    oq.main(["--event", event])
    return capsys.readouterr().out


def test_non_coordinator_is_untouched(env, monkeypatch, capsys):
    monkeypatch.setenv("SUBSTRATE_HOLDER", "XTRM-763-worker")
    assert call_main("prompt", {"session_id": "w", "prompt": "hi"}, monkeypatch, capsys) == ""
    assert call_main("stop", stop("w", last_assistant_message=QUESTION), monkeypatch, capsys) == ""
    assert not (env / "state" / "operator-questions").exists()


@pytest.mark.parametrize("ident,yes", [("proj-xt-claude-thu13-manager", True), ("fri14-manager", True),
                                        ("thu13-manager-2", True), ("EP-1-api-lead", True),
                                        ("proj-xt-claude-EP-2-ui-lead", True), ("EP-2-ui-lead-12", True),
                                        ("alpha-coord", True), ("beta-coord-3", True), ("mon-coord-123", False),
                                        ("alpha-coord-board", False), ("EP-1-lead-worker", False),
                                        ("proj-xt-pi-board-helper", False), ("proj-xt-claude-SB-12-fix-parser", False),
                                        ("XTRM-763-worker", False), ("leader", False), ("manager", False)])
def test_coordinator_pattern(env, ident, yes):
    assert oq.is_coordinator(ident) is yes


def test_xtrm_role_overrides_name(env, monkeypatch):
    monkeypatch.setenv("XTRM_ROLE", "worker")
    assert oq.is_coordinator("thu13-manager") is False
    for role in ("coordinator", "manager", "lead"):
        monkeypatch.setenv("XTRM_ROLE", role)
        assert oq.is_coordinator("plain-name") is True


def test_multi_project_config_needs_explicit_project(env, monkeypatch, tmp_path):
    cfg = tmp_path / "multi.json"
    cfg.write_text(json.dumps({"projects": {"a": {"repo_dir": str(tmp_path / "a")}, "b": {"repo_dir": str(tmp_path / "b")}}}))
    monkeypatch.setenv("PM_CONFIG", str(cfg))
    pm_config._RAW = pm_config._CACHE = None
    assert oq.project_applies(str(tmp_path / "elsewhere")) is False
    assert oq.project_applies(str(tmp_path / "b")) is True and os.environ["PM_PROJECT"] == "b"
    monkeypatch.setenv("PM_PROJECT", "zzz")
    assert oq.project_applies(str(tmp_path)) is False


def test_internal_error_fails_open(env, monkeypatch, capsys):
    monkeypatch.setattr(oq, "on_stop", lambda *a, **k: 1 / 0)
    assert call_main("stop", stop("s1"), monkeypatch, capsys) == ""
    assert "ZeroDivisionError" in (env / "state" / "operator-questions" / "errors.log").read_text()


# ---------------------------------------------------------------- end to end, real process, synthetic transcript
def transcript(path, texts):
    with open(path, "w") as fh:
        for t in texts:
            fh.write(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": t}]}}) + "\n")


def hook(event, payload, env_extra):
    e = {**os.environ, **env_extra}
    r = subprocess.run([sys.executable, str(HOOK), "--event", event], input=json.dumps(payload), text=True,
                       capture_output=True, env=e, timeout=30)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def test_end_to_end_synthetic_session(env):
    cfg = env / "pm.json"
    e = {"PM_CONFIG": str(cfg), "SUBSTRATE_HOLDER": IDENT, "PM_OPERATOR_QUESTION_TURNS": "5"}
    e.pop("PM_PROJECT", None)
    tpath = env / "t.jsonl"
    # warm the Status board doc cache with "no row yet" so the run needs no network
    cache = pm_question.state_root() / ("doc-%s.json" % OWNER)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps({"at": time.time(), "rows": [], "updatedAt": ""}))
    sid = {"session_id": "e2e", "cwd": "/x", "transcript_path": str(tpath)}
    assert hook("prompt", {**sid, "prompt": "pianifica la finestra di domani"}, e) == ""
    transcript(tpath, ["Ho pronto il piano. " + QUESTION])
    assert hook("stop", {**sid, "hook_event_name": "Stop"}, e) == ""        # the operator's own turn: not counted
    outs = []
    for i in range(5):                                                       # injected prompts: silent turns 1..5
        assert hook("prompt", {**sid, "prompt": "<task-notification>done %d</task-notification>" % i}, e) == ""
        transcript(tpath, ["Ok, continuo."])
        outs.append(hook("stop", {**sid, "hook_event_name": "Stop"}, e))
    assert outs[:4] == [""] * 4
    reminder = json.loads(outs[4])
    assert reminder["decision"] == "block" and QUESTION in reminder["reason"]
    assert hook("stop", {**sid, "stop_hook_active": True}, e) == ""         # the forced extra turn: no loop
    assert hook("stop", {**sid, "hook_event_name": "Stop"}, e) == ""        # next turn: already reminded
    hook("prompt", {**sid, "prompt": "ok, vai"}, e)                          # operator speaks: reset
    assert oq.load_state("e2e")["turns"] == 0


# ---------------------------------------------------------------- review findings (XTRM-763 reviewer)
def test_command_carries_the_hook_id(env):
    long_q = ("Vuoi che proceda con " + "il merge " * 60 + "adesso?")
    blk = {"id": "jrn_9", "sequence": 1, "kind": "blocker", "semantic": {"for": "operator", "q": long_q, "rec": "si"}}
    out = run_stops(5, text="working", journal=lambda r, k: [blk] if k == "blocker" else [])[4]
    (q,) = oq.blocker_questions(["EP-1"], lambda r, k: [blk] if k == "blocker" else [])
    assert "add --id %s " % q["qid"] in out["reason"] and "close --id %s" % q["qid"] in out["reason"]


def test_row_for_another_question_with_same_ref_does_not_count(env):
    blk = [{"id": "jrn_%d" % i, "sequence": i, "kind": "blocker", "semantic": {"for": "operator", "q": "Q number %d?" % i}}
           for i in (1, 2)]
    j = lambda r, k: blk if k == "blocker" else []
    qid1 = oq.blocker_questions(["EP-1"], j)[0]["qid"]
    t0 = pm_question.parse_ts("2026-11-13T03:00:00Z")
    fetch = lambda _p: ("rid", {"rows": [{"id": qid1, "ref": "EP-1", "at": "2026-11-13T03:00:04Z"}]}, "")
    out = run_stops(5, fetch=fetch, t0=t0, text="working", journal=j)[4]
    assert "Q number 2?" in out["reason"] and "Q number 1?" not in out["reason"]


def test_window_boundary_row_refreshed_in_first_window_turn_is_current(env):
    """Stops 10 s apart. A row stamped between the answering Stop and silent turn 1's Stop is current through turn 5
    and stale at turn 6 (the old rule, comparing with the first silent Stop, judged it stale at turn 5)."""
    qid = pm_question.qid_of(QUESTION)
    T = 1_800_000_000.0
    ts = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
    fetch = lambda _p: ("rid", {"rows": [{"id": qid, "at": ts(T + 15)}]}, "")
    oq.on_prompt({"session_id": "s1", "prompt": "ciao"}, T)
    oq.on_stop(stop(last_assistant_message=QUESTION), T + 10, fetch=fetch, journal=lambda r, k: [])
    outs = [oq.on_stop(stop(), T + 20 + 10 * i, fetch=fetch, journal=lambda r, k: []) for i in range(6)]
    assert outs[:5] == [None] * 5                      # turn 5: the row is still inside the 5-turn window
    assert "stale row" in outs[5]["reason"]            # turn 6: it fell out of the window


def test_failed_read_is_cached_for_five_minutes(env):
    calls = []

    def boom(p):
        calls.append(p)
        raise RuntimeError("down")
    run_stops(5, fetch=boom, t0=1_800_000_000.0)
    run_stops(7, fetch=boom, t0=1_800_000_010.0, session="s2")
    assert len(calls) == 1   # one attempt per DOC_TTL, not one per Stop
    assert "down" in (pm_question.state_root() / "errors.log").read_text()


def test_missing_site_setting_does_not_lose_the_counter(env, monkeypatch):
    cfg = json.loads(pathlib.Path(os.environ["PM_CONFIG"]).read_text())
    cfg.pop("status_board_site")
    pathlib.Path(os.environ["PM_CONFIG"]).write_text(json.dumps(cfg))
    pm_config._RAW = pm_config._CACHE = None
    assert run_stops(5, fetch=None) == [None] * 5       # real Hn(): pm_config exits, read fails open
    assert oq.load_state("s1")["turns"] == 5


def test_more_than_three_due_questions_are_one_reminder(env):
    blk = [{"id": "jrn_%d" % i, "sequence": i, "kind": "blocker", "semantic": {"for": "operator", "q": "Question %d?" % i}}
           for i in range(1, 6)]
    outs = run_stops(6, text="working", journal=lambda r, k: blk if k == "blocker" else [])
    assert [i + 1 for i, o in enumerate(outs) if o] == [5]
    assert "+2 more" in outs[4]["reason"]


def test_chat_question_is_due_n_turns_after_the_ask(env):
    oq.on_prompt({"session_id": "s1", "prompt": "ciao"}, 1.0)
    oq.on_stop(stop(last_assistant_message="ok"), 1.5, fetch=no_row)
    outs = [oq.on_stop(stop(last_assistant_message=QUESTION if i == 2 else "w"), 2.0 + i, fetch=no_row,
                       journal=lambda r, k: []) for i in range(10)]
    assert [i + 1 for i, o in enumerate(outs) if o] == [8]   # asked in silent turn 3, due 5 turns later


def test_instance_names_come_from_config_only(env):
    assert oq.detect_questions("Morgana, pronto per la finestra?") == []
    cfg = json.loads(pathlib.Path(os.environ["PM_CONFIG"]).read_text())
    cfg["operator_names"] = ["morgana"]
    pathlib.Path(os.environ["PM_CONFIG"]).write_text(json.dumps(cfg))
    pm_config._RAW = pm_config._CACHE = None
    oq._NAME_RE = None
    assert oq.detect_questions("Morgana, pronto per la finestra?")


@pytest.mark.parametrize("text", [
    "Cosa ne pensi?", "Che ne dici di procedere con la 2?", "Lo faccio?", "Should we merge now?", "Thoughts?",
    "Is that ok?", "Ok per te?", "Va bene così?", "Devo procedere con il merge?",
])
def test_more_operator_questions_detected(text):
    assert oq.detect_questions(text), text


@pytest.mark.parametrize("text", [
    "Why does the parser fail when you pass an empty list?",
    "As you can see, what does this do?",
    "Is there anything else you need?",
    "Can you see why X fails?",
    "Did you know the build takes 4 minutes?",
    "Tutto va bene?",
])
def test_not_operator_questions(text):
    assert oq.detect_questions(text) == []


def test_flat_config_with_dirs_needs_cwd_inside(env, monkeypatch, tmp_path):
    cfg = tmp_path / "flat.json"
    cfg.write_text(json.dumps({"repo_dir": str(tmp_path / "proj")}))
    monkeypatch.setenv("PM_CONFIG", str(cfg))
    pm_config._RAW = pm_config._CACHE = None
    assert oq.project_applies(str(tmp_path / "elsewhere")) is False
    assert oq.project_applies(str(tmp_path / "proj" / "sub")) is True


def test_stuck_answering_flag_expires(env):
    st = oq.load_state("s1")
    st["answering"] = 1000.0
    oq.save_state("s1", st)
    oq.on_stop(stop(), 1000.0 + 7200)
    assert oq.load_state("s1")["turns"] == 1

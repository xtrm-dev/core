"""Tests for pm_park with fakes for systemd-run, tmux, sb, gh and the clock. Run: python3 test_pm_park.py"""
import datetime as dt
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import pm_config  # noqa: E402
import pm_park  # noqa: E402
import route_target as rt  # noqa: E402

NOW = dt.datetime(2026, 11, 22, 12, 0, 0, tzinfo=dt.timezone.utc)


def cp(rc=0, out="", err=""):
    return subprocess.CompletedProcess([], rc, out, err)


def entry(seq, kind, who, summary="x"):
    return {"sequence": seq, "kind": kind, "participantId": who, "semantic": {"summary": summary}}


class Fake:
    """Routes every external call of pm_park by its first word and records it."""

    def __init__(self):
        self.calls = []
        self.cwds = []
        self.journal_ok = True
        self.entries = [entry(1, "milestone", "lead-a"), entry(2, "handoff", "lead-a", "handing off")]
        self.appended = []
        self.systemd_rc = 0
        self.loadstate = "loaded"
        self.check_rc = 0
        self.tmux_new_rc = 0
        self.pane_dead = "0"
        self.capture = ""
        self.prs = [{"number": 7, "title": "fix x", "mergedAt": "2026-11-22T11:00:00Z", "url": "u"}]

    def __call__(self, args, input=None, timeout=60):
        self.calls.append((list(args), input))
        self.cwds.append(os.getcwd())
        a0 = args[0]
        if a0 == "sb":
            if args[1:3] == ["journal", "show"]:
                return cp(out=json.dumps({"data": self.entries}))
            if args[1:3] == ["journal", "append"]:
                if not self.journal_ok:
                    return cp(1, err="no")
                self.appended.append((args[3], args[5], json.loads(pathlib.Path(args[7]).read_text())["summary"]))
                return cp(out=f"seq {10 + len(self.appended)}")
            if args[1:3] == ["issue", "resume"]:
                return cp(out="RESUME CAPSULE " + args[3])
        if a0 == "systemd-run":
            return cp(self.systemd_rc, err="boom" if self.systemd_rc else "")
        if a0 == "systemctl":
            return cp(out=self.loadstate) if "show" in args else cp()
        if a0 == "sh":
            return cp(self.check_rc, err="check says no" if self.check_rc not in (0, 1) else "")
        if a0 == "gh":
            return cp(out=json.dumps(self.prs))
        if a0 == "xt":
            return cp(self.tmux_new_rc, out="role-claude-lead-CORE-1:%9\n", err="xt failed" if self.tmux_new_rc else "")
        if a0 == "tmux":
            sub = args[1]
            if sub == "display-message":
                return cp(out="sess" if "session_name" in args[-1] else self.pane_dead)
            if sub in ("new-window", "new-session"):
                return cp(self.tmux_new_rc, out="%9\n", err="can't find session" if self.tmux_new_rc else "")
            if sub == "capture-pane":
                return cp(out=self.capture)
            return cp()
        return cp(127, err="unexpected " + a0)

    def tmux(self, sub):
        return [c for c in self.calls if c[0][:2] == ["tmux", sub]]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old = dict(os.environ)
        self.start = os.getcwd()
        root = pathlib.Path(self.tmp.name)
        self.wt = root / "wt"
        self.wt.mkdir()
        subprocess.run(["git", "init", "-q", str(self.wt)], check=True)
        cfg = root / "pm.json"
        cfg.write_text(json.dumps({"repo_slug": "org/alpha", "state_dir": str(root / "state"), "sb_bin": "sb"}))
        os.environ["PM_CONFIG"] = str(cfg)
        for k in ("PM_PARK_GATE_LOAD1", "PM_PARK_GATE_MEM_GB", "PM_PROJECT", "PM_STATE_DIR", "PM_REPO_SLUG", "PM_PARK_LAUNCH", "PM_PARK_MAX_ATTEMPTS"):
            os.environ.pop(k, None)
        pm_config._RAW = pm_config._CACHE = None
        self.fake = Fake()
        self.proc = root / "proc"
        (self.proc / "pressure").mkdir(parents=True)
        self.set_gate(load1="0.50", psi="1.00", mem_kb=16 * 1048576)
        patches = [mock.patch.object(pm_park, "run", self.fake), mock.patch.object(pm_park, "now", lambda: NOW),
                   mock.patch.object(pm_park, "sleep", lambda s: None), mock.patch.object(pm_park, "PROC", str(self.proc))]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        os.environ["PM_ANSWERS_INBOX"] = str(root / "answers.jsonl")

    def tearDown(self):
        os.chdir(self.start)
        os.environ.clear()
        os.environ.update(self.old)
        pm_config._RAW = pm_config._CACHE = None
        self.tmp.cleanup()

    def set_gate(self, load1, psi, mem_kb):
        (self.proc / "loadavg").write_text(f"{load1} 0.40 0.30 1/200 999\n")
        (self.proc / "pressure" / "memory").write_text(
            f"some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10={psi} avg60=0.00 avg300=0.00 total=1\n")
        (self.proc / "meminfo").write_text(f"MemTotal: 33554432 kB\nMemAvailable: {mem_kb} kB\n")

    def park(self, *extra, name="lead-a", at="2026-11-22T14:00:00Z"):
        argv = ["park", name, "--ref", "CORE-1", "--role", "lead", "--worktree", str(self.wt), "--pane", "%3",
                *(extra or (("--at", at) if at else ()))]
        return pm_park.main(argv)

    def rec(self, name="lead-a"):
        return json.loads(pm_park.record_path(name).read_text())


class ParkRefusals(Base):
    def refused(self, *extra, **kw):
        with mock.patch("sys.stderr"):
            self.assertEqual(self.park(*extra, **kw), 2)
        self.assertFalse(pm_park.record_path("lead-a").exists())
        self.assertEqual(self.fake.tmux("new-window"), [])
        self.assertFalse([c for c in self.fake.calls if c[0][0] == "systemd-run"])

    def test_no_handoff_entry_by_the_session(self):
        self.fake.entries = [entry(1, "milestone", "someone-else", "h")]
        self.refused()

    def test_last_own_entry_is_not_a_handoff(self):
        self.fake.entries.append(entry(3, "milestone", "lead-a"))
        self.refused()

    def test_entry_by_another_after_the_handoff_is_fine(self):
        self.fake.entries.append(entry(3, "note", "manager"))
        self.assertEqual(self.park(), 0)

    def test_self_needs_manager_told(self):
        self.refused("--at", "2026-11-22T14:00:00Z", "--self")

    def test_self_with_manager_told(self):
        self.assertEqual(self.park("--at", "2026-11-22T14:00:00Z", "--self", "--manager-told"), 0)
        self.assertTrue(self.rec()["self"])

    def test_holder_naming_the_session_counts_as_self(self):
        os.environ["SUBSTRATE_HOLDER"] = "lead-a"
        self.refused("--at", "2026-11-22T14:00:00Z")
        self.assertEqual(self.park("--at", "2026-11-22T14:00:00Z", "--manager-told"), 0)
        self.assertTrue(self.rec()["self"])

    def test_other_holder_is_not_self(self):
        os.environ["SUBSTRATE_HOLDER"] = "manager"
        self.assertEqual(self.park(), 0)
        self.assertFalse(self.rec()["self"])

    def test_no_wake(self):
        self.refused(at=None)
        self.fake.calls.clear()

    def test_check_needs_deadline(self):
        self.refused("--check", "true")

    def test_at_in_the_past(self):
        self.refused("--at", "2026-11-22T11:00:00Z")

    def test_both_wakes(self):
        self.refused("--at", "2026-11-22T14:00:00Z", "--check", "true", "--deadline", "2026-11-22T15:00:00Z")

    def test_already_parked(self):
        self.assertEqual(self.park(), 0)
        with mock.patch("sys.stderr"):
            self.assertEqual(self.park(), 2)

    def test_systemd_failure_removes_record(self):
        self.fake.systemd_rc = 1
        with mock.patch("sys.stderr"):
            self.assertEqual(self.park(), 2)
        self.assertFalse(pm_park.record_path("lead-a").exists())


    def test_systemd_failure_restores_the_earlier_record(self):
        self.assertEqual(self.park(), 0)
        rec = self.rec()
        rec["state"] = "woken"
        pm_park.save(rec)
        self.fake.systemd_rc = 1
        with mock.patch("sys.stderr"):
            self.assertEqual(self.park(), 2)
        self.assertEqual(self.rec(), rec)


class ParkWrites(Base):
    def test_record_timer_and_journal(self):
        os.environ["PATH"] = "/opt/nvm/bin:/usr/bin"
        with mock.patch("builtins.print") as pr:
            self.assertEqual(self.park(), 0)
        rec = self.rec()
        self.assertEqual((rec["name"], rec["role"], rec["ref"], rec["state"]), ("lead-a", "lead", "CORE-1", "parked"))
        self.assertEqual((rec["pane_id"], rec["tmux_target"], rec["handoff_seq"], rec["park_seq"]),
                         ("%3", "sess:", 2, 11))
        self.assertEqual(rec["park_time"], "2026-11-22T12:00:00Z")
        self.assertEqual(rec["unit"], "pm-park-lead-a")
        sd = [c[0] for c in self.fake.calls if c[0][0] == "systemd-run"][0]
        self.assertIn("--user", sd)
        self.assertIn("--setenv=PATH=/opt/nvm/bin:/usr/bin", sd)
        self.assertIn("--on-calendar=2026-11-22 14:00:00 UTC", sd)
        self.assertIn("--setenv=SUBSTRATE_HOLDER=pm_park", sd)
        self.assertIn("--property=KillMode=process", sd)
        self.assertEqual(sd[-4:], [sys.executable, str(pathlib.Path(pm_park.__file__).resolve()), "wake", "lead-a"])
        self.assertEqual(self.fake.appended[0][:2], ("CORE-1", "note"))
        self.assertIn("park: lead-a", self.fake.appended[0][2])
        out = " ".join(str(c.args[0]) for c in pr.call_args_list)
        self.assertIn("close the pane yourself: %3", out)
        self.assertNotIn("TOKEN", json.dumps(rec))

    def test_check_timer(self):
        self.assertEqual(self.park("--check", "test -f /x", "--deadline", "2026-11-22T20:00:00Z", "--every", "600"), 0)
        sd = [c[0] for c in self.fake.calls if c[0][0] == "systemd-run"][0]
        self.assertIn("--on-active=600s", sd)
        self.assertIn("--on-unit-inactive=600s", sd)
        self.assertFalse([x for x in sd if x.startswith("--on-calendar")])
        self.assertEqual(self.rec()["wake"]["check"], "test -f /x")


class Decide(Base):
    def rec_check(self, deadline="2026-11-22T20:00:00Z"):
        return {"wake": {"at": None, "check": "c", "deadline": deadline, "every": 300}}

    def test_at(self):
        r = {"wake": {"at": "2026-11-22T13:00:00Z"}}
        self.assertEqual(pm_park.decide(r, False)[0], False)
        r = {"wake": {"at": "2026-11-22T11:59:00Z"}}
        self.assertEqual(pm_park.decide(r, False)[:2], (True, "scheduled time 2026-11-22T11:59:00Z reached"))

    def test_check_0_wakes(self):
        self.assertEqual(pm_park.decide(self.rec_check(), False), (True, "check passed", None))

    def test_check_1_waits(self):
        self.fake.check_rc = 1
        self.assertEqual(pm_park.decide(self.rec_check(), False)[0], False)

    def test_check_other_exit_wakes_anyway_with_a_note(self):
        self.fake.check_rc = 3
        ok, cause, note = pm_park.decide(self.rec_check(), False)
        self.assertEqual((ok, cause), (True, "check error"))
        self.assertIn("exited 3", note or "")

    def test_check_timeout_wakes_anyway(self):
        orig = self.fake

        def timed_out(args, input=None, timeout=60):
            return cp(124, err="timed out") if args[0] == "sh" else orig(args, input, timeout)
        with mock.patch.object(pm_park, "run", timed_out):
            ok, cause, note = pm_park.decide(self.rec_check(), False)
        self.assertEqual((ok, cause), (True, "check error"))
        self.assertIn("timed out", note or "")

    def test_deadline_passed_wakes_without_running_the_check(self):
        self.fake.check_rc = 1
        ok, cause, note = pm_park.decide(self.rec_check("2026-11-22T11:00:00Z"), False)
        self.assertEqual((ok, cause), (True, "deadline passed"))
        self.assertIn("deadline", note or "")
        self.assertFalse([c for c in self.fake.calls if c[0][0] == "sh"])


class Gate(Base):
    def test_open(self):
        self.assertTrue(pm_park.gate()[0])

    def test_each_limit_shuts_it(self):
        for load1, psi, mem in (("15.01", "1", 8e6), ("1", "10.5", 8e6), ("1", "1", 4 * 1048576 - 1)):
            self.set_gate(load1, psi, int(mem))
            self.assertFalse(pm_park.gate()[0], (load1, psi, mem))

    def test_limits_are_settings(self):
        self.set_gate("20", "1", 16 * 1048576)
        os.environ["PM_PARK_GATE_LOAD1"] = "25"
        self.assertTrue(pm_park.gate()[0])
        os.environ["PM_PARK_GATE_MEM_GB"] = "20"
        self.assertFalse(pm_park.gate()[0])

    def test_unreadable_is_shut(self):
        (self.proc / "meminfo").unlink()
        self.assertFalse(pm_park.gate()[0])


class Wake(Base):
    def setUp(self):
        super().setUp()
        self.assertEqual(self.park(), 0)
        self.fake.appended.clear()
        self.fake.calls.clear()
        self.fake.capture = "[pm_park wake lead-a] You were respawned"
        pathlib.Path(os.environ["PM_ANSWERS_INBOX"]).write_text(
            json.dumps({"to": "lead-a", "text": "operator says go"}) + "\n" + json.dumps({"to": "lead-b", "text": "no"}) + "\n")

    def test_wake_not_due(self):
        with mock.patch.object(pm_park, "now", lambda: NOW - dt.timedelta(hours=1)):
            self.assertEqual(pm_park.main(["wake", "lead-a"]), 0)
        self.assertEqual(self.rec()["state"], "parked")
        self.assertEqual(self.fake.tmux("new-window"), [])

    def test_gate_shut_retries_and_never_launches(self):
        later = NOW + dt.timedelta(hours=3)
        self.set_gate("20", "1", 16 * 1048576)
        with mock.patch.object(pm_park, "now", lambda: later):
            self.assertEqual(pm_park.main(["wake", "lead-a"]), 0)
        rec = self.rec()
        self.assertEqual((rec["state"], rec["gate_waits"]), ("parked", 1))
        self.assertEqual(self.fake.tmux("new-window"), [])
        self.assertFalse([c for c in self.fake.calls if c[0][0] == "systemctl"])
        self.set_gate("1", "1", 16 * 1048576)
        with mock.patch.object(pm_park, "now", lambda: later):
            self.assertEqual(pm_park.main(["wake", "lead-a"]), 0)
        self.assertEqual(self.rec()["state"], "woken")

    def wake_ok(self, name="lead-a"):
        later = NOW + dt.timedelta(hours=3)
        with mock.patch.object(pm_park, "now", lambda: later), mock.patch("builtins.print"):
            return pm_park.main(["wake", name])

    def test_due_decision_survives_a_gate_shut_retry(self):
        later = NOW + dt.timedelta(hours=3)
        self.set_gate("20", "1", 16 * 1048576)
        with mock.patch.object(pm_park, "now", lambda: later):
            pm_park.main(["wake", "lead-a"])
        self.assertTrue(self.rec()["due"])
        self.set_gate("1", "1", 16 * 1048576)
        with mock.patch.object(pm_park, "now", lambda: NOW):  # the at-time looks not reached on the retry
            self.assertEqual(pm_park.main(["wake", "lead-a"]), 0)
        self.assertEqual(self.rec()["state"], "woken")
        self.assertTrue([c for c in self.fake.calls if c[0][0] == "xt"])

    def test_due_check_is_not_rerun_on_a_retry(self):
        self.fake.entries.append(entry(3, "handoff", "lead-b"))
        self.assertEqual(self.park("--check", "c", "--deadline", "2026-11-22T20:00:00Z", name="lead-b"), 0)
        self.set_gate("20", "1", 16 * 1048576)
        with mock.patch("builtins.print") as pr:
            pm_park.main(["wake", "lead-b"])
        self.assertIn("retries in 300s", str(pr.call_args_list))
        self.fake.check_rc = 1
        self.fake.calls.clear()
        self.set_gate("1", "1", 16 * 1048576)
        self.fake.capture = "[pm_park wake lead-b] You were respawned"
        with mock.patch("builtins.print"):
            pm_park.main(["wake", "lead-b"])
        self.assertFalse([c for c in self.fake.calls if c[0][0] == "sh"])
        self.assertEqual(self.rec("lead-b")["state"], "woken")

    def test_unexpected_error_is_counted_not_left_waking(self):
        with mock.patch.object(pm_park, "digest", side_effect=OSError("disk full")):
            with mock.patch.object(pm_park, "now", lambda: NOW + dt.timedelta(hours=3)), mock.patch("builtins.print"):
                self.assertEqual(pm_park.main(["wake", "lead-a"]), 1)
        rec = self.rec()
        self.assertEqual((rec["state"], rec["attempts"]), ("parked", 1))
        self.assertIn("OSError: disk full", rec["last_error"])

    def xt_call(self):
        calls = [c[0] for c in self.fake.calls if c[0][0] == "xt"]
        self.assertEqual(len(calls), 1)
        return calls[0]

    def test_wake_launches_fresh_session_through_xt_and_checks_the_nudge(self):
        self.fake.capture = "[pm_park wake lead-a] You were respawned"
        self.assertEqual(self.wake_ok(), 0)
        rec = self.rec()
        self.assertEqual((rec["state"], rec["wake_pane"], rec["attempts"]), ("woken", "%9", 0))
        cmd = self.xt_call()
        self.assertEqual(cmd[:3], ["xt", "attach", self.wt.name])
        for flag in ("--fresh", "--new-session", "--no-attach"):
            self.assertIn(flag, cmd)
        self.assertNotIn("--bead", cmd)  # the parked pane had no @agent_bead, so the wake gives none
        self.assertNotIn("--role", cmd)  # nor an @agent_role: a bare launch stays bare
        nudge_file = pm_park.parked_dir() / "lead-a.nudge.md"
        self.assertEqual(cmd[cmd.index("--prompt") + 1], f"@{nudge_file}")
        for needle in ("[pm_park wake lead-a]", "respawned after a pause", "Parked 2026-11-22T12:00:00Z",
                       "woken 2026-11-22T15:00:00Z", "long idle wait", "scheduled time", "pm_session.py show",
                       "journal seq 2 on CORE-1", "lead-a.digest.md", "route_target.py manager", "back up",
                       "[end pm_park wake lead-a]"):
            self.assertIn(needle, nudge_file.read_text())
        # no direct runtime launch, no tmux window of our own, and the nudge is not pasted when it already shows
        self.assertFalse(self.fake.tmux("new-window") or self.fake.tmux("new-session"))
        self.assertFalse(self.fake.tmux("paste-buffer"))
        self.assertEqual((pathlib.Path(rec["worktree"]) / ".pm-role").read_text().strip(), "lead")
        self.assertEqual((pathlib.Path(rec["worktree"]) / ".substrate-issue").read_text().strip(), "CORE-1")
        self.assertIn(["systemctl", "--user", "stop", "pm-park-lead-a.timer"], [c[0] for c in self.fake.calls])
        self.assertIn("wake: lead-a", self.fake.appended[-1][2])

    def test_park_records_what_the_relaunch_needs(self):
        rec = self.rec()
        self.assertEqual(rec["xt_name"], self.wt.name)
        self.assertEqual(rec["runtime"], "claude")
        self.assertIsNone(rec["agent_bead"])
        self.assertIsNone(rec["launch_role"])
        self.assertIn("parent_session", rec)

    def test_park_reads_pane_options_and_the_session_record(self):
        orig = self.fake

        def with_opts(args, input=None, timeout=60):
            if args[:3] == ["tmux", "show-options", "-p"]:
                orig.calls.append((list(args), input))
                return cp(out={"@agent_role": "lead\n", "@agent_bead": "CORE-9\n", "@agent_parent_session": "$4\n"}[args[-1]])
            return orig(args, input, timeout)
        (self.wt / ".xtrm").mkdir()
        (self.wt / ".xtrm" / "session-meta.json").write_text(json.dumps({"runtime": "pi", "launchedAt": "x"}))
        self.fake.entries += [entry(3, "handoff", "lead-b")]
        with mock.patch.object(pm_park, "run", with_opts):
            self.assertEqual(self.park(name="lead-b", at="2026-11-22T14:00:00Z"), 0)
        rec = self.rec("lead-b")
        self.assertEqual((rec["launch_role"], rec["agent_bead"], rec["parent_session"], rec["runtime"]),
                         ("lead", "CORE-9", "$4", "pi"))
        self.fake.capture = "[pm_park wake lead-b] You were respawned"
        with mock.patch.object(pm_park, "run", with_opts):
            self.assertEqual(self.wake_ok(name="lead-b"), 0)
        cmd = self.xt_call()
        self.assertEqual(cmd[cmd.index("--role") + 1], "lead")
        self.assertEqual(cmd[cmd.index("--bead") + 1], "CORE-9")
        self.assertEqual(cmd[cmd.index("--parent") + 1], "$4")

    def test_park_refuses_when_the_launch_role_cannot_be_read(self):
        self.fake.entries += [entry(3, "handoff", "lead-c")]
        argv = ["park", "lead-c", "--ref", "CORE-1", "--role", "lead", "--worktree", str(self.wt), "--at", "2026-11-22T14:00:00Z"]
        with mock.patch("builtins.print"), mock.patch("sys.stderr"):
            self.assertEqual(pm_park.main(argv), 2)  # no pane: the role cannot be read
            self.assertFalse(pm_park.record_path("lead-c").exists())
            self.assertEqual(pm_park.main(argv + ["--launch-role", "lead"]), 0)
        self.assertEqual(self.rec("lead-c")["launch_role"], "lead")
        self.fake.entries += [entry(4, "handoff", "lead-d")]
        with mock.patch("builtins.print"):
            self.assertEqual(pm_park.main(["park", "lead-d"] + argv[2:] + ["--launch-role", "none"]), 0)
        self.assertIsNone(self.rec("lead-d")["launch_role"])

    def test_model_and_extra_args(self):
        os.environ["PM_PARK_LAUNCH"] = "--add-dir /tmp/x"
        rec = self.rec()
        rec["model"] = "sonnet"
        pm_park.save(rec)
        self.assertEqual(self.wake_ok(), 0)
        cmd = self.xt_call()
        self.assertEqual(cmd[cmd.index("--model") + 1], "sonnet")
        self.assertEqual(cmd[cmd.index("--") + 1:], ["--add-dir", "/tmp/x"])

    def test_pm_settings_are_named_in_the_nudge(self):
        rec = self.rec()
        rec["pm_env"] = {"PM_PROJECT": "alpha"}
        pm_park.save(rec)
        self.assertEqual(self.wake_ok(), 0)
        text = (pm_park.parked_dir() / "lead-a.nudge.md").read_text()
        self.assertIn("PREFIX each pm_* command", text)
        self.assertIn("PM_PROJECT=alpha python3", text)

    def test_xt_failure_counts_as_an_attempt(self):
        orig = self.fake

        def xt_fails(args, input=None, timeout=60):
            if args[0] == "xt":
                orig.calls.append((list(args), input))
                return cp(1, err="no worktree")
            return orig(args, input, timeout)
        with mock.patch.object(pm_park, "run", xt_fails), mock.patch.object(pm_park, "now", lambda: NOW + dt.timedelta(hours=3)), mock.patch("builtins.print"):
            self.assertEqual(pm_park.main(["wake", "lead-a"]), 1)
        self.assertIn("no worktree", self.rec()["last_error"])

    def test_digest(self):
        self.fake.entries += [entry(11, "note", "lead-a", "old park"), entry(12, "finding", "worker-1", "found a thing")]
        self.assertEqual(self.wake_ok(), 0)
        text = (pm_park.parked_dir() / "lead-a.digest.md").read_text()
        self.assertIn("RESUME CAPSULE CORE-1", text)
        self.assertIn("seq 12 finding by worker-1: found a thing", text)
        self.assertNotIn("seq 11 note", text)
        self.assertIn("operator says go", text)
        self.assertNotIn('"no"', text)
        self.assertIn("#7 fix x", text)
        gh = [c[0] for c in self.fake.calls if c[0][0] == "gh"][0]
        self.assertIn("merged:>=2026-11-22T12:00:00Z", gh)

    def test_check_error_note_reaches_the_wake_entry(self):
        rec = self.rec()
        rec["wake"] = {"at": None, "check": "bad", "deadline": "2026-11-22T20:00:00Z", "every": 300}
        pm_park.save(rec)
        self.fake.check_rc = 2
        self.assertEqual(self.wake_ok(), 0)
        self.assertIn("For the manager: check exited 2", self.fake.appended[-1][2])
        self.assertIn("check error", self.rec()["wake_cause"])

    def test_pane_dies_retries_then_fails_and_tells_the_manager(self):
        self.fake.pane_dead = "1"
        for attempt in (1, 2):
            with mock.patch.object(pm_park, "now", lambda: NOW + dt.timedelta(hours=3)), mock.patch("builtins.print"):
                self.assertEqual(pm_park.main(["wake", "lead-a"]), 1)
            self.assertEqual((self.rec()["state"], self.rec()["attempts"]), ("parked", attempt))
        self.assertFalse([a for a in self.fake.appended if a[1] == "blocker"])
        with mock.patch.object(pm_park, "now", lambda: NOW + dt.timedelta(hours=3)), mock.patch("builtins.print"):
            self.assertEqual(pm_park.main(["wake", "lead-a"]), 1)
        self.assertEqual(self.rec()["state"], "failed")
        blockers = [a for a in self.fake.appended if a[1] == "blocker"]
        self.assertEqual(len(blockers), 1)
        self.assertIn("did not come up after 3 attempts", blockers[0][2])

    def test_nudge_seen_by_its_end_tag_only(self):
        self.fake.capture = "...\n  [end pm_park\n  wake lead-a]\n"
        self.assertEqual(self.wake_ok(), 0)

    def test_nudge_never_shows_fails(self):
        self.fake.capture = "nothing here"
        with mock.patch.object(pm_park, "now", lambda: NOW + dt.timedelta(hours=3)), mock.patch("builtins.print"):
            self.assertEqual(pm_park.main(["wake", "lead-a"]), 1)
        self.assertIn("nudge did not show", self.rec()["last_error"])
        self.assertEqual(len(self.fake.tmux("load-buffer")), 2)

    def test_wake_runs_in_the_worktree_and_flags_a_lost_journal_entry(self):
        self.fake.cwds.clear()
        self.fake.journal_ok = False
        self.assertEqual(self.wake_ok(), 0)
        sb_cwds = {cwd for (c, _), cwd in zip(self.fake.calls, self.fake.cwds) if c[0] in ("sb", "gh")}
        self.assertEqual(sb_cwds, {str(self.wt.resolve())})
        self.assertIn("could not be written", self.rec()["journal_error"])

    def test_woken_record_is_inert(self):
        self.assertEqual(self.wake_ok(), 0)
        self.fake.calls.clear()
        self.assertEqual(self.wake_ok(), 0)
        self.assertEqual(self.fake.tmux("new-window"), [])


class ListAndRoute(Base):
    def test_list_and_team(self):
        with mock.patch("builtins.print") as pr:
            pm_park.main(["list"])
        self.assertIn("no parked sessions", str(pr.call_args_list))
        self.assertEqual(self.park(), 0)
        with mock.patch("builtins.print") as pr:
            pm_park.main(["list"])
        line = pr.call_args_list[0].args[0]
        for needle in ("lead-a", "parked", "lead", "CORE-1", "at 2026-11-22T14:00:00Z", "pm-park-lead-a.timer"):
            self.assertIn(needle, line)
        with mock.patch("builtins.print") as pr:
            pm_park.main(["list", "--json"])
        self.assertEqual(json.loads(pr.call_args.args[0])[0]["name"], "lead-a")
        t = rt.team([])
        self.assertEqual(t["parked"], [{"name": "lead-a", "role": "lead", "ref": "CORE-1", "wake": "at 2026-11-22T14:00:00Z"}])
        with mock.patch("builtins.print") as pr:
            rt.print_team(t)
        parked = [c.args[0] for c in pr.call_args_list if " parked " in c.args[0]]
        self.assertEqual(len(parked), 1)
        self.assertIn("write to the journal of CORE-1, not to its socket", parked[0])

    def test_list_flags_a_missing_unit(self):
        self.assertEqual(self.park(), 0)
        self.fake.loadstate = "not-found"
        with mock.patch("builtins.print") as pr:
            pm_park.main(["list"])
        self.assertIn("MISSING", pr.call_args_list[0].args[0])
        with mock.patch("builtins.print") as pr:
            pm_park.main(["list", "--json"])
        self.assertTrue(json.loads(pr.call_args.args[0])[0]["unit_missing"])

    def test_no_parked_line_when_none(self):
        with mock.patch("builtins.print") as pr:
            rt.print_team(rt.team([]))
        self.assertFalse([c for c in pr.call_args_list if " parked " in c.args[0]])


if __name__ == "__main__":
    unittest.main()

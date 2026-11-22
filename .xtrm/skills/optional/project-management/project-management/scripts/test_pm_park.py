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
            return cp()
        if a0 == "sh":
            return cp(self.check_rc, err="check says no" if self.check_rc not in (0, 1) else "")
        if a0 == "gh":
            return cp(out=json.dumps(self.prs))
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

    def wake_ok(self):
        later = NOW + dt.timedelta(hours=3)
        with mock.patch.object(pm_park, "now", lambda: later), mock.patch("builtins.print"):
            return pm_park.main(["wake", "lead-a"])

    def test_wake_launches_fresh_session_and_nudges(self):
        self.assertEqual(self.wake_ok(), 0)
        rec = self.rec()
        self.assertEqual((rec["state"], rec["wake_pane"], rec["attempts"]), ("woken", "%9", 0))
        nw = self.fake.tmux("new-window")[0][0]
        self.assertIn("-d", nw)
        self.assertEqual(nw[nw.index("-t") + 1], "sess:")
        self.assertEqual(nw[nw.index("-c") + 1], rec["worktree"])
        self.assertEqual(nw[-1], "exec claude --dangerously-skip-permissions")
        self.assertNotIn("--continue", nw[-1])
        self.assertIn("XTMUX_AGENT_ROLE=lead", nw)
        self.assertIn("SUBSTRATE_HOLDER=lead-a", nw)
        self.assertEqual((pathlib.Path(rec["worktree"]) / ".pm-role").read_text().strip(), "lead")
        self.assertEqual((pathlib.Path(rec["worktree"]) / ".substrate-issue").read_text().strip(), "CORE-1")
        pasted = self.fake.tmux("load-buffer")[0][1]
        for needle in ("[pm_park wake lead-a]", "respawned after a pause", "Parked 2026-11-22T12:00:00Z",
                       "woken 2026-11-22T15:00:00Z", "long idle wait", "scheduled time", "pm_session.py show",
                       "journal seq 2 on CORE-1", "lead-a.digest.md", "route_target.py manager", "back up",
                       "[end pm_park wake lead-a]"):
            self.assertIn(needle, pasted)
        self.assertTrue(self.fake.tmux("paste-buffer"))
        self.assertTrue([c for c in self.fake.tmux("send-keys") if c[0][-1] == "Enter"])
        self.assertIn(["systemctl", "--user", "stop", "pm-park-lead-a.timer"], [c[0] for c in self.fake.calls])
        self.assertEqual(self.fake.appended[-1][1], "note")
        self.assertIn("wake: lead-a", self.fake.appended[-1][2])

    def test_launch_command_setting_and_model(self):
        os.environ["PM_PARK_LAUNCH"] = "claude --channels plugin:x"
        rec = self.rec()
        rec["model"] = "sonnet"
        pm_park.save(rec)
        self.assertEqual(self.wake_ok(), 0)
        self.assertEqual(self.fake.tmux("new-window")[0][0][-1], "exec claude --channels plugin:x --model sonnet")

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

    def test_session_gone_makes_a_new_session(self):
        orig = self.fake

        def no_session(args, input=None, timeout=60):
            if args[:2] == ["tmux", "new-window"]:
                orig.calls.append((list(args), input))
                return cp(1, err="can't find session: sess")
            return orig(args, input, timeout)
        with mock.patch.object(pm_park, "run", no_session):
            self.assertEqual(self.wake_ok(), 0)
        ns = self.fake.tmux("new-session")[0][0]
        self.assertEqual(ns[ns.index("-s") + 1], "sess")
        self.assertEqual(self.rec()["state"], "woken")

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

    def test_no_parked_line_when_none(self):
        with mock.patch("builtins.print") as pr:
            rt.print_team(rt.team([]))
        self.assertFalse([c for c in pr.call_args_list if " parked " in c.args[0]])


if __name__ == "__main__":
    unittest.main()

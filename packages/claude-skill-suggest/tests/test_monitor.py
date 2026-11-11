import json, os, shutil, subprocess, sys, tempfile, threading, time, unittest, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "bin"))
import turnstate as ts  # noqa: E402
import monitor as mon  # noqa: E402

FAKE = os.path.join(HERE, "fake_worker.py")


def user(text, uid=None, **extra):
    return {"type": "user", "uuid": uid or str(uuid.uuid4()), "cwd": "/work", "origin": {"kind": "human"}, "promptSource": "typed", "turnOrigin": "human",
            "message": {"role": "user", "content": text}, **extra}


def asst(stop):
    return {"type": "assistant", "uuid": str(uuid.uuid4()), "message": {"role": "assistant", "stop_reason": stop, "content": []}}


END = {"type": "system", "subtype": "turn_duration", "uuid": "x"}
PROMPT = "debug why the release pipeline regressed after the merge"


class Env(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="ss-test-")
        self.t = os.path.join(self.d, "t.jsonl")
        open(self.t, "w").close()
        os.environ.update(SKILL_SUGGEST_LOG_DIR=os.path.join(self.d, "log"), SKILL_SUGGEST_SLOT_DIR=os.path.join(self.d, "slots"),
                          SKILL_SUGGEST_WORKER_CMD=json.dumps([sys.executable, FAKE]), SKILL_SUGGEST_SLOTS="3")
        for k in ("FAKE_DELAY", "FAKE_FAIL", "FAKE_PICK", "FAKE_PIDFILE"):
            os.environ.pop(k, None)
        mon.SLOTS = 3
        mon.HARD_KILL_S = 4.0
        self.out = []

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def append(self, *rows, path=None):
        with open(path or self.t, "a") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")

    def monitor(self, path=None, sid="s1"):
        m = mon.Monitor(sid, path or self.t, emit=self.out.append)
        m.tick()  # prime on the empty history
        return m

    def pump(self, m, until, secs=5.0):
        end = time.time() + secs
        while time.time() < end:
            m.tick()
            if until():
                return True
            time.sleep(0.02)
        return False

    def rows(self):
        p = os.path.join(self.d, "log", "log.jsonl")
        return [json.loads(l) for l in open(p)] if os.path.exists(p) else []

    def reasons(self):
        return [r.get("reason") for r in self.rows()]


class TestTurnState(unittest.TestCase):
    def snap(self, *rows):
        d = tempfile.mkdtemp()
        try:
            p = os.path.join(d, "t.jsonl")
            open(p, "w").write("".join(json.dumps(r) + "\n" for r in rows))
            return ts.snapshot(p, os.path.getsize(p))
        finally:
            shutil.rmtree(d)

    def test_states(self):
        self.assertEqual(self.snap(user(PROMPT))["state"], "running")
        self.assertEqual(self.snap(user(PROMPT), asst("tool_use"))["state"], "running")
        self.assertEqual(self.snap(user(PROMPT), asst("end_turn"))["state"], "idle")
        self.assertEqual(self.snap(user(PROMPT), asst("tool_use"), END)["state"], "idle")
        self.assertEqual(self.snap(user(PROMPT), user("[Request interrupted by user]", isMeta=False))["state"], "idle")

    def test_drift_is_unknown(self):
        bad = asst("end_turn"); del bad["message"]["stop_reason"]
        self.assertEqual(self.snap(user(PROMPT), bad)["state"], "unknown")
        self.assertEqual(self.snap(asst("end_turn"))["state"], "unknown")  # assistant rows, no user row anywhere

    def test_bad_json_is_unknown(self):
        d = tempfile.mkdtemp()
        try:
            p = os.path.join(d, "t.jsonl"); open(p, "w").write("not json\n{also not\n")
            s = ts.snapshot(p, os.path.getsize(p))
            self.assertEqual(s["state"], "unknown")
        finally:
            shutil.rmtree(d)

    def test_epoch_ignores_tool_results_and_meta(self):
        a = user(PROMPT, uid="A")
        tr = {"type": "user", "uuid": "B", "message": {"role": "user", "content": [{"type": "tool_result", "content": "x"}]}}
        meta = user("ctx", uid="C", isMeta=True)
        self.assertEqual(self.snap(a, asst("tool_use"), tr, meta)["epoch"], "A")

    def test_eligibility(self):
        ok = lambda row: ts.eligible_prompt(row)[0] is not None
        why = lambda row: ts.eligible_prompt(row)[1]
        self.assertTrue(ok(user(PROMPT)))
        self.assertEqual(why(user("continue")), "control_nudge")
        self.assertEqual(why(user("Coordinator 8qox: please check the thing now")), "peer_relay")
        self.assertEqual(why(user("[from peer 06sm, CI result] the run is green again")), "peer_relay")
        self.assertEqual(why(user("/goal do something long")), "command")
        self.assertEqual(why(user("short one")), "too_short")
        self.assertEqual(why(user("<task-notification> done")), "command")
        self.assertEqual(why(user("[skill-suggest] Read /x/y.md")), "command")  # our own nudge never loops
        self.assertEqual(why(user(PROMPT, origin={"kind": "task-notification"})), "not_human")
        self.assertEqual(why(user(PROMPT, promptSource="system")), "not_human")
        self.assertEqual(why(user(PROMPT, turnOrigin="peer", origin={"kind": "peer"})), "not_human")


class TestDelivery(Env):
    def test_fire_while_running_delivers_one_clean_line(self):
        m = self.monitor()
        self.append(user(PROMPT, uid="E1"))
        self.assertTrue(self.pump(m, lambda: self.out))
        self.assertEqual(len(self.out), 1)
        self.assertNotIn("\n", self.out[0])
        self.assertTrue(self.out[0].startswith("[skill-suggest]"))
        self.assertLessEqual(len(self.out[0]), 600)
        self.assertIn("delivered", self.reasons())
        self.assertEqual(self.rows()[-1]["host"], "claude")

    def test_late_result_after_turn_end_is_dropped(self):  # the TOCTOU case
        os.environ["FAKE_DELAY"] = "0.6"
        m = self.monitor()
        self.append(user(PROMPT, uid="E1"))
        self.pump(m, lambda: m.job is not None, 2)
        self.append(asst("end_turn"), END)                      # the turn ends while the worker computes
        self.assertTrue(self.pump(m, lambda: m.job is None and "turn_ended" in self.reasons(), 4))
        time.sleep(0.2); m.tick()
        self.assertEqual(self.out, [])                           # nothing was written, nothing woke the session

    def test_new_prompt_cancels_the_old_worker(self):
        os.environ["FAKE_DELAY"] = "3"
        os.environ["FAKE_PIDFILE"] = os.path.join(self.d, "pid")
        m = self.monitor()
        self.append(user(PROMPT, uid="E1"))
        self.pump(m, lambda: m.job is not None, 2)
        pid = m.job["proc"].pid
        self.append(asst("tool_use"), user("now also compare the staging config for drift", uid="E2"))
        self.pump(m, lambda: m.job is not None and m.job["epoch"] == "E2", 2)
        self.assertIn("epoch_changed", self.reasons())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)                                      # the first worker is gone, not a zombie of the monitor
        m.cancel("test_end")

    def test_new_prompt_between_last_read_and_delivery_is_stale(self):
        # The race the delivery-time re-read closes: the worker finishes, and a newer prompt is already in the
        # transcript but the monitor has not seen it yet (poll_job runs before the next snapshot).
        os.environ["FAKE_DELAY"] = "0.3"
        m = self.monitor()
        self.append(user(PROMPT, uid="E1"))
        self.pump(m, lambda: m.job is not None, 2)
        self.append(asst("tool_use"), user("also compare the staging config for drift please", uid="E2"))
        m.job["proc"].wait(timeout=10)                           # finished; no tick has looked at the new row
        m.tick()
        self.assertEqual(self.out, [])
        self.assertIn("stale_epoch", self.reasons())

    @staticmethod
    def long_turn_rows():
        """The live shape: a big row after the prompt, then a small tool result. The tail holds a user row but not the prompt."""
        fat = asst("tool_use"); fat["message"]["content"] = [{"type": "text", "text": "y" * 300000}]
        small_tr = {"type": "user", "uuid": "TR", "message": {"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}}
        return [fat, asst("tool_use"), small_tr, asst("tool_use")]

    def test_long_turn_prompt_beyond_the_tail_still_delivers(self):
        # Found in a live session: after tool output the prompt row lay outside the 256 KB tail, the delivery-time
        # re-read saw no turn start and dropped a valid nudge as stale_epoch.
        os.environ["FAKE_DELAY"] = "0.4"
        m = self.monitor()
        self.append(user(PROMPT, uid="E1"))
        self.pump(m, lambda: m.job is not None, 2)
        self.append(*self.long_turn_rows())
        self.assertTrue(self.pump(m, lambda: self.out, 5))
        self.assertEqual(len(self.out), 1)

    def test_epoch_that_cannot_be_found_is_dropped(self):
        os.environ["FAKE_DELAY"] = "0.4"
        m = self.monitor()
        self.append(user(PROMPT, uid="E1"))
        self.pump(m, lambda: m.job is not None, 2)
        ts_max = ts.TAIL_MAX
        ts.TAIL_MAX = ts.TAIL                                    # widening is capped at the first read
        self.append(*self.long_turn_rows())
        try:
            self.pump(m, lambda: "epoch_unknown" in self.reasons(), 5)
        finally:
            ts.TAIL_MAX = ts_max
        self.assertEqual(self.out, [])
        self.assertIn("epoch_unknown", self.reasons())

    def test_idle_session_is_never_woken(self):
        os.environ["FAKE_DELAY"] = "0.3"
        m = self.monitor()
        self.append(user(PROMPT, uid="E1"), asst("end_turn"), END)   # already idle when the prompt is noticed
        self.pump(m, lambda: "turn_ended" in self.reasons(), 3)
        time.sleep(0.5); m.tick()
        self.assertEqual(self.out, [])

    def test_unknown_state_does_not_deliver(self):
        os.environ["FAKE_DELAY"] = "0.4"
        m = self.monitor()
        self.append(user(PROMPT, uid="E1"))
        self.pump(m, lambda: m.job is not None, 2)
        bad = asst("end_turn"); del bad["message"]["stop_reason"]   # transcript layout drifts mid-turn
        self.append(bad)
        self.pump(m, lambda: m.job is None, 4)
        self.assertEqual(self.out, [])
        self.assertIn("state_unknown", self.reasons())

    def test_cooldown_per_pick(self):
        m = self.monitor()
        self.append(user(PROMPT, uid="E1"))
        self.pump(m, lambda: len(self.out) == 1)
        self.append(asst("tool_use"), user("and again debug the second regression in staging", uid="E2"))
        self.pump(m, lambda: "cooldown" in self.reasons(), 4)
        self.assertEqual(len(self.out), 1)

    def test_worker_failure_and_timeout_fail_open(self):
        os.environ["FAKE_FAIL"] = "1"
        m = self.monitor()
        self.append(user(PROMPT, uid="E1"))
        self.pump(m, lambda: "worker_failed" in self.reasons(), 3)
        self.assertEqual(self.out, [])
        os.environ.pop("FAKE_FAIL"); os.environ["FAKE_DELAY"] = "10"; mon.HARD_KILL_S = 0.4
        self.append(asst("tool_use"), user("a different request about deploying the staging service", uid="E2"))
        self.pump(m, lambda: "worker_timeout" in self.reasons(), 4)
        self.assertEqual(self.out, [])
        self.assertIsNone(m.job)

    def test_not_a_person_means_no_worker(self):
        m = self.monitor()
        self.append(user(PROMPT, uid="E1", origin={"kind": "task-notification"}, promptSource="system"))
        for _ in range(10):
            m.tick(); time.sleep(0.02)
        self.assertIsNone(m.job)
        self.assertEqual(self.out, [])

    def test_resumed_session_ignores_history(self):
        self.append(user(PROMPT, uid="OLD"))
        m = self.monitor()                                       # primed on a transcript that already holds a prompt
        for _ in range(10):
            m.tick(); time.sleep(0.02)
        self.assertIsNone(m.job)
        self.assertEqual(self.out, [])

    def test_garbage_transcript_never_raises_or_delivers(self):
        m = self.monitor()
        open(self.t, "a").write("garbage\n")
        for _ in range(5):
            m.tick(); time.sleep(0.02)
        self.assertEqual(self.out, [])


class TestHostCap(Env):
    def test_burst_of_ten_sessions_is_capped_at_three_workers(self):
        os.environ["FAKE_DELAY"] = "1.0"
        monitors = []
        for i in range(10):
            p = os.path.join(self.d, "t%d.jsonl" % i); open(p, "w").close()
            monitors.append((p, self.monitor(path=p, sid="s%d" % i)))
        for p, _ in monitors:
            self.append(user(PROMPT, uid="E"), path=p)
        for _ in range(10):
            for _, m in monitors:
                m.tick()
        running = sum(1 for _, m in monitors if m.job is not None)
        self.assertEqual(running, 3)
        self.assertEqual(self.reasons().count("no_slot"), 7)
        for _, m in monitors:
            m.cancel("test_end")
        # slots are released: a fresh prompt can run again
        p, m = monitors[0]
        self.append(asst("tool_use"), user("one more request about reviewing the migration plan", uid="E9"), path=p)
        self.pump(m, lambda: m.job is not None, 2)
        self.assertIsNotNone(m.job)
        m.cancel("test_end")


class TestProcess(Env):
    def test_real_monitor_process_prints_only_the_nudge(self):
        home = os.path.join(self.d, "home"); proj = os.path.join(home, ".claude", "projects", "p"); os.makedirs(proj)
        t = os.path.join(proj, "sid1.jsonl"); open(t, "w").close()
        env = dict(os.environ, HOME=home, CLAUDE_CODE_SESSION_ID="sid1")
        p = subprocess.Popen([sys.executable, os.path.join(ROOT, "bin", "monitor.py")], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        threading.Timer(25, p.kill).start()   # a failure must fail, not hang on readline
        try:
            end = time.time() + 15  # a loaded box starts python slowly: wait for the monitor's own start row
            while time.time() < end and "primed" not in self.reasons():
                time.sleep(0.05)
            self.assertIn("primed", self.reasons())
            self.append(user(PROMPT, uid="E1"), path=t)
            line = p.stdout.readline().decode()
            self.assertTrue(line.startswith("[skill-suggest]"), line)
            time.sleep(0.4)
            p.terminate()
            rest = p.stdout.read().decode()
            self.assertEqual(rest, "")
            self.assertEqual(p.wait(timeout=3), 0)
        finally:
            if p.poll() is None:
                p.kill()

    def test_disable_switch_exits_quietly(self):
        r = subprocess.run([sys.executable, os.path.join(ROOT, "bin", "monitor.py")], env=dict(os.environ, SKILL_SUGGEST_DISABLE="1"), capture_output=True, timeout=5)
        self.assertEqual((r.returncode, r.stdout), (0, b""))


if __name__ == "__main__":
    unittest.main()

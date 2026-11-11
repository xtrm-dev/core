#!/usr/bin/env python3
"""skill-suggest plugin monitor for Claude Code (CORE-2594).

Owns delivery only; it makes no skill decision. It follows the session
transcript tail, and for each person-typed prompt it spawns one short-lived
worker (dist/worker.mjs, the shared TS judge). A worker result becomes a nudge
only if, at the moment of delivery, the turn it was computed for is still
running. Otherwise it is dropped. An idle session is never woken.

stdout is a channel into the model: this process prints the nudge line and
nothing else. Diagnostics go to the decision log. Fail-open: any error means
no nudge.
"""
import fcntl, json, os, shutil, signal, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import turnstate as ts  # noqa: E402

PLUGIN_ROOT = os.environ.get("CLAUDE_PLUGIN_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TICK = 0.1
HARD_KILL_S = float(os.environ.get("SKILL_SUGGEST_HARD_KILL_S", "4.0"))
COOLDOWN_S = 30 * 60           # one suggestion per catalog id per 30 minutes, as the Pi extension
SLOTS = int(os.environ.get("SKILL_SUGGEST_SLOTS", "3"))   # host-wide worker cap
NUDGE_MAX = 600
READ_WINDOW_TURNS = 3          # as the Pi input seam: the suggested file counts as acted on if read within 3 turns
PROMPT_MAX = 4000


def log_dir():
    return os.environ.get("SKILL_SUGGEST_LOG_DIR") or os.path.join(os.path.expanduser("~"), ".xtrm", "skill-suggest")


def slot_dir():
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.environ.get("SKILL_SUGGEST_SLOT_DIR") or os.path.join(base, "xtrm-skill-suggest", "slots")


def worker_cmd():
    override = os.environ.get("SKILL_SUGGEST_WORKER_CMD")
    if override:
        return json.loads(override)
    rt = shutil.which("bun") or shutil.which("node")
    return [rt, os.path.join(PLUGIN_ROOT, "dist", "worker.mjs")] if rt else None


class Monitor:
    def __init__(self, sid, path=None, emit=None, clock=time.monotonic):
        self.sid, self.path, self.clock = sid, path, clock
        self.emit = emit or (lambda line: (sys.stdout.write(line + "\n"), sys.stdout.flush()))
        self.seen_epoch = None
        self.primed = False
        self.job = None
        self.cooldown = {}
        self.sig = None
        self.errors = 0
        self.watch = None        # read-after-suggest: the nudge's path, until it is read or the window ends
        self.prev_state = None
        self.fresh_start = path is None   # no transcript yet at start: the first prompt is not history

    # -- decision log: same file and row shape as the Pi extension, host="claude"
    def log(self, **row):
        now = time.time()  # one clock read: seconds and milliseconds must agree
        row = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + ".%03dZ" % (int(now * 1000) % 1000), "host": "claude", "sid": self.sid, **row}
        try:
            os.makedirs(log_dir(), exist_ok=True)
            fd = os.open(os.path.join(log_dir(), "log.jsonl"), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
            try:
                os.write(fd, (json.dumps(row) + "\n").encode())
            finally:
                os.close(fd)
        except Exception:
            pass

    def snap(self):
        if not self.path:
            self.path = ts.find_transcript(self.sid) if self.sid else None
            if not self.path:
                return None
        return ts.snapshot(self.path, os.stat(self.path).st_size, need_epoch=True)

    # -- host-wide worker cap: a lock-file semaphore; the OS frees a slot when its holder dies
    def take_slot(self):
        try:
            os.makedirs(slot_dir(), exist_ok=True)
            for i in range(SLOTS):
                fd = os.open(os.path.join(slot_dir(), "slot-%d.lock" % i), os.O_RDWR | os.O_CREAT, 0o644)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return fd
                except OSError:
                    os.close(fd)
        except Exception:
            pass
        return None

    def cancel(self, why):
        j, self.job = self.job, None
        if not j:
            return
        try:
            os.killpg(j["proc"].pid, signal.SIGKILL)
        except Exception:
            pass
        try:
            j["proc"].wait(timeout=1)
        except Exception:
            pass
        self.release(j)
        self.log(seam="input", outcome="skip", reason=why, epoch=j["epoch"])

    @staticmethod
    def release(j):
        try:
            if j.get("slot") is not None:
                os.close(j["slot"])  # closing the fd drops the flock
        except Exception:
            pass

    def spawn(self, epoch, prompt, cwd, tools=()):
        cmd = worker_cmd()
        if not cmd:
            return self.log(seam="input", outcome="skip", reason="no_runtime", epoch=epoch)
        slot = self.take_slot()
        if slot is None:
            return self.log(seam="input", outcome="skip", reason="no_slot", epoch=epoch)  # the cap: drop, never queue
        try:
            ctx = ts.structured_context(list(tools))
            ctx["issue"] = os.environ.get("SUBSTRATE_ISSUE_REF") or os.environ.get("SUBSTRATE_ISSUE") or None
            payload = json.dumps({"sid": self.sid, "epoch": epoch, "cwd": cwd, "prompt": prompt[:PROMPT_MAX], **ctx})
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
            try:
                proc.stdin.write(payload.encode()); proc.stdin.close()
            except Exception:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except Exception:
                    pass
                proc.wait(timeout=1)  # never leave a process or a slot behind
                raise
            self.job = {"proc": proc, "epoch": epoch, "t0": self.clock(), "slot": slot}
        except Exception as e:
            os.close(slot)
            self.log(seam="input", outcome="skip", reason="spawn_failed:" + type(e).__name__, epoch=epoch)

    def deliver(self, job, out):
        """The only place a nudge is written. Re-reads the transcript immediately before writing."""
        if out.get("outcome") != "fire" or not isinstance(out.get("nudge"), str):
            return  # the worker already logged why it skipped
        pick = str(out.get("pick"))
        now = self.clock()
        s = self.snap()
        if s is None or s["state"] != "running":
            return self.log(seam="input", pick=pick, outcome="skip", reason="turn_ended" if s and s["state"] == "idle" else "state_unknown", epoch=job["epoch"], state=(s or {}).get("why"))
        if s["epoch"] is None:  # even the widest read found no turn start: cannot prove the turn is the same
            return self.log(seam="input", pick=pick, outcome="skip", reason="epoch_unknown", epoch=job["epoch"])
        if s["epoch"] != job["epoch"]:
            return self.log(seam="input", pick=pick, outcome="skip", reason="stale_epoch", epoch=job["epoch"])
        if now - self.cooldown.get(pick, -COOLDOWN_S) < COOLDOWN_S:
            return self.log(seam="input", pick=pick, outcome="skip", reason="cooldown", epoch=job["epoch"])
        line = " ".join(out["nudge"].split())[:NUDGE_MAX]
        self.cooldown[pick] = now
        self.emit(line)
        if isinstance(out.get("path"), str):
            self.watch = {"pick": pick, "path": out["path"], "left": READ_WINDOW_TURNS, "seen": {t[0] for t in s.get("tools", [])}}
        self.log(seam="input", pick=pick, outcome="deliver", reason="delivered", injected=True, epoch=job["epoch"], score=out.get("score"), ms=int((now - job["t0"]) * 1000))

    def poll_job(self):
        j = self.job
        if not j:
            return
        rc = j["proc"].poll()
        if rc is None:
            if self.clock() - j["t0"] > HARD_KILL_S:
                self.cancel("worker_timeout")
            return
        self.job = None
        try:
            raw = j["proc"].stdout.read().decode("utf-8", "replace").strip().splitlines()
            out = json.loads(raw[-1]) if raw else {}
        except Exception:
            out = {}
        finally:
            self.release(j)
        if rc != 0 or not out:
            return self.log(seam="input", outcome="skip", reason="worker_failed", epoch=j["epoch"], rc=rc)
        self.deliver(j, out)

    def watch_step(self, s):
        """read_after_suggest, the act-on rate: a path-identical Read of the suggested file within the window."""
        w, prev, self.prev_state = self.watch, self.prev_state, s["state"]
        if not w:
            return
        for tid, name, fp in s.get("tools", []):
            if tid in w["seen"]:
                continue
            w["seen"].add(tid)
            if name == "Read" and fp and os.path.abspath(fp) == os.path.abspath(w["path"]):
                self.watch = None
                return self.log(seam="read_after_suggest", pick=w["pick"], outcome="read", path=w["path"])
        if prev == "running" and s["state"] == "idle":
            w["left"] -= 1
            if w["left"] <= 0:
                self.watch = None
                self.log(seam="read_after_suggest", pick=w["pick"], outcome="expired")

    def tick(self):
        """One pass. Cheap when nothing changed: one stat."""
        self.poll_job()
        if not self.path:
            self.path = ts.find_transcript(self.sid) if self.sid else None
            if not self.path:
                return
        st = os.stat(self.path)
        sig = (st.st_size, st.st_mtime_ns)
        if sig == self.sig:
            return
        self.sig = sig
        s = ts.snapshot(self.path, st.st_size)
        self.watch_step(s)
        if not self.primed:  # a resumed session: do not act on history
            self.primed = True
            self.seen_epoch = None if self.fresh_start else s["epoch"]
            self.log(seam="monitor", outcome="start", reason="primed", state=s["why"])
            if not self.fresh_start:
                return
        if s["epoch"] is None or s["epoch"] == self.seen_epoch:
            return
        self.seen_epoch = s["epoch"]
        self.cancel("epoch_changed")  # a new turn start: whatever was computing is for the past
        prompt, why = ts.eligible_prompt(s["row"])
        if prompt is None:
            if why != "not_human":
                self.log(seam="input", outcome="skip", reason=why, epoch=s["epoch"])
            return
        if s["state"] != "running":
            return self.log(seam="input", outcome="skip", reason="turn_ended" if s["state"] == "idle" else "state_unknown", epoch=s["epoch"])
        self.spawn(s["epoch"], prompt, (s["row"] or {}).get("cwd") or os.getcwd(), s.get("tools", []))

    def run(self):
        while True:
            try:
                self.tick()
                self.errors = 0
            except Exception as e:
                self.errors += 1
                self.log(seam="input", outcome="skip", reason="monitor_error:" + type(e).__name__)
                if self.errors >= 20:
                    return  # stop quietly: no nudges is the safe state
                time.sleep(1.0)
            time.sleep(0.05 if self.job else TICK)


def main():
    if os.environ.get("SKILL_SUGGEST_DISABLE") == "1":
        return
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    m = Monitor(os.environ.get("CLAUDE_CODE_SESSION_ID"))
    try:
        m.run()
    finally:
        m.cancel("monitor_exit")


if __name__ == "__main__":
    main()

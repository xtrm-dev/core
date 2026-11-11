"""A stand-in worker: reads stdin, sleeps FAKE_DELAY, prints one JSON result.
FAKE_STDIN_DUMP: write the stdin payload there. FAKE_PATH: name this path in the result. FAKE_NUDGE_LEN: pad the nudge.
FAKE_PIDFILE: write a pid file. FAKE_GRANDCHILD: spawn a `sleep` child and write its pid to that file."""
import json, os, subprocess, sys, time
payload = sys.stdin.read()
if os.environ.get("FAKE_STDIN_DUMP"):
    open(os.environ["FAKE_STDIN_DUMP"], "w").write(payload)
if os.environ.get("FAKE_PIDFILE"):
    open(os.environ["FAKE_PIDFILE"] + "." + str(os.getpid()), "w").close()
if os.environ.get("FAKE_GRANDCHILD"):
    g = subprocess.Popen(["sleep", "30"])
    open(os.environ["FAKE_GRANDCHILD"], "w").write(str(g.pid))
time.sleep(float(os.environ.get("FAKE_DELAY", "0")))
if os.environ.get("FAKE_FAIL"):
    sys.exit(3)
nudge = "[skill-suggest] Read /abs/doc.md\nbefore you start."
if os.environ.get("FAKE_NUDGE_LEN"):
    nudge = "[skill-suggest] " + "word " * int(os.environ["FAKE_NUDGE_LEN"])
out = {"outcome": "fire", "pick": os.environ.get("FAKE_PICK", "eng/debug"), "score": 0.5, "nudge": nudge}
if os.environ.get("FAKE_PATH"):
    out["path"] = os.environ["FAKE_PATH"]
print(json.dumps(out))

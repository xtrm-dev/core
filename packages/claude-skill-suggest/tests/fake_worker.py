"""A stand-in worker: reads stdin, sleeps FAKE_DELAY, prints one JSON result. Writes its pid to FAKE_PIDFILE when set."""
import json, os, sys, time
sys.stdin.read()
if os.environ.get("FAKE_PIDFILE"):
    open(os.environ["FAKE_PIDFILE"] + "." + str(os.getpid()), "w").close()
time.sleep(float(os.environ.get("FAKE_DELAY", "0")))
if os.environ.get("FAKE_FAIL"):
    sys.exit(3)
print(json.dumps({"outcome": "fire", "pick": os.environ.get("FAKE_PICK", "eng/debug"), "score": 0.5,
                  "nudge": "[skill-suggest] Read /abs/doc.md\nbefore you start."}))

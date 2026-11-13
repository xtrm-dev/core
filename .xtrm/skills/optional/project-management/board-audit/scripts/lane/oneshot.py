#!/usr/bin/env python3
"""Fire reminders at given UTC times into events.log (watch.sh surfaces them).
Each entry: {"name": ..., "at": "YYYY-MM-DDTHH:MMZ", "note": "..."}
The reminder is a prompt to the agent, never an autonomous action."""
import json, sys, time, os
from datetime import datetime, timezone

import lanecfg

P = os.path.join(lanecfg.lane(), "oneshots.json")
LOG = os.path.join(lanecfg.lane(), "events.log")

def cli(argv):
    """No args: run the loop. `add <name> <at> <note>`: append one reminder and exit. Anything else: exit 2."""
    if not argv:
        return None
    if argv[0] == "add":
        if len(argv) < 4:
            print("usage: oneshot.py add <name> <YYYY-MM-DDTHH:MMZ> <note>", file=sys.stderr)
            sys.exit(2)
        name, at, note = argv[1], argv[2], " ".join(argv[3:])
        try:
            datetime.strptime(at, "%Y-%m-%dT%H:%MZ")
        except ValueError:
            print(f"bad timestamp {at!r}: expected YYYY-MM-DDTHH:MMZ", file=sys.stderr)
            sys.exit(2)
        try:
            items = json.load(open(P))
        except Exception:
            items = []
        if any(it.get("name") == name for it in items):
            print(f"reminder {name} already present", file=sys.stderr)
            sys.exit(0)
        items.append({"name": name, "at": at, "note": note})
        # the running daemon rewrites this file every 30 s; a read-modify-write is what keeps the entry alive
        json.dump(items, open(P, "w"), indent=1)
        print(f"added {name} at {at}")
        sys.exit(0)
    print(f"unknown argument {argv[0]!r}; no args runs the loop", file=sys.stderr)
    sys.exit(2)


def now():
    return datetime.now(timezone.utc)
cli(sys.argv[1:])
while True:
    try:
        items = json.load(open(P))
    except Exception:
        items = []
    t = now()
    keep = []
    for it in items:
        try:
            at = datetime.strptime(it["at"], "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
        except Exception:
            continue
        if t >= at:
            if not it.get("fired"):
                with open(LOG, "a") as f:
                    f.write(f"{t:%Y-%m-%dT%H:%M:%SZ} ONESHOT-FIRE {it['name']} due={it['at']} :: {it.get('note','')}\n")
                it["fired"] = t.strftime("%Y-%m-%dT%H:%M:%SZ")
        keep.append(it)
    try:
        json.dump(keep, open(P, "w"), indent=1)
    except Exception:
        pass
    time.sleep(30)

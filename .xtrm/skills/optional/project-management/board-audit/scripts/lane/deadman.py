#!/usr/bin/env python3
"""Dead-man switch for this lane: a router that stopped looks exactly like an inbox with no news.

Why (board-audit, "The router role"): silence is the default state of a healthy inbox and the default state
of a broken router. This process is the only thing that distinguishes them, so it must be independent of the
scheduler it watches — if the scheduler dies, nothing inside the scheduler can say so.

It writes ALARM lines into events.log, which is the file the session monitor tails, so a dead lane still
produces a sound. Checks, each against the record rather than against filesystem timestamps where possible:

  SCHEDULER-DEAD      the pid in the newest SCHEDULER-START line is gone, or its cwd is not this lane
  ROUTER-STALE        the newest events.log line carrying a timestamp is older than STALE_S
  SEND-UNCONFIRMED    an outbox-pending record has waited longer than SEND_S without mark-sent.py
  ROUTE-TARGET        the manager or board_helper role resolves to no live session, or to several
                      (not lead: several live leads are normal, and the board helper names the one it means)
  WATCHER-COUNT       zero or more than one tail on this lane's events.log (one watcher, and it advances)
  LOG-MISSING         events.log does not exist

Deliberately no alarm for "no new comment": that is the healthy state and an alarm on it is noise.
"""
import os
import re
import subprocess
import time
from datetime import datetime, timezone

import lanecfg
import route_target  # project-management/scripts, on sys.path via lanecfg

LANE = lanecfg.lane()
# Optional publisher for the unwatched-lane fact: a module exposing sync(unwatched, detail) -> str.
# Unset means the alarm stays in events.log only.
WATCHDOG = lanecfg.get("PM_LANE_WATCHDOG")
EV = os.path.join(LANE, "events.log")
PENDING = os.path.join(LANE, "outbox-pending")
OUTBOX = os.path.join(LANE, "pending-routes.jsonl")
STALE_S = 900          # ROUTE-PASS lands every 300 s; 900 is three missed passes
SEND_S = 600           # board-audit: an emitted body unconfirmed after 10 minutes is residue
CHECK_S = 120
TS = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)")


def stamp():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def alarm(msg):
    with open(EV, "a", encoding="utf-8") as fh:
        fh.write(f"{stamp()} ALARM {msg}\n")


def read_lines():
    try:
        with open(EV, encoding="utf-8", errors="replace") as fh:
            return fh.readlines()
    except FileNotFoundError:
        return None


def last_stamp(lines):
    for line in reversed(lines):
        m = TS.match(line)
        if m:
            return datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    return None


def last_scheduler_pid(lines):
    for line in reversed(lines):
        m = re.search(r"SCHEDULER-START pid=(\d+)", line)
        if m:
            return int(m.group(1))
    return None


def alive_in_lane(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False, "gone"
    except PermissionError:
        pass
    try:
        cwd = os.readlink(f"/proc/{pid}/cwd")
    except OSError:
        return True, "cmdline unreadable"
    return True, cwd


def watcher_count():
    try:
        out = subprocess.run(["ps", "-eo", "pid,cmd"], capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return -1
    n = 0
    for line in out.splitlines():
        parts = line.split(None, 1)
        if len(parts) < 2:
            continue
        cmd = parts[1]
        # count only the bare tail process, not the /bin/sh -c wrapper that
        # launched it (the wrapper's cmdline also contains the tail string,
        # which double-counted one watcher as two; fixed 2026-11-08)
        if cmd.startswith("tail -n 0 -F") and f"{LANE}/events.log" in line:
            n += 1
    return n


def check():
    lines = read_lines()
    if lines is None:
        alarm("LOG-MISSING events.log does not exist")
        return
    pid = last_scheduler_pid(lines)
    if pid is None:
        alarm("SCHEDULER-DEAD no SCHEDULER-START line in events.log")
    else:
        ok, where = alive_in_lane(pid)
        if not ok:
            alarm(f"SCHEDULER-DEAD pid={pid} is gone")
        elif where != LANE:
            alarm(f"SCHEDULER-DEAD pid={pid} cwd={where} is not this lane")
    ls = last_stamp(lines)
    if ls is None:
        alarm("ROUTER-STALE events.log carries no timestamped line")
    else:
        age = (datetime.now(timezone.utc) - ls).total_seconds()
        if age > STALE_S:
            alarm(f"ROUTER-STALE newest event is {int(age)}s old (limit {STALE_S}s)")
    # SEND-UNCONFIRMED, rewritten 2026-11-04 after six operator messages sat undelivered for four hours.
    # WHY it failed: this check looked in a PENDING *directory*, while the router writes its outbox to
    # pending-routes.jsonl (a file, one JSON record per line, `delivered` false until a model turn forwards
    # the text and marks it). The check therefore inspected nothing and was silent through the whole event;
    # silence from a control is indistinguishable from health, which is exactly how the messages were lost.
    # It now reads the file the router actually writes, and ages each record from its own timestamp.
    if os.path.exists(OUTBOX):
        import json as _json
        try:
            with open(OUTBOX, encoding="utf-8") as fh:
                recs = [_json.loads(l) for l in fh if l.strip()]
        except Exception as exc:  # noqa: BLE001
            alarm(f"SEND-UNCONFIRMED cannot read the outbox ({exc.__class__.__name__}) — the check is blind")
            recs = []
        for rec in recs:
            if rec.get("delivered"):
                continue
            when = rec.get("at") or rec.get("seen_at") or ""
            try:
                ts = datetime.strptime(str(when)[:16], "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
            except ValueError:
                ts = None
            age = (datetime.now(timezone.utc) - ts).total_seconds() if ts else SEND_S + 1
            if age > SEND_S:
                alarm(f"ROUTE-UNDELIVERED {rec.get('id')} on {rec.get('key')} waited {int(age)}s "
                      f"without being forwarded: {str(rec.get('text') or '')[:80]!r}")
    n = watcher_count()
    if n == 0:
        alarm("WATCHER-COUNT 0 tails on events.log: nobody is reading this log")
    elif n > 1:
        alarm(f"WATCHER-COUNT {n} tails on events.log: one watcher, not several")
    # ROUTE-TARGET: the default forward target is the one live manager, and one board helper reads this log. A
    # missing or doubled role is said here every pass, so a stale route is seen before a message waits on it.
    # Leads are not checked: several live leads are the normal state.
    try:
        live = route_target.sessions()
        for role in ("manager", "board_helper"):
            try:
                route_target.resolve(role, live)
            except route_target.RouteError as exc:
                alarm(f"ROUTE-TARGET {role}: {exc}")
    except route_target.RouteError as exc:
        alarm(f"ROUTE-TARGET cannot check: {exc}")

    # a correct alarm written only into the unread log is invisible (2026-11-09: 17 h with no reader),
    # so the same fact is published where the operator and the coordinator look, and cleared when a
    # reader is back. Import by path: this lane is not a package.
    if not WATCHDOG:
        return
    try:
        import importlib.util as _ilu
        _spec = _ilu.spec_from_file_location("lane_watchdog", os.path.expanduser(WATCHDOG))
        _mod = _ilu.module_from_spec(_spec)
        _spec.loader.exec_module(_mod)
        _msg = _mod.sync(n == 0, f"watcher_count={n} at {stamp()}")
        if _msg:
            alarm(_msg)
    except Exception as _exc:  # noqa: BLE001 - the switch must not die of its own watchdog
        alarm(f"LANE-WATCHDOG-ERROR {type(_exc).__name__}: {_exc}")


if __name__ == "__main__":
    alarm("DEADMAN-START checks every %ds, stale limit %ds" % (CHECK_S, STALE_S))
    while True:
        try:
            check()
        except Exception as exc:  # the switch must not die of its own bug
            alarm(f"DEADMAN-ERROR {type(exc).__name__}: {exc}")
        time.sleep(CHECK_S)

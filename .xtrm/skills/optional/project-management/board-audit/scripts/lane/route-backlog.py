#!/usr/bin/env python3
"""Undelivered operator decisions are a failure, so they are counted out loud.

route-watch.py classifies and appends to pending-routes.jsonl. Delivery happens through the agent's SendMessage,
which no shell script can call. That leaves one hole: if nobody delivers, silence looks like "nothing happened".
This script closes it by naming every undelivered decision older than GRACE_MIN minutes, so a lost message becomes
a visible number instead of a quiet absence.
"""
import json, os, subprocess, sys, datetime as dt

import lanecfg

LANE = lanecfg.lane()
OUTBOX = f"{LANE}/pending-routes.jsonl"
GRACE_MIN = 10
# DELIVERY MODEL (coordinator, 2026-11-01T12:09Z): route-backlog does not deliver. It names what must be SENT.
# The agent sends it by SendMessage with key, comment id, author time and the first 300 characters, and calls
# mark-routed.py only after the send returns. A line here is therefore an instruction, not a record of delivery.


def now():
    return dt.datetime.now(dt.timezone.utc)


def age_min(ts):
    try:
        t = dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        if t.tzinfo is None:
            t = t.replace(tzinfo=dt.timezone.utc)
        return (now() - t).total_seconds() / 60
    except Exception:
        return None


def main():
    if not os.path.exists(OUTBOX):
        return 0
    rows = []
    with open(OUTBOX, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    # backfill rows were recovered from events.log history, so they are a record, not a queue:
    # alarming on them forever would train the reader to ignore the alarm.
    undel = [r for r in rows if not r.get("delivered") and not r.get("backfill")]
    stale = [r for r in undel if (age_min(r.get("seen_at")) or 0) >= GRACE_MIN]
    if not undel:
        return 0
    stamp = now().strftime("%Y-%m-%dT%H:%M:%SZ")
    if stale:
        for r in stale:
            print(f"ROUTE-UNDELIVERED {stamp} id={r.get('id')} key={r.get('key')} cid={r.get('cid')} "
                  f"seen_at={r.get('seen_at')} age={(age_min(r.get('seen_at')) or 0):.0f}min trigger={r.get('trigger')} "
                  f"text={str(r.get('text'))[:300]!r} -> SEND this to the coordinator with SendMessage, then "
                  f"python3 {lanecfg.SCRIPTS / 'mark-routed.py'} {r.get('id')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""One command for a routed decision: emit the exact message text AND record it as being forwarded.

Why it exists (coordinator ruling, 2026-11-02): forwarding a routed decision and marking it routed were two
actions, so the delivered flag drifted from what was actually sent — four decisions sat in the outbox as
"undelivered" for a day although every one had been answered on its row. The flag is only worth having if it
cannot drift.

Shape: bash cannot send an intercom message (SendMessage is a model tool), so the pair is split where the
boundary really is:
  route-forward.py <id>[,<id>...]   -> prints the body to send, writes outbox-pending/<id>.json, does NOT mark
  mark-sent.py <id>[,<id>...]       -> marks delivered=true, moves the pending record to forwarded.jsonl

A pending file that is never confirmed is the visible residue, and watch.sh raises ALARM pending-send on it
after 10 minutes. Marking without the emit is impossible (no body), and emitting without sending leaves the
alarm armed.
"""
import json
import os
import sys
from datetime import datetime, timezone

import lanecfg  # noqa: E402

LANE = lanecfg.lane()
OUTBOX = os.path.join(LANE, "pending-routes.jsonl")
PENDING_DIR = os.path.join(LANE, "outbox-pending")


def stamp():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load():
    rows = []
    with open(OUTBOX, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def main(ids):
    os.makedirs(PENDING_DIR, exist_ok=True)
    rows = {r.get("id"): r for r in load()}
    missing = [i for i in ids if i not in rows]
    if missing:
        print(f"REFUSED unknown id(s) {missing}; nothing emitted and nothing marked")
        return 2
    already = [i for i in ids if rows[i].get("delivered")]
    if already:
        print(f"REFUSED already delivered: {already}; a second forward would double-report a decision")
        return 3
    lines = []
    for i in ids:
        r = rows[i]
        text = " ".join((r.get("text") or "").split())
        lines.append(f"{r.get('key')} c{r.get('cid')} ({r.get('at')}): {text}")
    body = "\n".join(lines)
    for i in ids:
        rec = {"id": i, "emitted_at": stamp(), "body": body}
        with open(os.path.join(PENDING_DIR, i.replace(":", "_") + ".json"), "w", encoding="utf-8") as fh:
            json.dump(rec, fh)
    # the coordinator's reply address changes on every handover, so it is read from the environment
    print("SEND-TO $XTRM_DISPATCHER_REPLY (%s)" % (os.environ.get("COORD_SOCK") or "COORD_SOCK not set"))
    print("--- BEGIN BODY (send this, then run mark-sent.py) ---")
    print(body)
    print("--- END BODY ---")
    print(f"PENDING {len(ids)} recorded; confirm with: python3 {lanecfg.SCRIPTS / 'mark-sent.py'} {','.join(ids)}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: route-forward.py <id>[,<id>...]")
        sys.exit(1)
    sys.exit(main([x for x in sys.argv[1].split(",") if x]))

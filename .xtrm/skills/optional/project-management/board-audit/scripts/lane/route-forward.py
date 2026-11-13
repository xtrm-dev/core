#!/usr/bin/env python3
"""One command for a routed decision: emit the exact message text AND record it as being forwarded.

Why it exists (coordinator ruling, 2026-11-02): forwarding a routed decision and marking it routed were two
actions, so the delivered flag drifted from what was actually sent — four decisions sat in the outbox as
"undelivered" for a day although every one had been answered on its row. The flag is only worth having if it
cannot drift.

Shape: bash cannot send an intercom message (SendMessage is a model tool), so the pair is split where the
boundary really is:
  route-forward.py <id>[,<id>...] [--to <name>]
                                    -> prints the body to send, writes outbox-pending/<id>.json, does NOT mark
  mark-sent.py <id>[,<id>...]       -> marks delivered=true, moves the pending record to forwarded.jsonl

A pending file that is never confirmed is the visible residue, and watch.sh raises ALARM pending-send on it
after 10 minutes. Marking without the emit is impossible (no body), and emitting without sending leaves the
alarm armed.

Target: the board helper decides where an operator comment goes. This script only prints a default, the live
session holding the `manager` role (project-management/scripts/route_target.py), resolved now and never stored.
`--to <name>` sends it to that live session instead (a lead, by its session name or worktree address). The old
COORD_SOCK environment override is gone: `--to` is the one manual override.
"""
import json
import os
import sys
from datetime import datetime, timezone

import lanecfg  # noqa: E402
import route_target  # noqa: E402  (project-management/scripts, on sys.path via lanecfg)

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


def main(ids, to=None):
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
    # The target is resolved now, from the live session registry, never stored: a stored address went stale
    # with its session (2026-11-12).
    try:
        if to:
            rec = route_target.find(to)
            if rec is None:
                print(f"REFUSED --to {to}: no single live session of this project has that name; nothing emitted")
                return 4
            target = rec["address"]
        else:
            target = route_target.resolve("manager")["address"]
    except route_target.RouteError as exc:
        print(f"REFUSED no route target: {exc}; pass --to <name> once a live session can take it. "
              "Nothing emitted and nothing marked")
        return 4
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
    print(f"SEND-TO {target}  (SendMessage to this name)")
    print("--- BEGIN BODY (send this, then run mark-sent.py) ---")
    print(body)
    print("--- END BODY ---")
    print(f"PENDING {len(ids)} recorded; confirm with: python3 {lanecfg.SCRIPTS / 'mark-sent.py'} {','.join(ids)}")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    to = None
    if "--to" in args:
        i = args.index("--to")
        if i + 1 >= len(args):
            print("usage: route-forward.py <id>[,<id>...] [--to <name>]")
            sys.exit(1)
        to = args[i + 1]
        del args[i:i + 2]
    if len(args) != 1:
        print("usage: route-forward.py <id>[,<id>...] [--to <name>]")
        sys.exit(1)
    sys.exit(main([x for x in args[0].split(",") if x], to))

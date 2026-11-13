#!/usr/bin/env python3
"""Confirm that the body route-forward.py emitted was sent: mark delivered and archive the record.

Refuses when the pending record is missing — a mark without an emitted body is the drift this pair exists to
prevent — and refuses an id that is not in the outbox. Writes one line per confirmation to forwarded.jsonl
with the body and its length, so "what was forwarded" is recoverable after the fact.
"""
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

import lanecfg  # noqa: E402

LANE = lanecfg.lane()
OUTBOX = os.path.join(LANE, "pending-routes.jsonl")
PENDING_DIR = os.path.join(LANE, "outbox-pending")
FORWARDED = os.path.join(LANE, "forwarded.jsonl")


def stamp():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main(ids):
    with lanecfg.outbox_lock(OUTBOX):
        return _main(ids)


def _main(ids):
    rows = []
    with open(OUTBOX, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    by_id = {r.get("id"): r for r in rows}

    pending, refused = {}, []
    for i in ids:
        p = os.path.join(PENDING_DIR, i.replace(":", "_") + ".json")
        if i not in by_id:
            refused.append(f"{i}: not in the outbox")
        elif not os.path.exists(p):
            refused.append(f"{i}: no emitted body (run route-forward.py first)")
        else:
            pending[i] = (p, json.load(open(p, encoding="utf-8")))
    if refused:
        print("REFUSED: " + "; ".join(refused) + " — nothing marked")
        return 2

    now = stamp()
    with open(FORWARDED, "a", encoding="utf-8") as fh:
        for i, (p, rec) in pending.items():
            body = rec.get("body", "")
            fh.write(json.dumps({"id": i, "sent_at": now, "emitted_at": rec.get("emitted_at"),
                                 "chars": len(body), "sha256": hashlib.sha256(body.encode()).hexdigest()[:16],
                                 "body": body}) + "\n")
            os.remove(p)
    for r in rows:
        if r.get("id") in pending:
            r["delivered"] = True
            r["delivered_at"] = now
    tmp = OUTBOX + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    os.replace(tmp, OUTBOX)  # readers (deadman) never see a half-written file
    print(f"marked delivered and archived {len(pending)}: {sorted(pending)}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: mark-sent.py <id>[,<id>...]")
        sys.exit(1)
    sys.exit(main([x for x in sys.argv[1].split(",") if x]))

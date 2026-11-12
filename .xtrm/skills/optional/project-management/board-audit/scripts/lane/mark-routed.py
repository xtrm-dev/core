#!/usr/bin/env python3
"""Mark one pending route as delivered. Refuses an unknown id so a typo cannot invent a delivery."""
import json, os, sys

import lanecfg

OUTBOX = os.path.join(lanecfg.lane(), "pending-routes.jsonl")


def main(rid):
    if not os.path.exists(OUTBOX):
        print(f"no outbox at {OUTBOX}")
        return 1
    rows, found = [], False
    with open(OUTBOX, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if r.get("id") == rid:
                r["delivered"] = True
                found = True
            rows.append(r)
    if not found:
        ids = [r.get("id") for r in rows][-8:]
        print(f"REFUSED unknown id {rid!r}; newest ids: {ids}")
        return 2
    with open(OUTBOX, "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    print(f"marked delivered: {rid}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: mark-routed.py <id>")
        sys.exit(1)
    sys.exit(main(sys.argv[1]))

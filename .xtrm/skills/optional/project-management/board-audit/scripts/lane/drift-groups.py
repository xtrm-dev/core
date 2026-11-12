#!/usr/bin/env python3
"""Group the cycle's status-drift rows by cause, for a per-group ruling (coordinator, 2026-11-04).

The cycle already writes every drifted row with its status, tier and evidence into
`lane/cycle/DRIFT-<HHMM>Z.json`; this reads the newest of those and prints counts plus three example keys
per group. It writes nothing and calls no API, so it is safe to re-run at any time.

WHY the grouping order matters. A row can satisfy several groups at once (a row can be active, its
Substrate ref is closed, AND the PR names a shared ref). The tier is applied first because it decides
whether the row is drift at all: `shared-ref` means the PR names a ref that several rows carry, which
proves the ref moved, not that this row's step ran. Keeping those separate stops a shared ref from
inflating the count a coordinator is asked to rule on.

Groups:
  E  shared-ref                     the ref moved, not necessarily this step   (probably not drift)
  F  merged, not on origin/stable   queueing, not a defect
  A  Waiting Production + deployed  the step ran, the row never moved
  A2 active status + deployed
  B  active status + ref CLOSED
  C  active status + journal result only            (weak evidence)
  D  Deferred while the work is live
  G  unclassified                   should be empty; if not, the classifier needs a new case

Usage: drift-groups.py [path-to-DRIFT.json]
"""
import glob
import json
import os
import sys
from collections import OrderedDict

import lanecfg

LANE = lanecfg.lane()
_ST = lanecfg.statuses()
WAITING = _ST["waiting_production"]
ACTIVE = tuple(_ST["active"])
DEFERRED = _ST["deferred"]
ORDER = ["E", "F", "A", "A2", "B", "C", "D", "G"]
LABEL = {
    "E": "shared-ref: the ref moved, not necessarily this step (probably not drift)",
    "F": "PR merged, not yet on origin/stable (queueing, not a defect)",
    "A": "Waiting Production + deployed PR on stable (the step ran, the row never moved)",
    "A2": "active status + deployed PR on stable",
    "B": "active status + Substrate ref CLOSED",
    "C": "active status + journal result entry only (WEAK evidence)",
    "D": "Deferred while the work is live (ref closed or PR on stable)",
    "G": "unclassified (classifier needs a case)",
}


def group_of(row):
    status, why, tier = row.get("status", ""), row.get("why", ""), row.get("tier", "")
    closed = "Substrate ref closed" in why
    on_stable = "on origin/stable" in why
    merged_not = "merged, not on origin/stable" in why
    # BOTH wordings: cycle.py said "journal result entry" until 2026-11-04, when the live-check rule
    # renamed it to "a result entry that names a live check". Keying on only the old phrase silently
    # dropped every C row into G the moment the cycle changed its words — the loud G is what caught it.
    journal = ("journal result entry" in why) or ("result entry that names a live check" in why)
    if tier == "shared-ref":
        return "E"
    if merged_not:
        return "F"
    if status == WAITING and on_stable:
        return "A"
    if status in ACTIVE and on_stable:
        return "A2"
    if status in ACTIVE and closed:
        return "B"
    if status == DEFERRED and (closed or on_stable):
        return "D"
    if status in ACTIVE and journal and not on_stable:
        return "C"
    if closed:
        return "B"
    if on_stable:
        return "A2"
    return "G"


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else None
    if not path:
        files = sorted(glob.glob(os.path.join(LANE, "cycle", "DRIFT-*.json")))
        if not files:
            print("no DRIFT-*.json in the cycle directory")
            return 2
        path = files[-1]
    rows = json.load(open(path))
    groups = OrderedDict((g, []) for g in ORDER)
    for r in rows:
        groups[group_of(r)].append(r)
    print(f"source: {os.path.basename(path)} ({len(rows)} rows)\n")
    for g in ORDER:
        rs = groups[g]
        if not rs:
            continue
        keys = ", ".join(r["key"] for r in rs[:3])
        print(f"{g:2s} {len(rs):3d}  {LABEL[g]}")
        print(f"          e.g. {keys}")
    real = sum(len(groups[g]) for g in ("A", "A2", "B", "C", "D"))
    explainable = len(groups["E"]) + len(groups["F"])
    weak = len(groups["C"])
    print(f"\n{len(rows)} drifted = {explainable} explainable without a ruling "
          f"+ {real} status-vs-evidence rows of which {weak} rest on weak evidence")
    if groups["G"]:
        print("!! unclassified rows present: the classifier needs a new case")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env bash
# Board cycle: one read-only pass, one CYCLE-<HHMM>Z.md, one summary line.
# Engine: cycle/cycle.py; its state lives in $PM_LANE_DIR/cycle.
set -u
SCRIPTS=$(cd "$(dirname "$0")" && pwd)
PMCFG="$(cd "$(dirname "$0")" && pwd)/../../../project-management/scripts/pm_config.py"
PM_PROJECT=${PM_PROJECT:-$(python3 "$PMCFG" project)} || exit 1; export PM_PROJECT
LANE=${PM_LANE_DIR:-$(python3 "$PMCFG" get PM_LANE_DIR)} || exit 1
L=$LANE/cycle
mkdir -p "$L"
OUT=$L/CYCLE-$(date -u +%H%MZ).md
cd "$L" || exit 1
python3 "$SCRIPTS/cycle/cycle.py" > "$OUT" 2>"$OUT.err"
rc=$?
python3 - "$OUT" "$rc" "$SCRIPTS" <<'PY'
import json, re, sys
path, rc, scripts = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.insert(0, scripts)
import lanecfg
f = lanecfg.data("PM_HYGIENE_FILTERS", required=True)
no_dates, overdue, next48 = (str(f[r]["id"]) for r in ("open_without_dates", "overdue", "next_48h"))
txt = open(path, encoding='utf-8', errors='replace').read()
m = re.search(r'## Counts\s*```\s*(\{.*?\n\})\s*```', txt, re.S)
c = json.loads(m.group(1)) if m else {}
keys = (f"{no_dates}_window", overdue, next48, "no_slot", "fold_orphans", "drift", "unmirrored_prod_contracts",
        "pr_links_missing", "pr_no_window", "new_comments", "new_tickets", "control_failures",
        # unrowed_done last: the digest appends it to the same CYCLE line, so both printers agree
        "unrowed_done", "unrowed_backlog",
        # the two label/slot pair counts, so they are filterable and visible in the one-line digest
        # (lead ruling 2026-11-06: "put the count in your cycle report")
        "slot_no_label", "window_no_slot", "window_no_slot_tracked")
if not c:
    print(f"CYCLE-ERROR rc={rc} no counts block in {path}")
else:
    parts = " ".join(f"{k}={c.get(k)}" for k in keys)
    tail = " CONTROL-FAILURES" if c.get("control_failures") else ""
    print(f"CYCLE rc={rc} {parts}{tail}")
    if c.get("control_failures"):
        print(f"CYCLE-CONTROL-FAILED counts={json.dumps({k: c.get(k) for k in keys})}")
PY
echo "CYCLE-FILE $OUT"

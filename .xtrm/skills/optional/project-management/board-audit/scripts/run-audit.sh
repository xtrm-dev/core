#!/bin/sh
# Board audit driver: snapshot a day's windows -> N judged runs -> deterministic majority.
#
# Usage:  ./run-audit.sh [N] [DAY]
#   N    odd number of runs, default 3
#   DAY  window start date, e.g. 2026-10-22; omit to use the pinned sample rows
#
# Everything it writes goes to a run directory OUTSIDE this git repo
# (default $HOME/.local/state/mmd-board-audit), never next to the code.
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
N=${1:-3}
DAY=${2:-}
RUNS=${MMD_AUDIT_RUN_DIR:-$HOME/.local/state/mmd-board-audit}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

: "${AGENTRUN_PI_ROOT:?set AGENTRUN_PI_ROOT to the @parcha/agentrun-pi install root}"
CLI="$AGENTRUN_PI_ROOT/dist/cli.js"
CONFIG="$HERE/agentrun-config-stock.mjs"
[ -f "$CLI" ] || { echo "agentrun CLI not found at $CLI"; exit 2; }

mkdir -p "$RUNS"
cd "$HERE"

python3 facts.py ${DAY:+--day "$DAY"} --out "$RUNS/input-$STAMP.json"

i=1
while [ "$i" -le "$N" ]; do
  PI_MODELS_PATH=${PI_MODELS_PATH:-$HOME/.pi/agent/models.json} \
  PI_MODELS_STORE_PATH=${PI_MODELS_STORE_PATH:-$RUNS/models-store.json} \
  node "$CLI" run "$HERE/../workflows/board-batch-verdicts-v3.json" "$RUNS/input-$STAMP.json" --config "$CONFIG" \
    > "$RUNS/run-$STAMP-$i.json" 2>&1 || { echo "run $i failed:"; tail -n 3 "$RUNS/run-$STAMP-$i.json"; exit 1; }
  i=$((i + 1))
done

python3 aggregate.py $(ls "$RUNS"/run-$STAMP-*.json | sort)
echo "receipts: $RUNS (stamp $STAMP)"

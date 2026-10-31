#!/bin/sh
# code-readiness-v1 driver: snapshot -> selftest (controls must pass) -> chunks -> N runs each -> code majority + method-2 compare.
# Usage: run-readiness.sh [N]   (run from a market-data git checkout; read-only everywhere)
# Env: READINESS_OUT (required: the runs root, under your lane scratch dir), READINESS_METHOD2 (optional independent table to compare)
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
N=${1:-3}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
: "${READINESS_OUT:?set READINESS_OUT to the lane scratch dir that holds the runs}"
RUNS="$READINESS_OUT/runs-$STAMP"; mkdir -p "$RUNS"
WF="$HERE/../../workflows/code-readiness-v1.json"
: "${AGENTRUN_PI_ROOT:=$(npm root -g)/@parcha/agentrun-pi}"; export AGENTRUN_PI_ROOT
CLI="$AGENTRUN_PI_ROOT/dist/cli.js"
CONFIG="$HOME/.xtrm/skills/optional/programme/board-audit/scripts/agentrun-config-stock.mjs"
gate() { f=$(awk '/^full/{sub("avg10=","",$2);print $2}' /proc/pressure/memory); m=$(awk '/MemAvailable/{print int($2/1048576)}' /proc/meminfo)
  awk -v f="$f" -v m="$m" 'BEGIN{exit !(f<=10 && m>=4)}' || { echo "GATE SHUT psi_mem_full=$f memavail_gb=$m $(date -u +%H:%MZ)"; return 1; }; }
python3 "$HERE/readiness_facts.py" snapshot --out "$RUNS/rows.json"
python3 "$HERE/readiness_facts.py" selftest "$RUNS/rows.json"
python3 "$HERE/readiness_facts.py" chunk "$RUNS/rows.json" --size 40
node "$CLI" validate "$WF" --inputs batch_id,rubric,rows
for c in "$RUNS"/rows.chunk-*.json; do
  base=$(basename "$c" .json | sed 's/rows\.chunk/run-chunk/')
  i=1
  while [ "$i" -le "$N" ]; do
    until gate; do sleep 60; done
    echo "run $base-$i $(date -u +%H:%MZ)"
    PI_MODELS_STORE_PATH="$RUNS/models-store.json" node "$CLI" run --config "$CONFIG" "$WF" "$c" \
      > "$RUNS/$base-$i.json" 2>"$RUNS/$base-$i.err" || { echo "RUN FAILED $base-$i:"; tail -n 5 "$RUNS/$base-$i.err"; exit 1; }
    i=$((i + 1))
  done
done
python3 "$HERE/aggregate_readiness.py" --runs "$RUNS"/run-chunk-*.json --rows "$RUNS/rows.json" \
  ${READINESS_METHOD2:+--method2 "$READINESS_METHOD2"} --out "$RUNS/majority.json"
echo "receipts: $RUNS"

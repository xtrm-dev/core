#!/bin/sh
# Programme sequencing, end to end (MMD-2909): snapshot, facts, judged runs, vote on flipped rows, slots, day runs, plan.
#
#   MMD_REPO=<market-data checkout> AGENTRUN_PI_ROOT=<agentrun-pi root> ./run-sequencing.sh [TAG]
#
# Read-only against Jira, Substrate and GitHub; the only git command that changes anything is `git fetch`.
# Every AgentRun is load-gated by run_plan.py. Output: run/, runs/, run-final/, PLAN.md next to this script.
set -eu
cd "$(dirname "$0")"
: "${AGENTRUN_PI_ROOT:?set AGENTRUN_PI_ROOT to the @parcha/agentrun-pi install root}"
: "${MMD_REPO:?set MMD_REPO to the market-data checkout}"
TAG=${1:-r$(date -u +%m%d%H%M)}

python3 facts_plan.py --selftest | tail -1
# SKIP_SNAPSHOT=1 resumes with the snapshot and facts already on disk (for example after a load-gate stop); facts_plan.py still refuses a snapshot older than one hour.
if [ "${SKIP_SNAPSHOT:-0}" != "1" ]; then
  python3 snapshot_plan.py --out snap
fi
python3 facts_plan.py --snap snap --out run

# A stopped run leaves chunk files that aggregate and build_plan would read: start every run directory of this tag empty.
rm -rf runs/"$TAG"-* 2>/dev/null || true
for node in bundles pairs items; do
  for i in 1 2; do
    python3 run_plan.py --node "$node" --rows "run/rows-$node.json" --out "runs/$TAG-$node-$i"
  done
  python3 aggregate_plan.py "runs/$TAG-$node-1" "runs/$TAG-$node-2" > "runs/$TAG-$node.agg.txt"
  head -1 "runs/$TAG-$node.agg.txt"
  KEYS=$(grep '^  FLIP ' "runs/$TAG-$node.agg.txt" | awk '{print $2}' | paste -sd, -)
  if [ -n "$KEYS" ]; then
    python3 run_plan.py --node "$node" --rows "run/rows-$node.json" --out "runs/$TAG-$node-3" --keys "$KEYS"
  fi
done

python3 finalize_plan.py --snap snap --facts run/facts.json --tag "$TAG" --out run-final
for i in 1 2; do
  python3 run_plan.py --node days --rows run-final/rows-days.json   --out "runs/${TAG}d-days-$i"
  python3 run_plan.py --node days --rows run-final-b/rows-days.json --out "runs/${TAG}db-days-$i"
done
python3 build_plan.py --facts run/facts.json --tag "$TAG" --days-tag "${TAG}d" --out PLAN.md
echo "plan: $(pwd)/PLAN.md"

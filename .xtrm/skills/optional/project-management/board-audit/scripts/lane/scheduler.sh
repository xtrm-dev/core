#!/usr/bin/env bash
# Board helper lane loops. One process owns every due-time; each pass appends event lines to
# events.log, which the session monitor tails. Durations: cycle/comment/report 15 min (a+b), deploy
# snapshot 15 min, tabellone health 30 min (d), Waiting Production audit 60 min and on any deploy move (e),
# HEAVY nightly queue watch 15 min, operator-channel router 5 min (this lane is the only router/filter).
# Settings: board-audit/references/setup-lane.md.
set -u
PMCFG="$(cd "$(dirname "$0")" && pwd)/../../../project-management/scripts/pm_config.py"
# Resolve the project once; every child script then reads the same one.
PM_PROJECT=${PM_PROJECT:-$(python3 "$PMCFG" project)} || exit 1; export PM_PROJECT
LANE=${PM_LANE_DIR:-$(python3 "$PMCFG" get PM_LANE_DIR)} || exit 1
SCRIPTS=$(cd "$(dirname "$0")" && pwd)
TAB_UNIT=${PM_TABELLONE_UNIT:-$(python3 "$PMCFG" get PM_TABELLONE_UNIT tabellone-sync.service)}
EV=$LANE/events.log
ST=$LANE/sched.state
touch "$EV"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$EV"; }
# State is one key per line, always rewritten whole: the first version wrote one space-separated line and
# `sed` collapsed it, which silently lost every other key (a state file is an interface - board-audit
# references/lane-automation.md).
save() { printf 'cycle=%s\ndeploy=%s\ntabellone=%s\nwp=%s\ntabhash=%s\nheavy=%s\nroute=%s\n' \
         "$cycle" "$deploy" "$tabellone" "$wp" "$tabhash" "$heavy" "$route" > "$ST.tmp" && mv "$ST.tmp" "$ST"; }
load() {
  cycle=0; deploy=0; tabellone=0; wp=0; tabhash=-; heavy=0; route=0
due=0
  if [ -f "$ST" ]; then
    while IFS='=' read -r k v; do
      case "$k" in cycle|deploy|tabellone|wp|tabhash|heavy|route) printf -v "$k" '%s' "${v:-0}";; esac
    done < "$ST"
  fi
}

run_cycle() {
  local out file
  out=$("$SCRIPTS/cycle-run.sh" 2>&1)
  file=$(printf '%s\n' "$out" | sed -n 's/^CYCLE-FILE //p')
  if [ -n "$file" ] && [ -s "$file" ]; then
    python3 "$SCRIPTS/cycle-digest.py" "$file" >> "$EV" 2>&1
  else
    log "CYCLE-RUN-FAIL $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)"
  fi
}

run_deploy() {
  local out moved=0
  out=$(python3 "$SCRIPTS/deploy-check.py" 2>&1)
  printf '%s\n' "$out" | while IFS= read -r l; do log "$l"; done
  case "$out" in *DEPLOY-NOW-AUDIT*) moved=1;; esac
  if [ "$moved" = 1 ]; then
    wp=$(date +%s); save
    run_wp
  fi
}

run_wp() {
  local out rc
  out=$(python3 "$SCRIPTS/wp-audit.py" 2>&1); rc=$?
  printf '%s\n' "$out" | while IFS= read -r l; do log "$l"; done
  [ $rc -ne 0 ] && [ $rc -ne 2 ] && log "WP-AUDIT-ERROR rc=$rc"
}

run_route() {
  local out rc
  out=$(python3 "$SCRIPTS/route-watch.py" 2>&1); rc=$?
  printf '%s\n' "$out" | while IFS= read -r l; do [ -n "$l" ] && log "$l"; done
  [ $rc -ne 0 ] && log "ROUTE-WATCH-ERROR rc=$rc"
}

run_heavy() {
  local out rc
  out=$(python3 "$SCRIPTS/heavy-stuck.py" 2>&1); rc=$?
  printf '%s\n' "$out" | while IFS= read -r l; do [ -n "$l" ] && log "$l"; done
  [ $rc -ne 0 ] && log "HEAVY-STUCK-ERROR rc=$rc"
}

run_due() {
  local out rc
  out=$(python3 "$SCRIPTS/due-check.py" 2>&1); rc=$?
  printf '%s\n' "$out" | while IFS= read -r l; do [ -n "$l" ] && log "$l"; done
  [ $rc -ne 0 ] && log "DUE-CHECK-ERROR rc=$rc"
}

run_routejira() {
  local out rc
  out=$(python3 "$SCRIPTS/route-jira.py" 2>&1); rc=$?
  # stdout is the event stream; a non-zero exit is the alarm, because a router that cannot read Jira is silent
  [ -n "$out" ] && printf '%s\n' "$out" | while IFS= read -r l; do log "$l"; done
  [ $rc -ne 0 ] && log "ROUTE-JIRA-FAIL rc=$rc"
}

run_backlog() {
  local out rc
  out=$(python3 "$SCRIPTS/route-backlog.py" 2>&1); rc=$?
  printf '%s\n' "$out" | while IFS= read -r l; do [ -n "$l" ] && log "$l"; done
  [ $rc -ne 0 ] && log "ROUTE-BACKLOG-ERROR rc=$rc"
}

run_tab() {
  local st hash
  st=$(systemctl --user show "$TAB_UNIT" -p Result -p ActiveState -p SubState -p ExecMainStatus -p LoadState 2>&1 | tr '\n' ' ')
  hash=$(printf '%s' "$st" | md5sum | cut -c1-8)
  if [ "$hash" != "$(get tabhash)" ]; then
    tabhash="$hash"; save
    case "$st" in
      *Result=success*|*ActiveState=active*|*LoadState=not-found*) log "TABELLONE-OK $st";;
      *) log "TABELLONE-FAIL $st";;
    esac
  fi
}

log "SCHEDULER-START pid=$$"
while :; do
  now=$(date +%s)
  load
  now=$(date +%s)
  if (( now - cycle >= 900 )); then cycle=$now; save; run_cycle; fi
  now=$(date +%s)
  if (( now - deploy >= 900 )); then deploy=$now; save; run_deploy; fi
  now=$(date +%s)
  if (( now - wp >= 3600 )); then wp=$now; save; run_wp; fi
  now=$(date +%s)
  if (( now - heavy >= 900 )); then heavy=$now; save; run_heavy; fi
  now=$(date +%s)
  if (( now - route >= 300 )); then route=$now; save; run_route; run_routejira; run_backlog; log "ROUTE-PASS heartbeat"; fi
  now=$(date +%s)
  if (( now - due >= 3600 )); then due=$now; save; run_due; fi
  now=$(date +%s)
  if (( now - tabellone >= 1800 )); then tabellone=$now; save; run_tab; fi
  sleep 60
done

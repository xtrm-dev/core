#!/usr/bin/env bash
# restore-plan.sh — turn an xtmux session snapshot into an ordered reopen plan.
#
# Usage:
#   session-recovery/scripts/restore-plan.sh [snapshot-path]
#     snapshot-path defaults to the canonical latest:
#       ${XDG_STATE_HOME:-~/.local/state}/xtmux/sessions/snapshot.json
#   Env knobs:
#     RECOVERY_BIN   override xtmux-obs discovery (auto: PATH, ~/.local/bin)
#     AGENTS_RUNNING=1  mark claude/pi/codex command panes as reopen targets
#
# Output: a plan with one line per pane, ordered agent-panes first, then a
# "scratch" section. Every Reopen line is a ready-to-paste tmux/xt command.
# Exit 0 with a plan; exit 2 with a JSON error when no snapshot exists.
set -euo pipefail

XDG="${XDG_STATE_HOME:-$HOME/.local/state}"
SNAP="${1:-$XDG/xtmux/sessions/snapshot.json}"

command -v jq >/dev/null || { printf 'restore-plan: jq required\n' >&2; exit 3; }
[ -f "$SNAP" ] || { printf '{"error":"no snapshot","path":"%s","hint":"run xtmux-obs snapshot-sessions while tmux is alive"}\n' "$SNAP" >&2; exit 2; }

# ponytail: line-oriented over jq gymnastics — the classification and ranking
# run once in the embedded python block below; jq is only the JSON validator.
jq -e . "$SNAP" >/dev/null 2>&1 || { printf '{"error":"snapshot not valid JSON","path":"%s"}\n' "$SNAP" >&2; exit 2; }

ts="$(date -u -d "@$(jq -r .capturedAtMs "$SNAP" 2>/dev/null || echo 0)" '+%Y-%m-%dT%H:%M:%SZ')"

python3 - "$SNAP" <<'PY'
import json, sys, calendar, datetime
snap = json.load(open(sys.argv[1]))
captured = datetime.datetime.fromtimestamp(snap["capturedAtMs"]/1000, tz=datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
agents, scratch = [], []
for p in snap["panes"]:
    row = dict(
        session=p["session"], win=p["windowIndex"], pane=p["paneId"],
        cmd=p["currentCommand"] or "-",
        state=p["agentStateRaw"] or "-",
        branch=p["branch"] or "-",
        slug=p["attachSlug"] or "-", cwd=p["cwd"] or "-",
    )
    (agents if row["cmd"] in ("claude", "pi", "codex") else scratch).append(row)

SORDER = {}  # stable session order for readability
def line(r, kind):
    if kind == "agent":
        hint = f"tmux new-window -t {r['session']} -n {r['slug']} -c '{r['cwd']}' 'claude -c'"
        alt = f"xt attach {r['slug']}" if r["slug"] != "-" else ""
        return f"{r['session']}:{r['win']} [{r['cmd']}|{r['state']}] {r['branch']} -> {hint}" + (f"  (or {alt})" if alt else "")
    return f"{r['session']}:{r['win']} [{r['cmd']}|{r['state']}] -> tmux attach -t {r['session']}:{r['win']}"

print(f"session-recovery restore plan — snapshot captured: {captured} · panes: {len(snap['panes'])}")
rank = {"running": 0, "needs-input": 1, "done": 2, "idle": 3}
agents.sort(key=lambda r: (rank.get(r["state"], 9), r["session"], r["win"]))
if agents:
    print("\nAGENT PANES — reopen first (ranked: running > needs-input > done > idle):")
    for r in agents: print("  " + line(r, "agent"))
if scratch:
    print("\nSCRATCH — reopen on demand:")
    seen = set()
    for r in scratch:
        key2 = (r["session"], r["win"], r["session"], r["win"])
        k = (r["session"], r["win"])
        if k in seen: continue
        seen.add(k)
        print("  " + line(r, "scratch"))
if not agents and not scratch:
    print("  (empty snapshot — no panes recorded)")
PY

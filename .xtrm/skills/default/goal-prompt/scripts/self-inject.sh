#!/usr/bin/env bash
# goal-prompt self-injection helper: submit a goal prompt as a user turn into this
# agent's own tmux pane (start-of-work re-entry).
#
# Usage:
#   goal-self-inject.sh '<single-line goal text>'   # literal, send-keys -l
#   goal-self-inject.sh --file <path> [--no-submit] # multi-line, paste-buffer
#   goal-self-inject.sh --goal <body-file> [--delay N] # two-pass /goal, Enter twice
# Optionally set TARGET_PANE to override own-pane resolution.
#
# Exit codes: 0 ok; 1 not in tmux / pane unresolved; 2 bad args or missing file.
set -euo pipefail

if [[ -z "${TMUX:-}" ]]; then
  echo "error: not inside a tmux session (TMUX unset)" >&2
  exit 1
fi

# Own pane: TARGET_PANE, else $TMUX_PANE (the pane this shell runs in). Never fall back to
# display-message without -t: it returns the client's ACTIVE pane, which can be another agent
# (2026-10-26: a goal landed in the board helper's pane that way).
pane="${TARGET_PANE:-${TMUX_PANE:-}}"
[[ -n "$pane" ]] || { echo "error: could not resolve own pane" >&2; exit 1; }

mode="${1:-}"
case "$mode" in
  --goal)
    # Two-pass /goal injection (operator method): type "/goal " literally, paste the body,
    # then Enter twice. --delay N waits first so a caller can run this in the background
    # and let its own turn end before the text lands.
    file="${2:-}"; delay=0
    [[ "${3:-}" == "--delay" ]] && delay="${4:-25}"
    [[ -f "$file" ]] || { echo "error: no such file: $file" >&2; exit 2; }
    total=$(( $(wc -c < "$file") + 6 ))
    (( total <= 4000 )) || { echo "error: goal is $total chars (> 4000)" >&2; exit 2; }
    sleep "$delay"
    tmux send-keys -t "$pane" -l '/goal '
    sleep 1
    tmux load-buffer -b goal-inject "$file"
    tmux paste-buffer -b goal-inject -d -t "$pane"
    sleep 2; tmux send-keys -t "$pane" Enter
    sleep 2; tmux send-keys -t "$pane" Enter
    echo "injected /goal ($total chars) into $pane"
    ;;
  --file)
    file="${2:-}"
    [[ -n "$file" ]] || { echo "usage: goal-self-inject.sh --file <path> [--no-submit]" >&2; exit 2; }
    [[ -f "$file" ]] || { echo "error: no such file: $file" >&2; exit 2; }
    tmux load-buffer "$file"
    tmux paste-buffer -t "$pane"
    # TUI inputs treat pasted newlines as in-draft line breaks, not submission —
    # always submit explicitly so the goal lands as a user turn, not a pending draft.
    if [[ "${3:-}" != "--no-submit" ]]; then
      tmux send-keys -t "$pane" Enter
    fi
    echo "injected file buffer ($(wc -c < "$file") bytes) into $pane"
    ;;
  "")
    echo "usage: goal-self-inject.sh '<goal text>' | goal-self-inject.sh --file <path> [--no-submit]" >&2
    exit 2
    ;;
  *)
    tmux send-keys -t "$pane" -l "$mode"
    tmux send-keys -t "$pane" Enter
    echo "injected ${#mode} chars into $pane"
    ;;
esac
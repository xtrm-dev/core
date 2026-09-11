#!/usr/bin/env bash
# goal-prompt self-injection helper: submit a goal prompt as a user turn into this
# agent's own tmux pane (start-of-work re-entry).
#
# Usage:
#   goal-self-inject.sh '<single-line goal text>'   # literal, send-keys -l
#   goal-self-inject.sh --file <path> [--no-submit] # multi-line, paste-buffer
# Optionally set TARGET_PANE to override own-pane resolution.
#
# Exit codes: 0 ok; 1 not in tmux / pane unresolved; 2 bad args or missing file.
set -euo pipefail

if [[ -z "${TMUX:-}" ]]; then
  echo "error: not inside a tmux session (TMUX unset)" >&2
  exit 1
fi

pane="${TARGET_PANE:-}"
if [[ -z "$pane" ]]; then
  pane="$(tmux display-message -p -F '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null || true)"
fi
[[ -n "$pane" ]] || { echo "error: could not resolve own pane" >&2; exit 1; }

mode="${1:-}"
case "$mode" in
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
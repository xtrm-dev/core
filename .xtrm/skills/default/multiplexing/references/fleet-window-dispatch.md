# Fleet window-dispatch (same-session variant)

For coordinated bounded work — an epic, a wave of related Issues, a batch of verification jobs — dispatch workers as **windows inside the current tmux session** instead of as fresh top-level tmux sessions. Native messaging is identical either way; the difference is inventory, cleanup, and cognitive load.

**When it fits.** A parent coordinator drives 3–10 short-to-medium-lived workers whose lifetime is bounded by the current task. Not for long-lived independent peers that must outlive the coordinator, and not when workers must survive an accidental parent-session kill — those still want separate sessions.

**Canonical recipe (proven).** Run from the parent's shell. `xt claude` / `xt pi` refuse to create nested worktrees, so the launch command MUST `cd` to the main repo root before invoking `xt`. New windows must be created empty then sent the command; `tmux new-window "cmd"` runs the cmd in the window's default shell and exits when it returns, which kills the pane before the agent boots.

```bash
SESSION=$(tmux display-message -p '#{session_name}')
MAIN=/path/to/main/repo/root      # NOT a worktree — nested worktrees are refused
SLUG=worker-slug                  # short kebab-case; becomes window name

tmux new-window -t "${SESSION}:" -n "$SLUG" -d
PANE=$(tmux list-panes -t "${SESSION}:${SLUG}" -F '#{pane_id}' | head -1)
tmux send-keys -t "$PANE" \
  "cd $MAIN && xt claude --bead $BEAD --prompt 'Read /tmp/.../brief.md and execute it exactly.'" Enter
```

For `xt pi`, replace `xt claude` with `xt pi --model <name>`; skill loading uses `/skill:<name>` in the prompt.

**Landmines actually hit and fixed.**

- **Zsh `:l` parameter modifier eats the target.** `"$SESSION:$SLUG"` becomes lowercased garbage. Quote as `"${SESSION}:"` (with braces) and pass the slug separately, or use `"${SESSION}:${SLUG}"`.
- **Nested-worktree refusal.** `xt claude` / `xt pi` explicitly refuse to create a worktree from inside an existing worktree. Always `cd` to the main repo root first, even when the current shell is already there — a stale `PWD` after a session pause can lie.
- **Inline command in `new-window`.** `tmux new-window -d "cmd"` exits the pane when `cmd` returns; the agent never boots visibly. Create the window empty, then `send-keys` the command so the shell persists.
- **Peer name collisions and roster drift.** `ListAgents` timestamps can be stale and peer entries can vanish while a process is still running. Trust the pane capture and the durable work state (Bead close, PR opened) over the roster when they disagree.

**Prompt shape.** Keep the initial prompt single-line; put the load-bearing instructions in a brief file and use a pointer prompt like `Read /tmp/.../brief.md and execute it exactly.` The tmux `send-keys` fallback rules still apply: never multiline-paste, never embed `$(...)` or backticks in a sent shell string.

**Ping-back.** Every worker's brief MUST identify the parent coordinator by its stable native peer name (visible in `ListAgents`) and require SendMessage on: start, each meaningful state change (Issue close, PR opened, block, escalation), and final completion. Silence is not a disposition.

**Kill / reuse.** Finished workers → `tmux kill-window -t "${SESSION}:${SLUG}"`. To reuse a window for the next task, send `/exit` (or Ctrl-D twice) to the running agent, `rename-window` to the new slug, then `send-keys` the next `xt` command. Killing and spawning fresh is safer; reuse is fine when the same pane's shell state is desirable.

**Do not use for.** Long-lived independent peers, cross-machine workers, or anything you need to survive the parent tmux session dying. Also do not use when the workers themselves need to spawn further windows into the same tmux session — nested fleet-mode has not been evaluated.

**Cleanup.** `tmux list-windows -t "$SESSION"` is the whole inventory. No `list-sessions` sweep needed.

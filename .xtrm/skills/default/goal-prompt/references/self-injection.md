# Self-injection — mechanics and guardrails

Re-entry primitive: the agent submits a goal prompt to its *own* tmux pane as a user
turn, so a session can start work off a durable goal without a human pasting anything.
Same transport as peer-to-peer commanding (`/multiplexing`), different target
(`-t <own-pane>` instead of a peer pane).

## Why the goal-prompt shape makes this safe

- The payload is the skim-safe minimum: OBJECTIVE + READ FIRST (`refs/…` path) +
  gates. The file holds all depth; the injected text stays thin.
- Multi-line bodies do not survive `send-keys` reliably (quoting, escapes, newlines).
  The original-first design removes the pressure to inject bodies at all.
- The objective-first ordering means an agent that only ever reads the injected line
  still knows the objective, the success gates, and the stop condition.

## Mechanics

- Own pane resolution: `tmux display-message -p -F '#{session_name}:#{window_index}.#{pane_index}'`
  (or parse `$TMUX`; `$SESSION_NAME` when set). Override with `TARGET_PANE`.
- Single-line payload: `tmux send-keys -t <pane> -l '<text>'` then `Enter` (`-l` =
  literal, no key-name interpretation).
- Multi-line payload: `tmux load-buffer <file>` + `tmux paste-buffer -t <pane>` +
  a separate `send-keys Enter` to submit. Pasted newlines are in-draft line breaks
  in TUI inputs, not submission — verified live: without the explicit Enter the goal
  sat as a pending draft for 180s. `--no-submit` composes without submitting.
- Helper: `goal-self-inject.sh '<text>' | goal-self-inject.sh --file <path> [--no-submit]`.

## Guardrails

1. **Safe checkpoint only.** Session start, idle, or a defined milestone. Never
   mid-flight over an unfinished goal — two interleaved instruction streams corrupt
   state.
2. **Well-formed payloads only.** The injected text must be goal-prompt skill output:
   OBJECTIVE line, READ FIRST to a real refs path, precedence rule, gates, stop
   predicate. Arbitrary text = rewriting the instruction stream with garbage.
3. **Stop predicate required.** The goal must say when it is done and that completion
   does not reinject. Self-reinjection loops are the classic failure; reinjection is
   an explicit opt-in inside the goal, never automatic completion behavior.
4. **Native surfaces first.** If the harness offers a real self-message/continuation
   API, use it. Tmux is the compatibility transport, not the default.
5. **Verify before injecting.** Resolve the pane, confirm it is the intended session
   and that it is idle, then send. Injection is equivalent to a user submitting input.

## Verified recipe: Claude Code coordinator (mon-coord, 2026-10-26)

Operator method, verified live on pane %273 (3705-byte goal, landed and set):

1. Write the goal body (without the `/goal ` prefix) to a file under the coordinator cache,
   e.g. `~/.cache/<coord>/goal-<coord>.txt`; keep the verbatim source next to it
   (`goal-source-<date>.md`). If this skill's `refs/` is outside the active worktree, the
   worktree edit guard refuses the write: use `~/.cache/<coord>/` instead.
2. Count it: `printf '/goal %s' "$(cat <file>)" | wc -c` must be <= 4000.
3. Store it durably first: `sb journal append <epic> --kind handoff --semantic <json file>`
   with the full goal text inside the summary.
4. Inject in two passes, from a BACKGROUND command so it lands after the current turn ends
   (the pane is then idle): type `/goal ` literally, paste the body from a named buffer,
   then Enter twice (Claude Code needs the second Enter; see memory
   claude-code-pane-needs-extra-enter):

   ```bash
   sleep 25; P=<own pane id>; tmux send-keys -t $P -l '/goal '; sleep 1
   tmux load-buffer -b goal <file>; tmux paste-buffer -b goal -d -t $P; sleep 2
   tmux send-keys -t $P Enter; sleep 2; tmux send-keys -t $P Enter
   ```

   Or: `scripts/self-inject.sh --goal <file> [--delay 25]` (run it with run_in_background).
5. Verify: the next turn shows `Goal set: ...` and the Stop hook condition. Before injecting,
   confirm the target: `tmux display -p -t "$TMUX_PANE" '#{pane_id}'` must be your own pane, and
   pass it explicitly (`TARGET_PANE=$TMUX_PANE`). A run without a resolvable own pane must fail,
   never fall back to the client's active pane (2026-10-26: the goal landed in a peer's pane and
   the peer started executing it; it was stopped within a minute, no action taken).

Refresh triggers: after every compaction (the Mercury post-compact hook reminds you, step 2)
and after each meaningful milestone: when tasks named in the goal are finished or the next
work is clearer, update the delta in the source file, rebuild the goal, store, re-inject.
Never re-inject on completion of the stop predicate.

## Precedence with the skill

The self-injection section belongs to this skill's payload contract; the tmux
mechanics and continuation doctrine live with `/using-xtrm` (Continuity) and
`/multiplexing`. This file duplicates neither — it documents the send-keys primitive
this skill's payload is designed to survive.
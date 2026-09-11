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

## Precedence with the skill

The self-injection section belongs to this skill's payload contract; the tmux
mechanics and continuation doctrine live with `/starting-and-resuming-work` and
`/multiplexing`. This file duplicates neither — it documents the send-keys primitive
this skill's payload is designed to survive.
# Discovery and pre-flight

### From Pi

For Pi and Claude peers alike (one first-party roster):

```typescript
ListAgents()
```

Verify target name/id and cwd before a consequential handoff.

### From Claude Code

Use `ListAgents` to see addressable peers. A Pi session with the Claude transport enabled should appear in the same peer list.

Verify the target name and working directory. If native discovery says the target is absent, do not guess a tmux pane and inject the message anyway.

### tmux inventory

Use plain tmux only when you need terminal topology or to account for non-agent panes:

```bash
tmux list-sessions
tmux list-panes -a -F '#{session_name} #{window_id} #{pane_id} #{pane_current_command} #{pane_current_path}'
```

A pane being present does not prove its agent transport is reachable; the native roster decides that.

## Before starting

Do not start by running `xtmux --help`.

1. If launching a new worker, run `xt --help` and the relevant `xt <provider> --help`. The current CLI is authoritative for launch flags.
2. Verify the current harness/runtime version when transport behavior is in doubt (`pi --version`, `claude --version`).
3. For Pi, verify the first-party `intercom` extension is loaded (`pi list` or the current Pi package/config surface); the Claude transport additionally needs `intercom.claudeTransport` enabled.
4. For Claude Code, verify `/list-agents` is available. If it is not, native cross-session messaging is unavailable in that session.
5. Never install or globally reconfigure a dependency silently. Missing native transport is a visible prerequisite/failure, not permission to fall back invisibly.

No messaging dependencies need installing: coordination ships in the first-party `intercom` extension. Do not install `pi-messenger` or `pi-collaborating-agents` merely for this skill; they carry broader task/spawn/reservation semantics that native coordination does not need.

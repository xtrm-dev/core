# Managed Pi extension entrypoints

This directory is the canonical source for managed Pi extension entrypoints.

Runtime delivery is package-based via `npm:@jaggerxtrm/pi-extensions`.

## sp-terminal-overlay

Streaming terminal-style overlay for specialist/process monitoring commands.

Commands:

- `/sp-feed [args]` — opens `sp feed -f [args]` in an overlay.
- `/sp-ps [args]` / `/xtrm-ps [args]` — opens a one-shot `sp ps [args]` snapshot in an overlay; `--follow`/`-f` are stripped to avoid repaint loops.
- `/xtrm-terminal <command>` — opens an arbitrary shell command in an overlay.

Keys: `Esc`/`q` close, `r` restart, arrows/page keys scroll.

## serena-pool

Shared Serena daemon pool for Pi sessions.

Behavior:

- Resolves the current git repo root on `session_start`.
- Maps each repo root to a deterministic local port.
- Reuses an existing Serena MCP daemon when the port is already listening.
- Spawns Serena via `uvx` when no daemon is listening and exports `SERENA_MCP_PORT` for `pi-serena-tools`.
- Persists ownership state under `/tmp/serena-pool` and reaps only owned orphan process groups from dead recorded daemons.

Debugging:

```bash
DEBUG=serena-pool pi
```

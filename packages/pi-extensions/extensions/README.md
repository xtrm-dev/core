# Managed Pi extension entrypoints

This directory is the canonical source for managed Pi extension entrypoints.

Runtime delivery is package-based via `npm:@jaggerxtrm/pi-extensions`.

## xtrm-agent-host

Connects every Pi session to the local XTRM agent host (`xt host start`, PRD xtrm-app §35.3, §35.8):

- pushes `xtrm.agent-event.v1` frames over `$XDG_RUNTIME_DIR/xtrm/agent-host.sock` (fallback `~/.xtrm/run/agent-host.sock`; override `XTRM_AGENT_HOST_SOCKET`): `session_identity` first, then the Pi lifecycle, tool events with the raw `sourceInfo`, `extension_ui_request` / `extension_ui_resolved`, `command_result`, and `session_shutdown`;
- executes `xtrm.agent-command.v1` commands: `prompt` (rejected `busy` while working), `steer`, `follow_up`, `abort`, and `extension_ui_response`;
- proxies `ctx.ui.select` / `confirm` / `input`: the host and the terminal dialog race, and the first answer wins. Each request ends with one `extension_ui_resolved` (`resolvedBy`: `local` | `host`, `outcome`: `answered` | `cancelled`), so the host leaves `waiting_for_input` as soon as the terminal answers. Pi's `confirm()` returns `false` for "No" and for a dismissed dialog alike, so a locally dismissed confirm reports `answered`. `ctx.ui.editor` is not proxied and stays terminal-only: Pi 1.0.0 gives `editor()` no `AbortSignal`, so a host answer could not dismiss the terminal editor, and the GUI never sees editor prompts.

`message_update` and `tool_execution_update` are coalesced (50 ms). The `message` field is authoritative, and `assistantMessageEvent.partial` is dropped. Identity reads the `xt pi` pane options (`@agent_role`, `@agent_bead`, `@agent_parent_session`, `@agent_worktree`, `@agent_branch`), with `XTMUX_AGENT_ROLE` / `XTMUX_AGENT_BEAD` as fallbacks. The extension publishes `@xtrm_agent_session_id` on its pane so that child sessions can resolve `parentSessionId`. `XTRM_AGENT_LAUNCH=gui` marks a GUI launch, and `XTRM_AGENT_HOST=off` disables the bridge. When no host runs, the extension spawns no subprocess and prints nothing. It retries the socket with backoff (1 s → 30 s).

## sp-terminal-overlay

Streaming terminal-style overlay for specialist/process monitoring commands.

Commands:

- `/sp-feed [args]` — opens `sp feed -f [args]` in an overlay.
- `/sp-ps [args]` / `/xtrm-ps [args]` — opens a one-shot `sp ps [args]` snapshot in an overlay; `--follow`/`-f` are stripped to avoid repaint loops.
- `/xtrm-terminal <command>` — opens an arbitrary shell command in an overlay.

Keys: `Esc`/`q` close, `r` restart, arrows/page keys scroll.

## Retired sources

Directories retained for migration compatibility are not active extensions. The `disabled` map in `../src/manifest.json` is authoritative for retirement state.

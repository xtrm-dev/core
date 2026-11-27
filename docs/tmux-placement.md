# Tmux placement

Status: CORE-2802. Scope: where a new `xt claude|pi|codex` seat and `xt attach --fresh` open their pane.

This document is the single placement rule. The launcher applies it to every new launch. It never moves or kills an existing pane; placement applies to new launches only.

## The rule

The target session is resolved in this order. The first source that resolves wins.

| Order | Source | How it resolves |
|---|---|---|
| 1 | Explicit flag | `--session <name>` (or `--pane <id>`/`<session>:<window>` for a pane target). |
| 2 | The dispatcher's own session | In order: `$TMUX_PANE` (the pane the launch runs in), `$TMUX` (the client's session), `XTRM_SESSION_ID`, `XTRM_SESSION_NAME`, `XTRM_PARENT_SESSION_ID`, `XTRM_PARENT_PANE_ID`. Each value is confirmed with one `tmux display-message` query and skipped when stale. |
| 3 | The configured default | `session` in `~/.xtrm/config/launch.json` (or the file named by `XTRM_LAUNCH_CONFIG`). |
| 4 | A new session | Last resort only, when a flag or a role rule asked for a session and none resolved. The launcher writes one warning to stderr: `warning: no tmux session to place this launch in; launching a new session instead`. A plain launch that asked for no placement outside tmux creates its session without a warning, because that session is the product, not a fallback. |

Order 2 is why a child lands in its parent's session even when the launch process has no `$TMUX`: a dispatched agent, an in-process specialist, the app and a remote caller keep the pane id or the exported identity of the session they live in, and the parent session recorded by CORE-2801 (`@agent_parent_session` / `XTRM_PARENT_SESSION_ID`) participates in the same order.

Inside the target session, the existing role rules apply:

| Role rule (`placement` in `launch.json`) | Result inside the target session |
|---|---|
| `workers` | A pane in the `workers` window, up to `workersMaxPanes` (default 4), then `workers-2`, `workers-3`, … |
| `window` | A new window in the target session, named by `--window-name`, else by the seat name. |
| `pane:<target>` | The named pane or window of the target session. |
| `current` | The caller's own pane. It needs `$TMUX`; without `$TMUX` the launch opens a window in the resolved session, and a new session as the last resort. |

A launch with no placement at all stays in the caller's own pane when `$TMUX` is set. Without `$TMUX` it opens a window in the target session, and creates a new session (silently) when nothing resolved.

## Configuration

`~/.xtrm/config/launch.json` (schema version 1). `XTRM_LAUNCH_CONFIG` names a different file.

```json
{
  "version": 1,
  "session": "operator",
  "workersMaxPanes": 4,
  "placement": { "worker": "workers", "lead": "window" }
}
```

`session` is optional. When it is absent, a launch outside every session named above creates one session per launch, as before.

## Examples

A lead pane in session `operator` launches a worker. The launch shell has no `$TMUX`:

```text
xt pi worker-core-2802 --issue CORE-2802
# $TMUX_PANE = %3, which belongs to $0 (operator)
# placement: worker -> workers; workerMaxPanes 4
# result: a new pane in operator:workers
```

A caller in another project's session stays in that session:

```text
# $TMUX_PANE = %9, which belongs to $1 (other-project)
xt pi worker-x --role worker
# result: a new pane in other-project:workers, never in operator
```

A cron job or a CI runner with no session and no configured default:

```text
xt pi nightly --no-attach
# stderr: warning: no tmux session to place this launch in; launching a new session instead
```

## Identity

The parent session a child records is `@agent_parent_session` (`XTRM_PARENT_SESSION_ID`). The launcher takes it from `--parent` when given, else from the dispatcher environment of CORE-2801, else from the session this rule resolved. Pane options and the full identity schema are in [agent-identity.md](agent-identity.md).

## Tests

- `cli/src/tests/tmux-placement.test.ts`: the resolution order, one case per source, with `env: {}` so a case never depends on the host.
- `cli/src/tests/tmux-placement-session.test.ts`: a private tmux server (`TMUX_TMPDIR`) with a real `operator` session. A caller without `$TMUX` places a worker in `operator:workers`, four launches fill the window, the fifth rolls over to `workers-2`, a caller in a second session stays in that session, and the last resort writes the warning.

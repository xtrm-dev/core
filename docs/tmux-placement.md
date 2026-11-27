# Tmux placement

Status: CORE-2802. Scope: where a new seat opens its pane — `xt claude`, `xt pi`, `xt codex --window`, and `xt attach --fresh`.

This document is the single placement rule. It never moves or kills an existing pane; placement applies to new launches only.

Coverage, stated exactly, because the surfaces differ:

- `xt claude`, `xt pi` and `xt attach --fresh` apply the rule in full: the target session, then the role rule inside it.
- `xt codex --window` applies the whole rule to its own surface (`$TMUX` is no longer required, and order 3 counts); it always opens a new window, because codex has no role-rule flags.
- `xt codex` without `--window` keeps its own behaviour: it creates its own session named `codex-<name>` (or `role-codex-<role>-<issue>`), outside this rule, and records no session identity. Changing that launch is a separate issue.

## The rule

The target session is resolved in this order. The first source that resolves wins.

| Order | Source | How it resolves |
|---|---|---|
| 1 | Explicit flag | `--session <name>` (or `--pane <id>`/`<session>:<window>` for a pane target). |
| 2 | The dispatcher's own session | In order: `$TMUX_PANE` (the pane the launch runs in), `$TMUX` (the client's session), `XTRM_SESSION_ID`, `XTRM_SESSION_NAME`, `XTRM_PARENT_SESSION_ID`, `XTRM_PARENT_PANE_ID`. Each value is confirmed with one `tmux display-message` query against the socket that identity came from, and skipped when stale or unconfirmed. |
| 3 | The configured default | `session` in `~/.xtrm/config/launch.json` (or the file named by `XTRM_LAUNCH_CONFIG`). |
| 4 | A new session | Last resort only, when a flag or a role rule asked for a session and none resolved. The launcher writes one warning to stderr: `warning: no tmux session to place this launch in; launching a new session instead`. A plain launch that asked for no placement outside tmux creates its session without a warning, because that session is the product, not a fallback. |

### The socket decides what an id means

A pane id (`%3`) and a session id (`$1`) are unique only inside one tmux server. Confirming `%3` against the default server would confirm a different pane that happens to share the number, which is how a launch lands in an unrelated session.

So order 2 also resolves the socket, and every query of that step runs against it: the socket of `$TMUX`, else the value of `XTRM_SESSION_SOCKET`. The launcher records that variable for the seats it creates — `xt pi`, `xt claude`, `xt codex --window` and `xt attach --fresh`; a bare `xt codex` records no session identity at all, and `xt attach` rebuilds the identity of an existing seat. When neither names a socket, no identity at that step is trusted — even a `%3` the process carries — and the launch falls through to order 3, saying why on stderr:

```text
warning: %3 names a tmux session, but the server it belongs to is unknown; not placing this launch in it (set $TMUX or XTRM_SESSION_SOCKET)
```

A plain launch with no role rule stays silent in that case, for the same reason order 4 stays silent. A launch with a role rule or a flag speaks, because it asked for a placement.

Each cause writes its own note, so one launch can print two — a dropped socket, then the last resort:

```text
warning: /tmp/tmux-1000/coord is recorded as this seat's tmux server, but nothing answers there; creating on the default server
warning: no tmux session to place this launch in; launching a new session instead
```

That pair appears only when nothing else names a session: an identity whose server is unknown, no `session` in the launch config, and a role rule or flag that needs one.

A recorded socket that nothing answers on is dropped for the whole launch, with that note and no other effect:

```text
warning: /tmp/tmux-1000/coord is recorded as this seat's tmux server, but nothing answers there; creating on the default server
```

Dropping it matters more than the note. `tmux -S <path> new-session` does not fail on a path that holds no server: it starts one there, so keeping a dead socket would create a seat on a phantom server that nothing else can see. After the drop the launch creates on the default server (or on the socket of an explicit target), and the create verb and every later call — the pane options, the published identity, the cleanup — carry the same binding. A failed launch cleans up on the socket it created on, never on the default one.

Order 2 is why a child lands in its parent's session even when the launch process has no `$TMUX`: a dispatched agent, an in-process specialist, the app and a remote caller keep the pane id, the socket and the exported identity of the session they live in, and the parent session recorded by CORE-2801 (`@agent_parent_session` / `XTRM_PARENT_SESSION_ID`) participates in the same order.

Inside the target session, the existing role rules apply:

| Role rule (`placement` in `launch.json`) | Result inside the target session |
|---|---|
| `workers` | A pane in the `workers` window, up to `workersMaxPanes` (default 4), then `workers-2`, `workers-3`, … |
| `window` | A new window in the target session, named by `--window-name`, else by the seat name. |
| `pane:<target>` | The named pane or window of the target session. |
| `current` | The caller's own pane. It needs `$TMUX`; without `$TMUX` the launch opens a window in the resolved session, and a new session as the last resort. |

A launch with no placement at all stays in the caller's own pane when `$TMUX` is set. Without `$TMUX` it opens a window in the target session, and creates a new session (silently) when nothing resolved.

`--window` needs a session, not a client: a caller without `$TMUX` whose session order 2 resolves may use it.

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
# $TMUX_PANE = %3 and XTRM_SESSION_SOCKET = /tmp/tmux-1000/default
# both belong to $0 (operator); the pane is confirmed on that socket
# placement: worker -> workers; workerMaxPanes 4
# result: a new pane in operator:workers
```

A caller in another project's session stays in that session:

```text
# $TMUX_PANE = %9, which belongs to $1 (other-project)
xt pi worker-x --role worker
# result: a new pane in other-project:workers, never in operator
```

Two servers both hold a `%0`; the socket decides:

```text
# $TMUX_PANE = %0, XTRM_SESSION_SOCKET = /tmp/tmux-1000/coord (server A)
xt pi worker-y
# result: a pane in A's session, and server B's session untouched
```

A cron job or a CI runner with no session and no configured default:

```text
xt pi nightly --no-attach
# stderr: warning: no tmux session to place this launch in; launching a new session instead
```

## Identity

The parent session a child records is `@agent_parent_session` (`XTRM_PARENT_SESSION_ID`). The launcher takes it from `--parent` when given, else from the dispatcher environment of CORE-2801, else from the session this rule resolved. Pane options and the full identity schema are in [agent-identity.md](agent-identity.md).

## A note on tmux format strings

tmux rewrites a TAB inside a format argument to `_` under a non-UTF-8 locale (`LC_ALL=C`: `display-message -p '#{session_id}\t#{session_name}'` returns `$0_operator`), while a UTF-8 locale preserves it. Every tmux format in the launcher therefore separates its fields with `|`, which tmux never rewrites; a TAB-separated listing arrives collapsed and a live pane or session reads as missing (CORE-2811).

## Tests

- `cli/src/tests/tmux-placement.test.ts`: the resolution order, one case per source and per socket rule, with `env: {}` or an explicit env so a case never depends on the host.
- `cli/src/tests/tmux-detached-output-session.test.ts`: the shipped listing format and the shipped `xt pi --json` launcher argv against a private tmux server, so a TAB separator that the operator's tmux collapses fails the test instead of silently reporting the detached session as gone.
- `cli/src/tests/tmux-placement-session.test.ts`: private tmux servers under a private `TMUX_TMPDIR`. The resolver gets the caller's environment only, never a binding, and its runner fails any call it did not expect to be bound — so the test fails on a tree whose placement does not bind. A caller without `$TMUX` places a worker in `operator:workers`, four launches fill the window, the fifth rolls over to `workers-2`, a caller in a second session stays in that session, two servers that both hold `%0` are told apart by their sockets, a dead recorded socket creates on the default server without starting a server at the dead path, an identity with no known socket is refused, and the last resort writes the warning.
- `cli/src/tests/codex-worktree-session.test.ts`: `xt codex --window` binds its window to the resolved session without `$TMUX`, takes order 3 when the caller carries no identity, and refuses a caller whose session nothing resolves.
- `cli/src/tests/worktree-session-beads-noise.test.ts`: a failed launch on a private socket cleans up on that socket — every `kill-*` and buffer call carries `-S <socket>`.
- `cli/src/tests/worktree-session-identity.test.ts`: an identity the server does not answer for is not opened in, and a plain launch outside tmux writes no placement warning.
- Launcher tests that reach tmux through a stub assert the socket on every bound call instead of discarding the binding, so a call that loses it fails the test.

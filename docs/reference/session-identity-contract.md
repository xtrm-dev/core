# Contract note: XTRM session identity env fields (Core → X1)

Status: implemented in Core (XTRM-252.4 R4). Consumer: X1 ExecutionContext
envelope (`xtrm` repo, `packages/substrate`), then Journal / Closure /
ExecutionBinding / WorkReceipt / Specialists settlement.

## Fields

| Variable | Source | Present when |
|---|---|---|
| `XTRM_SESSION_NAME` | tmux session name (`pi-<slug>`, `claude-<slug>`, `role-<slug>…`, post-suffix) | Always on `xt`-launched sessions |
| `XTRM_SESSION_ID` | tmux `#{session_id}` (e.g. `$7`) | Always except bare `new-session` first exec (see below) |

## Transport (all carry identical values)

- Current-pane launches: process spawn env (both fields).
- `tmux new-session` launches: `-e XTRM_SESSION_NAME=<name>` at creation;
  `tmux set-environment -t <session> XTRM_SESSION_ID=<id>` immediately after.
- Specialist (`--role`) launches: additionally `sessionEnv` in the buffered
  tmux payload; the consumer execs the runtime with it merged into env.
- Plain direct launches (`xt pi <name>` with no prompt/bead/override):
  process spawn env (both fields when inside tmux).

## Read rules for X1

1. Prefer process env. Fall back to `tmux show-environment` on the session
   only for `XTRM_SESSION_ID` on bare `new-session` launches.
2. Unknown stays absent: the launcher never emits empty strings,
   placeholders, or invented ids. Absent means unknown (ADR §98) — never
   backfill from model prose, display labels, or branch/worktree names.
3. The launcher accepts no model-entered session flags; there is no parallel
   registry to consult. These two variables are the whole contract.

## Provenance

- Launcher: `cli/src/utils/worktree-session.ts` (`launchTmuxSession`
  new-session/current-pane paths, direct-spawn path, `buildBufferedRuntimeCommand`).
- Builders: `cli/src/core/session-identity.ts` (`buildSessionIdentityEnv`,
  `resolveCurrentTmuxSessionIdentity`, `resolveTmuxSessionId`).
- Tests: `cli/src/tests/session-identity.test.ts`,
  `cli/src/tests/worktree-session-identity.test.ts`.

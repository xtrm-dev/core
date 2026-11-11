# Contract note: XTRM session identity env fields (Core → X1)

Status: implemented in Core (XTRM-252.4 R4). Consumer: X1 ExecutionContext
envelope (`xtrm` repo, `packages/substrate`), then Journal / Closure /
ExecutionBinding / WorkReceipt / Specialists settlement.

## Fields

| Variable | Source | Present when |
|---|---|---|
| `XTRM_SESSION_NAME` | tmux session name (`pi-<slug>`, `claude-<slug>`, `role-<slug>…`, post-suffix) | Always on `xt`-launched sessions |
| `XTRM_SESSION_ID` | tmux `#{session_id}` (e.g. `$7`) | Always except bare `new-session` first exec (see below) |

## These are session ids, not worker ids (CORE-2619)

`XTRM_SESSION_ID` and `XTRM_PARENT_SESSION_ID` name a tmux **session**, and every
window launched into that session shares the value. On this machine five workers
ran as windows of session `xx` and all five carried `XTRM_SESSION_ID=$1`. The
value is a tmux session id: it looks like `$0`, `$1`, `$7`.

Therefore:

- Never use `XTRM_SESSION_ID` as a worker's run identity. It cannot distinguish
two workers of one session, and its `$N` form reads like an unexpanded shell
parameter — which is how it was once misreported as a quoting bug (CORE-2618,
closed invalid: the value was correct, the scoping was wrong).
- The worker's own run identity is the runtime session id: `PI_SESSION_ID` for
Pi, the Claude session id for Claude. Per-worker lineage is the Substrate holder
plus that id, and `TMUX_PANE` if a pane address is needed.
- The `run=` field of the hidden `<!-- xtrm issue=<REF> holder=<holder> run=<id> -->`
marker takes that runtime session id, never `XTRM_SESSION_ID`. The `gh` shim
refuses a create whose marker carries a `$N` run and names the right variable.

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

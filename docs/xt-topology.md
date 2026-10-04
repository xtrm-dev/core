# `xt topology` — aggregated topology projection and viewer

Audit `~/dev/11.md` §P2-05 (projection) and §P2-06 (viewer).

An operator running N concurrent panes has no single answer to *"what is running
where, under which coordinator, on which worktree and branch, against which bead,
and has it landed?"*. The facts exist, but they live in six systems that share no
key — so the join gets done by hand across `xtmux dashboard`, `sp ps`, `bd list`,
`git worktree list` and `gh pr list`.

`xt topology` performs that join once and renders it.

```bash
xt topology                    # summary: source ledger + counts
xt topology --view chains      # coordinators and the jobs they own
xt topology --json             # xtrm.topology.projection.v1 snapshot
xt topology --no-github        # skip the slow, rate-limited PR query
```

## What it joins

```
tmux pane → interactive runtime → role → coordinator → specialist jobs
          → bead → worktree → branch → integration target → pull request
```

| Source | Read via | Contributes |
|---|---|---|
| xtmux | `xtmux topology --json` | host identity |
| tmux | `tmux list-panes -a -F …` | panes, window/pane index, window name, active flags + `@agent_*` lineage |
| Specialists | `sp ps --json` | jobs, chains, epics, branches |
| Substrate | `sb --json issue show <ref>` per issue ref a pane names (max 64) | issue status (`bead` field, v1 name) |
| git | `git worktree list --porcelain` | worktrees, branches, HEADs |
| GitHub | `gh pr list --json …` | PR evidence |

## Guarantees

**Read-only by construction.** `READ_ONLY_COMMANDS` in
`cli/src/core/topology-projection.ts` is the single table every argv is built
from. There is no code path that can issue a mutating command — the guarantee is
structural, not a review convention. The test suite asserts the recorded argv
against that table and pins the two dangerous prefixes: `git worktree list`
(`worktree` also has `add` / `remove` / `prune`) and `gh pr list` (`pr` also has
`create` / `merge` / `close`).

**No duplicate mutable graph.** `collectProjection()` is a pure function of the
world plus a command runner. No cache, no materialization, no module state —
there is nothing to persist into. Every invocation recomputes from live sources,
so the snapshot cannot drift from its sources.

**Completion is never inferred from terminal output.** The only completion
signals any view may read are `bead.status`, `pull_request.merged_at` / `state`,
and `job.status`. `agent.state` is a runtime lifecycle signal (idle / working)
and is never treated as done-ness. A pane whose session is literally named
`work-is-done` with an open bead renders as open.

**Pane capture never transits this command.** The
`xtrm.topology.projection.v1` contract has no `content` / `preview` / `output` /
`capture` field at any level, and every object is `additionalProperties: false`.
A producer therefore cannot smuggle terminal text through it even by accident,
so capture output can never reach the durable event journal. `--view routes`
prints the exact `xtmux pane capture` command instead.

**Sources degrade independently.** Each is queried concurrently and bounded by
its own timeout. `unavailable` (binary absent — not a bug) is kept distinct from
`error` (present but failed — a bug signal). The `sources[]` ledger is what stops
a degraded projection from reading as an empty world: without it, an absent `sp`
and "no jobs running" both produce an empty jobs array. Views announce the
degradation rather than rendering a convincing empty table.

## Views

| View | Shows |
|---|---|
| `summary` | source ledger + counts (default) |
| `topology` | every pane, its session, command and role |
| `chains` | coordinator panes and the jobs they own |
| `lineage` | chain roots and their descendants |
| `worktrees` | worktree/branch graph, including unattached worktrees |
| `collisions` | worktrees shared by more than one live pane |
| `integration` | job branch → integration target → PR state |
| `beads` | bead state per pane |
| `prs` | pull-request evidence per branch |
| `routes` | exact commands for the surfaces xtmux and git own |

Every view is a pure `(projection) => string` function, which is what keeps them
testable without a live host and stops one from quietly acquiring its own data
source.

### What the viewer deliberately does *not* implement

The audit lists live journal feed, reply obligations, monitors and wakes, pane
preview, and git diff among the operator views. These are live streams and
diagnostics that xtmux and git already own, bound and clamp. Reimplementing them
would fork the behavior — and in pane capture's case would pull terminal content
into a process that must never hold it.

`--view routes` prints the exact command for each, with real pane ids and
worktree paths filled in from the snapshot:

```
xtmux log follow --after-id <n>
xtmux obligations list --pane "$(tmux display-message -p '#{pane_id}')" --json
xtmux monitor-list --json
xtmux pane capture --pane %1656 --lines 40
git -C /repo/.xtrm/worktrees/coord diff
```

Deployment evidence beyond PR merge state is `/deploy-monitor`'s job, not this
command's.

## Known limitations

- **Issues resolve through Substrate (XTRM-629).** Substrate resolves refs across
  projects, so a pane in another repository gets its real issue state. A ref
  Substrate does not know (a legacy Beads id) reports status `unknown`; that is
  not a source failure. Before XTRM-629 the source was Beads (`bd list`), and the
  schema still accepts a `beads` ledger entry from older producers.
- **Job attribution is by bead identity.** A job is attributed to a pane when
  they share a bead (directly, or via the pane's bead being the job's epic), or
  when the pane is parked inside the job's own worktree. Jobs whose coordinator
  pane has died surface under `orphans.jobs` rather than vanishing.
- **`@agent_role` / `@agent_worktree` / `@agent_branch` come from tmux directly**
  because `xtmux topology --json` does not yet publish them (tracked as
  `xtmux-71y`). When it does, the enrichment call can be dropped and the
  projection gains remote-host support for free via the xtmux bridge.

## Live feed in the agent host (XTRM-629)

`xt host start` serves the same projection to app clients over every host
transport (loopback, SSH port forward, direct mode with a device token):

- `GET /v1/topology` returns one `topology_snapshot`.
- `GET /v1/topology/events` (SSE) sends a `topology_snapshot` first, then
  `topology_update` diffs (event `id` = `seq`). A reconnect always starts with a
  fresh snapshot.
- Every pane that hosts a live agent host session carries `agent_session`
  (`session_id`, `provider`, `state`), joined on `session_identity.tmux.paneId`.
  Shells and editors are included with `agent_session: null`.

Messages carry `topology: 1` (feed protocol version) and a `revision` (16 hex of
sha256 over the projection without `generated_at_ms` and `sources[].duration_ms`).
An identical revision is never resent. A client applies an update only when its
`base_revision` matches, with `applyTopologyUpdate()` from `@xtrm/contracts`.

**Size cap.** An update over 64 KiB, or over half of the snapshot, is sent as a
snapshot. A snapshot over 4 MiB drops `orphans` and sets `truncated: true`; panes
are never dropped. A client more than 8 MiB behind is disconnected and
resubscribes.

**Events and cost.** One feed serves all clients: each refresh is one
`tmux list-panes -a` pass, joined with enrichment (xtmux, `sp`, `sb`, git, and
`gh` only with `--topology-github`) cached for 10 s and refreshed in the
background. Refreshes are coalesced (leading edge, one trailing pass, 100 ms
minimum gap) and serialized once for every subscriber. Changes are pushed by one
tmux control-mode observer client (`-C attach-session -r -f
ignore-size,no-output,no-detach-on-destroy` plus one `refresh-client -B`
subscription to `@agent_state`, the pane command and the pane path). The observer
cannot send input, never resizes a window and receives no pane output; tmux does
list it as an attached client. Without it the feed polls every 2 s; with it,
every 10 s as a safety net. Registry frames that change a pane's session or state
also trigger a refresh. With no subscriber the feed runs no client and no timer.

Measured on a private tmux server (`agent-host-topology.test.ts`): session,
window and pane create/close/rename arrive in about 100 ms; an `@agent_state`
flip in 250–400 ms, bounded by tmux's 1 Hz subscription timer (worst case just
over 1 s); a registered session's pane join in under 100 ms.

## Contract

`xtrm.topology.projection.v1`, published in `@xtrm/contracts`. The schema is the
source of truth; `TopologyProjectionV1` mirrors it and the fixture test guards
their agreement.

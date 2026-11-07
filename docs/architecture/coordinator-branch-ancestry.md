# Coordinator branch ancestry and merge authority

Audit reference: `~/dev/11.md` §P1-03, §P1-04. Implemented in `xtrm-6hey0.4`.

Two rules that only make sense together: where a specialist chain's branches come
from, and who is allowed to move work up the chain.

The single most important thing this document does is say **which component
enforces each rule**. Core owns interactive session launch; Specialists owns
background job execution and job lineage. An ancestry document that implied Core
creates or polices `sp/*` branches would be a lie, and lies in architecture docs
are how the next person builds on sand.

---

## Branch topology

```text
main
└── xt/<coordinator-slug>              ← coordinator integration branch (Core)
    ├── sp/explorer-<job>              ← specialist branches (Specialists)
    ├── sp/executor-<job>
    ├── sp/test-runner-<job>
    └── sp/reviewer-<job>
```

Specialist branches derive from the **current coordinator integration branch**,
not independently from `main`. That is what makes a chain coherent:

- a later specialist can inspect changes earlier ones already landed
- tests run against the integrated epic state, not against `main` plus a guess
- the reviewer assesses the coordinator-level result rather than one slice
- the coordinator can reject one branch without touching `main`

---

## The base-branch publication contract

Core cannot create specialist branches — a coordinator lives inside its own
worktree, and Core **refuses to create a worktree from inside another worktree**
(`launchWorktreeSession`), so `xt claude|pi` cannot spawn a grandchild at all.
`sp/*` worktrees are created by Specialists.

So Core's half of P1-03 is publication, not creation. Every launched session
publishes its integration branch two ways:

| Channel | Key | Notes |
| --- | --- | --- |
| tmux pane option | `@agent_branch` | readable by any peer on the same tmux server |
| child process env | `XTMUX_AGENT_BRANCH` | survives re-execs, which pane options do not |

with `@agent_worktree` / `XTMUX_AGENT_WORKTREE` alongside for the path. A
coordinator reads its own branch with:

```bash
base="$(tmux show-options -p -qv @agent_branch)"     # or: "$XTMUX_AGENT_BRANCH"
```

and passes it as the base when dispatching a chain. Consuming that value when
creating `sp/*` branches is a **Specialists-side** change.

### Why there is no `xt --base <branch>`

It would have no caller. Core cannot launch grandchildren (above), and `sp`
creates its own worktrees without going through `launchWorktreeSession`. Adding
a flag with no consumer is the speculative generality this repo's `ponytail`
discipline exists to prevent. If Specialists later wants Core to seed a worktree
from a non-`main` base, that is the moment to add it — with a caller.

### Why the per-job metadata block is not here

Audit P1-03 recommends per-job metadata:

```json
{ "parent_job_id": "…", "root_runtime_origin": { … }, "integration": { "base_branch": "…" } }
```

That belongs to Specialists' `SupervisorStatus`, and the contract already says
so. From `packages/contracts/schemas/xtrm.runtime-origin.v1.json`:

> worktree/branch/role/parent-job lineage is **NOT** here — it lives on
> `SupervisorStatus` (`spawn_origin` / `root_runtime_origin`).

Core emitting a competing copy would create two sources of truth for job lineage
and make Core a second job supervisor — explicitly forbidden by
[`interactive-role-envelope.md`](./interactive-role-envelope.md).

---

## Merge authority ladder

| Actor | May do | May not do |
| --- | --- | --- |
| specialist job | commit and publish **its own** branch | merge into `main`; merge a sibling's branch |
| chain coordinator | merge **accepted** specialist branches into its coordinator branch | merge itself into `main`; author the implementation; spawn a nested coordinator |
| main orchestrator | merge coordinator branches into `main` | override strategic/irreversible calls the operator reserved |
| operator | anything, including overriding every rule above | — |

Forbidden by construction of the ladder:

- a specialist branch merged directly into `main`
- a coordinator authoring the implementation instead of dispatching it
- a coordinator merging itself into `main` without main-orchestrator authority
- a nested coordinator hierarchy that was not explicitly designed

---

## Enforcement — who actually stops you

| Rule | Enforced by | How |
| --- | --- | --- |
| every interactive session gets its own worktree + branch | **Core** (code) | `launchWorktreeSession` always creates them; no `--no-worktree` exists |
| the main orchestrator stays in the main worktree | **Core** (code) | nested-worktree refusal in `launchWorktreeSession` |
| the integration branch is discoverable | **Core** (code) | `@agent_branch` / `XTMUX_AGENT_BRANCH` |
| a subordinate coordinator is launched safely | **Core** (code) | `--subordinate` + the P1-05 checks in `resolveSubordinateLaunch` / `checkSubordinateRole` |
| no nested chain coordinators | **Core** (code) | `checkSubordinateRole` compares the launching pane's `@agent_role` to the role being launched |
| merging into `main` is operator/coordinator authority | **process** (retired code gate) | `xt merge` and its `readSubordinateIdentity` gate were retired (CORE-2552); the review guard is being rebuilt in the `gh pr merge` wrapper under CORE-2530 |
| `sp/*` derives from the coordinator branch | **Specialists** | consumes the published base when creating job worktrees |
| specialist job lineage / `root_runtime_origin` | **Specialists** | `SupervisorStatus` |
| coordinator does not author implementation | **prompt** | `chain-coordinator.specialist.json` system prompt; not mechanically checkable |
| coordinator merges only *accepted* branches | **prompt + reviewer gate** | judgement, by definition |

### The retired `xt merge` gate was a guardrail, not a boundary

It read `@agent_role` and `@agent_parent_session` from the current pane. With no
tmux, no pane options, or no launcher metadata it did nothing, and anyone who can
run `xt merge` can also run `gh pr merge` directly. Its purpose was to stop an
agent from *absent-mindedly* draining the queue from inside a subordinate
session — not to make that impossible. CORE-2552 retired the command, so that
ladder now exists only as process discipline; CORE-2530 puts a real review guard
in the `gh pr merge` wrapper instead.

---

## Cross-references

- [`interactive-role-envelope.md`](./interactive-role-envelope.md) — the Core/Specialists boundary this document applies.
- [`../xt-pi-role.md`](../xt-pi-role.md) — `--subordinate`, worktree isolation, and the full pane-option/env tables.
- `test/integration-suite/suite-c-coordinator-lineage.mjs` — asserts the Core-enforced rows of the enforcement table.

---
title: Hooks Reference
scope: hooks
category: reference
version: 2.0.0
updated: 2026-09-04
description: "Current XTRM hook policy, compiled wiring, shipped payload, and lifecycle behavior"
source_of_truth_for:
  - "policies/*.json"
  - ".xtrm/config/hooks.json"
  - ".xtrm/hooks/**"
  - "packages/pi-extensions/extensions/**"
domain: [hooks, claude, pi, enforcement]
updated_at: 2026-09-04
---

# Hooks Reference

XTRM hook behavior has three layers:

```text
policies/*.json                 # authored wiring / runtime declarations
  -> scripts/compile-policies.mjs
  -> .xtrm/config/hooks.json    # compiled Claude hook configuration

policy command references
  -> .xtrm/hooks/**             # shipped Claude-side payload

policy pi.extension declarations
  -> packages/pi-extensions/extensions/**
```

Do not hand-edit `.xtrm/config/hooks.json` as the source of a behavior change. Update the
policy/payload, compile, and verify parity.

## Current Claude event model

The current compiled configuration uses:

| Event | Current purpose |
|---|---|
| `SessionStart` | claim/context restore, environment checks, session telemetry, stale-worktree reap |
| `PreToolUse` | worktree and Beads mutation gates, Specialists Agent guard, commit gate |
| `PostToolUse` | claim synchronization, quality checks, GitNexus enrichment, tool telemetry |
| `Stop` | claim gate and inbox/reply reminder |
| `PreCompact` | durable claim save before context compaction |

The compiled `.xtrm/config/hooks.json` is the definitive current event/matcher list.

## Current wired hooks

### SessionStart

| Hook | Behavior |
|---|---|
| `beads-compact-restore.mjs` | restores claim/session continuity after resume/compaction |
| `quality-check-env.mjs` | reports missing local quality-tool capability |
| `xtrm-session-logger.mjs` | records session-start diagnostic telemetry |
| `worktree-reap-sweep.mjs` | reaps/reconciles stale managed worktree state at session start |

### PreToolUse

| Matcher | Hook | Behavior |
|---|---|---|
| `Edit|Write|MultiEdit|NotebookEdit` | `worktree-boundary.mjs` | enforces managed worktree mutation boundary |
| same | `beads-edit-gate.mjs` | enforces required claimed-work contract before edits |
| `Agent` | `specialists-agent-guard.mjs` | prevents raw Agent dispatch when Specialists-governed execution applies |
| `Bash` | `beads-commit-gate.mjs` | guards commit lifecycle against unresolved claimed work |

### PostToolUse

| Matcher | Hook | Behavior |
|---|---|---|
| `Bash|execute_shell_command|bash` | `beads-claim-sync.mjs` | synchronizes session claim/close state after Beads commands |
| write/edit tools | `quality-check.cjs` | JS/TS quality feedback |
| write/edit tools | `quality-check.py` | Python quality feedback |
| `Bash|Grep|Read|Glob` | `gitnexus/gitnexus-hook.cjs` | adds bounded graph/context enrichment when applicable |
| all | `xtrm-tool-logger.mjs` | records diagnostic tool-call telemetry |

### Stop

| Hook | Behavior |
|---|---|
| `beads-stop-gate.mjs` | reminds about unresolved claimed work |
| `inbox-reminder-stop.mjs` | prevents silent session exit when pending XTRM inbox/reply obligations remain |

### PreCompact

| Hook | Behavior |
|---|---|
| `beads-compact-save.mjs` | saves current claim/continuation state before compaction |

The compiler adds a wrapper-level `script` hint for compact save/restore so test/runtime
machinery can identify those groups. Other groups use the normal matcher/hooks shape.

## Beads lifecycle ownership

Beads/Dolt owns canonical work lifecycle facts. Core hooks maintain session gates,
continuity, reminders, and diagnostic telemetry; they do not create a second lifecycle
source of truth.

```text
Beads events
  = canonical created / claimed / updated / closed / reopened / status facts

Core hook telemetry/KV
  = runtime/session diagnostics and enforcement state
```

Consumers must not treat older `bd.claimed`, `bd.closed`, `bd.claim`, or `bd.close`
diagnostic records as independent authoritative lifecycle events.

## Worktree ownership

`worktree-boundary.mjs` protects the current managed worktree mutation boundary.
`worktree-reap-sweep.mjs` handles stale managed worktree cleanup/reconciliation at session
start. Both are runtime safety machinery; do not duplicate their state model inside a
skill prompt.

## Inbox/reply continuity

`inbox-reminder-stop.mjs` is part of the current Stop contract. A worker with a pending
message/reply obligation should not simply terminate because its local task appears done.
General messaging and wake/reply doctrine belongs to `/multiplexing`; the Stop hook is the
deterministic reminder/enforcement surface.

## Quality hooks

`quality-check.cjs`, `quality-check.py`, and `quality-check-env.mjs` provide fast local
feedback. They are not substitutes for repository tests/review/release gates. Engineering
judgment and causal debugging live in `/engineering-quality`; deterministic local checks
stay in hooks/CI.

## Policy compilation and parity

Generate or verify Claude config with:

```bash
node scripts/compile-policies.mjs
node scripts/compile-policies.mjs --check
```

The compiler reads `policies/*.json`, validates policy-declared Claude payload references
against `.xtrm/hooks/**`, and refuses to emit wiring that points at a missing/non-file
payload.

For Pi declarations/deployment parity:

```bash
node scripts/compile-policies.mjs --check-pi
```

Pi extensions live under `packages/pi-extensions/extensions/**`; do not assume a Claude
hook event has an identical Pi lifecycle callback. The policy declares the intended
runtime coverage and the extension source implements the Pi side.

## Development workflow

Use optional `/hook-development` when adding/changing a hook. The required shape is:

```text
define lifecycle event + failure semantics
  -> implement payload
  -> declare wiring in policy
  -> compile
  -> verify payload/config parity
  -> test allow/block/error/timeout behavior
  -> verify Pi side when runtime=pi/both
  -> update this reference when current behavior changes
```

Hook code should be deterministic, bounded, and explicit about fail-open vs fail-closed
behavior. Avoid loading large context or performing unnecessary network work on hot paths.

## Troubleshooting

If hook wiring appears stale:

```bash
node scripts/compile-policies.mjs --check
```

If a Claude-side command points at a missing payload, the compiler reports the policy,
event, command, and expected `.xtrm/hooks/<path>`.

If Pi behavior diverges:

```bash
node scripts/compile-policies.mjs --check-pi
```

For a blocked edit/commit, inspect the current Beads claim/work state and the exact gate
message before clearing any state manually. Do not bypass a valid gate merely to continue.

## Related

- `/hook-development` — authoring/change workflow
- `/engineering-quality` — code/debug/test/review discipline
- `/multiplexing` — inter-agent messaging and reply obligations
- `docs/pi-extensions.md` — Pi runtime extensions
- `scripts/compile-policies.mjs` — compiler/parity implementation

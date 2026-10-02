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

Since CORE-2339 the Claude hook surface is **one process per event**: a single
`dispatch.mjs` registered for PreToolUse, PostToolUse and SessionStart, which
runs the xt checks in-process. `Stop` keeps its own single hook.

| Event | Command | Checks that run inside it |
|---|---|---|
| `PreToolUse` (`Edit\|Write\|MultiEdit\|NotebookEdit\|Agent`) | `node .xtrm/hooks/dispatch.mjs pre` | worktree boundary guard; specialists agent guard |
| `PostToolUse` (all tools) | `node .xtrm/hooks/dispatch.mjs post` | tool.call logging; GitNexus enrichment (Bash/Grep/Read/Glob + Serena); quality gate — in-process for JS/TS, `quality-check.py` child for Python |
| `SessionStart` (all) | `node .xtrm/hooks/dispatch.mjs session` | quality-gate environment probe; session-start logging; worktree reap sweep |
| `Stop` (all) | `node .xtrm/hooks/inbox-reminder-stop.mjs` | unread pane-scoped inbound message reminder |

The wiring is generated: edit `policies/hook-dispatcher.json` and run
`node scripts/compile-policies.mjs`. Never hand-edit `.xtrm/config/hooks.json`.

# Hooks

Claude Code hooks that extend agent behavior with automated checks, workflow enhancements, and safety guardrails.

## Dispatch model (CORE-2339)

One process per event, not one process per hook. `.xtrm/config/hooks.json`
registers a single `dispatch.mjs` command for PreToolUse, PostToolUse and
SessionStart; the dispatcher runs every xt-managed check in-process and keeps
the guard modules as the single source of truth for their decisions:

- `worktree-boundary.mjs` → `boundaryDecision(input)`
- `specialists-agent-guard.mjs` → `agentGuardDecision(input)`
- `xtrm-tool-logger.mjs` → `logToolCall(input)`
- `xtrm-session-logger.mjs` → `logSessionStart(input)`
- `quality-check-env.mjs` → `envCheck(input)`
- `worktree-reap-sweep.mjs` → `reapSweep(input)`
- `gitnexus/gitnexus-hook.cjs` → `enrich(input)`
- `quality-check.cjs` → `main(input)` (in-process, JS/TS only)

Each of those files still works standalone (same stdin/exit contract), so
direct invocation, tests and rollback keep working. The quality gates are routed
by file language:

- JS/TS edits run `quality-check.cjs` **in-process** (`main(input)` returns the
  exit code instead of calling `process.exit`, so the dispatcher forwards it) —
  byte-identical output, no second node startup per edited file.
- Python edits spawn `quality-check.py` as the one remaining child (different
  runtime).
- Everything else spawns nothing. Previously **both** interpreters ran for
  every edit and each exited early after full interpreter startup.

Guard parity: the dispatcher forwards the quality child's exit code verbatim
(exit 2 still blocks) and preserves each guard's own fail-open semantics. A
watchdog just under each event's registered timeout guarantees a stalled
dispatcher exits instead of accumulating as a stuck process (the RSS growth
mechanism measured in MMD-2235).

Measure before/after with `scripts/hook-bench/bench.py` (see its README).

## Overview

Hooks intercept specific events in the Claude Code lifecycle. Following architecture decisions in v2.0.0+, the hook ecosystem is designed exclusively for Claude Code.

*Note: In v2.1.15+, several older hooks (`skill-suggestion.py`, `skill-discovery.py`, `gitnexus-impact-reminder.py`, and `type-safety-enforcement.py`) were removed or superseded by native capabilities, CLI commands, and consolidated quality gates.*

## Project Hooks

### gitnexus-hook.cjs

**Purpose**: Enriches tool calls with knowledge graph context via `gitnexus augment`. Now supports Serena tools and uses a deduplication cache for efficiency.

**Trigger**: PostToolUse (Grep|Glob|Bash|Serena edit tools)

## Issue Tracking Gates (retired — lane 2 deleted)

The `bd` (beads) issue-tracker gates are retired. The 11 `beads-*.mjs` payload
files were deleted in lane 2; nothing live imports them:

- `statusline.mjs` — git-only line; no `bd` subprocess.
- `xtrm-tool-logger.mjs` / `xtrm-session-logger.mjs` — `resolveCwd`/`resolveSessionId`
  inlined.
- `xtrm-logger.mjs` — project anchor is `.xtrm/`, not `.beads/`; no `.beads` probe.
- Pi `custom-footer` — git-only footer; no beads segment, no cache module load.
- `claude-runtime-sync.ts` — SEAM comment updated; canonical template
  (`.xtrm/config/hooks.json`) wires no `beads-*` hooks.

**Installation**: `xtrm install all` wires only the gates listed below. Do not
re-add `beads-*` registrations; the canonical template is the source of truth.

## Hook Timeouts

Adjust hook execution timeouts in `settings.json` if commands take longer than expected:

```json
{
  "hooks": {
    "PostToolUse": [{
      "hooks": [{
        "timeout": 5000  // Timeout in milliseconds (5000ms = 5 seconds)
      }]
    }]
  }
}
```

## Creating Custom Hooks

To create new project-specific hooks, use the `hook-development` global skill. Follow the canonical structure defined in the `xtrm-tools` core libraries.

For debugging orphaned hooks, use `xtrm clean`.

## Pi Extensions Migration

Core workflow hooks have been migrated to native Pi Extensions for better performance and integration. See the [Pi Extensions Migration Guide](../docs/pi-extensions-migration.md) for details.

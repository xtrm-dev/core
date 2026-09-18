# Hooks

Claude Code hooks that extend agent behavior with automated checks, workflow enhancements, and safety guardrails.

## Overview

Hooks intercept specific events in the Claude Code lifecycle. Following architecture decisions in v2.0.0+, the hook ecosystem is designed exclusively for Claude Code.

*Note: In v2.1.15+, several older hooks (`skill-suggestion.py`, `skill-discovery.py`, `gitnexus-impact-reminder.py`, and `type-safety-enforcement.py`) were removed or superseded by native capabilities, CLI commands, and consolidated quality gates.*

## Project Hooks

### gitnexus-hook.cjs

**Purpose**: Enriches tool calls with knowledge graph context via `gitnexus augment`. Now supports Serena tools and uses a deduplication cache for efficiency.

**Trigger**: PostToolUse (Grep|Glob|Bash|Serena edit tools)

## Issue Tracking Gates (retired — lane 1 severed)

The `bd` (beads) issue-tracker gates are retired. The 11 `beads-*.mjs` payload
files remain on disk until lane 2 (deletion) but nothing live imports them:

- `statusline.mjs` — git-only line; `beads-status-cache.mjs` import cut, no `bd` subprocess.
- `xtrm-tool-logger.mjs` / `xtrm-session-logger.mjs` — `resolveCwd`/`resolveSessionId`
  inlined; `beads-gate-utils.mjs` import cut.
- `xtrm-logger.mjs` — project anchor is `.xtrm/`, not `.beads/`; no `.beads` probe.
- Pi `custom-footer` — beads segment severed (`BEADS_RETIRED_LANE1`); renders
  git-only; the cache module is never loaded (no-module path).
- `claude-runtime-sync.ts` — SEAM comment updated; canonical template
  (`.xtrm/config/hooks.json`) wires no `beads-*` hooks.

**Installation**: `xtrm install all` wires only the gates listed below. Do not
re-add `beads-*` registrations; the canonical template is the source of truth.

### Core Gates
- **`beads-edit-gate.mjs`** (PreToolUse) — Blocks writes/edits without an active issue claim.
- **`beads-commit-gate.mjs`** (PreToolUse) — Blocks commits with an unresolved session claim.
- **`beads-stop-gate.mjs`** (Stop) — Blocks session stop while a claim remains open.

### Compaction & State Preservation (v2.1.18+)
- **`beads-pre-compact.mjs`** (PreCompact) — Saves the currently `in_progress` beads state before Claude clears context.
- **`beads-session-start.mjs`** (SessionStart) — Restores the `in_progress` state when the session restarts after compaction.

*Note: As of v2.1.18+, hook blocking messages are quieted and compacted to save tokens.*

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

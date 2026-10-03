import fs from 'fs-extra';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolvePackageRoot } from '../core/registry-scaffold.js';

// Pin the canonical hook template. The global-only hooks steady state (guard,
// dedupe, machine-wide cleanup) treats every registration below as load-bearing:
// a template regression that silently drops one would un-wire it everywhere.
// This test exists so the steady-state set is enforced by CI, not by memory.
//
// Substrate-first (ADR sections 40-41, 45): the template no longer wires
// beads-* hooks. Their successors are owned by xtrm-6qu.6 (see the SEAM in
// cli/src/core/claude-runtime-sync.ts) — this set must grow substrate-*
// entries there, never re-add beads-* entries here.
describe('canonical hook template (.xtrm/config/hooks.json)', () => {
  // Resolve the same way claude-runtime-sync does: the package root owns
  // .xtrm/registry.json, the template sits at .xtrm/config/hooks.json.
  const hooksPath = path.join(resolvePackageRoot(), '.xtrm', 'config', 'hooks.json');

  it('contains every load-bearing canonical hook (12 entries across 8 events: CORE-2339 dispatcher + XTRM-569 reporter)', () => {
    const config = fs.readJsonSync(hooksPath) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type?: string; command: string }> }>>;
    };

    const entries = new Set<string>();
    for (const [event, wrappers] of Object.entries(config.hooks)) {
      for (const wrapper of wrappers) {
        for (const hook of wrapper.hooks ?? []) {
          const basename = hook.command.split('/').pop() ?? hook.command;
          entries.add(`${event}:${basename}`);
        }
      }
    }

    // CORE-2339: PreToolUse/PostToolUse/SessionStart consolidate into one
    // dispatch.mjs process per event (guards still routed in-process);
    // Stop keeps its single standalone hook. The standalone guard files must
    // stay shippable — the dispatcher imports them for their decisions.
    const expected = [
      'SessionStart:dispatch.mjs session',
      'PreToolUse:dispatch.mjs pre',
      'PostToolUse:dispatch.mjs post',
      'Stop:inbox-reminder-stop.mjs',
      // XTRM-569: the agent host presence reporter covers the PRD §35.8 item 4 v0 hook set.
      ...['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'SessionEnd'].map(
        (event) => `${event}:agent-host-reporter.mjs`,
      ),
    ];
    expect([...entries].sort()).toEqual([...expected].sort());
  });

  it('keeps the dispatcher matchers covering every consolidated guard (CORE-2339)', () => {
    const config = fs.readJsonSync(hooksPath) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };

    const byEvent: Record<string, string[]> = {};
    for (const [event, wrappers] of Object.entries(config.hooks)) {
      byEvent[event] = wrappers.map((w) => w.matcher ?? '');
    }

    // The old per-hook matchers, unioned per event — nothing may fall out of
    // the dispatcher's routing table (see dispatch.mjs EDIT_TOOLS/GITNEXUS_TOOLS).
    expect(byEvent.PreToolUse).toContain('Edit|Write|MultiEdit|NotebookEdit|Agent');
    // PostToolUse has no matcher: the old xtrm-tool-logger was registered for
    // every tool (and kept full tool.call logging coverage that way). The
    // dispatcher's internal routing is the narrower part.
    expect(byEvent.PostToolUse).toEqual(['']);
    expect(byEvent.SessionStart).toEqual(['']);
  });

  it('wires no beads-* hooks (retired; successors owned by xtrm-6qu.6)', () => {
    const config = fs.readJsonSync(hooksPath) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const allCommands = Object.values(config.hooks)
      .flat()
      .flatMap((w) => (w.hooks ?? []).map((h) => h.command));

    expect(allCommands.some((c) => c.includes('beads-'))).toBe(false);
  });
});

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

  it('contains every load-bearing canonical hook (10 entries across 4 events)', () => {
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

    const expected = [
      'SessionStart:quality-check-env.mjs',
      'SessionStart:xtrm-session-logger.mjs',
      'SessionStart:worktree-reap-sweep.mjs',
      'PreToolUse:worktree-boundary.mjs',
      'PreToolUse:specialists-agent-guard.mjs',
      'PostToolUse:quality-check.cjs',
      'PostToolUse:quality-check.py',
      'PostToolUse:gitnexus-hook.cjs',
      'PostToolUse:xtrm-tool-logger.mjs',
      'Stop:inbox-reminder-stop.mjs',
    ];
    expect([...entries].sort()).toEqual([...expected].sort());
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

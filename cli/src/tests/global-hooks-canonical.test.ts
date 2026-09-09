import fs from 'fs-extra';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolvePackageRoot } from '../core/registry-scaffold.js';

// Pin the canonical hook template. The global-only hooks steady state (guard,
// dedupe, machine-wide cleanup) treats every registration below as load-bearing:
// a template regression that silently drops one would un-wire it everywhere.
// This test exists so the 16-entry set is enforced by CI, not by memory.
describe('canonical hook template (.xtrm/config/hooks.json)', () => {
  // Resolve the same way claude-runtime-sync does: the package root owns
  // .xtrm/registry.json, the template sits at .xtrm/config/hooks.json.
  const hooksPath = path.join(resolvePackageRoot(), '.xtrm', 'config', 'hooks.json');

  it('contains every load-bearing canonical hook (16 entries across 5 events)', () => {
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
      'SessionStart:beads-compact-restore.mjs',
      'SessionStart:quality-check-env.mjs',
      'SessionStart:xtrm-session-logger.mjs',
      'SessionStart:worktree-reap-sweep.mjs',
      'PreToolUse:worktree-boundary.mjs',
      'PreToolUse:beads-edit-gate.mjs',
      'PreToolUse:specialists-agent-guard.mjs',
      'PreToolUse:beads-commit-gate.mjs',
      'PostToolUse:beads-claim-sync.mjs',
      'PostToolUse:quality-check.cjs',
      'PostToolUse:quality-check.py',
      'PostToolUse:gitnexus-hook.cjs',
      'PostToolUse:xtrm-tool-logger.mjs',
      'Stop:beads-stop-gate.mjs',
      'Stop:inbox-reminder-stop.mjs',
      'PreCompact:beads-compact-save.mjs',
    ];
    expect([...entries].sort()).toEqual([...expected].sort());
  });

  it('keeps the compact save/restore gates wired (PreCompact save, SessionStart restore)', () => {
    const config = fs.readJsonSync(hooksPath) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const allCommands = Object.values(config.hooks)
      .flat()
      .flatMap((w) => (w.hooks ?? []).map((h) => h.command));

    expect(allCommands.some((c) => c.includes('beads-compact-save.mjs'))).toBe(true);
    expect(allCommands.some((c) => c.includes('beads-compact-restore.mjs'))).toBe(true);
  });
});

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reconcileProjectClaudeHooks } from '../core/claude-runtime-sync.js';

// reconcileProjectClaudeHooks resolves the canonical hooks.json from the package root
// (the xtrm-tools repo root in tests, via __dirname walk), then rewrites the project's
// .claude/settings.json hooks section. These tests exercise the xtrm-0p7bp guarantee:
// newly-shipped xtrm-managed hooks (e.g. service-skills) get wired into an existing
// consumer settings.json on apply, idempotently, without clobbering other keys.

let repoRoot = '';

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-reconcile-test-'));
  fs.ensureDirSync(path.join(repoRoot, '.xtrm', 'hooks'));
});

afterEach(() => {
  fs.removeSync(repoRoot);
});

describe('reconcileProjectClaudeHooks', () => {
  it('wires canonical hooks into an existing settings.json with no hooks, preserving other keys', async () => {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    fs.ensureDirSync(path.dirname(settingsPath));
    fs.writeJsonSync(settingsPath, {
      permissions: { allow: ['Bash(ls:*)'], defaultMode: 'default' },
      model: 'claude-opus-4-8',
      hooks: {},
    });

    const result = await reconcileProjectClaudeHooks(repoRoot, { dryRun: false });

    expect(result.changed).toBe(true);
    const written = fs.readJsonSync(settingsPath);
    // Non-hook keys preserved
    expect(written.permissions.allow).toEqual(['Bash(ls:*)']);
    expect(written.model).toBe('claude-opus-4-8');
    // Hooks section now populated from canonical
    expect(Object.keys(written.hooks).length).toBeGreaterThan(0);
    // Regression guard for xtrm-0p7bp: the service-skills hooks must be present.
    const allCommands = JSON.stringify(written.hooks);
    expect(allCommands).toContain('skill_activator');
    expect(allCommands).toContain('cataloger');
    expect(allCommands).toContain('drift_detector');
  });

  it('is idempotent: a second run reports no change', async () => {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    fs.ensureDirSync(path.dirname(settingsPath));
    fs.writeJsonSync(settingsPath, { hooks: {} });

    const first = await reconcileProjectClaudeHooks(repoRoot, { dryRun: false });
    expect(first.changed).toBe(true);

    const second = await reconcileProjectClaudeHooks(repoRoot, { dryRun: false });
    expect(second.changed).toBe(false);
  });

  it('dry-run reports the change without writing', async () => {
    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    fs.ensureDirSync(path.dirname(settingsPath));
    fs.writeJsonSync(settingsPath, { hooks: {} });

    const result = await reconcileProjectClaudeHooks(repoRoot, { dryRun: true });

    expect(result.changed).toBe(true);
    // Settings file untouched (still empty hooks)
    const written = fs.readJsonSync(settingsPath);
    expect(written.hooks).toEqual({});
  });
});

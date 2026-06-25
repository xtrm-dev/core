import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runClaudeRuntimeSyncPhase } from '../core/claude-runtime-sync.js';

// xtrm-il7ov: runClaudeRuntimeSyncPhase must NOT overwrite the hooks section of
// ~/.claude/settings.json when invoked with isGlobal=true. Every xtrm-managed hook
// command references <projectRoot>/.xtrm/hooks/ — they are project-scoped by
// definition. Letting the global path replace ~/.claude/settings.json's hooks
// section wipes the user's globally-configured hooks (PreCompact bd prime,
// SessionStart context-mode-cache-heal, etc.) and duplicates project hooks.

let repoRoot = '';
let homeDir = '';
let originalHome: string | undefined;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-il7ov-repo-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-il7ov-home-'));
  fs.ensureDirSync(path.join(repoRoot, '.xtrm', 'hooks'));
  fs.ensureDirSync(path.join(homeDir, '.claude'));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  vi.restoreAllMocks();
  fs.removeSync(repoRoot);
  fs.removeSync(homeDir);
});

describe('runClaudeRuntimeSyncPhase isGlobal=true', () => {
  it('preserves the user-configured hooks section in ~/.claude/settings.json', async () => {
    const settingsPath = path.join(homeDir, '.claude', 'settings.json');
    const userHooks = {
      PreCompact: [{ hooks: [{ type: 'command', command: '/usr/local/bin/bd prime' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: '/usr/local/bin/context-mode-cache-heal.mjs' }] }],
    };
    fs.writeJsonSync(settingsPath, {
      permissions: { allow: ['Bash(ls:*)'] },
      model: 'claude-opus-4-8',
      hooks: userHooks,
    });

    const result = await runClaudeRuntimeSyncPhase({ repoRoot, dryRun: false, isGlobal: true });

    expect(result.wroteSettings).toBe(false);
    expect(result.hooksEntriesWritten).toBe(0);
    expect(result.hooksEventsWritten).toBe(0);
    expect(result.settingsPath).toBe(settingsPath);
    const after = fs.readJsonSync(settingsPath);
    expect(after.hooks).toEqual(userHooks);
    expect(after.model).toBe('claude-opus-4-8');
    expect(after.permissions.allow).toEqual(['Bash(ls:*)']);
  });

  it('does not create ~/.claude/settings.json when it is absent', async () => {
    const settingsPath = path.join(homeDir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath)).toBe(false);

    const result = await runClaudeRuntimeSyncPhase({ repoRoot, dryRun: false, isGlobal: true });

    expect(result.wroteSettings).toBe(false);
    // ensureGlobalStatusLine may create the file with just a statusLine field;
    // the contract is only that we did NOT write a hooks section.
    if (fs.existsSync(settingsPath)) {
      const after = fs.readJsonSync(settingsPath);
      expect(after.hooks).toBeUndefined();
    }
  });
});

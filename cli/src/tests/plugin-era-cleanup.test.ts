import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPluginEraCleanup } from '../core/plugin-era-cleanup.js';

let tmpDir = '';
let projectRoot = '';
let previousHome: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-prune-test-'));
  projectRoot = path.join(tmpDir, 'project');
  await fs.ensureDir(projectRoot);

  previousHome = process.env.HOME;
  process.env.HOME = path.join(tmpDir, 'home');

  await seedPluginEraArtifacts({ projectRoot, homeDir: process.env.HOME });
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }

  await fs.remove(tmpDir);
});

async function seedPluginEraArtifacts(params: { projectRoot: string; homeDir: string }): Promise<void> {
  const { projectRoot, homeDir } = params;

  await fs.ensureDir(path.join(homeDir, '.claude', 'plugins', 'data', 'xtrm-tools-xtrm-tools'));
  await fs.ensureDir(path.join(homeDir, '.claude', 'plugins', 'cache', 'xtrm-tools'));
  await fs.ensureDir(path.join(homeDir, '.claude', 'plugins', 'marketplaces', 'xtrm-tools'));
  await fs.ensureDir(path.join(homeDir, '.claude', 'plugins', 'data', 'serena'));
  await fs.ensureDir(path.join(homeDir, '.claude', 'plugins', 'cache', 'serena'));
  await fs.writeJson(path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), {
    'xtrm-tools@xtrm-tools': { version: '0.0.1' },
    'serena@claude-plugins-official': { version: '1.2.3' },
  }, { spaces: 2 });
  await fs.writeJson(path.join(homeDir, '.claude', 'plugins', 'known_marketplaces.json'), {
    'xtrm-tools': { source: { source: 'directory', path: '/tmp/x' } },
    'claude-plugins-official': { source: { source: 'github', owner: 'anthropics', repo: 'claude-plugins-official' } },
  }, { spaces: 2 });

  await fs.writeJson(path.join(homeDir, '.claude', 'settings.json'), {
    permissions: { allow: ['Bash(git status)'], defaultMode: 'acceptEdits' },
    model: 'claude-sonnet-4-5',
    hooks: { PostToolUse: [] },
    skillSuggestions: { enabled: false },
    statusLine: { type: 'command', command: 'echo ok' },
    enabledPlugins: {
      'xtrm-tools@xtrm-tools': true,
      'serena@claude-plugins-official': true,
    },
    extraKnownMarketplaces: {
      'xtrm-tools': { source: { source: 'directory', path: '/tmp/x' } },
      'claude-plugins-official': { source: { source: 'github', owner: 'anthropics', repo: 'claude-plugins-official' } },
    },
  }, { spaces: 2 });

  await fs.ensureDir(path.join(homeDir, '.pi', 'agent', 'extensions', 'beads'));
  await fs.ensureDir(path.join(homeDir, '.pi', 'agent', 'extensions', 'custom-ext'));

  // Batch G: .agents/skills cleanup removed - legacy path handling deleted

  await fs.ensureDir(path.join(projectRoot, '.claude'));
  await fs.writeJson(path.join(projectRoot, '.claude', 'settings.json'), {
    permissions: { allow: ['Read(README.md)'] },
    model: 'claude-opus-4-1',
    enabledPlugins: {
      'xtrm-tools@xtrm-tools': true,
      'serena@claude-plugins-official': true,
    },
    extraKnownMarketplaces: {
      'xtrm-tools': { source: { source: 'directory', path: '/tmp/x' } },
      'claude-plugins-official': true,
    },
  }, { spaces: 2 });

  await fs.ensureDir(path.join(projectRoot, '.claude', 'hooks'));
  await fs.writeFile(path.join(projectRoot, '.claude', 'hooks', 'quality-check.cjs'), '// legacy\n');
  await fs.writeFile(path.join(projectRoot, '.claude', 'hooks', 'specialists-complete.mjs'), '// legacy specialists\n');

  await fs.ensureDir(path.join(projectRoot, '.xtrm', 'hooks'));
  await fs.writeFile(path.join(projectRoot, '.xtrm', 'hooks', 'quality-check.cjs'), '// canonical\n');
  await fs.ensureDir(path.join(projectRoot, '.xtrm', 'config'));
  await fs.writeJson(path.join(projectRoot, '.xtrm', 'config', 'hooks.json'), { hooks: {} }, { spaces: 2 });

  await fs.ensureDir(path.join(projectRoot, '.xtrm', 'skills', 'default', 'clean-code'));

  const validHookPath = path.join(projectRoot, '.xtrm', 'hooks', 'valid.mjs');
  await fs.writeFile(validHookPath, '// valid\n');
  await fs.writeJson(path.join(projectRoot, '.xtrm', 'config', 'hooks.json'), {
    hooks: {
      PreToolUse: [
        { name: 'stale-hook', scriptPath: path.join(projectRoot, '.xtrm', 'hooks', 'missing.mjs') },
        { name: 'valid-hook', scriptPath: validHookPath },
      ],
    },
  }, { spaces: 2 });
}

describe('runPluginEraCleanup', () => {
  it('shows prune plan in dry-run without mutating files', async () => {
    const result = await runPluginEraCleanup({
      dryRun: true,
      yes: true,
      scope: 'all',
      repoRoot: projectRoot,
    });

    expect(result.planned.length).toBeGreaterThan(0);
    expect(await fs.pathExists(path.join(process.env.HOME as string, '.claude', 'plugins'))).toBe(true);

    const globalSettings = await fs.readJson(path.join(process.env.HOME as string, '.claude', 'settings.json')) as Record<string, unknown>;
    expect(globalSettings.enabledPlugins).toBeTruthy();
    expect(globalSettings.extraKnownMarketplaces).toBeTruthy();
  });

  it('prunes hook rows whose scripts are missing and preserves valid rows', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await runPluginEraCleanup({
      dryRun: false,
      yes: true,
      scope: 'all',
      repoRoot: projectRoot,
    });

    const homeDir = process.env.HOME as string;

    expect(await fs.pathExists(path.join(homeDir, '.claude', 'plugins'))).toBe(true);
    expect(await fs.pathExists(path.join(homeDir, '.claude', 'plugins', 'data', 'xtrm-tools-xtrm-tools'))).toBe(false);
    expect(await fs.pathExists(path.join(homeDir, '.claude', 'plugins', 'cache', 'xtrm-tools'))).toBe(false);
    expect(await fs.pathExists(path.join(homeDir, '.claude', 'plugins', 'marketplaces', 'xtrm-tools'))).toBe(false);
    expect(await fs.pathExists(path.join(homeDir, '.claude', 'plugins', 'data', 'serena'))).toBe(true);
    expect(await fs.pathExists(path.join(homeDir, '.claude', 'plugins', 'cache', 'serena'))).toBe(true);

    const installedPlugins = await fs.readJson(path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json')) as Record<string, unknown>;
    expect(installedPlugins['xtrm-tools@xtrm-tools']).toBeUndefined();
    expect(installedPlugins['serena@claude-plugins-official']).toBeTruthy();

    const knownMarketplaces = await fs.readJson(path.join(homeDir, '.claude', 'plugins', 'known_marketplaces.json')) as Record<string, unknown>;
    expect(knownMarketplaces['xtrm-tools']).toBeUndefined();
    expect(knownMarketplaces['claude-plugins-official']).toBeTruthy();

    const globalSettings = await fs.readJson(path.join(homeDir, '.claude', 'settings.json')) as Record<string, unknown>;
    expect(globalSettings.permissions).toBeTruthy();
    expect(globalSettings.model).toBe('claude-sonnet-4-5');
    expect(globalSettings.hooks).toBeTruthy();
    expect(globalSettings.skillSuggestions).toBeTruthy();
    expect(globalSettings.statusLine).toBeTruthy();
    expect(globalSettings.enabledPlugins).toEqual({ 'serena@claude-plugins-official': true });
    expect(globalSettings.extraKnownMarketplaces).toEqual({ 'claude-plugins-official': { source: { source: 'github', owner: 'anthropics', repo: 'claude-plugins-official' } } });

    expect(await fs.pathExists(path.join(homeDir, '.pi', 'agent', 'extensions', 'beads'))).toBe(false);
    expect(await fs.pathExists(path.join(homeDir, '.pi', 'agent', 'extensions', 'custom-ext'))).toBe(true);

    // Batch G: .agents/skills cleanup code removed - no assertions on legacy path

    const projectSettings = await fs.readJson(path.join(projectRoot, '.claude', 'settings.json')) as Record<string, unknown>;
    expect(projectSettings.enabledPlugins).toEqual({ 'serena@claude-plugins-official': true });
    expect(projectSettings.extraKnownMarketplaces).toEqual({ 'claude-plugins-official': true });

    expect(await fs.pathExists(path.join(projectRoot, '.claude', 'hooks', 'quality-check.cjs'))).toBe(false);
    expect(await fs.pathExists(path.join(projectRoot, '.claude', 'hooks', 'specialists-complete.mjs'))).toBe(true);

    const hooksConfig = await fs.readJson(path.join(projectRoot, '.xtrm', 'config', 'hooks.json')) as { hooks: { PreToolUse: Array<{ name: string }> } };
    expect(hooksConfig.hooks.PreToolUse).toEqual([{ name: 'valid-hook', scriptPath: path.join(projectRoot, '.xtrm', 'hooks', 'valid.mjs') }]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('stale-hook'));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(path.join(projectRoot, '.xtrm', 'hooks', 'missing.mjs')));
    warning.mockRestore();
  });

  it('prunes the CORE-2393 herdr/orca known orphans and their hook command', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const homeDir = process.env.HOME as string;

    const herdrHook = path.join(homeDir, '.claude', 'hooks', 'herdr-agent-state.sh');
    const orcaExtension = path.join(homeDir, '.pi', 'agent', 'extensions', 'orca-agent-status.ts');
    const herdrExtension = path.join(homeDir, '.pi', 'agent', 'extensions', 'herdr-agent-state.ts');
    const herdrBinary = path.join(homeDir, '.local', 'bin', 'herdr');
    const herdrConfigDir = path.join(homeDir, '.config', 'herdr');

    await fs.ensureDir(path.dirname(herdrHook));
    await fs.writeFile(herdrHook, '#!/bin/sh\n');
    await fs.writeFile(herdrExtension, '// herdr\n');
    await fs.writeFile(orcaExtension, '// orca\n');
    await fs.ensureDir(path.dirname(herdrBinary));
    await fs.writeFile(herdrBinary, '#!/bin/sh\n');
    await fs.ensureDir(path.join(herdrConfigDir, 'logs'));

    const keptCommand = '~/.tmux/scripts/xtmux-agent-state.sh';
    // CORE-2393 review: the matcher keys on the executed program, so a row that
    // merely mentions the retired name as an argument to a non-interpreter must
    // survive. `echo herdr-agent-state.sh` is the canonical such row.
    const mentionsNameOnly = 'echo herdr-agent-state.sh';
    await fs.writeJson(path.join(homeDir, '.claude', 'settings.json'), {
      permissions: { allow: ['Bash(git status)'], defaultMode: 'acceptEdits' },
      model: 'claude-sonnet-4-5',
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: `bash ${herdrHook}` }] },
          { hooks: [{ type: 'command', command: mentionsNameOnly }] },
        ],
        PostToolUse: [
          { hooks: [{ type: 'command', command: keptCommand }] },
        ],
        // Interpreter with a flag before the script must still be pruned.
        SessionEnd: [
          { hooks: [{ type: 'command', command: `node --no-warnings ${path.join(homeDir, '.claude', 'hooks', 'orca-agent-status.ts')}` }] },
        ],
      },
      statusLine: { type: 'command', command: 'echo ok' },
    }, { spaces: 2 });

    const dryRunResult = await runPluginEraCleanup({
      dryRun: true,
      yes: true,
      scope: 'global',
      repoRoot: projectRoot,
    });
    expect(dryRunResult.planned.map((operation) => operation.label)).toEqual(expect.arrayContaining([
      '~/.claude/hooks/herdr-agent-state.sh',
      '~/.pi/agent/extensions/herdr-agent-state.ts',
      '~/.pi/agent/extensions/orca-agent-status.ts',
      '~/.local/bin/herdr',
      '~/.config/herdr',
    ]));
    expect(await fs.pathExists(herdrHook)).toBe(true);
    expect(await fs.pathExists(herdrConfigDir)).toBe(true);

    await runPluginEraCleanup({
      dryRun: false,
      yes: true,
      scope: 'global',
      repoRoot: projectRoot,
    });

    expect(await fs.pathExists(herdrHook)).toBe(false);
    expect(await fs.pathExists(herdrExtension)).toBe(false);
    expect(await fs.pathExists(orcaExtension)).toBe(false);
    expect(await fs.pathExists(herdrBinary)).toBe(false);
    expect(await fs.pathExists(herdrConfigDir)).toBe(false);

    const globalSettings = await fs.readJson(path.join(homeDir, '.claude', 'settings.json')) as Record<string, unknown>;
    expect(globalSettings.permissions).toEqual({ allow: ['Bash(git status)'], defaultMode: 'acceptEdits' });
    expect(globalSettings.model).toBe('claude-sonnet-4-5');
    expect(globalSettings.statusLine).toEqual({ type: 'command', command: 'echo ok' });
    expect(globalSettings.hooks).toEqual({
      SessionStart: [{ hooks: [{ type: 'command', command: mentionsNameOnly }] }],
      PostToolUse: [{ hooks: [{ type: 'command', command: keptCommand }] }],
    });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('herdr-agent-state.sh'));
    warning.mockRestore();
  });
});

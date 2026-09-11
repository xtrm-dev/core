import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../commands/pi-install.js', () => ({
  runPiInstall: vi.fn(async (_dryRun: boolean, _isGlobal: boolean, projectRoot: string) => {
    const settingsPath = path.join(projectRoot, '.pi', 'settings.json');
    fs.ensureDirSync(path.dirname(settingsPath));
    fs.writeJsonSync(settingsPath, { skills: ['../.xtrm/skills/active'] }, { spaces: 2 });
  }),
}));

vi.mock('../core/machine-bootstrap.js', async () => {
  const actual = await vi.importActual<typeof import('../core/machine-bootstrap.js')>('../core/machine-bootstrap.js');
  return {
    ...actual,
    runMachineBootstrapPhase: vi.fn(async () => undefined),
  };
});

import { runInstall } from '../commands/install.js';
import { runPiInstall } from '../commands/pi-install.js';

interface HooksConfig {
  hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>;
}

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

let tmpDir = '';
let previousCwd = '';
let previousHome = '';

beforeEach(() => {
  previousCwd = process.cwd();
  previousHome = process.env.HOME ?? '';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-install-test-'));
  // Isolate HOME to a subdir so global-scope writes (~/.claude/skills, ~/.xtrm)
  // do not collide with per-repo assertions rooted at tmpDir.
  process.env.HOME = path.join(tmpDir, 'home');
  fs.ensureDirSync(process.env.HOME);
  process.chdir(tmpDir);
});

afterEach(() => {
  delete process.env.XTRM_GLOBAL_SKILLS;
  if (previousHome) process.env.HOME = previousHome;
  else delete process.env.HOME;
  process.chdir(previousCwd);
  fs.removeSync(tmpDir);
  vi.restoreAllMocks();
});

async function runInstallCli(args: string[]): Promise<{ logs: string[] }> {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  });

  try {
    await runInstall({
      dryRun: args.includes('--dry-run'),
      force: args.includes('--force'),
      prune: args.includes('--prune'),
      yes: args.includes('--yes'),
    });
    return { logs };
  } finally {
    logSpy.mockRestore();
  }
}

function readHooksConfig(): HooksConfig {
  return fs.readJsonSync(path.join(REPO_ROOT, '.xtrm', 'config', 'hooks.json')) as HooksConfig;
}

function expectedCommand(commandTemplate: string, hooksRoot: string): string {
  return commandTemplate.replace(/\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([^\s"]+)/g, `"${hooksRoot}/$1"`);
}

// Every case here drives the real installer against a /tmp scaffold, so wall-clock
// is load-dependent rather than logic-dependent — the 30s global default in
// cli/vitest.config.ts is a machine-load tripwire, not a regression signal (xtrm-5tw31).
describe('runtime maintenance integration', { timeout: 120_000 }, () => {
  it('fresh install scaffolds .xtrm and writes absolute hook commands to settings.json', async () => {
    await runInstallCli(['--yes']);

    expect(fs.pathExistsSync(path.join(tmpDir, '.xtrm', 'hooks'))).toBe(true);
    expect(fs.pathExistsSync(path.join(tmpDir, '.xtrm', 'config'))).toBe(true);
    expect(fs.pathExistsSync(path.join(tmpDir, '.xtrm', 'skills', 'default'))).toBe(true);
    expect(fs.pathExistsSync(path.join(tmpDir, '.mcp.json'))).toBe(true);

    const mcpConfig = fs.readJsonSync(path.join(tmpDir, '.mcp.json')) as { mcpServers?: Record<string, unknown> };
    expect(Object.keys(mcpConfig.mcpServers ?? {})).toEqual(expect.arrayContaining([
      'gitnexus',
      'github-grep',
      'deepwiki',
    ]));

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    expect(fs.pathExistsSync(settingsPath)).toBe(true);

    const settings = fs.readJsonSync(settingsPath) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>;
    };
    const hooksConfig = readHooksConfig();

    const hooksRoot = path.join(tmpDir, '.xtrm', 'hooks');
    for (const [eventName, definitions] of Object.entries(hooksConfig.hooks)) {
      const wrappers = settings.hooks[eventName] ?? [];
      expect(wrappers.length).toBe(definitions.length);

      definitions.forEach((definition, index) => {
        const wrapper = wrappers[index];
        expect(wrapper.hooks.length).toBe(definition.hooks.length);

        definition.hooks.forEach((hook, hookIndex) => {
          const commandHook = wrapper.hooks[hookIndex];
          expect(commandHook.type).toBe(hook.type);
          expect(commandHook.command).toBe(expectedCommand(hook.command, hooksRoot));
        });
      });
    }
  });

  it('creates global default pointers and preserves direct project runtime roots across reruns', async () => {
    await runInstallCli(['--yes']);

    const homeDir = process.env.HOME!;
    const claudeSkillsPath = path.join(homeDir, '.claude', 'skills');
    const globalDefaultPath = path.join(homeDir, '.xtrm', 'skills', 'default');

    const claudeLinkStat = fs.lstatSync(claudeSkillsPath);
    expect(claudeLinkStat.isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(claudeSkillsPath)).toBe(globalDefaultPath);
    expect(fs.pathExistsSync(globalDefaultPath)).toBe(true);
    expect(fs.lstatSync(path.join(tmpDir, '.claude', 'skills')).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(tmpDir, '.pi', 'skills')).isDirectory()).toBe(true);
    expect(fs.pathExistsSync(path.join(tmpDir, '.xtrm', 'skills', 'active'))).toBe(false);

    const claudeMtimeBefore = claudeLinkStat.mtimeMs;

    await new Promise(resolve => setTimeout(resolve, 10));
    await runInstallCli(['--yes']);

    const claudeMtimeAfter = fs.lstatSync(claudeSkillsPath).mtimeMs;
    expect(claudeMtimeAfter).toBe(claudeMtimeBefore);
  });

  it('second install is idempotent and does not overwrite up-to-date files', async () => {
    await runInstallCli(['--yes']);

    const targetFile = path.join(tmpDir, '.xtrm', 'hooks', 'worktree-boundary.mjs');
    const before = fs.statSync(targetFile).mtimeMs;

    await new Promise(resolve => setTimeout(resolve, 10));
    const { logs } = await runInstallCli(['--yes']);

    const after = fs.statSync(targetFile).mtimeMs;
    expect(after).toBe(before);
    expect(logs.some(line => line.includes('Up-to-date'))).toBe(true);
  });

  it('drifted file is skipped without --force and overwritten with --force', async () => {
    await runInstallCli(['--yes']);

    const driftedFile = path.join(tmpDir, '.xtrm', 'hooks', 'worktree-boundary.mjs');
    const upstreamFile = path.join(REPO_ROOT, '.xtrm', 'hooks', 'worktree-boundary.mjs');

    fs.writeFileSync(driftedFile, '// user custom change\n', 'utf8');

    const noForceResult = await runInstallCli(['--yes']);
    expect(noForceResult.logs.some(line => line.includes('Drift detected'))).toBe(true);
    expect(noForceResult.logs.some(line => line.includes('hooks/worktree-boundary.mjs'))).toBe(true);
    expect(fs.readFileSync(driftedFile, 'utf8')).toBe('// user custom change\n');

    const forceResult = await runInstallCli(['--yes', '--force']);
    expect(fs.readFileSync(driftedFile, 'utf8')).toBe(fs.readFileSync(upstreamFile, 'utf8'));
    expect(forceResult.logs.some(line => line.includes('Drift detected'))).toBe(false);
  });

  it('dry-run prints scaffold actions and writes no files', async () => {
    const { logs } = await runInstallCli(['--dry-run', '--yes']);

    expect(logs.some(line => line.includes('[DRY RUN] would install'))).toBe(true);
    expect(fs.pathExistsSync(path.join(tmpDir, '.xtrm'))).toBe(false);
    expect(fs.pathExistsSync(path.join(tmpDir, '.claude', 'settings.json'))).toBe(false);
  });

  it('treats retired XTRM_GLOBAL_SKILLS flag as no-op for direct runtime scaffolding', async () => {
    process.env.XTRM_GLOBAL_SKILLS = '1';

    await runInstallCli(['--yes']);

    // xtrm-vtqlg.5: per-repo managed tiers are retired — install scaffolds the
    // state file and the GLOBAL tiers, never repo-local default//optional/.
    expect(fs.pathExistsSync(path.join(tmpDir, '.xtrm', 'skills', 'state.json'))).toBe(true);
    expect(fs.pathExistsSync(path.join(tmpDir, '.xtrm', 'skills', 'default'))).toBe(false);
    expect(fs.pathExistsSync(path.join(tmpDir, '.xtrm', 'skills', 'optional'))).toBe(false);
    expect(fs.pathExistsSync(path.join(tmpDir, '.xtrm', 'skills', 'user', 'packs'))).toBe(false);
    expect(fs.pathExistsSync(path.join(tmpDir, '.xtrm', 'skills', 'active'))).toBe(false);
    expect(fs.pathExistsSync(path.join(process.env.HOME!, '.xtrm', 'skills', 'default'))).toBe(true);
  });

  it('hook wiring includes all hooks and preserves existing permissions.allow on reinstall', async () => {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    fs.ensureDirSync(path.dirname(settingsPath));
    fs.writeJsonSync(settingsPath, {
      permissions: {
        allow: ['Bash(git status)', 'Read(README.md)'],
        defaultMode: 'acceptEdits',
      },
      model: 'claude-sonnet-4-5',
      skillSuggestions: { enabled: false },
    }, { spaces: 2 });

    await runInstallCli(['--yes']);
    await runInstallCli(['--yes']);

    const settings = fs.readJsonSync(settingsPath) as {
      permissions?: { allow?: string[] };
      hooks?: Record<string, unknown[]>;
      model?: string;
      skillSuggestions?: { enabled?: boolean };
    };

    const hooksConfig = readHooksConfig();

    expect(settings.permissions?.allow).toEqual(['Bash(git status)', 'Read(README.md)']);
    expect(settings.model).toBe('claude-sonnet-4-5');
    expect(settings.skillSuggestions?.enabled).toBe(false);
    expect(Object.keys(settings.hooks ?? {}).sort()).toEqual(Object.keys(hooksConfig.hooks).sort());

    const serializedSettings = JSON.stringify(settings);
    expect(serializedSettings.toLowerCase().includes('marketplace')).toBe(false);
    expect(serializedSettings.toLowerCase().includes('claude plugin')).toBe(false);
  });

  it('prune mode removes plugin-era settings keys and rewrites hooks to .xtrm absolute paths', async () => {
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    fs.ensureDirSync(path.dirname(settingsPath));
    fs.writeJsonSync(settingsPath, {
      permissions: {
        allow: ['Bash(git status)'],
        defaultMode: 'acceptEdits',
      },
      model: 'claude-sonnet-4-5',
      skillSuggestions: { enabled: false },
      statusLine: { type: 'command', command: 'echo status' },
      enabledPlugins: { 'xtrm-tools@xtrm-tools': true },
      extraKnownMarketplaces: { xtrm: true },
      hooks: {
        PostToolUse: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PLUGIN_ROOT/legacy-hook.mjs"' }] }],
      },
    }, { spaces: 2 });

    await runInstallCli(['--yes', '--prune']);

    const settings = fs.readJsonSync(settingsPath) as {
      hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      enabledPlugins?: unknown;
      extraKnownMarketplaces?: unknown;
      permissions?: { allow?: string[] };
      model?: string;
      skillSuggestions?: { enabled?: boolean };
      statusLine?: unknown;
    };

    expect(settings.enabledPlugins).toBeUndefined();
    expect(settings.extraKnownMarketplaces).toBeUndefined();
    expect(settings.permissions?.allow).toEqual(['Bash(git status)']);
    expect(settings.model).toBe('claude-sonnet-4-5');
    expect(settings.skillSuggestions?.enabled).toBe(false);
    expect(settings.statusLine).toBeTruthy();

    const postToolHooks = settings.hooks?.PostToolUse ?? [];
    expect(postToolHooks.length).toBeGreaterThan(0);
    const flattenedCommands = postToolHooks.flatMap(wrapper => wrapper.hooks.map(hook => hook.command));
    expect(flattenedCommands.some(command => command.includes('.xtrm/hooks/'))).toBe(true);
    expect(flattenedCommands.some(command => command.includes('CLAUDE_PLUGIN_ROOT'))).toBe(false);
  });

  it('forwards skipGlobalPromptSync to runPiInstall so update can sync globals once (xtrm-3ljgz.2)', async () => {
    (runPiInstall as unknown as ReturnType<typeof vi.fn>).mockClear();

    await runInstall({
      dryRun: false,
      yes: true,
      projectRoot: tmpDir,
      skipMachineBootstrap: true,
      skipClaudeRuntimeSync: true,
      skipGlobalPromptSync: true,
    });

    expect(runPiInstall).toHaveBeenCalledTimes(1);
    expect(runPiInstall).toHaveBeenCalledWith(false, false, tmpDir, expect.objectContaining({
      skipGlobalPromptSync: true,
    }));
  });

  it('direct install does not skip the global prompt sync by default (xtrm-3ljgz.2)', async () => {
    (runPiInstall as unknown as ReturnType<typeof vi.fn>).mockClear();

    await runInstall({
      dryRun: false,
      yes: true,
      projectRoot: tmpDir,
      skipMachineBootstrap: true,
      skipClaudeRuntimeSync: true,
    });

    expect(runPiInstall).toHaveBeenCalledTimes(1);
    expect(runPiInstall).toHaveBeenCalledWith(false, false, tmpDir, expect.objectContaining({
      skipGlobalPromptSync: undefined,
    }));
  });
});

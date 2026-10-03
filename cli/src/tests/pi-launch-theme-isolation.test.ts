import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// XTRM-581: the xt pi launch preflight must write themes only into the agent dir
// the launched Pi reads, and a non-installed (worktree/source) build must never
// re-point the operator's global ~/.pi/agent/themes links at itself.

const THEME_FILES = ['xtrm-dark.json', 'xtrm-dark-flattools.json', 'xtrm-light.json', 'xtrm-light-flattools.json'];
const ENV_KEYS = ['HOME', 'PI_AGENT_DIR', 'PI_CODING_AGENT_DIR'] as const;

let tempRoot = '';
let previousEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function seedSentinelThemes(themeDir: string): void {
  fs.ensureDirSync(themeDir);
  for (const name of THEME_FILES) fs.symlinkSync(`/sentinel/${name}`, path.join(themeDir, name));
}

function readLinks(themeDir: string): Record<string, string | null> {
  return Object.fromEntries(THEME_FILES.map((name) => {
    try {
      return [name, fs.readlinkSync(path.join(themeDir, name))];
    } catch {
      return [name, null];
    }
  }));
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-pi-theme-iso-'));
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.HOME = path.join(tempRoot, 'home');
  delete process.env.PI_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  seedSentinelThemes(path.join(tempRoot, 'home', '.pi', 'agent', 'themes'));
  vi.resetModules();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  await fs.remove(tempRoot);
});

describe('pi launch preflight theme isolation (XTRM-581)', () => {
  it('writes theme links only into PI_CODING_AGENT_DIR and leaves the global agent dir unchanged', async () => {
    const globalThemes = path.join(tempRoot, 'home', '.pi', 'agent', 'themes');
    const isolatedAgent = path.join(tempRoot, 'isolated-agent');
    const before = readLinks(globalThemes);
    process.env.PI_CODING_AGENT_DIR = isolatedAgent;
    const projectRoot = path.join(tempRoot, 'repo');
    await fs.ensureDir(projectRoot);

    const { runPiLaunchPreflight } = await import('../core/pi-runtime.js');
    const result = await runPiLaunchPreflight(projectRoot, false);

    expect(result.themesChanged).toBe(true);
    const isolatedThemes = path.join(isolatedAgent, 'themes');
    for (const name of THEME_FILES) {
      const link = path.join(isolatedThemes, name);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(link)).toBe(true);
      expect(path.basename(fs.realpathSync(link))).toBe(name);
    }
    expect(result.staleOverride.path).toBe(path.join(isolatedAgent, 'extensions', 'pi-mcp-adapter'));
    expect(readLinks(globalThemes)).toEqual(before);
  });

  it('does not re-point global agent dir links when launched from a non-installed build', async () => {
    const globalThemes = path.join(tempRoot, 'home', '.pi', 'agent', 'themes');
    const before = readLinks(globalThemes);
    const projectRoot = path.join(tempRoot, 'repo');
    await fs.ensureDir(projectRoot);
    const log = vi.fn();

    const { runPiLaunchPreflight } = await import('../core/pi-runtime.js');
    const result = await runPiLaunchPreflight(projectRoot, false, log);

    expect(result.themesChanged).toBe(false);
    expect(readLinks(globalThemes)).toEqual(before);
    expect(log.mock.calls.flat().join('\n')).toContain('Skipped XTRM Pi theme sync');
  });

  it('still syncs themes into an explicit non-global PI_AGENT_DIR from a source build', async () => {
    const globalThemes = path.join(tempRoot, 'home', '.pi', 'agent', 'themes');
    const before = readLinks(globalThemes);
    const scratchAgent = path.join(tempRoot, 'scratch-agent');
    process.env.PI_AGENT_DIR = scratchAgent;
    const projectRoot = path.join(tempRoot, 'repo');
    await fs.ensureDir(projectRoot);

    const { runPiLaunchPreflight } = await import('../core/pi-runtime.js');
    const result = await runPiLaunchPreflight(projectRoot, false);

    expect(result.themesChanged).toBe(true);
    expect(Object.values(readLinks(path.join(scratchAgent, 'themes'))).every(Boolean)).toBe(true);
    expect(readLinks(globalThemes)).toEqual(before);
  });

  it('resolves the launch agent dir with PI_CODING_AGENT_DIR > PI_AGENT_DIR > ~/.pi/agent', async () => {
    const { resolvePiLaunchAgentDir } = await import('../core/pi-runtime.js');
    expect(resolvePiLaunchAgentDir({ PI_CODING_AGENT_DIR: '/iso', PI_AGENT_DIR: '/scratch' })).toBe('/iso');
    expect(resolvePiLaunchAgentDir({ PI_AGENT_DIR: '/scratch' })).toBe('/scratch');
    expect(resolvePiLaunchAgentDir({})).toBe(path.join(os.homedir(), '.pi', 'agent'));
  });

  it('classifies only node_modules package roots as installed builds', async () => {
    const { isInstalledPackageRoot } = await import('../core/pi-runtime.js');
    expect(isInstalledPackageRoot('/home/u/.nvm/versions/node/v25/lib/node_modules/xtrm-tools')).toBe(true);
    expect(isInstalledPackageRoot('/home/u/dev/core/.xtrm/worktrees/core-xt-claude-x')).toBe(false);
    expect(isInstalledPackageRoot('/home/u/dev/core')).toBe(false);
  });
});

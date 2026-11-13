import { spawnSync } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getContext, resolveConfCwd, resolveConfProjectDir } from '../core/context.js';
import { ensureEnvFile, getEnvFilePath, getConfigDir } from '../utils/env-manager.js';

// CORE-2630: config paths must follow HOME even after the CLI module graph has
// been loaded. Before the fix, CONFIG_DIR (env-manager) and the cached Conf
// instance (context) were bound to the HOME in force at import/first use, so a
// later HOME change kept writing to the original home.
//
// The platform branches are exercised by stubbing process.platform: CI runs on
// linux only, so a plain `if (platform !== 'darwin') return` would report a pass
// on a branch it never entered (review finding, round 3).
describe('HOME is resolved lazily (CORE-2630)', () => {
  let firstHome = '';
  let secondHome = '';
  let previousHome: string | undefined;
  let previousXdg: string | undefined;

  beforeEach(() => {
    firstHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-home-a-'));
    secondHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-home-b-'));
    previousHome = process.env.HOME;
    previousXdg = process.env.XDG_CONFIG_HOME;
    // Load the module graph under the first home.
    process.env.HOME = firstHome;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    fs.removeSync(firstHome);
    fs.removeSync(secondHome);
  });

  it('env-manager writes under the new HOME after a change', () => {
    // Module graph already loaded under firstHome (beforeEach). Now switch.
    process.env.HOME = secondHome;
    const created = ensureEnvFile();
    expect(created).toBe(false); // created fresh
    const envPath = getEnvFilePath();
    expect(envPath).toContain(secondHome);
    expect(envPath).not.toContain(firstHome);
    expect(fs.existsSync(envPath)).toBe(true);
    expect(getConfigDir()).toBe(path.join(secondHome, '.config', 'jaggers-agent-tools'));
    expect(fs.existsSync(path.join(firstHome, '.config', 'jaggers-agent-tools', '.env'))).toBe(false);
  });

  it('context reads from the new HOME after a change', async () => {
    // Seed a store under firstHome.
    process.env.HOME = firstHome;
    const ctx1 = await getContext({ createMissingDirs: true, projectRoot: firstHome });
    expect(ctx1.syncMode).toBe('copy');
    const firstStore = path.join(resolveConfProjectDir(), 'config.json');
    expect(await fs.pathExists(firstStore)).toBe(true);

    // Switch HOME and resolve again; the read must not reuse the old store.
    process.env.HOME = secondHome;
    const ctx2 = await getContext({ createMissingDirs: false, projectRoot: secondHome });
    expect(ctx2.syncMode).toBe('copy');
    expect(await fs.pathExists(path.join(secondHome, '.config', 'xtrm-cli-nodejs', 'config.json'))).toBe(false);
    // The old home's store stays where it was.
    expect(await fs.pathExists(firstStore)).toBe(true);
  });

  it('writes the store exactly where the resolver says (not just "somewhere")', async () => {
    process.env.HOME = firstHome;
    await getContext({ createMissingDirs: true, projectRoot: firstHome });
    // The writer's real path, not a second copy of the same expression.
    expect(await fs.pathExists(path.join(resolveConfProjectDir(), 'config.json'))).toBe(true);
    expect(resolveConfCwd()).toBe(resolveConfProjectDir());
  });
});

// CORE-2630 round 3: the delta's only new branch is per-platform, and CI is
// linux-only, so each platform base is asserted with a stubbed process.platform.
describe('the config directory mirrors env-paths per platform (CORE-2630)', () => {
  let previousHome: string | undefined;
  let previousXdg: string | undefined;
  let previousAppData: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    previousXdg = process.env.XDG_CONFIG_HOME;
    previousAppData = process.env.APPDATA;
    process.env.HOME = '/home/tester';
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.APPDATA;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
  });

  it('darwin: ~/Library/Preferences, ignoring XDG_CONFIG_HOME', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    process.env.XDG_CONFIG_HOME = '/should/be/ignored';
    expect(resolveConfProjectDir()).toBe('/home/tester/Library/Preferences/xtrm-cli-nodejs');
  });

  it('win32: APPDATA/xtrm-cli-nodejs/Config', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    process.env.APPDATA = '/appdata';
    expect(resolveConfProjectDir()).toBe(path.join('/appdata', 'xtrm-cli-nodejs', 'Config'));
  });

  it('win32 without APPDATA falls back to ~/AppData/Roaming', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    delete process.env.APPDATA;
    expect(resolveConfProjectDir()).toBe(path.join('/home/tester', 'AppData', 'Roaming', 'xtrm-cli-nodejs', 'Config'));
  });

  it('linux: XDG_CONFIG_HOME when set, ~/.config otherwise, empty means unset', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    process.env.XDG_CONFIG_HOME = '/xdg';
    expect(resolveConfProjectDir()).toBe('/xdg/xtrm-cli-nodejs');
    process.env.XDG_CONFIG_HOME = '';
    expect(resolveConfProjectDir()).toBe(path.join('/home/tester', '.config', 'xtrm-cli-nodejs'));
    delete process.env.XDG_CONFIG_HOME;
    expect(resolveConfProjectDir()).toBe(path.join('/home/tester', '.config', 'xtrm-cli-nodejs'));
  });

  it('agrees with env-paths, which must be asked in a fresh process', () => {
    // env-paths captures os.homedir() at module load, so asking it in this
    // process would compare a live resolver with a frozen module and depend on
    // import order. A child process with the same environment is the real check.
    const script = "import('env-paths').then(m => process.stdout.write(m.default('xtrm-cli', { suffix: 'nodejs' }).config))";
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, HOME: '/home/tester', XDG_CONFIG_HOME: '', APPDATA: '' },
    });
    expect(child.status, child.stderr).toBe(0);
    expect(resolveConfProjectDir()).toBe(child.stdout.trim());
  });
});

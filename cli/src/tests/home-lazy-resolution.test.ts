import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureEnvFile, getEnvFilePath, getConfigDir } from '../utils/env-manager.js';
import { getContext } from '../core/context.js';

// CORE-2630: config paths must follow HOME even after the CLI module graph
// has been loaded. Before the fix, CONFIG_DIR (env-manager) and the cached
// Conf instance (context) were bound to the HOME in force at import/first use,
// so a later HOME change kept writing to the original home.
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
    // The file must land under secondHome, not firstHome.
    const envPath = getEnvFilePath();
    expect(envPath).toContain(secondHome);
    expect(envPath).not.toContain(firstHome);
    expect(fs.existsSync(envPath)).toBe(true);
    expect(fs.existsSync(path.join(firstHome, '.config', 'jaggers-agent-tools', '.env'))).toBe(false);
  });

  it('context reads from the new HOME after a change', async () => {
    // Seed a store under firstHome.
    process.env.HOME = firstHome;
    const ctx1 = await getContext({ createMissingDirs: true, projectRoot: firstHome });
    expect(ctx1.syncMode).toBe('copy');

    // Switch HOME and resolve again; the read must not reuse the old store.
    process.env.HOME = secondHome;
    const ctx2 = await getContext({ createMissingDirs: false, projectRoot: secondHome });
    expect(ctx2.syncMode).toBe('copy');
    // The store file must not have been created under secondHome by a read.
    expect(await fs.pathExists(path.join(secondHome, '.config', 'xtrm-cli-nodejs', 'config.json'))).toBe(false);
    // And the old home's store stays where it was.
    expect(await fs.pathExists(path.join(firstHome, '.config', 'xtrm-cli-nodejs', 'config.json'))).toBe(true);
  });
});

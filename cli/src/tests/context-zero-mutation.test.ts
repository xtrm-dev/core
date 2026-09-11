import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getContext } from '../core/context.js';

// Read-only context resolution must not create the Conf store file: the
// fail-closed gates rely on byte-identical HOME snapshots.
describe('getContext read-only paths', () => {
  let home = '';
  let previousHome: string | undefined;
  let previousXdg: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-ctx-home-'));
    previousHome = process.env.HOME;
    previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = home;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    fs.removeSync(home);
  });

  it('does not create the config store on read-only resolution', async () => {
    const ctx = await getContext({ createMissingDirs: false, projectRoot: home });
    expect(ctx.syncMode).toBe('copy');
    expect(await fs.pathExists(path.join(home, '.config', 'xtrm-cli-nodejs', 'config.json'))).toBe(false);
  });
});

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ packageRoot: '', home: '' }));

vi.mock('../core/registry-scaffold.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/registry-scaffold.js')>()),
  resolvePackageRoot: () => mocked.packageRoot,
}));

import { createCleanCommand } from '../commands/clean.js';

// CORE-2513: xt clean must surface a guard refusal instead of reporting "no retired skills".
describe('xt clean --skills-only: prune guard refusal', () => {
  let tmpDir = '';
  let previousCwd = '';
  let previousHome: string | undefined;

  beforeEach(async () => {
    previousCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-clean-refusal-'));
    mocked.packageRoot = path.join(tmpDir, 'pkg');
    mocked.home = path.join(tmpDir, 'home');
    previousHome = process.env.HOME;
    process.env.HOME = mocked.home;
    process.chdir(tmpDir);

    const names = ['a', 'b', 'c', 'd', 'e', 'keep'];
    await fs.outputJson(path.join(mocked.packageRoot, '.xtrm', 'registry.json'), {
      version: '1.0.0',
      assets: {
        skills: {
          source_dir: '.xtrm/skills/default',
          install_mode: 'copy',
          files: { 'other/SKILL.md': { hash: 'h', version: '1.0.0' } },
        },
      },
    });
    const skillsRoot = path.join(mocked.home, '.xtrm', 'skills');
    for (const name of names) await fs.outputFile(path.join(skillsRoot, 'default', name, 'SKILL.md'), '#');
    await fs.outputJson(path.join(skillsRoot, '.installer-manifest.json'), { default: names.map(n => `${n}/SKILL.md`) });
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.remove(tmpDir);
    vi.restoreAllMocks();
  });

  it('prints the refusal with the override hint, no "No retired" line, and deletes nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await createCleanCommand().parseAsync(['node', 'clean', '--skills-only', '--yes'], { from: 'node' });

    const output = logSpy.mock.calls.map(call => String(call[0])).join('\n');
    expect(output).toContain('Refused to prune 6 retired skill(s)');
    expect(output).toContain('XTRM_ALLOW_LARGE_PRUNE=1');
    expect(output).not.toContain('No retired managed skills found');
    expect(await fs.readdir(path.join(mocked.home, '.xtrm', 'skills', 'default'))).toHaveLength(6);
  });
});

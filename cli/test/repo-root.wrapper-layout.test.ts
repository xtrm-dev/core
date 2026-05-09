import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

describe('findRepoRoot wrapper layout support', () => {
  let tempRoot: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-wrapper-root-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempRoot);
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    vi.restoreAllMocks();
    await fs.remove(tempRoot);
  });

  it('resolves source root from packaged layout (.xtrm/registry.json + .xtrm/skills)', async () => {
    const wrapperRoot = path.join(tempRoot, 'node_modules', 'xtrm-tools');
    await fs.ensureDir(path.join(wrapperRoot, '.xtrm', 'skills', 'default'));
    await fs.writeJson(path.join(wrapperRoot, '.xtrm', 'registry.json'), { version: '1.0.0', assets: {} });
    cwdSpy.mockReturnValue(path.join(wrapperRoot, 'bin'));

    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
      const asString = String(p);
      if (asString.endsWith('/.xtrm/registry.json')) return false;
      return require('node:fs').existsSync(p);
    });

    const { findRepoRoot } = await import('../src/utils/repo-root.js?t=wrapper-' + Date.now());
    await expect(findRepoRoot()).resolves.toBe(wrapperRoot);
    existsSpy.mockRestore();
  });

  it('rejects symlinked packaged markers during cwd ancestry lookup', async () => {
    const fakeRoot = path.join(tempRoot, 'fake-root');
    const realElsewhere = path.join(tempRoot, 'elsewhere');
    await fs.ensureDir(path.join(realElsewhere, 'skills'));
    await fs.ensureDir(path.join(fakeRoot, '.xtrm'));
    await fs.ensureDir(path.join(fakeRoot, 'child'));
    await fs.symlink(realElsewhere, path.join(fakeRoot, '.xtrm', 'skills'));
    await fs.symlink(path.join(realElsewhere, 'skills'), path.join(fakeRoot, '.xtrm', 'registry.json'));
    cwdSpy.mockReturnValue(path.join(fakeRoot, 'child'));

    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
      const asString = String(p);
      if (asString.endsWith('/.xtrm/registry.json')) return false;
      return require('node:fs').existsSync(p);
    });

    const { findRepoRoot } = await import('../src/utils/repo-root.js?t=symlink-' + Date.now());
    await expect(findRepoRoot()).rejects.toThrow('Could not locate xtrm-tools source repo root');
    existsSpy.mockRestore();
  });

  it('prefers bundle root over cwd project .xtrm markers', async () => {
    const projectRoot = path.join(tempRoot, 'project');
    await fs.ensureDir(path.join(projectRoot, '.xtrm', 'skills', 'default'));
    await fs.writeJson(path.join(projectRoot, '.xtrm', 'registry.json'), { version: 'fake', assets: {} });
    cwdSpy.mockReturnValue(projectRoot);

    const { findRepoRoot } = await import('../src/utils/repo-root.js?t=shadow-' + Date.now());
    const resolved = await findRepoRoot();
    expect(resolved).not.toBe(projectRoot);
    expect(await fs.pathExists(path.join(resolved, '.xtrm', 'registry.json'))).toBe(true);
  });
});

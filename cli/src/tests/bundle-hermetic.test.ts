import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  absolutePathOffences,
  bundleNeedles,
  bundleVerdict,
  mainCheckoutFromCommonDir,
  prebuildVerdict,
  resolutionRootShared,
} from '../../scripts/bundle-hermetic.mjs';

// The defect both guards exist for: a bundle built through a node_modules that
// links into another checkout carried 932 absolute module paths, and the
// prebuild check (a cwd prefix test) reported nothing. These tests judge the
// artefact and the resolution root, which is where the defect was visible.
describe('bundle hermeticity: the artefact', () => {
  it('names every offending needle with its count and first line', () => {
    const source = ['const a = 1;', 'import x from "/home/someone/dev/core/node_modules/y";', 'const b = "/home/someone/dev/core/node_modules/y";'].join('\n');
    const offences = absolutePathOffences(source, ['/home/someone', '/home/']);
    expect(offences).toEqual([
      { needle: '/home/someone', count: 2, firstLine: 2 },
      { needle: '/home/', count: 2, firstLine: 2 },
    ]);
  });

  it('refuses a bundle that names the machine, and says how often', () => {
    const verdict = bundleVerdict({
      source: 'ok\nimport y from "/home/someone/dev/core/node_modules/y/index.js";\n',
      homeDir: '/home/someone',
      repoRoot: '/home/someone/dev/core',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.offences[0]).toMatchObject({ needle: '/home/someone', count: 1, firstLine: 2 });
  });

  it('accepts a bundle that carries only relative resolution', () => {
    const verdict = bundleVerdict({
      source: 'require("../node_modules/y/index.js"); require("../node_modules/z/index.js");',
      homeDir: '/home/someone',
      repoRoot: '/home/someone/dev/core',
    });
    expect(verdict).toEqual({ ok: true, offences: [] });
  });

  it('never treats an empty needle as a match', () => {
    expect(absolutePathOffences('anything at all', ['', '/home/'])).toEqual([]);
    expect(bundleNeedles({ homeDir: '', repoRoot: '' })).toEqual(['/home/']);
  });
});

describe('bundle hermeticity: the resolution root', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'xt-bh-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports the shared directory when a worktree node_modules links into the main checkout', () => {
    const main = join(root, 'main');
    const wt = join(root, 'wt');
    mkdirSync(join(main, 'node_modules'), { recursive: true });
    mkdirSync(wt, { recursive: true });
    symlinkSync(join(main, 'node_modules'), join(wt, 'node_modules'));
    const shared = resolutionRootShared({ worktreeModules: join(wt, 'node_modules'), mainModules: join(main, 'node_modules') });
    expect(shared?.worktreeReal).toBe(join(main, 'node_modules'));
  });

  it('says nothing when the two directories are genuinely separate', () => {
    const main = join(root, 'main');
    const wt = join(root, 'wt');
    mkdirSync(join(main, 'node_modules'), { recursive: true });
    mkdirSync(join(wt, 'node_modules'), { recursive: true });
    expect(resolutionRootShared({ worktreeModules: join(wt, 'node_modules'), mainModules: join(main, 'node_modules') })).toBeNull();
  });

  it('says nothing when a directory is absent, rather than guessing', () => {
    expect(resolutionRootShared({ worktreeModules: join(root, 'missing'), mainModules: join(root, 'also-missing') })).toBeNull();
  });

  it('refuses a worktree build whose cli/node_modules links into the main checkout', () => {
    const main = join(root, 'main');
    const wt = join(root, 'wt');
    mkdirSync(join(main, 'cli', 'node_modules'), { recursive: true });
    mkdirSync(join(wt, 'cli'), { recursive: true });
    symlinkSync(join(main, 'cli', 'node_modules'), join(wt, 'cli', 'node_modules'));
    const verdict = prebuildVerdict({ cwd: join(wt, 'cli'), gitCommonDir: join(main, '.git') });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/cli\/node_modules resolves to .*the same directory the main checkout uses/);
  });

  it('refuses a worktree build whose root node_modules links into the main checkout', () => {
    const main = join(root, 'main');
    const wt = join(root, 'wt');
    mkdirSync(join(main, 'node_modules'), { recursive: true });
    mkdirSync(join(wt, 'cli'), { recursive: true });
    symlinkSync(join(main, 'node_modules'), join(wt, 'node_modules'));
    const verdict = prebuildVerdict({ cwd: join(wt, 'cli'), gitCommonDir: join(main, '.git') });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/node_modules resolves to .*the same directory the main checkout uses/);
  });

  it('allows a build in the main checkout itself', () => {
    const main = join(root, 'main');
    mkdirSync(join(main, 'cli', 'node_modules'), { recursive: true });
    const verdict = prebuildVerdict({ cwd: join(main, 'cli'), gitCommonDir: join(main, '.git') });
    expect(verdict).toEqual({ ok: true, shared: null, reason: null });
  });

  it('allows a worktree that has its own node_modules', () => {
    const main = join(root, 'main');
    const wt = join(root, 'wt');
    mkdirSync(join(main, 'cli', 'node_modules'), { recursive: true });
    mkdirSync(join(wt, 'cli', 'node_modules'), { recursive: true });
    const verdict = prebuildVerdict({ cwd: join(wt, 'cli'), gitCommonDir: join(main, '.git') });
    expect(verdict.ok).toBe(true);
  });

  it('reads the main checkout from the git common dir', () => {
    expect(mainCheckoutFromCommonDir('/repo/main/.git')).toBe('/repo/main');
  });
});

import { execSync } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveMainProjectRoot } from '../utils/repo-root.js';

// xtrm-6ofgm: every entrypoint that defaults its target to "current project"
// must resolve to the MAIN checkout, never the worktree dir, so hook command
// strings in .claude/settings.json never bake an ephemeral worktree path.

let mainRepo = '';

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: 'pipe' });
}

beforeEach(() => {
  mainRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-6ofgm-')));
  git(mainRepo, 'init -q -b main');
  git(mainRepo, 'config user.email test@test');
  git(mainRepo, 'config user.name test');
  fs.writeFileSync(path.join(mainRepo, 'README.md'), 'seed\n');
  git(mainRepo, 'add README.md');
  git(mainRepo, 'commit -q -m seed');
});

afterEach(() => {
  fs.removeSync(mainRepo);
});

describe('resolveMainProjectRoot', () => {
  it('returns the main checkout root when called from the main checkout', () => {
    expect(resolveMainProjectRoot(mainRepo)).toBe(mainRepo);
  });

  it('returns the main checkout root when called from a linked worktree (xtrm-6ofgm regression)', () => {
    const worktreePath = path.join(mainRepo, '.xtrm', 'worktrees', 'test-wt');
    fs.ensureDirSync(path.dirname(worktreePath));
    git(mainRepo, `worktree add ${worktreePath} -b feature/wt`);
    const resolved = resolveMainProjectRoot(worktreePath);
    expect(resolved).toBe(mainRepo);
  });

  it('returns the main checkout root when called from a nested subdirectory of a worktree', () => {
    const worktreePath = path.join(mainRepo, '.xtrm', 'worktrees', 'nested-wt');
    fs.ensureDirSync(path.dirname(worktreePath));
    git(mainRepo, `worktree add ${worktreePath} -b feature/x`);
    const nestedDir = path.join(worktreePath, 'pkg', 'src');
    fs.ensureDirSync(nestedDir);
    const resolved = resolveMainProjectRoot(nestedDir);
    expect(resolved).toBe(mainRepo);
  });

  it('falls back to cwd when not inside a git repo', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-6ofgm-nongit-'));
    try {
      const resolved = resolveMainProjectRoot(nonGitDir);
      // git rev-parse will fail; helper falls back to cwd.
      expect(resolved).toBe(nonGitDir);
    } finally {
      fs.removeSync(nonGitDir);
    }
  });
});

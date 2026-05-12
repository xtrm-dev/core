import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: mocked.spawnSync,
}));

describe('worktree session .beads handling (no symlink; skip-worktree only)', () => {
  let tempRoot = '';
  let previousCwd = '';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-worktree-beads-'));
    previousCwd = process.cwd();
    mocked.spawnSync.mockReset();
    vi.resetModules();
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.remove(tempRoot);
    vi.restoreAllMocks();
  });

  function mockProcessExit(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`exit:${code ?? 0}`) as never;
    });
  }

  it('removes worktree .beads/ and marks tracked .beads paths skip-worktree (no symlink)', async () => {
    const repoRoot = path.join(tempRoot, 'repo');
    const worktreePath = path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-pi-noise1');
    const gitDir = path.join(worktreePath, '.git');
    const beadsPath = path.join(worktreePath, '.beads');

    await fs.ensureDir(repoRoot);
    await fs.ensureDir(path.join(repoRoot, '.beads'));
    await fs.ensureDir(path.join(repoRoot, '.xtrm', 'worktrees'));
    process.chdir(repoRoot);

    mocked.spawnSync.mockImplementation((command: string, args: string[]) => {
      const joinedArgs = args.join(' ');

      if (command === 'git' && joinedArgs === 'rev-parse --show-toplevel') {
        return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
      }

      if (command === 'git' && joinedArgs === 'rev-parse --git-common-dir') {
        return { status: 0, stdout: '.git\n', stderr: '' };
      }

      if (command === 'bd' && args[0] === 'worktree' && args[1] === 'create') {
        // Simulate bd's checkout of the tracked .beads/ tree into the new worktree.
        fs.ensureDirSync(worktreePath);
        fs.ensureDirSync(gitDir);
        fs.ensureDirSync(beadsPath);
        fs.writeFileSync(path.join(beadsPath, 'issues.jsonl'), '');
        fs.writeFileSync(path.join(beadsPath, 'config.yaml'), '');
        return { status: 0, stdout: '', stderr: '' };
      }

      if (command === 'git' && joinedArgs === `-C ${worktreePath} ls-files -- .beads`) {
        return { status: 0, stdout: '.beads/issues.jsonl\n.beads/config.yaml\n', stderr: '' };
      }

      if (command === 'pi') {
        return { status: 0, stdout: '', stderr: '' };
      }

      return { status: 0, stdout: '', stderr: '' };
    });

    const exitSpy = mockProcessExit();
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    await expect(launchWorktreeSession({ runtime: 'pi', name: 'noise1' })).rejects.toThrow('exit:0');

    // .beads/ must be removed from the worktree entirely (no symlink, no dir).
    expect(await fs.pathExists(beadsPath)).toBe(false);

    // The git info/exclude write is gone — no need to write it when no symlink exists.
    const excludePath = path.join(gitDir, 'info', 'exclude');
    expect(await fs.pathExists(excludePath)).toBe(false);

    // skip-worktree must still be applied so tracked .beads/* don't show as deleted.
    expect(mocked.spawnSync).toHaveBeenCalledWith(
      'git',
      ['-C', worktreePath, 'update-index', '--skip-worktree', '--', '.beads/issues.jsonl', '.beads/config.yaml'],
      expect.objectContaining({ cwd: worktreePath }),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

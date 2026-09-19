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

let tempRoot = '';
let previousCwd = '';
let previousPiAgentDir: string | undefined;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-pi-launch-'));
  previousCwd = process.cwd();
  previousPiAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = path.join(tempRoot, 'pi-agent');
  mocked.spawnSync.mockReset();
  vi.resetModules();
});

afterEach(async () => {
  process.chdir(previousCwd);
  if (previousPiAgentDir === undefined) {
    delete process.env.PI_AGENT_DIR;
  } else {
    process.env.PI_AGENT_DIR = previousPiAgentDir;
  }
  await fs.remove(tempRoot);
  vi.restoreAllMocks();
});

function mockProcessExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new Error(`exit:${code ?? 0}`) as never;
  });
}

function createStalePiMcpAdapterOverride(piAgentDir: string): string {
  const overrideDir = path.join(piAgentDir, 'extensions', 'pi-mcp-adapter');
  fs.ensureDirSync(overrideDir);
  fs.writeJsonSync(path.join(overrideDir, 'package.json'), { name: 'pi-mcp-adapter' });
  return overrideDir;
}

function createBrokenCoreSymlink(projectRoot: string): string {
  const symlinkDir = path.join(projectRoot, '.xtrm', 'extensions', 'node_modules', '@xtrm');
  const symlinkPath = path.join(symlinkDir, 'pi-core');
  const wrongTarget = path.join(projectRoot, 'wrong-core');

  fs.ensureDirSync(path.join(projectRoot, '.xtrm', 'extensions', 'core'));
  fs.ensureDirSync(wrongTarget);
  fs.ensureDirSync(symlinkDir);

  if (fs.existsSync(symlinkPath)) fs.removeSync(symlinkPath);
  fs.symlinkSync(path.relative(symlinkDir, wrongTarget), symlinkPath);
  return symlinkPath;
}

describe('pi launch self-heal regression', () => {
  it('heals broken core symlink + stale pi-mcp-adapter override on xt pi launch path', async () => {
    const repoRoot = path.join(tempRoot, 'repo');
    await fs.ensureDir(path.join(repoRoot, '.xtrm', 'extensions', 'core'));
    await fs.ensureDir(path.join(repoRoot, '.pi', 'npm'));
    process.chdir(repoRoot);

    const overrideDir = createStalePiMcpAdapterOverride(process.env.PI_AGENT_DIR as string);

    mocked.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel') {
        return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
      }

      if (command === 'git' && args.join(' ') === 'rev-parse --git-common-dir') {
        return { status: 0, stdout: '.git\n', stderr: '' };
      }

      if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        // Git-first path (CORE-2307): `git worktree add` is the primary
        // creator. Mirror the bd fallback's side effects (worktree dir +
        // broken core symlink) so the self-heal path is exercised.
        const worktreePath = args.includes('-b') ? args[3] : args[2];
        fs.ensureDirSync(path.join(worktreePath as string, '.xtrm', 'extensions', 'core'));
        createBrokenCoreSymlink(worktreePath as string);
        return { status: 0, stdout: '', stderr: '' };
      }

      if (command === 'bd' && args[0] === 'worktree' && args[1] === 'create') {
        const worktreePath = args[2];
        fs.ensureDirSync(path.join(worktreePath, '.xtrm', 'extensions', 'core'));
        createBrokenCoreSymlink(worktreePath);
        return { status: 0, stdout: '', stderr: '' };
      }

      if (command === 'pi') {
        return { status: 0, stdout: '', stderr: '' };
      }

      return { status: 0, stdout: '', stderr: '' };
    });

    const exitSpy = mockProcessExit();
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    await expect(launchWorktreeSession({ runtime: 'pi', name: 'heal1' })).rejects.toThrow('exit:0');

    const worktreePath = path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-pi-heal1');
    const symlinkDir = path.join(worktreePath, '.xtrm', 'extensions', 'node_modules', '@xtrm');
    const symlinkPath = path.join(symlinkDir, 'pi-core');
    const resolvedTarget = path.resolve(symlinkDir, await fs.readlink(symlinkPath));

    expect(resolvedTarget).toBe(path.resolve(path.join(worktreePath, '.xtrm', 'extensions', 'core')));
    expect(await fs.pathExists(overrideDir)).toBe(false);

    expect(mocked.spawnSync).toHaveBeenCalledWith('pi', ['--name', 'repo-xt-pi-heal1'], expect.objectContaining({ cwd: worktreePath }));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('heals broken state on xt attach pi resume path before launching runtime', async () => {
    const repoRoot = path.join(tempRoot, 'repo');
    const worktreePath = path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-pi-abc1');

    await fs.ensureDir(path.join(worktreePath, '.xtrm', 'extensions', 'core'));
    await fs.ensureDir(path.join(worktreePath, '.xtrm'));
    await fs.writeJson(path.join(worktreePath, '.xtrm', 'session-meta.json'), {
      runtime: 'pi',
      launchedAt: '2026-04-01T00:00:00.000Z',
    });

    createBrokenCoreSymlink(worktreePath);
    const overrideDir = createStalePiMcpAdapterOverride(process.env.PI_AGENT_DIR as string);
    process.chdir(repoRoot);

    mocked.spawnSync.mockImplementation((command: string, args: string[]) => {
      const joinedArgs = args.join(' ');

      if (command === 'git' && joinedArgs === 'rev-parse --git-common-dir') {
        return { status: 0, stdout: '.git\n', stderr: '' };
      }

      if (command === 'git' && joinedArgs === 'worktree list --porcelain') {
        return {
          status: 0,
          stdout: `worktree ${repoRoot}\nHEAD 111\nbranch refs/heads/main\n\nworktree ${worktreePath}\nHEAD 222\nbranch refs/heads/xt/abc1\n`,
          stderr: '',
        };
      }

      if (command === 'git' && joinedArgs.startsWith('log -1 --format=')) {
        return { status: 0, stdout: '2026-04-03 12:00:00 +0000\x1fresume\n', stderr: '' };
      }

      if (command === 'pi' && joinedArgs === '-c') {
        return { status: 0, stdout: '', stderr: '' };
      }

      return { status: 0, stdout: '', stderr: '' };
    });

    const exitSpy = mockProcessExit();
    const { createAttachCommand } = await import('../commands/attach.js');

    const cmd = createAttachCommand();
    await expect(cmd.parseAsync(['node', 'attach', 'abc1'])).rejects.toThrow('exit:0');

    const symlinkDir = path.join(worktreePath, '.xtrm', 'extensions', 'node_modules', '@xtrm');
    const symlinkPath = path.join(symlinkDir, 'pi-core');
    const resolvedTarget = path.resolve(symlinkDir, await fs.readlink(symlinkPath));

    expect(resolvedTarget).toBe(path.resolve(path.join(worktreePath, '.xtrm', 'extensions', 'core')));
    expect(await fs.pathExists(overrideDir)).toBe(false);
    expect(mocked.spawnSync).toHaveBeenCalledWith('pi', ['-c'], expect.objectContaining({ cwd: worktreePath, stdio: 'inherit' }));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('prefers an exact branch over an earlier path suffix match', async () => {
    const repoRoot = path.join(tempRoot, 'repo');
    const barfooPath = path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-barfoo');
    const fooPath = path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-foo');

    for (const worktreePath of [barfooPath, fooPath]) {
      await fs.ensureDir(path.join(worktreePath, '.xtrm'));
      await fs.writeJson(path.join(worktreePath, '.xtrm', 'session-meta.json'), {
        runtime: 'pi',
        launchedAt: '2026-04-01T00:00:00.000Z',
      });
    }
    process.chdir(repoRoot);

    mocked.spawnSync.mockImplementation((command: string, args: string[]) => {
      const joinedArgs = args.join(' ');

      if (command === 'git' && joinedArgs === 'rev-parse --git-common-dir') {
        return { status: 0, stdout: '.git\n', stderr: '' };
      }

      if (command === 'git' && joinedArgs === 'worktree list --porcelain') {
        return {
          status: 0,
          stdout: [
            `worktree ${repoRoot}`,
            'HEAD 111',
            'branch refs/heads/main',
            '',
            `worktree ${barfooPath}`,
            'HEAD 222',
            'branch refs/heads/xt/barfoo',
            '',
            `worktree ${fooPath}`,
            'HEAD 333',
            'branch refs/heads/xt/foo',
            '',
          ].join('\n'),
          stderr: '',
        };
      }

      if (command === 'git' && joinedArgs.startsWith('log -1 --format=')) {
        return { status: 0, stdout: '2026-04-03 12:00:00 +0000\x1fresume\n', stderr: '' };
      }

      if (command === 'pi' && joinedArgs === '-c') {
        return { status: 0, stdout: '', stderr: '' };
      }

      return { status: 0, stdout: '', stderr: '' };
    });

    const exitSpy = mockProcessExit();
    const { createAttachCommand } = await import('../commands/attach.js');

    await expect(createAttachCommand().parseAsync(['node', 'attach', 'foo'])).rejects.toThrow('exit:0');

    expect(mocked.spawnSync).toHaveBeenCalledWith(
      'pi',
      ['-c'],
      expect.objectContaining({ cwd: fooPath, stdio: 'inherit' }),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

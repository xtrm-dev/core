import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  ensureAgentsSkillsSymlink: vi.fn(async () => undefined),
}));

vi.mock('node:child_process', () => ({
  spawnSync: mocked.spawnSync,
}));

vi.mock('../core/skills-scaffold.js', () => ({
  ensureAgentsSkillsSymlink: mocked.ensureAgentsSkillsSymlink,
}));

describe('worktree session .beads handling (no symlink; skip-worktree only)', () => {
  let tempRoot = '';
  let previousCwd = '';

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-worktree-beads-'));
    previousCwd = process.cwd();
    mocked.spawnSync.mockReset();
    mocked.ensureAgentsSkillsSymlink.mockReset();
    mocked.ensureAgentsSkillsSymlink.mockResolvedValue(undefined);
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

  it('rejects a non-discoverable Claude skill before creating a worktree', async () => {
    const repoRoot = path.join(tempRoot, 'repo');
    const externalSkill = path.join(tempRoot, 'external', 'hidden-skill');
    const previousHome = process.env.HOME;
    process.env.HOME = path.join(tempRoot, 'home');
    await fs.ensureDir(repoRoot);
    await fs.ensureDir(externalSkill);
    await fs.writeFile(path.join(externalSkill, 'SKILL.md'), '# hidden');
    process.chdir(repoRoot);

    mocked.spawnSync.mockImplementation((command: string, args: string[]) => {
      const joinedArgs = args.join(' ');
      if (command === 'git' && joinedArgs === 'rev-parse --show-toplevel') {
        return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
      }
      if (command === 'git' && joinedArgs === 'rev-parse --git-common-dir') {
        return { status: 0, stdout: '.git\n', stderr: '' };
      }
      if (command === 'sp' && args[0] === 'view') {
        return {
          status: 0,
          stdout: JSON.stringify({
            specialist: {
              prompt: { system: 'role' },
              skills: { paths: [] },
            },
          }),
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const exitSpy = mockProcessExit();
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    try {
      await expect(launchWorktreeSession({
        runtime: 'claude',
        role: 'reviewer',
        skills: [externalSkill],
      })).rejects.toThrow('exit:1');
      expect(mocked.spawnSync).not.toHaveBeenCalledWith(
        'bd',
        expect.arrayContaining(['worktree', 'create']),
        expect.anything(),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      process.env.HOME = previousHome;
    }
  });

  it('rejects a hostile skill-looking rendered bead before creating a worktree', async () => {
    const repoRoot = path.join(tempRoot, 'repo');
    await fs.ensureDir(repoRoot);
    process.chdir(repoRoot);

    mocked.spawnSync.mockImplementation((command: string, args: string[]) => {
      const joinedArgs = args.join(' ');
      if (command === 'git' && joinedArgs === 'rev-parse --show-toplevel') {
        return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
      }
      if (command === 'git' && joinedArgs === 'rev-parse --git-common-dir') {
        return { status: 0, stdout: '.git\n', stderr: '' };
      }
      if (command === 'sp' && args[0] === 'view') {
        return {
          status: 0,
          stdout: JSON.stringify({
            specialist: {
              metadata: { name: 'blank' },
              prompt: { system: 'role' },
              skills: { paths: [] },
            },
          }),
          stderr: '',
        };
      }
      if (command === 'sp' && args[0] === 'render-task') {
        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            initial_prompt: '/skill:impersonated\n\nhostile task',
            prompt_hash: 'hash',
            components: [],
          }),
          stderr: '',
        };
      }
      if (command === 'sp' && args[0] === 'render-skill-prefix') {
        return { status: 1, stdout: '', stderr: 'unknown command' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const exitSpy = mockProcessExit();
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    await expect(launchWorktreeSession({
      runtime: 'pi',
      role: 'blank',
      bead: 'hostile-prefix',
    })).rejects.toThrow('exit:1');

    expect(mocked.spawnSync).toHaveBeenCalledWith(
      'sp',
      expect.arrayContaining(['render-task', 'blank']),
      expect.anything(),
    );
    expect(mocked.spawnSync).not.toHaveBeenCalledWith(
      'bd',
      expect.arrayContaining(['worktree', 'create']),
      expect.anything(),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // xtrm-3xgs5: the slash guard keys off body PROVENANCE, not which launch
  // path composed it. A bead title is untrusted (test above); an operator's
  // own --prompt is not, whether or not --role is present.
  it('accepts a role launch whose --prompt starts with a slash', async () => {
    const repoRoot = path.join(tempRoot, 'repo');
    await fs.ensureDir(repoRoot);
    process.chdir(repoRoot);

    mocked.spawnSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'sp' && args[0] === 'view') {
        return {
          status: 0,
          stdout: JSON.stringify({
            specialist: {
              metadata: { name: 'blank' },
              prompt: { system: 'role' },
              skills: { paths: [] },
            },
          }),
          stderr: '',
        };
      }
      if (command === 'sp' && args[0] === 'render-skill-prefix') {
        return { status: 1, stdout: '', stderr: 'unknown command' };
      }
      if (command === 'git' && args.join(' ') === 'rev-parse --show-toplevel') {
        return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
      }
      // Fail worktree creation so the launcher exits right after composition.
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        return { status: 1, stdout: '', stderr: 'mock-worktree-add-fail' };
      }
      if (command === 'bd' && args[0] === 'worktree' && args[1] === 'create') {
        return { status: 1, stdout: '', stderr: 'no beads db' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockProcessExit();
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    await expect(launchWorktreeSession({
      runtime: 'pi',
      role: 'blank',
      prompt: '/skill:multiplexing take bead X and do Y',
    })).rejects.toThrow(/exit:/);

    const errorOutput = errorSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');
    expect(errorOutput).not.toMatch(/starts with '\/'/);
    expect(errorOutput).not.toMatch(/would parse untrusted text as a slash-command/);
  });

  it('launches a detached general Pi session with prompt and overrides', async () => {
    const repoRoot = path.join(tempRoot, 'repo');
    const worktreePath = path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-pi-general');
    await fs.ensureDir(path.join(repoRoot, '.beads'));
    process.chdir(repoRoot);

    let newSessionArgs: string[] = [];
    let usedBufferedTransport = false;
    mocked.spawnSync.mockImplementation((command: string, args: string[]) => {
      const joinedArgs = args.join(' ');
      if (command === 'git' && joinedArgs === 'rev-parse --show-toplevel') {
        return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
      }
      if (command === 'git' && joinedArgs === 'rev-parse --git-common-dir') {
        return { status: 0, stdout: '.git\n', stderr: '' };
      }
      if (command === 'bd' && args[0] === 'worktree' && args[1] === 'create') {
        fs.ensureDirSync(worktreePath);
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'has-session') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'new-session') {
        newSessionArgs = args;
      }
      if (command === 'tmux' && (args[0] === 'load-buffer' || args[0] === 'wait-for')) {
        usedBufferedTransport = true;
      }
      if (command === 'tmux' && args[0] === 'list-panes') {
        return { status: 0, stdout: '%42\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const exitSpy = mockProcessExit();
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    await expect(launchWorktreeSession({
      runtime: 'pi',
      name: 'general',
      prompt: 'echo hi',
      model: 'openai-codex/gpt-5.6-luna',
      thinking: 'high',
      attach: false,
    })).rejects.toThrow('exit:0');

    // Bare launches hand tmux the runtime command line directly — no buffer,
    // no consumer wrapper, no wait-for sync-points. xtrm-3xgs5.
    expect(usedBufferedTransport).toBe(false);
    expect(newSessionArgs[newSessionArgs.length - 1]).toBe(
      "'pi' '--name' 'repo-xt-pi-general' '--model' 'openai-codex/gpt-5.6-luna' '--thinking' 'high' 'echo hi'",
    );
    expect(mocked.spawnSync).not.toHaveBeenCalledWith('sp', expect.anything(), expect.anything());
    expect(mocked.spawnSync).toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['new-session', '-s', 'pi-general']),
      expect.anything(),
    );
    expect(mocked.spawnSync).toHaveBeenCalledWith(
      'tmux',
      ['set-option', '-p', '-t', '%42', '@agent_task', 'session:general'],
      expect.anything(),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('reports metadata failure and sanitizes an unsafe runtime version in the structured outcome', async () => {
    const repoRoot = path.join(tempRoot, 'repo');
    const worktreePath = path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-pi-json');
    await fs.ensureDir(path.join(repoRoot, '.beads'));
    process.chdir(repoRoot);

    mocked.spawnSync.mockImplementation((command: string, args: string[]) => {
      const joinedArgs = args.join(' ');
      if (command === 'sh' && args[0] === '-c') {
        return { status: 0, stdout: 'bin/pi\n', stderr: '' };
      }
      if (command === 'git' && joinedArgs === 'rev-parse --show-toplevel') {
        return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
      }
      if (command === 'git' && joinedArgs === 'rev-parse --git-common-dir') {
        return { status: 0, stdout: '.git\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        // Git-first path (CORE-2307): `git worktree add` is the primary
        // creator. Mirror the bd fallback's side effects, including the
        // session-meta.json directory that forces writeSessionMeta to fail.
        fs.ensureDirSync(worktreePath);
        fs.ensureDirSync(path.join(worktreePath, '.xtrm', 'session-meta.json'));
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'bd' && args[0] === 'worktree' && args[1] === 'create') {
        fs.ensureDirSync(worktreePath);
        fs.ensureDirSync(path.join(worktreePath, '.xtrm', 'session-meta.json'));
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'has-session') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'list-panes') {
        return { status: 0, stdout: '%42\n', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'list-sessions') {
        return { status: 0, stdout: 'pi-json\t$7\n', stderr: '' };
      }
      if (command === path.join(repoRoot, 'bin', 'pi') && args[0] === '--version') {
        return { status: 0, stdout: 'pi 0.74.2\u001b[31m\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = mockProcessExit();
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    await expect(launchWorktreeSession({
      runtime: 'pi',
      name: 'json',
      prompt: 'echo hi',
      attach: false,
      json: true,
    })).rejects.toThrow('exit:0');

    expect(logSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const outcome = JSON.parse(String(stdoutSpy.mock.calls[0][0]));
    expect(outcome).toMatchObject({
      schema_version: 'xtrm.command-outcome.v1',
      runtime: { name: 'pi', version: null },
      identity: { session_name: 'pi-json', tmux_session_id: '$7', pane_id: '%42' },
      worktree: { path: worktreePath, branch: 'xt/json', owner: 'core' },
      readiness: { status: 'unverified', source: 'tmux-pane' },
      persistence: { completed: false, kind: 'worktree.session-metadata' },
    });
    expect(outcome.next_actions.some((next: { kind: string }) => next.kind === 'resume')).toBe(false);
    expect(mocked.spawnSync).toHaveBeenCalledWith(
      path.join(repoRoot, 'bin', 'pi'),
      ['--version'],
      expect.objectContaining({ cwd: worktreePath, stdio: 'pipe' }),
    );
    expect(mocked.spawnSync.mock.calls.some(([command, args]) =>
      command === 'tmux'
      && args[0] === 'new-session'
      && args.at(-1) === `'${path.join(repoRoot, 'bin', 'pi')}' '--name' 'repo-xt-pi-json' 'echo hi'`
    )).toBe(true);
    expect(mocked.spawnSync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['worktree', 'add']),
      expect.objectContaining({ cwd: repoRoot }),
    );
    expect(mocked.spawnSync).not.toHaveBeenCalledWith(
      'bd',
      ['worktree', 'create', worktreePath, '--branch', 'xt/json'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('rejects an oversized structured slug before creating a worktree or tmux session', async () => {
    const repoRoot = path.join(tempRoot, 'repo');
    await fs.ensureDir(path.join(repoRoot, '.beads'));
    process.chdir(repoRoot);

    mocked.spawnSync.mockImplementation((command: string, args: string[]) => {
      const joinedArgs = args.join(' ');
      if (command === 'git' && joinedArgs === 'rev-parse --show-toplevel') {
        return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
      }
      if (command === 'git' && joinedArgs === 'rev-parse --git-common-dir') {
        return { status: 0, stdout: '.git\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockProcessExit();
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    await expect(launchWorktreeSession({
      runtime: 'pi',
      name: `group/${'a'.repeat(251)}`,
      prompt: 'echo hi',
      attach: false,
      json: true,
    })).rejects.toThrow('exit:1');

    expect(errorSpy.mock.calls.flat().join(' ')).toContain('invalid sessionSlug');
    expect(mocked.spawnSync).not.toHaveBeenCalledWith(
      'bd',
      expect.arrayContaining(['worktree', 'create']),
      expect.anything(),
    );
    expect(mocked.spawnSync).not.toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['new-session']),
      expect.anything(),
    );
  });

  it('rejects a detached structured role in the current tmux pane before creating a worktree', async () => {
    const repoRoot = path.join(tempRoot, 'repo');
    await fs.ensureDir(path.join(repoRoot, '.beads'));
    process.chdir(repoRoot);
    const previousTmux = process.env.TMUX;
    process.env.TMUX = '/tmp/tmux-1000/default,1,0';

    mocked.spawnSync.mockImplementation((command: string, args: string[]) => {
      const joinedArgs = args.join(' ');
      if (command === 'git' && joinedArgs === 'rev-parse --show-toplevel') {
        return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
      }
      if (command === 'git' && joinedArgs === 'rev-parse --git-common-dir') {
        return { status: 0, stdout: '.git\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockProcessExit();
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    try {
      await expect(launchWorktreeSession({
        runtime: 'pi',
        name: 'role-detached',
        role: 'reviewer',
        attach: false,
        json: true,
      })).rejects.toThrow('exit:1');
    } finally {
      if (previousTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = previousTmux;
    }

    expect(errorSpy.mock.calls.flat().join(' ')).toContain('--no-attach requires --new-session');
    expect(mocked.spawnSync).not.toHaveBeenCalledWith(
      'bd',
      expect.arrayContaining(['worktree', 'create']),
      expect.anything(),
    );
    expect(mocked.spawnSync).not.toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['new-session']),
      expect.anything(),
    );
  });

  it('rejects a structured worktree path with control characters before launch mutations', async () => {
    const repoRoot = path.join(tempRoot, 'repo\nhostile');
    await fs.ensureDir(path.join(repoRoot, '.beads'));
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
        fs.ensureDirSync(args[2]);
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'has-session') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'list-panes') {
        return { status: 0, stdout: '%42\n', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'list-sessions') {
        return { status: 0, stdout: 'pi-missingmeta\t$7\n', stderr: '' };
      }
      if (command === 'pi' && args[0] === '--version') {
        return { status: 0, stdout: 'pi 0.74.2\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockProcessExit();
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    await expect(launchWorktreeSession({
      runtime: 'pi',
      name: 'control-path',
      prompt: 'echo hi',
      attach: false,
      json: true,
    })).rejects.toThrow('exit:1');

    expect(errorSpy.mock.calls.flat().join(' ')).toContain('invalid worktreePath');
    expect(mocked.spawnSync).not.toHaveBeenCalledWith(
      'bd',
      expect.arrayContaining(['worktree', 'create']),
      expect.anything(),
    );
    expect(mocked.spawnSync).not.toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['new-session']),
      expect.anything(),
    );
  });

  it('transports a 100KB rendered bead through a tmux buffer without putting it in the new-session command', async () => {
    const repoRoot = path.join(tempRoot, 'repo');
    const worktreePath = path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-claude-large');
    const body = `Rendered reviewer task\n\n${'B'.repeat(100 * 1024)}`;
    await fs.ensureDir(path.join(repoRoot, '.beads'));
    process.chdir(repoRoot);

    let bufferedPayload = '';
    let newSessionCommand = '';
    mocked.spawnSync.mockImplementation((command: string, args: string[], options?: { input?: string }) => {
      const joinedArgs = args.join(' ');
      if (command === 'sp' && args[0] === 'view') {
        return {
          status: 0,
          stdout: JSON.stringify({
            specialist: {
              metadata: { name: 'reviewer' },
              prompt: { system: 'role' },
              skills: { paths: [] },
            },
          }),
          stderr: '',
        };
      }
      if (command === 'sp' && args[0] === 'render-task') {
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, initial_prompt: body, prompt_hash: 'hash', components: [] }),
          stderr: '',
        };
      }
      if (command === 'sp' && args[0] === 'render-skill-prefix') {
        return args[1] === '--help'
          ? { status: 0, stdout: 'usage', stderr: '' }
          : { status: 0, stdout: JSON.stringify({ ok: true, skill_prefix: '' }), stderr: '' };
      }
      if (command === 'git' && joinedArgs === 'rev-parse --show-toplevel') {
        return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
      }
      if (command === 'git' && joinedArgs === 'rev-parse --git-common-dir') {
        return { status: 0, stdout: '.git\n', stderr: '' };
      }
      if (command === 'bd' && args[0] === 'worktree' && args[1] === 'create') {
        fs.ensureDirSync(worktreePath);
        fs.ensureDirSync(path.join(worktreePath, '.git'));
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'has-session') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'new-session') {
        newSessionCommand = args.at(-1) ?? '';
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'load-buffer') {
        bufferedPayload = options?.input ?? '';
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'list-panes') {
        return { status: 0, stdout: '%42\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const exitSpy = mockProcessExit();
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    await expect(launchWorktreeSession({
      runtime: 'claude',
      role: 'reviewer',
      bead: 'large-bead',
      name: 'large',
      newSession: true,
      attach: false,
    })).rejects.toThrow('exit:0');

    expect(newSessionCommand).not.toContain(body);
    expect(newSessionCommand.length).toBeLessThan(4096);
    expect(JSON.parse(bufferedPayload).runtimeArgs.at(-1)).toBe(body);

    const tmuxCalls = mocked.spawnSync.mock.calls.filter(([command]) => command === 'tmux');
    const loadIndex = tmuxCalls.findIndex(([, args]) => args[0] === 'load-buffer');
    const runtimeBuffer = tmuxCalls[loadIndex][1][2];
    const readyIndex = tmuxCalls.findIndex(([, args]) =>
      args[0] === 'wait-for' && args[1] === `${runtimeBuffer}-consumer-ready`);
    const signalIndex = tmuxCalls.findIndex(([, args]) =>
      args[0] === 'wait-for' && args[1] === '-S' && args[2] === `${runtimeBuffer}-ready`);
    expect(readyIndex).toBeGreaterThan(-1);
    expect(readyIndex).toBeLessThan(loadIndex);
    expect(loadIndex).toBeLessThan(signalIndex);
    expect(tmuxCalls[readyIndex][2]).toEqual(expect.objectContaining({ timeout: 5000 }));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('bounds consumer readiness and cleans up the blocked session on timeout', async () => {
    const repoRoot = path.join(tempRoot, 'repo');
    const worktreePath = path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-pi-readytimeout');
    await fs.ensureDir(path.join(repoRoot, '.beads'));
    process.chdir(repoRoot);

    mocked.spawnSync.mockImplementation((command: string, args: string[]) => {
      const joinedArgs = args.join(' ');
      if (command === 'sp' && args[0] === 'view') {
        return {
          status: 0,
          stdout: JSON.stringify({
            specialist: {
              metadata: { name: 'blank' },
              prompt: { system: 'role' },
              skills: { paths: [] },
            },
          }),
          stderr: '',
        };
      }
      if (command === 'sp' && args[0] === 'render-skill-prefix') {
        return args[1] === '--help'
          ? { status: 0, stdout: 'usage', stderr: '' }
          : { status: 0, stdout: JSON.stringify({ ok: true, skill_prefix: '' }), stderr: '' };
      }
      if (command === 'git' && joinedArgs === 'rev-parse --show-toplevel') {
        return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
      }
      if (command === 'git' && joinedArgs === 'rev-parse --git-common-dir') {
        return { status: 0, stdout: '.git\n', stderr: '' };
      }
      if (command === 'bd' && args[0] === 'worktree' && args[1] === 'create') {
        fs.ensureDirSync(worktreePath);
        fs.ensureDirSync(path.join(worktreePath, '.git'));
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'has-session') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'wait-for' && args[1]?.endsWith('-consumer-ready')) {
        return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const exitSpy = mockProcessExit();
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    await expect(launchWorktreeSession({
      runtime: 'pi',
      role: 'blank',
      name: 'readytimeout',
      newSession: true,
      attach: false,
    })).rejects.toThrow('exit:1');

    expect(mocked.spawnSync).not.toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['load-buffer']),
      expect.anything(),
    );
    expect(mocked.spawnSync).toHaveBeenCalledWith(
      'tmux',
      ['delete-buffer', '-b', expect.stringMatching(/^xtrm-role-[0-9a-f]{32}$/)],
      { stdio: 'ignore' },
    );
    expect(mocked.spawnSync).toHaveBeenCalledWith(
      'tmux',
      ['kill-session', '-t', 'role-pi-blank'],
      { stdio: 'ignore' },
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it.each(['launch', 'load', 'signal'] as const)(
    'deletes the transient buffer when %s fails',
    async (failure) => {
    const repoRoot = path.join(tempRoot, 'repo');
    const name = `${failure}fail`;
    const worktreePath = path.join(repoRoot, '.xtrm', 'worktrees', `repo-xt-pi-${name}`);
    await fs.ensureDir(path.join(repoRoot, '.beads'));
    process.chdir(repoRoot);

    mocked.spawnSync.mockImplementation((command: string, args: string[]) => {
      const joinedArgs = args.join(' ');
      if (command === 'sp' && args[0] === 'view') {
        return {
          status: 0,
          stdout: JSON.stringify({
            specialist: {
              metadata: { name: 'blank' },
              prompt: { system: 'role' },
              skills: { paths: [] },
            },
          }),
          stderr: '',
        };
      }
      if (command === 'sp' && args[0] === 'render-skill-prefix') {
        return args[1] === '--help'
          ? { status: 0, stdout: 'usage', stderr: '' }
          : { status: 0, stdout: JSON.stringify({ ok: true, skill_prefix: '' }), stderr: '' };
      }
      if (command === 'git' && joinedArgs === 'rev-parse --show-toplevel') {
        return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
      }
      if (command === 'git' && joinedArgs === 'rev-parse --git-common-dir') {
        return { status: 0, stdout: '.git\n', stderr: '' };
      }
      if (command === 'bd' && args[0] === 'worktree' && args[1] === 'create') {
        fs.ensureDirSync(worktreePath);
        fs.ensureDirSync(path.join(worktreePath, '.git'));
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'has-session') {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (command === 'tmux' && args[0] === 'new-session' && failure === 'launch') {
        return { status: 1, stdout: '', stderr: 'launch failed' };
      }
      if (command === 'tmux' && args[0] === 'load-buffer' && failure === 'load') {
        return { status: 1, stdout: '', stderr: 'load failed' };
      }
      if (command === 'tmux' && args[0] === 'wait-for' && args[1] === '-S' && failure === 'signal') {
        return { status: 1, stdout: '', stderr: 'signal failed' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const exitSpy = mockProcessExit();
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    await expect(launchWorktreeSession({
      runtime: 'pi',
      role: 'blank',
      name,
      newSession: true,
      attach: false,
    })).rejects.toThrow('exit:1');

    expect(mocked.spawnSync).toHaveBeenCalledWith(
      'tmux',
      ['delete-buffer', '-b', expect.stringMatching(/^xtrm-role-[0-9a-f]{32}$/)],
      { stdio: 'ignore' },
    );
    if (failure !== 'launch') {
      expect(mocked.spawnSync).toHaveBeenCalledWith(
        'tmux',
        ['kill-session', '-t', 'role-pi-blank'],
        { stdio: 'ignore' },
      );
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

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

  it('marks tracked .specialists/{default,user} paths skip-worktree on claude worktree (xtrm-6jd2)', async () => {
    const repoRoot = path.join(tempRoot, 'repo');
    const worktreePath = path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-claude-spec1');
    const gitDir = path.join(worktreePath, '.git');

    await fs.ensureDir(repoRoot);
    await fs.ensureDir(path.join(repoRoot, '.beads'));
    await fs.ensureDir(path.join(repoRoot, '.specialists', 'default'));
    await fs.ensureDir(path.join(repoRoot, '.specialists', 'user'));
    await fs.writeFile(path.join(repoRoot, '.specialists', 'user', 'a.specialist.json'), '{}');
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
        fs.ensureDirSync(worktreePath);
        fs.ensureDirSync(gitDir);
        // Simulate bd's checkout of tracked .beads/* and .specialists/user/*.
        fs.ensureDirSync(path.join(worktreePath, '.beads'));
        fs.writeFileSync(path.join(worktreePath, '.beads', 'issues.jsonl'), '');
        fs.ensureDirSync(path.join(worktreePath, '.specialists', 'user'));
        fs.writeFileSync(path.join(worktreePath, '.specialists', 'user', 'a.specialist.json'), '{}');
        return { status: 0, stdout: '', stderr: '' };
      }

      if (command === 'git' && joinedArgs === `-C ${worktreePath} ls-files -- .beads`) {
        return { status: 0, stdout: '.beads/issues.jsonl\n', stderr: '' };
      }

      if (command === 'git' && joinedArgs === `-C ${worktreePath} ls-files -- .specialists/default`) {
        return { status: 0, stdout: '', stderr: '' };
      }

      if (command === 'git' && joinedArgs === `-C ${worktreePath} ls-files -- .specialists/user`) {
        return { status: 0, stdout: '.specialists/user/a.specialist.json\n', stderr: '' };
      }

      // ensureAgentsSkillsSymlink + claude CLI launch — return success.
      return { status: 0, stdout: '', stderr: '' };
    });

    const exitSpy = mockProcessExit();
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    await expect(launchWorktreeSession({ runtime: 'claude', name: 'spec1' })).rejects.toThrow('exit:0');

    // .specialists/user must be skip-worktree'd (matches the tracked .json file).
    expect(mocked.spawnSync).toHaveBeenCalledWith(
      'git',
      ['-C', worktreePath, 'update-index', '--skip-worktree', '--', '.specialists/user/a.specialist.json'],
      expect.objectContaining({ cwd: worktreePath }),
    );

    // .specialists/default has no tracked files in this test — verify the
    // ls-files probe still happened so the contract is consistent.
    expect(mocked.spawnSync).toHaveBeenCalledWith(
      'git',
      ['-C', worktreePath, 'ls-files', '--', '.specialists/default'],
      expect.objectContaining({ cwd: worktreePath }),
    );

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('with XTRM_GLOBAL_SKILLS=1 verifies global pointer and skips project skills rebuild when worktree has no user packs', async () => {
    const repoRoot = path.join(tempRoot, 'repo');
    const worktreePath = path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-claude-global1');
    const gitDir = path.join(worktreePath, '.git');
    const previousHome = process.env.HOME;
    const previousFlag = process.env.XTRM_GLOBAL_SKILLS;

    process.env.HOME = tempRoot;
    process.env.XTRM_GLOBAL_SKILLS = '1';

    await fs.ensureDir(repoRoot);
    await fs.ensureDir(path.join(repoRoot, '.beads'));
    await fs.ensureDir(path.join(repoRoot, '.xtrm', 'worktrees'));
    await fs.ensureDir(path.join(tempRoot, '.xtrm', 'skills', 'active'));
    await fs.ensureDir(path.join(tempRoot, '.claude'));
    await fs.symlink(path.join(tempRoot, '.xtrm', 'skills', 'active'), path.join(tempRoot, '.claude', 'skills'));
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
        fs.ensureDirSync(worktreePath);
        fs.ensureDirSync(gitDir);
        fs.ensureDirSync(path.join(worktreePath, '.beads'));
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command === 'git' && joinedArgs === `-C ${worktreePath} ls-files -- .beads`) {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const exitSpy = mockProcessExit();
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    try {
      await expect(launchWorktreeSession({ runtime: 'claude', name: 'global1' })).rejects.toThrow('exit:0');
      expect(mocked.ensureAgentsSkillsSymlink).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      process.env.HOME = previousHome;
      process.env.XTRM_GLOBAL_SKILLS = previousFlag;
    }
  });
});

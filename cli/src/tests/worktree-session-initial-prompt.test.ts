import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CORE-2454: xt pi launches with an initial prompt (--prompt, or --bead with
// --role) export XTRM_INITIAL_PROMPT=1 to the Pi process; launches without an
// initial prompt do not. Covers both sides plus the claude-runtime negative.

const mocked = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock('node:child_process', () => ({ spawnSync: mocked.spawnSync }));

vi.mock('../core/skills-scaffold.js', () => ({
  ensureAgentsSkillsSymlink: vi.fn(async () => undefined),
}));

const ROLE_SPEC = JSON.stringify({
  specialist: {
    metadata: { name: 'testrole', version: '1.0.0', category: 'testing', description: 'd' },
    execution: { mode: 'tool' },
    prompt: { system: 'You are the test role.' },
    skills: { paths: [] },
  },
});

interface Harness {
  repoRoot: string;
  newSessionArgs: string[] | null;
}

function installMock(h: Harness): void {
  const { repoRoot } = h;
  mocked.spawnSync.mockImplementation((command: string, args: string[] = []) => {
    const joined = args.join(' ');
    if (command === 'git' && joined === 'rev-parse --show-toplevel') return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
    if (command === 'git' && joined === 'rev-parse --git-common-dir') return { status: 0, stdout: '.git\n', stderr: '' };
    if (command === 'git' && args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'symbolic-ref') return { status: 0, stdout: 'origin/main\n', stderr: '' };
    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === '--quiet' && (args[3] ?? '').startsWith('origin/')) return { status: 0, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'rev-parse') return { status: 1, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'config') return { status: 1, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'ls-files') return { status: 0, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
      const wtPath = args.find((a) => a.startsWith(repoRoot));
      if (wtPath) fs.ensureDirSync(wtPath);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'bd') return { status: 1, stdout: '', stderr: 'no bd' };
    if (command === 'sp' && args[0] === 'view') return { status: 0, stdout: ROLE_SPEC, stderr: '' };
    if (command === 'sp' && args[0] === 'render-skill-prefix' && args[1] === '--help') return { status: 0, stdout: '', stderr: '' };
    if (command === 'sp' && args[0] === 'render-skill-prefix') {
      return { status: 0, stdout: JSON.stringify({ ok: true, skill_prefix: '' }), stderr: '' };
    }
    if (command === 'sp' && args[0] === 'render-task') {
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, initial_prompt: 'do the bead task', prompt_hash: 'h', components: [] }),
        stderr: '',
      };
    }
    if (command === 'tmux' && args[0] === 'has-session') return { status: 1, stdout: '', stderr: '' };
    if (command === 'tmux' && args[0] === 'new-session') {
      h.newSessionArgs = [...args];
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'tmux' && args[0] === 'display-message') return { status: 1, stdout: '', stderr: 'no session' };
    if (command === 'tmux' && args[0] === 'list-panes') return { status: 0, stdout: '%17\n', stderr: '' };
    if (command === 'tmux') return { status: 0, stdout: '', stderr: '' };
    if ((command === 'pi' || command === 'claude') && Array.isArray(args)) {
      return { status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null };
    }
    return { status: 0, stdout: '', stderr: '' };
  });
}

function envPairs(args: string[] | null): Record<string, string> {
  const out: Record<string, string> = {};
  const list = args ?? [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '-e' && i + 1 < list.length) {
      const eq = list[i + 1].indexOf('=');
      out[list[i + 1].slice(0, eq)] = list[i + 1].slice(eq + 1);
    }
  }
  return out;
}

describe('xt pi XTRM_INITIAL_PROMPT launch env (CORE-2454)', () => {
  let tempRoot = '';
  let repoRoot = '';
  let homeRoot = '';
  let previousCwd = '';
  let previousHome: string | undefined;
  let previousTmux: string | undefined;
  let previousCompat: string | undefined;
  let h: Harness;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-initial-prompt-'));
    repoRoot = path.join(tempRoot, 'repo');
    homeRoot = path.join(tempRoot, 'home');
    await fs.ensureDir(repoRoot);
    await fs.ensureDir(homeRoot);
    previousCwd = process.cwd();
    previousHome = process.env.HOME;
    previousTmux = process.env.TMUX;
    previousCompat = process.env.XTRM_SKIP_RUNTIME_COMPAT;
    process.env.HOME = homeRoot;
    process.env.XTRM_SKIP_RUNTIME_COMPAT = '1';
    delete process.env.TMUX;
    process.chdir(repoRoot);
    mocked.spawnSync.mockReset();
    vi.resetModules();
    h = { repoRoot, newSessionArgs: null };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true as never);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
    if (previousCompat === undefined) delete process.env.XTRM_SKIP_RUNTIME_COMPAT;
    else process.env.XTRM_SKIP_RUNTIME_COMPAT = previousCompat;
    await fs.remove(tempRoot);
    vi.restoreAllMocks();
  });

  it('unit: --prompt and --bead-with---role count as an initial prompt', async () => {
    const { hasInitialPromptForLaunch, piInitialPromptEnv } = await import('../utils/worktree-session.js');
    expect(hasInitialPromptForLaunch({ prompt: 'hi' })).toBe(true);
    expect(hasInitialPromptForLaunch({ role: 'testrole', bead: 'X-1' })).toBe(true);
    expect(hasInitialPromptForLaunch({})).toBe(false);
    expect(hasInitialPromptForLaunch({ bead: 'X-1' })).toBe(false);
    expect(hasInitialPromptForLaunch({ role: 'testrole' })).toBe(false);
    expect(piInitialPromptEnv('pi', true)).toEqual({ XTRM_INITIAL_PROMPT: '1' });
    expect(piInitialPromptEnv('pi', false)).toEqual({ XTRM_INITIAL_PROMPT: '0' });
    expect(piInitialPromptEnv('claude', true)).toEqual({});
  });

  it('bare pi with --prompt exports XTRM_INITIAL_PROMPT=1 to the new session', async () => {
    installMock(h);
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');
    await expect(
      launchWorktreeSession({ runtime: 'pi', name: 'ip1', prompt: 'hello', attach: false }),
    ).rejects.toThrow('exit:0');
    expect(envPairs(h.newSessionArgs)['XTRM_INITIAL_PROMPT']).toBe('1');
  });

  it('bare pi without a prompt exports XTRM_INITIAL_PROMPT=0', async () => {
    installMock(h);
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');
    await expect(
      launchWorktreeSession({ runtime: 'pi', name: 'ip2', attach: false }),
    ).rejects.toThrow('exit:0');
    expect(envPairs(h.newSessionArgs)).toHaveProperty('XTRM_INITIAL_PROMPT', '0');
  });

  it('role pi with --bead exports XTRM_INITIAL_PROMPT=1', async () => {
    installMock(h);
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');
    await expect(
      launchWorktreeSession({ runtime: 'pi', name: 'ip3', role: 'testrole', bead: 'X-1', attach: false }),
    ).rejects.toThrow('exit:0');
    expect(envPairs(h.newSessionArgs)['XTRM_INITIAL_PROMPT']).toBe('1');
  });

  it('role pi without prompt or bead exports XTRM_INITIAL_PROMPT=0', async () => {
    installMock(h);
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');
    await expect(
      launchWorktreeSession({ runtime: 'pi', name: 'ip4', role: 'testrole', attach: false }),
    ).rejects.toThrow('exit:0');
    expect(envPairs(h.newSessionArgs)).toHaveProperty('XTRM_INITIAL_PROMPT', '0');
  });

  it('claude with --prompt never exports XTRM_INITIAL_PROMPT (Pi-only signal)', async () => {
    installMock(h);
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');
    await expect(
      launchWorktreeSession({ runtime: 'claude', name: 'ip5', prompt: 'hello', attach: false }),
    ).rejects.toThrow('exit:0');
    expect(envPairs(h.newSessionArgs)).not.toHaveProperty('XTRM_INITIAL_PROMPT');
  });
});

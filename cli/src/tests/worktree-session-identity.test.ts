import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Launcher-boundary propagation proof (XTRM-252.4 R4): the SAME session
// identity the launcher holds crosses every process boundary (spawn env,
// `tmux new-session -e`, `tmux set-environment`, role payload) and unknown
// values stay absent instead of being fabricated. Real launchWorktreeSession
// with a hermetic mocked spawnSync surface; no real tmux/git/worktree moves.

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
  setEnvCalls: string[][];
  loadedPayload: Record<string, unknown> | null;
  piSpawnEnv: Record<string, string> | null;
}

function installMock(h: Harness, opts: { sessionIdAnswer?: string | null } = {}): void {
  const { repoRoot } = h;
  const answer = opts.sessionIdAnswer === undefined ? '$7' : opts.sessionIdAnswer;
  mocked.spawnSync.mockImplementation((command: string, args: string[] = [], mo: Record<string, unknown> = {}) => {
    const joined = args.join(' ');
    if (command === 'git' && joined === 'rev-parse --show-toplevel') return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
    if (command === 'git' && joined === 'rev-parse --git-common-dir') return { status: 0, stdout: '.git\n', stderr: '' };
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
    if (command === 'sp' && args[0] === 'render-skill-prefix' && args[1] === '--help') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'sp' && args[0] === 'render-skill-prefix') {
      return { status: 0, stdout: JSON.stringify({ ok: true, skill_prefix: '' }), stderr: '' };
    }
    if (command === 'tmux' && args[0] === 'has-session') return { status: 1, stdout: '', stderr: '' };
    if (command === 'tmux' && args[0] === 'new-session') {
      h.newSessionArgs = [...args];
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'tmux' && args[0] === 'display-message') {
      if (joined.includes('#{pane_id}')) return { status: 0, stdout: '%9\n', stderr: '' };
      if (args.includes('-t')) {
        return answer === null
          ? { status: 1, stdout: '', stderr: 'no session' }
          : { status: 0, stdout: `${answer}\n`, stderr: '' };
      }
      if (joined.includes('#{session_id}')) return { status: 0, stdout: '$3\n', stderr: '' };
      if (joined.includes('#{session_name}')) return { status: 0, stdout: 'cur-sess\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    }
    if (command === 'tmux' && args[0] === 'list-panes') return { status: 0, stdout: '%17\n', stderr: '' };
    if (command === 'tmux' && args[0] === 'set-environment') {
      h.setEnvCalls.push([...args]);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'tmux' && args[0] === 'load-buffer') {
      const input = (mo as { input?: string }).input;
      if (typeof input === 'string') {
        try { h.loadedPayload = JSON.parse(input) as Record<string, unknown>; } catch { h.loadedPayload = null; }
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'tmux') return { status: 0, stdout: '', stderr: '' };
    if ((command === 'pi' || command === 'claude') && Array.isArray(args)) {
      h.piSpawnEnv = { ...((mo as { env?: Record<string, string> }).env ?? {}) };
      return { status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null };
    }
    return { status: 0, stdout: '', stderr: '' };
  });
}

function sessionNameFromNewSession(args: string[] | null): string {
  expect(args).not.toBeNull();
  const idx = (args ?? []).indexOf('-s');
  expect(idx).toBeGreaterThanOrEqual(0);
  return (args ?? [])[idx + 1];
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

describe('xt/tmux launcher session-identity propagation', () => {
  let tempRoot = '';
  let repoRoot = '';
  let homeRoot = '';
  let previousCwd = '';
  let previousHome: string | undefined;
  let previousTmux: string | undefined;
  let previousCompat: string | undefined;
  let h: Harness;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-session-id-'));
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
    h = { repoRoot, newSessionArgs: null, setEnvCalls: [], loadedPayload: null, piSpawnEnv: null };
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

  it('bare pi launch carries the same name via -e and the same id via set-environment', async () => {
    installMock(h);
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    await expect(launchWorktreeSession({ runtime: 'pi', name: 'idem1', attach: false })).rejects.toThrow('exit:0');

    const sessionName = sessionNameFromNewSession(h.newSessionArgs);
    expect(sessionName).toBe('pi-idem1');
    // Name rides the spawn boundary (-e); id is server-assigned, published after.
    expect(envPairs(h.newSessionArgs)['XTRM_SESSION_NAME']).toBe(sessionName);
    expect(h.setEnvCalls).toContainEqual(['set-environment', '-t', sessionName, 'XTRM_SESSION_ID', '$7']);
    // Same values, no fabrication anywhere on the boundary.
    const eVars = h.newSessionArgs?.filter((a) => a.startsWith('XTRM_SESSION_')) ?? [];
    expect(eVars).not.toContain('XTRM_SESSION_ID=$7');
    expect(eVars).not.toContain('XTRM_SESSION_ID=');
  });

  it('bare claude launch propagates the same identity values', async () => {
    installMock(h);
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    await expect(launchWorktreeSession({ runtime: 'claude', name: 'idem2', attach: false })).rejects.toThrow('exit:0');

    const sessionName = sessionNameFromNewSession(h.newSessionArgs);
    expect(sessionName).toBe('claude-idem2');
    expect(envPairs(h.newSessionArgs)['XTRM_SESSION_NAME']).toBe(sessionName);
    expect(h.setEnvCalls).toContainEqual(['set-environment', '-t', sessionName, 'XTRM_SESSION_ID', '$7']);
  });

  it('specialist (role) launch delivers the same identity in the exec payload', async () => {
    installMock(h);
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    await expect(launchWorktreeSession({ runtime: 'pi', name: 'spec1', role: 'testrole', attach: false })).rejects.toThrow('exit:0');

    const sessionName = sessionNameFromNewSession(h.newSessionArgs);
    // The consumer execs the runtime after creation, so both values are present.
    expect(h.loadedPayload?.['sessionEnv']).toEqual({
      XTRM_SESSION_ID: '$7',
      XTRM_SESSION_NAME: sessionName,
    });
    // And the session environment carries the identical pair.
    expect(envPairs(h.newSessionArgs)['XTRM_SESSION_NAME']).toBe(sessionName);
    expect(h.setEnvCalls).toContainEqual(['set-environment', '-t', sessionName, 'XTRM_SESSION_ID', '$7']);
  });

  it('current-pane tmux launch puts both observed values in the runtime spawn env', async () => {
    process.env.TMUX = '/tmp/tmux-1000/default,9,0';
    installMock(h);
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    // A turn-1 body routes a bare launch into the tmux path; inside $TMUX
    // with attach that is current-pane mode — no tmux session is created.
    await expect(launchWorktreeSession({ runtime: 'pi', name: 'cur1', prompt: 'hi' })).rejects.toThrow('exit:0');

    expect(h.newSessionArgs).toBeNull();
    expect(h.piSpawnEnv?.['XTRM_SESSION_ID']).toBe('$3');
    expect(h.piSpawnEnv?.['XTRM_SESSION_NAME']).toBe('cur-sess');
  });

  it('direct plain-runtime launch carries the current session identity in env', async () => {
    process.env.TMUX = '/tmp/tmux-1000/default,9,0';
    installMock(h);
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    // No prompt/bead/override: the plain `pi --name` direct-spawn path.
    await expect(launchWorktreeSession({ runtime: 'pi', name: 'plain1' })).rejects.toThrow('exit:0');

    expect(h.newSessionArgs).toBeNull();
    expect(h.piSpawnEnv?.['XTRM_SESSION_ID']).toBe('$3');
    expect(h.piSpawnEnv?.['XTRM_SESSION_NAME']).toBe('cur-sess');
  });

  it('direct launch outside tmux fabricates no session identity', async () => {
    installMock(h);
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    await expect(launchWorktreeSession({ runtime: 'pi', name: 'plain2' })).rejects.toThrow('exit:0');

    expect(h.newSessionArgs).toBeNull();
    expect(h.piSpawnEnv).not.toBeNull();
    expect(h.piSpawnEnv?.['XTRM_SESSION_ID']).toBeUndefined();
    expect(h.piSpawnEnv?.['XTRM_SESSION_NAME']).toBeUndefined();
  });

  it('an unresolvable session id stays absent on every boundary (non-fabrication)', async () => {
    installMock(h, { sessionIdAnswer: null });
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');

    await expect(launchWorktreeSession({ runtime: 'pi', name: 'noid1', attach: false })).rejects.toThrow('exit:0');

    const sessionName = sessionNameFromNewSession(h.newSessionArgs);
    // Name still propagates; no id key is invented on any transport.
    expect(envPairs(h.newSessionArgs)['XTRM_SESSION_NAME']).toBe(sessionName);
    expect(h.setEnvCalls).toHaveLength(0);
    const flat = (h.newSessionArgs ?? []).join('\n');
    expect(flat).not.toContain('XTRM_SESSION_ID');
  });
});

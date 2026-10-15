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
  newWindowArgs?: string[] | null;
}

function installMock(h: Harness, opts: { sessionIdAnswer?: string | null } = {}): void {
  const { repoRoot } = h;
  const answer = opts.sessionIdAnswer === undefined ? '$7' : opts.sessionIdAnswer;
  mocked.spawnSync.mockImplementation((command: string, args: string[] = [], mo: Record<string, unknown> = {}) => {
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
    if (command === 'tmux' && args[0] === 'new-window') {
      h.newWindowArgs = [...args];
      return { status: 0, stdout: '%21\n', stderr: '' };
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
  let previousDispatchEnv: Record<string, string | undefined> = {};
  let h: Harness;
  const DISPATCH_KEYS = ['SUBSTRATE_HOLDER', 'XTRM_DISPATCHER_NAME', 'XTRM_DISPATCHER_ADDRESS', 'XTRM_PARENT_SESSION_ID', 'XTRM_PARENT_PANE_ID', 'TMUX_PANE'];

  // CORE-2390: the test worker's parent pid is a "Claude session" with a
  // socket, and the launching env carries a dispatcher's own holder.
  function armDispatcher(): void {
    const dir = path.join(homeRoot, '.claude', 'sessions');
    fs.ensureDirSync(dir);
    fs.writeJsonSync(path.join(dir, `${process.ppid}.json`), {
      pid: process.ppid, name: 'coord-1', messagingSocketPath: '/run/user/1000/cc-socks/77.sock',
    });
    process.env.SUBSTRATE_HOLDER = 'coord-1-self';
  }

  function expectDispatcher(env: Record<string, string> | null | undefined, holder: string): void {
    expect(env?.['SUBSTRATE_HOLDER']).toBe(holder);
    expect(env?.['XTRM_DISPATCHER_NAME']).toBe('coord-1');
    expect(env?.['XTRM_DISPATCHER_ADDRESS']).toBe('uds:/run/user/1000/cc-socks/77.sock');
  }

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
    previousDispatchEnv = Object.fromEntries(DISPATCH_KEYS.map((k) => [k, process.env[k]]));
    for (const k of DISPATCH_KEYS) delete process.env[k];
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
    for (const [k, v] of Object.entries(previousDispatchEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
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

  describe('dispatcher identity (CORE-2390)', () => {
    it('direct spawn carries dispatcher and overrides an inherited SUBSTRATE_HOLDER', async () => {
      armDispatcher();
      installMock(h);
      const { launchWorktreeSession } = await import('../utils/worktree-session.js');

      await expect(launchWorktreeSession({ runtime: 'claude', name: 'dwk1' })).rejects.toThrow('exit:0');

      expect(h.newSessionArgs).toBeNull();
      expectDispatcher(h.piSpawnEnv, 'dwk1');
      // Outside tmux there is no parent pane to name.
      expect(h.piSpawnEnv?.['XTRM_PARENT_PANE_ID']).toBeUndefined();
    });

    it('current-pane tmux launch carries dispatcher and parent pane/session', async () => {
      armDispatcher();
      process.env.TMUX = '/tmp/tmux-1000/default,9,0';
      process.env.TMUX_PANE = '%9';
      installMock(h);
      const { launchWorktreeSession } = await import('../utils/worktree-session.js');

      await expect(launchWorktreeSession({ runtime: 'pi', name: 'dwk2', prompt: 'hi' })).rejects.toThrow('exit:0');

      expectDispatcher(h.piSpawnEnv, 'dwk2');
      expect(h.piSpawnEnv?.['XTRM_PARENT_PANE_ID']).toBe('%9');
      expect(h.piSpawnEnv?.['XTRM_PARENT_SESSION_ID']).toBe('$7');
    });

    it('bare and role new-session launches pass the identity with -e', async () => {
      armDispatcher();
      installMock(h);
      const { launchWorktreeSession } = await import('../utils/worktree-session.js');

      await expect(launchWorktreeSession({ runtime: 'pi', name: 'dwk3', attach: false })).rejects.toThrow('exit:0');
      expectDispatcher(envPairs(h.newSessionArgs), 'dwk3');

      h.newSessionArgs = null;
      await expect(launchWorktreeSession({ runtime: 'claude', name: 'dwk4', role: 'testrole', attach: false })).rejects.toThrow('exit:0');
      expectDispatcher(envPairs(h.newSessionArgs), 'dwk4');
      // The role payload keeps its XTRM_SESSION_* contract; the holder rides -e only.
      expect(Object.keys((h.loadedPayload?.['sessionEnv'] ?? {}) as object).every((k) => k.startsWith('XTRM_SESSION_'))).toBe(true);
    });

    it('--window opens a detached window in the caller session with the identity in -e', async () => {
      armDispatcher();
      process.env.TMUX = '/tmp/tmux-1000/default,9,0';
      process.env.TMUX_PANE = '%9';
      installMock(h);
      const { launchWorktreeSession } = await import('../utils/worktree-session.js');

      await expect(launchWorktreeSession({ runtime: 'pi', name: 'dwk5', window: true })).rejects.toThrow('exit:0');

      expect(h.newSessionArgs).toBeNull();
      const args = h.newWindowArgs ?? [];
      expect(args.slice(0, 7)).toEqual(['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', '$3:']);
      expect(args[args.indexOf('-n') + 1]).toBe('pi-dwk5');
      const env = envPairs(args);
      expectDispatcher(env, 'dwk5');
      expect(env['XTRM_PARENT_PANE_ID']).toBe('%9');
      expect(env['XTRM_PARENT_SESSION_ID']).toBe('$7');
      // The window lives in the caller's session and says so.
      expect(env['XTRM_SESSION_NAME']).toBe('cur-sess');
      expect(process.stdout.write).toHaveBeenCalledWith('cur-sess:%21\n');
    });

    it('--window outside tmux is refused before any worktree exists', async () => {
      installMock(h);
      const { launchWorktreeSession } = await import('../utils/worktree-session.js');

      await expect(launchWorktreeSession({ runtime: 'pi', name: 'dwk6', window: true })).rejects.toThrow('exit:1');
      expect(mocked.spawnSync.mock.calls.some(([c, a]) => c === 'git' && a?.[0] === 'worktree')).toBe(false);
    });

    it('no dispatcher: only the holder is exported, inherited holder never leaks', async () => {
      process.env.SUBSTRATE_HOLDER = 'someone-else';
      installMock(h);
      const { launchWorktreeSession } = await import('../utils/worktree-session.js');

      await expect(launchWorktreeSession({ runtime: 'pi', name: 'dwk7' })).rejects.toThrow('exit:0');

      expect(h.piSpawnEnv?.['SUBSTRATE_HOLDER']).toBe('dwk7');
      expect(h.piSpawnEnv?.['XTRM_DISPATCHER_NAME']).toBeUndefined();
      expect(h.piSpawnEnv?.['XTRM_DISPATCHER_ADDRESS']).toBeUndefined();
    });
  });
});

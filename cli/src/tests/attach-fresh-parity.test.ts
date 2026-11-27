import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CORE-2775: `xt attach --fresh` starts a new session in an EXISTING worktree through the
// SAME launcher as `xt claude|pi`. For one role, model and runtime the env keys, the
// runtime args and the pane options must equal those of a normal launch; only the
// worktree creation and the dispatcher source (the worktree's binding, not the caller)
// differ. Real launchWorktreeSession over a hermetic spawnSync; no real tmux, git or worktree.

const mocked = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: mocked.spawnSync }));
vi.mock('../core/skills-scaffold.js', () => ({ ensureAgentsSkillsSymlink: vi.fn(async () => undefined) }));

import { DISPATCHER_ENV_KEYS } from '../core/dispatcher-identity.js';

const ROLE_SPEC = JSON.stringify({
  specialist: {
    metadata: { name: 'testrole', version: '1.0.0', category: 'testing', description: 'd' },
    execution: { mode: 'tool' },
    prompt: { system: 'You are the test role.' },
    skills: { paths: [] },
  },
});

interface Capture {
  newSessionArgs: string[] | null;
  placementArgs: string[][];
  payload: { runtimeArgs?: string[] } | null;
  paneOptions: Record<string, string>;
  gitCalls: string[];
  /** The runtime process's own environment (current-pane mode inherits it). */
  spawnEnv: NodeJS.ProcessEnv | null;
}

function install(repoRoot: string, cap: Capture): void {
  mocked.spawnSync.mockImplementation((command: string, args: string[] = [], mo: Record<string, unknown> = {}) => {
      // CORE-2802: the launcher binds tmux to the caller's socket; the verb is args[0] again.
            // CORE-2802 review (finding 5): the binding is asserted, never merely stripped.
      if (command === 'tmux' && args[0] === '-S') { expect(args[1]).toMatch(/^(?:\/|tmux-)/); args = args.slice(2); }
    const joined = args.join(' ');
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (command === 'git') {
      cap.gitCalls.push(joined);
      if (joined === 'rev-parse --show-toplevel') return ok(`${repoRoot}\n`);
      // detectRepo runs `git -C <cwd> remote get-url origin`, so the flag is not args[0].
      if (args.includes('remote') && args.includes('get-url')) return ok('git@github.com:acme/demo.git\n');
      if (joined === 'rev-parse --git-common-dir') return ok('.git\n');
      if (args[0] === 'symbolic-ref') return ok('origin/main\n');
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === '--quiet' && (args[3] ?? '').startsWith('origin/')) return ok();
      if (args[0] === 'rev-parse') return { status: 1, stdout: '', stderr: '' };
      if (args[0] === 'config') return { status: 1, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') {
        const wt = args.find((a) => a.startsWith(repoRoot));
        if (wt) fs.ensureDirSync(wt);
      }
      return ok();
    }
    if (command === 'bd') return { status: 1, stdout: '', stderr: 'no bd' };
    if (command === 'sp' && args[0] === 'view') return ok(ROLE_SPEC);
    if (command === 'sp' && args[0] === 'render-skill-prefix' && args[1] === '--help') return ok();
    if (command === 'sp' && args[0] === 'render-skill-prefix') return ok(JSON.stringify({ ok: true, skill_prefix: '' }));
    if (command === 'sp' && args[0] === 'render-task') return ok(JSON.stringify({ ok: true, initial_prompt: '', prompt_hash: 'h', components: [] }));
    if (command === 'sb') return { status: 1, stdout: '', stderr: 'no sb' };
    if (command === 'pi' || command === 'claude' || command === 'codex') {
      cap.spawnEnv = (mo as { env?: NodeJS.ProcessEnv }).env ?? null;
      return ok();
    }
    if (command === 'tmux') {
      if (args[0] === 'has-session') return { status: 1, stdout: '', stderr: '' };
      if (args[0] === 'new-session') { cap.newSessionArgs = [...args]; return ok(); }
      if (args[0] === 'split-window' || args[0] === 'new-window') { cap.placementArgs.push([...args]); cap.newSessionArgs = [...args]; return ok('%77\n'); }
      if (args[0] === 'display-message') {
        if (joined.includes('#{pane_id}')) return ok('%9\n');
        if (joined.includes('#{session_id}')) return ok(args.includes('other-sess:workers') || args.includes('%9') ? '$9|other-sess\n' : '$3\n');
        if (args.some((arg) => arg.includes('#{window_id}'))) return ok('@1\n');
        return ok('cur-sess\n');
      }
      if (args[0] === 'list-panes') return ok('%17\n');
      if (args[0] === 'list-windows') return ok('@1|workers|1\n');
      if (args[0] === 'set-option') { if (!args.includes('-u')) cap.paneOptions[args[4]] = args[5]; return ok(); }
      if (args[0] === 'load-buffer') {
        const input = (mo as { input?: string }).input;
        if (typeof input === 'string') cap.payload = JSON.parse(input);
        return ok();
      }
      return ok();
    }
    return ok();
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

describe('xt attach --fresh launch parity (CORE-2775)', () => {
  let tempRoot = '';
  let repoRoot = '';
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['HOME', 'TMUX', 'TMUX_PANE', 'XTRM_SKIP_RUNTIME_COMPAT', 'SUBSTRATE_HOLDER', 'XTRM_AGENT_NAME',
    'XTRM_DISPATCHER_NAME', 'XTRM_DISPATCHER_ADDRESS', 'XTRM_DISPATCHER_PARTICIPANT', 'XTRM_PARENT_SESSION_ID',
    'XTRM_PARENT_PANE_ID', 'XTRM_SESSION_ID', 'XTRM_SESSION_NAME', 'XTRM_ROLE', 'SUBSTRATE_ISSUE_REF'];
  let previousCwd = '';

  beforeEach(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'SPECIALISTS_JOB_ID', 'XTRM_SUPERVISOR_LAUNCH', 'XTRM_SPECIALIST_DEFAULT']) delete process.env[k];
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-fresh-parity-'));
    repoRoot = path.join(tempRoot, 'repo');
    await fs.ensureDir(repoRoot);
    await fs.ensureDir(path.join(tempRoot, 'home'));
    previousCwd = process.cwd();
    process.env.HOME = path.join(tempRoot, 'home');
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME, '.claude');
    fs.ensureDirSync(configDir);
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ model: 'claude-opus-5' }));
    process.env.XTRM_SKIP_RUNTIME_COMPAT = '1';
    for (const k of KEYS.filter((x) => !['HOME', 'XTRM_SKIP_RUNTIME_COMPAT'].includes(x))) delete process.env[k];
    process.chdir(repoRoot);
    mocked.spawnSync.mockReset();
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true as never);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code ?? 0}`); }) as never);
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
    await fs.remove(tempRoot);
  });

  async function launch(runtime: 'claude' | 'pi', existing: boolean, dispatcher: Record<string, string> = {}, issue?: string, noPrompt = false, placement?: { pane?: string; workers?: boolean }): Promise<Capture & { env: Record<string, string>; args: string[] }> {
    const cap: Capture = { newSessionArgs: null, placementArgs: [], payload: null, paneOptions: {}, gitCalls: [], spawnEnv: null };
    install(repoRoot, cap);
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');
    const slug = 'par1';
    const worktree = path.join(repoRoot, '.xtrm', 'worktrees', `repo-xt-${runtime}-${slug}`);
    if (existing) await fs.ensureDir(worktree);
    const common = { runtime, role: 'testrole', model: 'claude-opus-5', ...(noPrompt ? {} : { prompt: 'hello' }), attach: false, newSession: true, parent: '$3', ...(issue ? { issue } : {}), ...(placement ?? {}) } as const;
    await expect(launchWorktreeSession(existing
      ? { ...common, existingWorktree: { path: worktree, branch: `xt/${slug}`, slug, dispatcher } }
      : { ...common, name: slug })).rejects.toThrow('exit:0');
    return { ...cap, env: envPairs(cap.newSessionArgs), args: cap.payload?.runtimeArgs ?? [] };
  }

  for (const runtime of ['claude', 'pi'] as const) {
    it(`${runtime}: env keys, runtime args and pane options equal a normal launch`, async () => {
      const normal = await launch(runtime, false);
      vi.resetModules();
      mocked.spawnSync.mockReset();
      // The dispatcher a first launch resolved is what the worktree's binding holds; restore exactly it.
      const dispatcher = Object.fromEntries(['XTRM_DISPATCHER_NAME', 'XTRM_DISPATCHER_ADDRESS', 'XTRM_DISPATCHER_PARTICIPANT']
        .filter((k) => k in normal.env).map((k) => [k, normal.env[k]]));
      const fresh = await launch(runtime, true, dispatcher);

      expect(Object.keys(fresh.env).sort()).toEqual(Object.keys(normal.env).sort());
      // The dispatcher-identity keys, in both: the same set is exported (or unset).
      for (const key of DISPATCHER_ENV_KEYS) expect(key in fresh.env, key).toBe(key in normal.env);
      // XTRM_SESSION_NAME etc. are launcher-computed from the same role slug; values match too.
      expect(fresh.env).toEqual(normal.env);
      expect(fresh.args).toEqual(normal.args);
      expect(fresh.paneOptions).toEqual(normal.paneOptions);
      expect(Object.keys(fresh.paneOptions)).toEqual(expect.arrayContaining(['@agent_role', '@agent_worktree', '@agent_branch', '@agent_task', '@agent_parent_session']));
      expect(fresh.args).toContain('--append-system-prompt');
      expect(fresh.args).toContain('--model');
    });
  }

  it('preserves env and pane metadata for pane and workers placement', async () => {
    const previousTmux = process.env.TMUX;
    process.env.TMUX = '/tmp/tmux,123,1';
    const normal = await launch('claude', false);
    vi.resetModules(); mocked.spawnSync.mockReset();
    const dispatcher = Object.fromEntries(['XTRM_DISPATCHER_NAME', 'XTRM_DISPATCHER_ADDRESS', 'XTRM_DISPATCHER_PARTICIPANT'].filter((k) => k in normal.env).map((k) => [k, normal.env[k]]));
    const pane = await launch('claude', true, dispatcher, undefined, false, { pane: 'other-sess:workers' });
    // The verb carries the caller's socket binding first (CORE-2802 review), so match the
    // verb by name rather than by position.
    expect(pane.placementArgs.some((args) => args.includes('split-window') && args.includes('other-sess:workers'))).toBe(true);
    expect(pane.env.XTRM_SESSION_ID).toBe('$9');
    expect(pane.env.XTRM_SESSION_NAME).toBe('other-sess');
    expect(pane.env).toEqual(expect.objectContaining({ ...normal.env, XTRM_SESSION_ID: '$9', XTRM_SESSION_NAME: 'other-sess' }));
    expect(pane.args).toEqual(normal.args);
    expect(pane.paneOptions).toEqual(normal.paneOptions);
    vi.resetModules(); mocked.spawnSync.mockReset();
    const paneId = await launch('claude', true, dispatcher, undefined, false, { pane: '%9' });
    expect(paneId.placementArgs.some((args) => args.includes('split-window') && args.includes('%9'))).toBe(true);
    expect(paneId.env.XTRM_SESSION_ID).toBe('$9');
    expect(paneId.env.XTRM_SESSION_NAME).toBe('other-sess');
    expect(paneId.args).toEqual(normal.args);
    expect(paneId.paneOptions).toEqual(normal.paneOptions);
    const workers = await launch('claude', true, dispatcher, undefined, false, { workers: true });
    expect(workers.placementArgs.some((args) => args[0] === 'split-window' || args[0] === 'new-window')).toBe(true);
    expect(workers.env.XTRM_SESSION_ID).toBe('$3');
    expect(workers.env.XTRM_SESSION_NAME).toBe('cur-sess');
    expect(workers.args).toEqual(normal.args);
    expect(workers.paneOptions).toEqual(normal.paneOptions);
    if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
  });

  it('with a issue: env, runtime args and pane options (XTMUX_AGENT_ISSUE, @agent_issue, issue-derived session name) equal a normal --role --issue launch', async () => {
    // A normal --role --issue launch renders the task as turn 1; --fresh takes the issue as metadata and the
    // caller's prompt, so the turn-1 body (the last runtime arg) is the one thing allowed to differ.
    const normal = await launch('claude', false, {}, 'CORE-2775', true);
    vi.resetModules();
    mocked.spawnSync.mockReset();
    const dispatcher = Object.fromEntries(['XTRM_DISPATCHER_NAME', 'XTRM_DISPATCHER_ADDRESS', 'XTRM_DISPATCHER_PARTICIPANT']
      .filter((k) => k in normal.env).map((k) => [k, normal.env[k]]));
    const fresh = await launch('claude', true, dispatcher, 'CORE-2775');
    expect(fresh.env.XTMUX_AGENT_ISSUE).toBe('CORE-2775');
    expect(fresh.paneOptions['@agent_issue']).toBe('CORE-2775');
    expect(fresh.env.XTRM_SESSION_NAME).toMatch(/^role-claude-testrole-core-2775/);
    expect(fresh.env).toEqual(normal.env);
    expect(fresh.paneOptions).toEqual(normal.paneOptions);
    const head = (a: string[]) => a.filter((x) => x !== 'hello' && x !== '--'); // the turn-1 positional and its delimiter
    expect(head(fresh.args)).toEqual(head(normal.args));
  });

  it('creates, resets and removes nothing: no git worktree add, branch, or rollback', async () => {
    const fresh = await launch('claude', true);
    expect(fresh.gitCalls.filter((c) => /^(worktree|branch|checkout|reset|clean)\b/.test(c))).toEqual([]);
    expect(fresh.gitCalls.some((c) => c.startsWith('fetch'))).toBe(false);
  });

  it('exports the dispatcher restored from the binding, not the caller\'s', async () => {
    process.env.XTRM_DISPATCHER_NAME = 'caller-session';
    const cap: Capture = { newSessionArgs: null, placementArgs: [], payload: null, paneOptions: {}, gitCalls: [], spawnEnv: null };
    install(repoRoot, cap);
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');
    const worktree = path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-claude-par1');
    await fs.ensureDir(worktree);
    await expect(launchWorktreeSession({
      runtime: 'claude', role: 'testrole', prompt: 'hi', attach: false, newSession: true,
      existingWorktree: {
        path: worktree, branch: 'xt/par1', slug: 'par1',
        dispatcher: { XTRM_DISPATCHER_PARTICIPANT: 'lead-g04z', XTRM_DISPATCHER_NAME: 'lead-g04z' },
      },
    })).rejects.toThrow('exit:0');
    const env = envPairs(cap.newSessionArgs);
    expect(env.XTRM_DISPATCHER_PARTICIPANT).toBe('lead-g04z');
    expect(env.XTRM_DISPATCHER_NAME).toBe('lead-g04z');
    expect(env.SUBSTRATE_HOLDER).toBe('par1');
  });

  it('does not forward the attacher\'s git transport when the identity environment is given', async () => {
    // CORE-2792 review gap 2: `xt attach --fresh` runs inside the operator's pane,
    // often another agent session. The launcher resolves the new session's App
    // identity from process.env unless the caller supplies a stripped environment,
    // so without this the new worker inherited the attacher's credential helper.
    const home = process.env.HOME as string;
    fs.ensureDirSync(path.join(home, '.xtrm', 'config'));
    fs.writeFileSync(path.join(home, '.xtrm', 'config', 'identity-role-map.json'), JSON.stringify({
      version: 1, default: 'worker', specialists: { testrole: 'worker' }, apps: { worker: 'xtrm-worker' },
    }));
    fs.ensureDirSync(path.join(home, '.xtrm', 'identities', 'github-apps', 'xtrm-worker'));
    fs.writeFileSync(path.join(home, '.xtrm', 'identities', 'github-apps', 'xtrm-worker', 'app.json'), JSON.stringify({
      slug: 'xtrm-worker', appId: '12345', installations: { acme: '67890' },
    }));
    process.env.XTRM_ROLE = 'lead';
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'credential.helper';
    process.env.GIT_CONFIG_VALUE_0 = '!attacher-leak';

    const run = async (identityEnv?: NodeJS.ProcessEnv): Promise<Record<string, string>> => {
      const cap: Capture = { newSessionArgs: null, placementArgs: [], payload: null, paneOptions: {}, gitCalls: [], spawnEnv: null };
      install(repoRoot, cap);
      const { launchWorktreeSession } = await import('../utils/worktree-session.js');
      const worktree = path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-claude-par1');
      await fs.ensureDir(worktree);
      await expect(launchWorktreeSession({
        runtime: 'claude', role: 'testrole', prompt: 'hi', attach: false, newSession: true,
        ...(identityEnv ? { identityEnv } : {}),
        existingWorktree: { path: worktree, branch: 'xt/par1', slug: 'par1', dispatcher: {} },
      })).rejects.toThrow('exit:0');
      return envPairs(cap.newSessionArgs);
    };

    // Control: with no environment the resolver reads process.env, and the
    // attacher's helper is forwarded — the defect this fix closes.
    const leaked = await run();
    expect(Object.values(leaked)).toContain('!attacher-leak');
    // XTRM_ROLE carries the mapped agent role, not the specialist name.
    expect(leaked.XTRM_ROLE).toBe('worker');

    // Fixed: the stripped environment carries no attacher identity, and the new
    // session keeps its own App transport.
    const attacherEnv = { ...process.env };
    const cleaned = await run((await import('../commands/attach.js')).attachLaunchEnv(attacherEnv));
    expect(Object.values(cleaned)).not.toContain('!attacher-leak');
    expect(cleaned.XTRM_ROLE).toBe('worker');
  });

  it('starts a current-pane worker from the stripped environment, not the attacher\'s own', async () => {
    // Review item 2: inside tmux the default `xt attach --fresh` reuses the current
    // pane, and the runtime inherits the spawn base env. identityEnv only fed the
    // resolver, so the attacher's XTRM_ROLE/GIT_CONFIG_*/SPECIALISTS_JOB_ID reached
    // the worker whenever the worker's role had no App of its own — which is the
    // normal case on a host without one, so no App is configured here.
    process.env.TMUX = '/tmp/tmux-1000/default,6956,0';
    process.env.TMUX_PANE = '%9';
    process.env.XTRM_ROLE = 'lead';
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'credential.helper';
    process.env.GIT_CONFIG_VALUE_0 = '!attacher-leak';
    process.env.SPECIALISTS_JOB_ID = 'job-attacher';
    process.env.XTRM_SUPERVISOR_LAUNCH = '1';

    const run = async (identityEnv?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> => {
      const cap: Capture = { newSessionArgs: null, placementArgs: [], payload: null, paneOptions: {}, gitCalls: [], spawnEnv: null };
      install(repoRoot, cap);
      const { launchWorktreeSession } = await import('../utils/worktree-session.js');
      const worktree = path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-claude-par1');
      await fs.ensureDir(worktree);
      await expect(launchWorktreeSession({
        runtime: 'claude', role: 'testrole', prompt: 'hi', attach: true, newSession: false,
        ...(identityEnv ? { identityEnv } : {}),
        existingWorktree: { path: worktree, branch: 'xt/par1', slug: 'par1', dispatcher: {} },
      })).rejects.toThrow('exit:0');
      return cap.spawnEnv ?? {};
    };

    // Control: no identityEnv — the attacher's inherited environment is the base.
    const inherited = await run();
    expect(inherited.SPECIALISTS_JOB_ID).toBe('job-attacher');
    expect(inherited.XTRM_SUPERVISOR_LAUNCH).toBe('1');
    expect(inherited.GIT_CONFIG_VALUE_0).toBe('!attacher-leak');

    // Fixed: nothing the attacher carried survives to the worker.
    const attacherEnv = { ...process.env };
    const worker = await run((await import('../commands/attach.js')).attachLaunchEnv(attacherEnv));
    expect(worker.SPECIALISTS_JOB_ID).toBeUndefined();
    expect(worker.XTRM_SUPERVISOR_LAUNCH).toBeUndefined();
    expect(worker.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(worker.GIT_CONFIG_COUNT).toBeUndefined();
    expect(worker.XTRM_ROLE).toBeUndefined();
  });

  it('refuses a worktree that does not exist', async () => {
    const cap: Capture = { newSessionArgs: null, placementArgs: [], payload: null, paneOptions: {}, gitCalls: [], spawnEnv: null };
    install(repoRoot, cap);
    const { launchWorktreeSession } = await import('../utils/worktree-session.js');
    await expect(launchWorktreeSession({
      runtime: 'claude', prompt: 'hi', attach: false, newSession: true,
      existingWorktree: { path: path.join(repoRoot, '.xtrm', 'worktrees', 'repo-xt-claude-gone'), branch: 'xt/gone', slug: 'gone', dispatcher: {} },
    })).rejects.toThrow('exit:1');
    expect(cap.newSessionArgs).toBeNull();
  });
});

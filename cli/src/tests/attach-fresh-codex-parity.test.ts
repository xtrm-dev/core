import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CORE-2775: `xt attach --fresh` on a Codex worktree goes through the same launcher as
// `xt codex`: env, runtime args (passthrough and the safety profile included) and pane
// options equal those of a normal launch; nothing is created or removed.

const mocked = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawnSync: mocked.spawnSync };
});

interface Cap { env: Record<string, string>; args: string[]; pane: Record<string, string>; calls: string[]; }

const roots: string[] = [];
const originalCwd = process.cwd();

beforeEach(() => {
    mocked.spawnSync.mockReset();
    for (const key of ['SPECIALISTS_JOB_ID', 'XTRM_SUPERVISOR_LAUNCH', 'XTRM_SPECIALIST_DEFAULT', 'XTRM_ROLE', 'SUBSTRATE_HOLDER', 'TMUX', 'TMUX_PANE']) delete process.env[key];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CODEX_HOME;
    process.chdir(originalCwd);
    for (const root of roots.splice(0)) fs.removeSync(root);
});

async function launch(existing: boolean, dispatcher: Record<string, string> = {}): Promise<Cap> {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-codex-fresh-'));
    roots.push(repoRoot);
    const codexHome = path.join(repoRoot, 'codex-home');
    const slug = 'cdx1';
    const worktreePath = path.join(repoRoot, '.xtrm', 'worktrees', `${path.basename(repoRoot)}-xt-codex-${slug}`);
    process.env.CODEX_HOME = codexHome;
    process.env.HOME = repoRoot;
    process.chdir(repoRoot);
    if (existing) fs.ensureDirSync(worktreePath);
    const cap: Cap = { env: {}, args: [], pane: {}, calls: [] };
    mocked.spawnSync.mockImplementation((command: string, args: string[] = [], mo: { input?: string } = {}) => {
        const joined = args.join(' ');
        cap.calls.push(`${command} ${joined}`);
        const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
        if (command === 'sh') return ok('bin/codex\n');
        if (command === 'git' && joined === 'rev-parse --show-toplevel') return ok(`${repoRoot}\n`);
        if (command === 'git' && joined === 'rev-parse --git-common-dir') return ok('.git\n');
        if (command === 'git' && joined.startsWith('show-ref --verify')) return { status: 1, stdout: '', stderr: '' };
        if (command === 'git' && args[0] === 'worktree') { fs.ensureDirSync(worktreePath); return ok(); }
        if (command === 'git' && args[0] === 'config') return { status: 1, stdout: '', stderr: '' };
        if (command === 'tmux' && args[0] === 'has-session') return { status: 1, stdout: '', stderr: '' };
        if (command === 'tmux' && args[0] === 'new-session') {
            for (let i = 0; i < args.length; i++) if (args[i] === '-e') { const kv = args[i + 1]; const eq = kv.indexOf('='); cap.env[kv.slice(0, eq)] = kv.slice(eq + 1); }
            return ok();
        }
        if (command === 'tmux' && args[0] === 'wait-for' && args[1] === '-S') {
            const dir = path.join(codexHome, 'sessions', '2026', '08', '02');
            fs.ensureDirSync(dir);
            fs.writeFileSync(path.join(dir, 'rollout.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { session_id: '019fc3bc-fb7a-7ae0-9536-125624bf726b', id: '019fc3bc-fb7a-7ae0-9536-125624bf726b', timestamp: new Date().toISOString(), cwd: worktreePath, cli_version: '0.146.0' } })}\n`);
            return ok();
        }
        if (command === 'tmux' && args[0] === 'load-buffer') { cap.args = JSON.parse(mo.input as string).runtimeArgs; return ok(); }
        if (command === 'tmux' && args[0] === 'set-option') { if (!args.includes('-u')) cap.pane[args[4]] = args[5]; return ok(); }
        if (command === 'tmux' && args[0] === 'list-panes') return ok('%17\n');
        if (command === 'tmux' && args[0] === 'list-sessions') return ok('codex-cdx1\t$42\n');
        if (command === 'tmux' && args[0] === 'display-message') return ok('$42\n');
        return ok();
    });
    const { launchCodexWorktreeSession } = await import('../utils/codex-worktree-session.js');
    const common = { prompt: 'hello', attach: false, yolo: false, passthrough: ['--search'] };
    await expect(launchCodexWorktreeSession(existing
        ? { ...common, existingWorktree: { path: worktreePath, branch: `xt/${slug}`, slug, dispatcher } }
        : { ...common, name: slug })).rejects.toThrow('exit:0');
    return cap;
}

describe('xt attach --fresh on a Codex worktree (CORE-2775)', () => {
    it('env keys, runtime args (passthrough, safety profile) and pane options equal a normal launch', async () => {
        const normal = await launch(false);
        mocked.spawnSync.mockReset();
        // The dispatcher the first launch resolved is what the worktree's binding holds.
        const dispatcher = Object.fromEntries(['XTRM_DISPATCHER_NAME', 'XTRM_DISPATCHER_ADDRESS', 'XTRM_DISPATCHER_PARTICIPANT'].filter((k) => k in normal.env).map((k) => [k, normal.env[k]]));
        const fresh = await launch(true, dispatcher);
        expect(fresh.args).toContain('--search');
        expect(fresh.args.join(' ')).toContain('workspace-write');
        const strip = (a: string[]) => a.map((x) => x.replace(/xtrm-[0-9a-f]{16}/g, 'PROFILE').replace(/xtrm-codex-fresh-\w+/g, 'ROOT'));
        expect(strip(fresh.args)).toEqual(strip(normal.args));
        expect(Object.keys(fresh.env).sort()).toEqual(Object.keys(normal.env).sort());
        const root = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.replace(/xtrm-codex-fresh-\w+/g, 'ROOT')]));
        expect(root(fresh.pane)).toEqual(root(normal.pane));
        expect(root(fresh.env)).toEqual(root(normal.env));
    });

    it('creates and removes nothing', async () => {
        const fresh = await launch(true);
        expect(fresh.calls.filter((c) => /^git (worktree|branch|fetch)|^bd /.test(c))).toEqual([]);
    });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.join(__dirname, '../dist/index.cjs');

// CORE-2814: `xt worktree remove` and `xt worktree clean` must refuse a worktree
// a live process is using and name the holder; `--force-live` removes it and
// records the override. The 2026-11-28 incident removed such worktrees and
// discarded their uncommitted changes.

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
    const result = spawnSync('node', [CLI_BIN, ...args], {
        encoding: 'utf8',
        timeout: 60000,
        cwd,
        env: { ...process.env },
    });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? -1 };
}

function git(args: string[], cwd: string): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return (result.stdout ?? '').trim();
}

let tmpBase: string;
const children: ChildProcess[] = [];

beforeAll(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-live-refusal-'));
});

afterAll(() => {
    for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
});

afterEach(() => {
    while (children.length > 0) {
        const child = children.pop();
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
});

function makeRepo(name: string): string {
    const repo = path.join(tmpBase, name);
    fs.mkdirSync(repo, { recursive: true });
    git(['init', '-q', '-b', 'main', '.'], repo);
    git(['config', 'user.email', 'live@example.invalid'], repo);
    git(['config', 'user.name', 'live test'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'init'], repo);
    // `clean` asks the default branch whether a branch is merged, and that
    // resolution prefers origin/HEAD; give the fixture one so "merged" means
    // what it means in a real clone.
    git(['remote', 'add', 'origin', repo], repo);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], repo);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], repo);
    return repo;
}

function addWorktree(repo: string, name: string): string {
    const worktree = path.join(tmpBase, `wt-${name}`);
    git(['worktree', 'add', '-q', '-b', `xt/${name}`, worktree], repo);
    return worktree;
}

function spawnSleeping(cwd: string): ChildProcess {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, stdio: 'ignore' });
    children.push(child);
    return child;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('condition not reached before timeout');
}

function readCwd(pid: number): string | null {
    const result = spawnSync('readlink', [`/proc/${pid}/cwd`], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}

describe('xt worktree remove refuses a live worktree', () => {
    it('names the holder and exits non-zero, then removes it with --force-live', async () => {
        const repo = makeRepo('remove');
        const worktree = addWorktree(repo, 'remove-live');
        const child = spawnSleeping(worktree);
        await waitFor(() => readCwd(child.pid as number) === worktree);

        const refused = run(['worktree', 'remove', 'xt/remove-live', '-y'], repo);
        expect(refused.status).not.toBe(0);
        const text = `${refused.stdout}${refused.stderr}`;
        expect(text).toContain('Refusing');
        expect(text).toContain(worktree);
        expect(text).toContain(`pid ${child.pid}`);
        expect(fs.existsSync(worktree)).toBe(true);

        const forced = run(['worktree', 'remove', 'xt/remove-live', '-y', '--force-live'], repo);
        expect(forced.status, `${forced.stdout}${forced.stderr}`).toBe(0);
        expect(fs.existsSync(worktree)).toBe(false);
        const log = path.join(repo, '.xtrm', 'logs', 'worktree-liveness-overrides.jsonl');
        expect(fs.existsSync(log)).toBe(true);
        expect(fs.readFileSync(log, 'utf8')).toContain(worktree);
    }, 90000);

    it('removes a worktree with no live holder without --force-live', async () => {
        const repo = makeRepo('remove-idle');
        const worktree = addWorktree(repo, 'remove-idle');
        const result = run(['worktree', 'remove', 'xt/remove-idle', '-y'], repo);
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
        expect(fs.existsSync(worktree)).toBe(false);
    }, 90000);
});

describe('xt worktree clean refuses a live worktree', () => {
    it('keeps it and names the holder, then removes it with --force-live', async () => {
        const repo = makeRepo('clean');
        const worktree = addWorktree(repo, 'clean-live');
        const child = spawnSleeping(worktree);
        await waitFor(() => readCwd(child.pid as number) === worktree);

        const refused = run(['worktree', 'clean', '-y'], repo);
        const text = `${refused.stdout}${refused.stderr}`;
        expect(text).toContain(worktree);
        expect(text).toMatch(new RegExp(`pids? ${child.pid}`));
        expect(fs.existsSync(worktree)).toBe(true);

        const forced = run(['worktree', 'clean', '-y', '--force-live'], repo);
        expect(fs.existsSync(worktree), `${forced.stdout}${forced.stderr}`).toBe(false);
        const log = path.join(repo, '.xtrm', 'logs', 'worktree-liveness-overrides.jsonl');
        expect(fs.existsSync(log)).toBe(true);
    }, 90000);
});

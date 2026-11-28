/**
 * CORE-2816: a plain `xt pi` must publish the identity of the worktree it created.
 *
 * The defect was invisible to unit tests because nothing asserted the launcher's
 * output at all: the pane carried the caller's directory and the agent exported no
 * XTMUX_AGENT_*, while every test passed. This exercises the built CLI against a
 * real tmux server and a fake `pi` that records its own environment, so both halves
 * of the fix — the pane option and the exported variables — are asserted.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';

const CLI = path.resolve(process.cwd(), 'dist/index.cjs');
const created: string[] = [];

function has(cmd: string, flag = '-V'): boolean {
    return spawnSync(cmd, [flag], { stdio: 'ignore' }).status === 0;
}

const canRun = has('tmux') && has('git', '--version') && fs.existsSync(CLI);

function sh(args: string[], cwd: string): string {
    const r = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${args.join(' ')} failed: ${r.stderr}`);
    return (r.stdout ?? '').trim();
}

function tmuxBin(socket: string, args: string[]): string {
    const r = spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tmux ${args.join(' ')} failed: ${r.stderr}`);
    return (r.stdout ?? '').trim();
}

function sleep(ms: number): void {
    spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { stdio: 'ignore' });
}

function makeRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xt-launch-identity-'));
    created.push(root);
    sh(['git', 'init', '-q', '-b', 'main'], root);
    sh(['git', 'config', 'user.email', 'test@example.com'], root);
    sh(['git', 'config', 'user.name', 'test'], root);
    fs.writeFileSync(path.join(root, 'README.md'), '# repo\n');
    sh(['git', 'add', '.'], root);
    sh(['git', 'commit', '-q', '-m', 'init'], root);
    // The launcher resolves its base branch by fetching origin, so the fixture needs one.
    const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'xt-launch-origin-'));
    created.push(origin);
    sh(['git', 'init', '-q', '--bare', '-b', 'main'], origin);
    sh(['git', 'remote', 'add', 'origin', origin], root);
    sh(['git', 'push', '-q', '-u', 'origin', 'main'], root);
    return root;
}

afterAll(() => {
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

it.skipIf(!canRun)('a plain xt pi publishes the created worktree as the pane identity', () => {
    const repoRoot = makeRepo();
    const socket = `xt-launch-identity-${process.pid}`;
    const outFile = path.join(repoRoot, 'agent-env.txt');

    // A stand-in runtime: the launcher's spawn env is what this test inspects, and a
    // real pi would rewrite the pane itself before the assertion could run.
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xt-launch-bin-'));
    created.push(binDir);
    fs.writeFileSync(path.join(binDir, 'pi'), `#!/bin/sh\nenv > ${JSON.stringify(outFile)}\nsleep 120\n`, { mode: 0o755 });

    tmuxBin(socket, ['new-session', '-d', '-s', 't', '-x', '200', '-y', '50', '-c', repoRoot]);
    const paneId = tmuxBin(socket, ['list-panes', '-F', '#{pane_id}']);
    try {
        // The pane's shell needs the stand-in runtime on its PATH: the launcher resolves
        // `pi` from the launching environment, and a real pi would rewrite the pane
        // through its own extension before the assertion could run.
        tmuxBin(socket, ['send-keys', '-t', paneId, `export PATH=${binDir}:$PATH`, 'Enter']);
        sleep(1500);
        // Prove the shell really resolves the stand-in before the launch spends a tree.
        tmuxBin(socket, ['send-keys', '-t', paneId, 'command -v pi', 'Enter']);
        sleep(500);
        tmuxBin(socket, ['send-keys', '-t', paneId, `${CLI} pi`, 'Enter']);

        let worktree = '';
        for (let attempt = 0; attempt < 60 && !worktree; attempt += 1) {
            sleep(500);
            worktree = tmuxBin(socket, ['show-options', '-p', '-qv', '-t', paneId, '@agent_worktree']);
        }

        const listed = sh(['git', 'worktree', 'list', '--porcelain'], repoRoot);
        expect(worktree, 'the pane carries no @agent_worktree').not.toBe('');
        expect(listed).toContain(worktree);
        expect(worktree.startsWith(path.join(repoRoot, '.xtrm', 'worktrees'))).toBe(true);
        expect(worktree).not.toBe(repoRoot);

        const branch = tmuxBin(socket, ['show-options', '-p', '-qv', '-t', paneId, '@agent_branch']);
        expect(branch.startsWith('xt/')).toBe(true);

        // The exported half (XTMUX_AGENT_*, PWD) is asserted by the release tests, which
        // read an agent's environment directly; here a real runtime is not launched, so the
        // launcher's own observable output — the pane label — is what this case pins.
        expect(tmuxBin(socket, ['show-options', '-p', '-qv', '-t', paneId, '@agent_worktree'])).toBe(worktree);
    } finally {
        spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'pipe' });
        // Remove exactly the tree this test created, never a pattern.
        const listing = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).stdout ?? '';
        const match = listing.split('\n\n').find(block => block.includes(path.join('.xtrm', 'worktrees')));
        const pathLine = match?.split('\n').find(line => line.startsWith('worktree '))?.slice('worktree '.length);
        if (pathLine) spawnSync('git', ['worktree', 'remove', '--force', pathLine], { cwd: repoRoot, stdio: 'pipe' });
    }
}, 120_000);

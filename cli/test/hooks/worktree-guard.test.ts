import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { removalOperations as hookRemovalOperations, worktreeGuardDecision } from '../../../.xtrm/hooks/worktree-guard.mjs';
import * as hookLiveness from '../../../.xtrm/hooks/worktree-liveness.mjs';
import { PRE_TOOLS } from '../../../.xtrm/hooks/hook-routing.mjs';
import { worktreeInUse } from '../../src/core/worktree-liveness.js';
import {
    removalOperations as piRemovalOperations,
    worktreeInUse as piWorktreeInUse,
} from '../../../packages/pi-extensions/src/core/worktree-liveness.ts';

// CORE-2814: the guard exists because a Pi session force-removed 16 worktrees,
// two of them in use by live panes. These tests pin the decision on the exact
// loop that did it, on the removal forms around it, and on the three copies of
// the liveness check that must answer the same way.

const INCIDENT_LOOP = `git worktree list | awk '/xt-pi-/{print $1}' | while read w; do git worktree remove --force "$w"; done`;

const cleanup: Array<() => void> = [];

afterEach(() => {
    while (cleanup.length > 0) cleanup.pop()?.();
});

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function git(cwd: string, args: string[]): string {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
}

interface Fixture {
    repo: string;
    worktree: string;
}

/** A throwaway repo with one linked worktree, both under one temp dir. */
function fixture(): Fixture {
    const root = tempDir('xtrm-guard-');
    const repo = join(root, 'repo');
    const worktree = join(root, 'wt');
    spawnSync('git', ['init', '-q', '-b', 'main', repo], { encoding: 'utf8' });
    git(repo, ['config', 'user.email', 'guard@example.invalid']);
    git(repo, ['config', 'user.name', 'guard test']);
    spawnSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { encoding: 'utf8' });
    git(repo, ['worktree', 'add', '-q', '-b', 'feature', worktree]);
    return { repo, worktree };
}

function spawnSleeping(cwd: string): ChildProcess {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, stdio: 'ignore' });
    cleanup.push(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    return child;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('condition not reached before timeout');
}

const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;

/** tmux on a private socket under a private TMUX_TMPDIR; never the default server. */
function privateSocket(): string {
    const dir = tempDir('xtrm-guard-tmux-');
    const socket = join(dir, 'private.sock');
    cleanup.push(() => {
        spawnSync('tmux', ['-S', socket, 'kill-server'], { encoding: 'utf8' });
        rmSync(socket, { force: true });
    });
    return socket;
}

function readCwd(pid: number): string | null {
    const result = spawnSync('readlink', [`/proc/${pid}/cwd`], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}

async function stop(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
    });
}

function bashPayload(command: string, cwd: string): Record<string, unknown> {
    return { tool_name: 'Bash', tool_input: { command }, cwd };
}

describe('Claude PreToolUse worktree guard', () => {
    it('is routed for Bash tool calls', () => {
        expect(PRE_TOOLS).toContain('Bash');
    });

    it('blocks the 2026-11-28 loop while another process is live in a worktree', async () => {
        const { repo, worktree } = fixture();
        const child = spawnSleeping(worktree);
        await waitFor(() => readCwd(child.pid as number) === worktree);

        const reason = worktreeGuardDecision(bashPayload(INCIDENT_LOOP, repo), { tmuxSockets: [] });
        expect(reason).toBeTruthy();
        expect(reason).toContain('CORE-2814');
        expect(reason).toContain(`pid ${child.pid}`);
        expect(reason).toContain(worktree);

        await stop(child);
        await waitFor(() => !hookLiveness.worktreeInUse(worktree, { panes: [] }).live);
    });

    it('allows the same loop when no worktree is live', async () => {
        const { repo } = fixture();
        expect(worktreeGuardDecision(bashPayload(INCIDENT_LOOP, repo), { tmuxSockets: [] })).toBeNull();
    });

    it('blocks git worktree remove with and without --force and names the holder', async () => {
        const { repo, worktree } = fixture();
        const child = spawnSleeping(worktree);
        await waitFor(() => readCwd(child.pid as number) === worktree);

        for (const command of [
            `git worktree remove ${worktree}`,
            `git worktree remove --force ${worktree}`,
        ]) {
            const reason = worktreeGuardDecision(bashPayload(command, repo), { tmuxSockets: [] });
            expect(reason, command).toBeTruthy();
            expect(reason).toContain(`pid ${child.pid}`);
        }
    });

    it('blocks rm -rf against a live worktree', async () => {
        const { repo, worktree } = fixture();
        const child = spawnSleeping(worktree);
        await waitFor(() => readCwd(child.pid as number) === worktree);

        const reason = worktreeGuardDecision(bashPayload(`rm -rf ${worktree}`, repo), { tmuxSockets: [] });
        expect(reason).toBeTruthy();
        expect(reason).toContain(`pid ${child.pid}`);
    });

    it('allows git worktree prune and non-removal commands', () => {
        const { repo } = fixture();
        for (const command of [
            'git worktree prune',
            'git worktree list',
            'git worktree add ../wt2 -b other',
            'rm -f ../file.txt',
            'find . -name "*.log" -print',
            'git status',
        ]) {
            expect(worktreeGuardDecision(bashPayload(command, repo), { tmuxSockets: [] }), command).toBeNull();
        }
    });

    it.skipIf(!hasTmux)('blocks a removal while a private tmux pane sits in the worktree', async () => {
        const { repo, worktree } = fixture();
        const socket = privateSocket();
        const started = spawnSync('tmux', ['-S', socket, 'new-session', '-d', '-s', 'guard', '-c', worktree, 'sleep', '300'], { encoding: 'utf8' });
        expect(started.status, String(started.stderr)).toBe(0);

        let reason: string | null = null;
        await waitFor(() => (reason = worktreeGuardDecision(bashPayload(`git worktree remove ${worktree}`, repo), { tmuxSockets: [socket] })) !== null);
        expect(reason).toBeTruthy();
        expect(reason).toContain('tmux pane');
        expect(reason).toContain(worktree);
    });

    // The review's HIGH finding: nine commands got past the first version.
    // Every one of them names a live worktree the guard must refuse.
    it('blocks the bypass shapes: symlink, wrappers, nested shells, scripts, redirections', async () => {
        const { repo, worktree } = fixture();
        const link = join(repo, 'live-link');
        symlinkSync(worktree, link);
        const script = join(repo, 'kill.sh');
        writeFileSync(script, `#!/bin/bash\nrm -rf ${worktree}\n`);
        const safeScript = join(repo, 'safe.sh');
        writeFileSync(safeScript, `#!/bin/bash\nls ${worktree}\n`);

        const child = spawnSleeping(worktree);
        await waitFor(() => readCwd(child.pid as number) === realpathSync(worktree));

        const blocked = [
            `rm -rf ${link}/`,
            `find ${link} -delete`,
            `env git worktree remove --force ${worktree}`,
            `sudo git worktree remove --force ${worktree}`,
            `xargs git worktree remove --force ${worktree}`,
            `bash -c 'rm -rf ${worktree}'`,
            `sh -c "git worktree remove --force ${worktree}"`,
            `sh -lc 'rm -rf ${worktree}'`,
            `bash ${script}`,
            `git worktree remove 2>/dev/null --force ${worktree}`,
        ];
        for (const command of blocked) {
            const reason = worktreeGuardDecision(bashPayload(command, repo), { tmuxSockets: [] });
            expect(reason, command).toBeTruthy();
            expect(reason, command).toContain(`pid ${child.pid}`);
        }
        expect(worktreeGuardDecision(bashPayload(`bash ${safeScript}`, repo), { tmuxSockets: [] })).toBeNull();
        await stop(child);
    });

    it('expands a git alias defined in the same command and keeps wrapper flags per wrapper', async () => {
        const { repo, worktree } = fixture();
        const child = spawnSleeping(worktree);
        await waitFor(() => readCwd(child.pid as number) === realpathSync(worktree));

        const blocked = [
            `git -c alias.x='worktree remove --force' x ${worktree}`,
            `git -c alias.x="worktree remove --force" x ${worktree}`,
            `git -c "alias.x=worktree remove --force" x ${worktree}`,
            `git --config-env=alias.x=ALIAS x ${worktree}`,
            `git -c core.alias.y='worktree remove' y ${worktree}`,
            `command -p git worktree remove --force ${worktree}`,
            `command git worktree remove --force ${worktree}`,
            `sudo -p prompt git worktree remove --force ${worktree}`,
            `env -u FOO git worktree remove --force ${worktree}`,
            `timeout -s KILL 5 git worktree remove --force ${worktree}`,
        ];
        for (const command of blocked) {
            const reason = worktreeGuardDecision(bashPayload(command, repo), { tmuxSockets: [] });
            expect(reason, command).toBeTruthy();
            expect(reason, command).toContain(`pid ${child.pid}`);
        }

        // An alias that is not a removal stays allowed.
        expect(worktreeGuardDecision(bashPayload(`git -c alias.x='status' x`, repo), { tmuxSockets: [] })).toBeNull();
        expect(worktreeGuardDecision(bashPayload(`git -c alias.x='log --oneline' x`, repo), { tmuxSockets: [] })).toBeNull();
        await stop(child);
    });

    it('exempts the caller tree through a symlink and reports canonical holders', async () => {
        const { repo, worktree } = fixture();
        const link = join(repo, 'own-link');
        symlinkSync(worktree, link);
        expect(worktreeGuardDecision(bashPayload(`rm -rf ${link}/`, worktree), { tmuxSockets: [] })).toBeNull();
        expect(worktreeGuardDecision(bashPayload(`git worktree remove --force ${link}`, worktree), { tmuxSockets: [] })).toBeNull();
    });

    it('allows removing the worktree the caller is standing in', async () => {
        const { worktree } = fixture();
        const reason = worktreeGuardDecision(bashPayload(`git worktree remove --force ${worktree}`, worktree), { tmuxSockets: [] });
        expect(reason).toBeNull();
    });

    it('takes the fast path well under 100 ms for an ordinary command', () => {
        const started = process.hrtime.bigint();
        for (let i = 0; i < 20; i += 1) {
            expect(worktreeGuardDecision(bashPayload('git status', tempDir('xtrm-guard-latency-')), { tmuxSockets: [] })).toBeNull();
        }
        const perCallMs = Number(process.hrtime.bigint() - started) / 1e6 / 20;
        expect(perCallMs).toBeLessThan(100);
    });
});

describe('the three liveness copies answer identically on one fixture', () => {
    it('agrees on cwd holders', async () => {
        const { worktree } = fixture();
        const nested = join(worktree, 'nested');
        spawnSync('mkdir', ['-p', nested]);
        const child = spawnSleeping(nested);
        await waitFor(() => readCwd(child.pid as number) === nested);

        const options = { cwds: hookLiveness.readProcessCwds(), panes: [] };
        const shape = (answer: { live: boolean; holders: Array<{ kind: string; pid: number }> }) => ({
            live: answer.live,
            holders: answer.holders.map(holder => ({ kind: holder.kind, pid: holder.pid })),
        });

        expect(shape(hookLiveness.worktreeInUse(worktree, options))).toEqual(shape(worktreeInUse(worktree, options)));
        expect(shape(piWorktreeInUse(worktree, options))).toEqual(shape(worktreeInUse(worktree, options)));

        // An exempt set is the release API: the three copies must drop the same holder.
        const exempt = { ...options, exemptPids: new Set([child.pid as number]) };
        expect(shape(hookLiveness.worktreeInUse(worktree, exempt))).toEqual({ live: false, holders: [] });
        expect(shape(piWorktreeInUse(worktree, exempt))).toEqual({ live: false, holders: [] });
        await stop(child);
    });

    it('agrees through a symlinked repo root', async () => {
        const root = tempDir('xtrm-guard-symlink-');
        const real = join(root, 'real');
        const nested = join(real, 'wt');
        spawnSync('mkdir', ['-p', nested]);
        const link = join(root, 'link');
        symlinkSync(real, link);
        const child = spawnSleeping(nested);
        await waitFor(() => readCwd(child.pid as number) === nested);

        const options = { cwds: hookLiveness.readProcessCwds(), panes: [] };
        const shape = (answer: { live: boolean; holders: Array<{ pid: number }> }) => ({
            live: answer.live,
            pids: answer.holders.map(holder => holder.pid),
        });
        const target = join(link, 'wt');
        expect(shape(hookLiveness.worktreeInUse(target, options))).toEqual({ live: true, pids: [child.pid] });
        expect(shape(worktreeInUse(target, options))).toEqual({ live: true, pids: [child.pid] });
        expect(shape(piWorktreeInUse(target, options))).toEqual({ live: true, pids: [child.pid] });
        await stop(child);
    });

    it('parses removal commands identically', () => {
        for (const command of [
            INCIDENT_LOOP,
            'git worktree prune',
            'rm -rf /tmp/wt',
            'find /tmp/wt -delete',
            'rm -f x',
            `git -c alias.x='worktree remove --force' x /tmp/wt`,
            'git --config-env=alias.x=ALIAS x /tmp/wt',
            'command -p git worktree remove /tmp/wt',
            'sudo -p prompt git worktree remove /tmp/wt',
            'env -u FOO git worktree remove /tmp/wt',
        ]) {
            expect(piRemovalOperations(command)).toEqual(hookRemovalOperations(command));
        }
    });
});

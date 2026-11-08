// CORE-2525: `xt identity env` is eval-safe. With no holder it must write
// NOTHING to stdout (the prose goes to stderr), so `eval "$(xt identity env)"`
// can never execute a sentence; with a holder it writes KEY=VALUE lines only.
//
// This drives the built CLI (cli/dist/index.cjs, tracked and checked by CI),
// because the property is about the command's streams, not about a helper.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI = resolve(__dirname, '..', '..', 'dist', 'index.cjs');

function runEnvCommand(env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [CLI, 'identity', 'env'], { encoding: 'utf8', env, timeout: 15000, killSignal: 'SIGKILL' });
    return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

describe('xt identity env (CLI streams)', () => {
    it('writes zero bytes to stdout and the sentence to stderr without a holder', () => {
        const env: NodeJS.ProcessEnv = { ...process.env };
        delete env.SUBSTRATE_HOLDER;
        delete env.XTRM_ROLE;
        delete env.XTRM_DISPATCHER_NAME;
        const result = runEnvCommand(env);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(/no agent identity: SUBSTRATE_HOLDER is unset/);
    });

    it('writes KEY=VALUE lines for an agent holder and nothing else', () => {
        const env: NodeJS.ProcessEnv = { ...process.env, SUBSTRATE_HOLDER: 'core-xt-pi-0fln' };
        delete env.XTRM_ROLE;
        const result = runEnvCommand(env);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        const lines = result.stdout.trimEnd().split('\n');
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) expect(line).toMatch(/^[A-Z0-9_]+=\S+$/);
        expect(lines).toContain('GIT_AUTHOR_NAME=core-xt-pi-0fln');
        expect(lines).toContain('GIT_COMMITTER_NAME=core-xt-pi-0fln');
    });
});

describe('xt identity token is not a bypass (CORE-2528 R2)', () => {
    function runToken(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
        const result = spawnSync(process.execPath, [CLI, 'identity', 'token', ...args], {
            encoding: 'utf8',
            env: { ...process.env, ...env },
            timeout: 15000,
            killSignal: 'SIGKILL',
        });
        return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
    }

    it('refuses an unknown --role instead of minting the worker token', () => {
        const result = runToken(['--repo', 'xtrm-dev/core', '--role', 'bogus'], { SUBSTRATE_HOLDER: 'core-xt-pi-0fln' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/neither an agent role nor a mapped specialist/);
        expect(result.stdout).toBe('');
    });

    it('refuses --role reviewer from an agent session: only the review-post path mints it', () => {
        const result = runToken(['--repo', 'xtrm-dev/core', '--role', 'reviewer'], { SUBSTRATE_HOLDER: 'core-xt-pi-0fln', XTRM_ROLE: 'reviewer' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/minted only by the review-post path/);
    });

    it('refuses a role other than the session\'s own inside an agent tree', () => {
        const result = runToken(['--repo', 'xtrm-dev/core', '--role', 'coordinator'], { SUBSTRATE_HOLDER: 'core-xt-pi-0fln', XTRM_ROLE: 'worker' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/may not mint a coordinator token/);
    });
});

describe('merge-check reachability and the audit trail (CORE-2528 delta M6)', () => {
    function runMergeCheck(env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
        const result = spawnSync(process.execPath, [CLI, 'identity', 'merge-check', '--repo', 'xtrm-dev/core', '--pr', '42'], {
            encoding: 'utf8',
            env: { ...process.env, ...env },
            timeout: 15000,
            killSignal: 'SIGKILL',
        });
        return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
    }

    it('honours the override when the reviewer token cannot be minted (App absent)', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-noapp-'));
        const state = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-state-'));
        try {
            const result = runMergeCheck({
                HOME: home,
                XDG_STATE_HOME: state,
                XTRM_MERGE_GUARD: 'on',
                SUBSTRATE_HOLDER: 'core-xt-pi-0fln',
                XTRM_ROLE: 'coordinator',
                XTRM_MERGE_GUARD_OVERRIDE: 'validation without the App',
            });
            expect(result.status).toBe(0);
            expect(result.stdout).toMatch(/merge allowed for xtrm-dev\/core#42 by XTRM_MERGE_GUARD_OVERRIDE/);
            const log = path.join(state, 'xtrm', 'merge-guard-override.log');
            expect(fs.readFileSync(log, 'utf8')).toContain('validation without the App');
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
            fs.rmSync(state, { recursive: true, force: true });
        }
    });

    it('refuses an override whose log and Journal writes both fail', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-noapp-'));
        // A regular FILE as the parent: mkdir reports ENOTDIR immediately. Never a
        // /proc path: recursive mkdir spins in the kernel on those (2026-11-09).
        const file = path.join(home, 'not-a-dir');
        fs.writeFileSync(file, 'x');
        try {
            const result = runMergeCheck({
                HOME: home,
                XDG_STATE_HOME: path.join(file, 'state'),
                XTRM_MERGE_GUARD: 'on',
                SUBSTRATE_HOLDER: 'core-xt-pi-0fln',
                XTRM_ROLE: 'coordinator',
                XTRM_MERGE_GUARD_OVERRIDE: 'no audit trail',
            });
            expect(result.status).toBe(1);
            expect(result.stderr).toMatch(/audit trail failed/);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

describe('the credential helper refuses what it must not answer (delta review #3)', () => {
    function runCredential(env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
        const child: NodeJS.ProcessEnv = { ...process.env, ...env };
        // A spread cannot remove a key: delete it from the merged env explicitly.
        for (const key of ['SUBSTRATE_HOLDER', 'XTRM_ROLE']) {
            if (!(key in env)) delete child[key];
        }
        const result = spawnSync(process.execPath, [CLI, 'identity', 'credential', 'get'], {
            encoding: 'utf8',
            env: child,
            input: 'protocol=https\nhost=github.com\npath=xtrm-dev/core.git\n\n',
            timeout: 15000,
            killSignal: 'SIGKILL',
        });
        return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
    }

    it('answers nothing for the reviewer role and says why', () => {
        const result = runCredential({ SUBSTRATE_HOLDER: 'h', XTRM_ROLE: 'reviewer', HOME: os.tmpdir() });
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(/reviewer role does not push/);
    });

    it('writes one stderr line when the session has no role', () => {
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: os.tmpdir() };
        delete env.SUBSTRATE_HOLDER;
        delete env.XTRM_ROLE;
        const result = runCredential(env);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(/no role, so no App credential/);
    });
});

describe('a pathological state directory fails fast (delta batch 3, item 1)', () => {
    it('refuses within seconds on /proc and names the state directory in the refusal', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-noapp-'));
        try {
            const result = spawnSync(
                process.execPath,
                [CLI, 'identity', 'merge-check', '--repo', 'xtrm-dev/core', '--pr', '42'],
                {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        HOME: home,
                        XDG_STATE_HOME: '/proc/self/nope',
                        XTRM_MERGE_GUARD: 'on',
                        SUBSTRATE_HOLDER: 'h',
                        XTRM_ROLE: 'coordinator',
                        XTRM_MERGE_GUARD_OVERRIDE: 'why',
                    },
                    // 5 s: with checkStateDir removed the child hangs in mkdir and is
                    // killed here, so the test goes red instead of blocking the run.
                    timeout: 5000,
                    killSignal: 'SIGKILL',
                },
            );
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(1);
            const stderr = String(result.stderr ?? '');
            expect(stderr).toMatch(/audit trail failed/);
            expect(stderr).toMatch(/\/proc\/self\/nope/);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    }, 10000);
});

describe('a refused override is explained on stderr (batch 4, item 5)', () => {
    it('tells the agent why its override was not honoured', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-noapp-'));
        try {
            const result = spawnSync(
                process.execPath,
                [CLI, 'identity', 'merge-check', '--repo', 'xtrm-dev/core', '--pr', '42'],
                {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        HOME: home,
                        XTRM_MERGE_GUARD: 'on',
                        SUBSTRATE_HOLDER: 'h',
                        XTRM_ROLE: 'worker',
                        XTRM_MERGE_GUARD_OVERRIDE: 'because',
                    },
                    timeout: 15000,
                    killSignal: 'SIGKILL',
                },
            );
            expect(result.status).toBe(1);
            const stderr = String(result.stderr ?? '');
            expect(stderr).toMatch(/override refused/);
            expect(stderr).toMatch(/role worker may not override/);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

describe('merge-check with the guard off needs no App (batch 5, item 5)', () => {
    it('exits 0 without minting anything', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-noapp-'));
        try {
            const result = spawnSync(
                process.execPath,
                [CLI, 'identity', 'merge-check', '--repo', 'xtrm-dev/core', '--pr', '42'],
                {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        HOME: home,
                        SUBSTRATE_HOLDER: 'h',
                        // XTRM_MERGE_GUARD deliberately unset.
                    },
                    timeout: 15000,
                    killSignal: 'SIGKILL',
                },
            );
            const stderr = String(result.stderr ?? '');
            expect(result.status).toBe(0);
            expect(String(result.stdout ?? '') + stderr).toMatch(/merge guard is off/);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

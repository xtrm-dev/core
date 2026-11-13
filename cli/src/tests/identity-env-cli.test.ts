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

import { runSb } from '../commands/identity.js';

const CLI = resolve(__dirname, '..', '..', 'dist', 'index.cjs');

function writeHeadStub(home: string, head = 'd'.repeat(40)): string {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const stub = path.join(bin, 'gh');
    fs.writeFileSync(stub, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'repo') { process.stdout.write(JSON.stringify({ nameWithOwner: 'xtrm-dev/core' })); process.exit(0); }
process.stdout.write(JSON.stringify({ number: 42, headRefOid: '${head}', url: 'https://github.com/xtrm-dev/core/pull/42' }));
`, { mode: 0o755 });
    return stub;
}



function runEnvCommand(input: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
    const env: NodeJS.ProcessEnv = { ...input };
    // CORE-2528: a supervisor-launched session exports these; the test env must
    // not decide any identity outcome.
    for (const key of ['SPECIALISTS_JOB_ID', 'XTRM_SUPERVISOR_LAUNCH', 'XTRM_ROLE', 'XTRM_SPECIALIST_DEFAULT']) delete env[key];
    for (const key of Object.keys(env)) {
        if (key === 'GIT_CONFIG_COUNT' || key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) delete env[key];
    }
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

    it('carries XTRM_AGENT_NAME when the session has one (CORE-2606)', () => {
        const env: NodeJS.ProcessEnv = {
            ...process.env, SUBSTRATE_HOLDER: '0fln', XTRM_AGENT_NAME: 'core-xt-pi-0fln',
        };
        delete env.XTRM_ROLE;
        const result = runEnvCommand(env);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('XTRM_AGENT_NAME=core-xt-pi-0fln');
        // The holder itself is not part of the eval'd env (it is the caller's own).
        expect(result.stdout).not.toContain('SUBSTRATE_HOLDER=');
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
                XTRM_REAL_GH: writeHeadStub(home),
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

    it('records the resolved head in the override log when the App is absent (test first)', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-noapp-'));
        const state = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-state-'));
        const bin = path.join(home, 'bin');
        fs.mkdirSync(bin, { recursive: true });
        const head = 'd'.repeat(40);
        // A stub gh answers the only call the CLI makes: pr view --json number,headRefOid.
        const gh = path.join(bin, 'gh');
        fs.writeFileSync(gh, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ number: 42, headRefOid: '${head}' }));\n`);
        fs.chmodSync(gh, 0o755);
        try {
            const result = runMergeCheck({
                HOME: home,
                XDG_STATE_HOME: state,
                XTRM_MERGE_GUARD: 'on',
                SUBSTRATE_HOLDER: 'core-xt-pi-0fln',
                XTRM_ROLE: 'coordinator',
                XTRM_MERGE_GUARD_OVERRIDE: 'App absent, head still recorded',
                XTRM_REAL_GH: gh,
            });
            expect(result.status).toBe(0);
            const log = fs.readFileSync(path.join(state, 'xtrm', 'merge-guard-override.log'), 'utf8');
            const entry = JSON.parse(log.trim().split('\n').pop() ?? '{}');
            expect(entry.head).toBe(head);
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
                XTRM_REAL_GH: writeHeadStub(home),
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
        writeHeadStub(home);
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
                        XTRM_REAL_GH: path.join(home, 'bin', 'gh'),
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

describe('doctor hard-fails on an invalid role map (M37)', () => {
    it('reports the role map as a hard failure and exits 1', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-badmap-'));
        try {
            fs.mkdirSync(path.join(home, '.xtrm', 'config'), { recursive: true });
            fs.writeFileSync(path.join(home, '.xtrm', 'config', 'identity-role-map.json'), '{not json');
            const result = spawnSync(process.execPath, [CLI, 'identity', 'doctor', '--json'], {
                encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 15000, killSignal: 'SIGKILL',
            });
            expect(result.status).toBe(1);
            const report = JSON.parse(String(result.stdout ?? '{}'));
            const roleMap = report.checks.find((check: { check: string }) => check.check === 'role map');
            expect(roleMap).toMatchObject({ ok: false, hard: true });
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

describe('merge-check refuses an override whose head cannot be resolved (C1)', () => {
    it('fails closed when the stub gh cannot report the PR head', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-nohead-'));
        const bin = path.join(home, 'bin');
        fs.mkdirSync(bin, { recursive: true });
        // A gh that can name the repo but never the PR: no head, no URL.
        const stub = path.join(bin, 'gh');
        fs.writeFileSync(stub, `#!/usr/bin/env bash
if [ "$1" = "repo" ]; then echo '{"nameWithOwner":"xtrm-dev/core"}'; exit 0; fi
if [ "$1" = "pr" ]; then echo '{"number":5}' ; exit 0; fi
echo '{}'
`, { mode: 0o755 });
        try {
            const result = spawnSync(process.execPath, [CLI, 'identity', 'merge-check', '--gh-args', '["pr","merge","5"]', '--json'], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    HOME: home,
                    XTRM_MERGE_GUARD: 'on',
                    XTRM_MERGE_GUARD_OVERRIDE: 'because',
                    XTRM_ROLE: 'coordinator',
                    SUBSTRATE_HOLDER: 'coord',
                    XTRM_REAL_GH: stub,
                },
                timeout: 20000,
                killSignal: 'SIGKILL',
            });
            expect(result.status).toBe(1);
            const decision = JSON.parse(String(result.stdout ?? '{}'));
            expect(decision.allow).toBe(false);
            expect(decision.reason).toMatch(/the reviewed head could not be resolved, so the override is refused/);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

describe('identity doctor without a role map (CORE-2528 remainder)', () => {
    it('says identities are not configured, prints no contradictory role-map line, and still names the Apps', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-nomap-'));
        try {
            const result = spawnSync(process.execPath, [CLI, 'identity', 'doctor', '--json'], {
                encoding: 'utf8',
                env: { ...process.env, HOME: home },
                timeout: 15000,
                killSignal: 'SIGKILL',
            });
            const report = JSON.parse(String(result.stdout ?? '{}'));
            const checks = JSON.stringify(report);
            expect(checks).toContain('identities not configured');
            expect(checks).not.toContain('"check":"role map"');
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

describe('merge-check with the guard off needs no App (batch 5, item 5)', () => {
    it('exits 0 without minting anything', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-noapp-'));
        try {
            // Hermetic (CORE-2528 review, LOW): a developer shell that exports the
            // guard flag, an override, a role or a stub must not decide this test.
            const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SUBSTRATE_HOLDER: 'h' };
            for (const key of ['XTRM_MERGE_GUARD', 'XTRM_MERGE_GUARD_OVERRIDE', 'XTRM_ROLE']) delete env[key];
            for (const key of Object.keys(env)) {
                if (key.startsWith('STUB_')) delete env[key];
            }
            const result = spawnSync(
                process.execPath,
                [CLI, 'identity', 'merge-check', '--repo', 'xtrm-dev/core', '--pr', '42'],
                { encoding: 'utf8', env, timeout: 15000, killSignal: 'SIGKILL' },
            );
            const stderr = String(result.stderr ?? '');
            expect(result.status).toBe(0);
            expect(String(result.stdout ?? '') + stderr).toMatch(/merge guard is off/);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

// CORE-2606: the live receipt warning said only "Journal receipt failed: sb
// exited 1", because sb reports a JSON refusal on STDOUT and leaves stderr
// empty. The warning must name the resolved binary and the reason, and the
// reason must be found on either stream.
describe('the Journal receipt warning names sb and its reason (CORE-2606)', () => {
    function withSbStub(script: string, body: (stub: string) => void): void {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-sbstub-'));
        const stub = path.join(dir, 'sb');
        fs.writeFileSync(stub, script, { mode: 0o755 });
        const previousPath = process.env.PATH;
        process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ''}`;
        try {
            body(stub);
        } finally {
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    it('names the resolved sb path and the stderr text', () => {
        withSbStub('#!/bin/sh\necho "sb: invalid result payload" >&2\nexit 3\n', (stub) => {
            const result = runSb(['journal', 'append', 'CORE-2606', '--kind', 'result']);
            expect(result.ok).toBe(false);
            expect(result.error).toContain(stub);
            expect(result.error).toContain('exited 3');
            expect(result.error).toContain('sb: invalid result payload');
        });
    });

    it('reads the JSON refusal from stdout when stderr is empty (the live case)', () => {
        const refusal = 'invalid result payload: result.verdict is not a bounded result field';
        withSbStub(`#!/bin/sh\necho '${JSON.stringify({ ok: false, error: refusal })}'\nexit 1\n`, (stub) => {
            const result = runSb(['journal', 'append', 'CORE-2606', '--kind', 'result']);
            expect(result.ok).toBe(false);
            expect(result.error).toContain(stub);
            expect(result.error).toContain('exited 1');
            expect(result.error).toContain(`(stdout) ${refusal}`);
        });
    });

    it('says how it knows nothing when both streams are empty', () => {
        withSbStub('#!/bin/sh\nexit 1\n', (stub) => {
            const result = runSb(['journal', 'append', 'CORE-2606']);
            expect(result.ok).toBe(false);
            expect(result.error).toContain(stub);
            expect(result.error).toContain('no stderr and no JSON error on stdout');
        });
    });

    it('reports success without inventing an error', () => {
        withSbStub('#!/bin/sh\nexit 0\n', () => {
            expect(runSb(['journal', 'append', 'CORE-2606'])).toEqual({ ok: true, stdout: '' });
        });
    });
});

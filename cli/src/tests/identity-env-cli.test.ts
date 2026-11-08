// CORE-2525: `xt identity env` is eval-safe. With no holder it must write
// NOTHING to stdout (the prose goes to stderr), so `eval "$(xt identity env)"`
// can never execute a sentence; with a holder it writes KEY=VALUE lines only.
//
// This drives the built CLI (cli/dist/index.cjs, tracked and checked by CI),
// because the property is about the command's streams, not about a helper.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI = resolve(__dirname, '..', '..', 'dist', 'index.cjs');

function runEnvCommand(env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [CLI, 'identity', 'env'], { encoding: 'utf8', env });
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

// CORE-2528 remainder: launch-time identity (review rulings).
//
// The rule: export XTRM_ROLE and the GIT_CONFIG_* transport ONLY when this host
// has the role's App AND an installation for the repo owner; APPEND, never
// replace, the caller's entries; refuse before the worktree only for a
// supervisor launch with no mapping (when a map exists), an invalid role name,
// or an explicit reviewer that cannot get its App on a host where it exists.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseGithubOrigin, preflightLaunchIdentity, resolveLaunchIdentity, roleMapConfigured } from '../core/launch-identity.js';
import { resolveAgentRole } from '../core/identity-roles.js';

let home = '';

function writeFile(file: string, body: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
}

function writeRoleMap(specialists: Record<string, string | null> = { 'pr-reviewer': 'reviewer' }): void {
    writeFile(path.join(home, '.xtrm', 'config', 'identity-role-map.json'), {
        version: 1,
        default: 'worker',
        specialists,
        apps: { worker: 'xtrm-worker', reviewer: 'xtrm-reviewer', coordinator: 'xtrm-coord' },
    });
}

function writeApp(slug: string, installations: Record<string, string>): void {
    writeFile(path.join(home, '.xtrm', 'identities', 'github-apps', slug, 'app.json'), {
        slug,
        appId: '12345',
        owner: 'xtrm-dev',
        installations,
    });
}

function resolve(roleName: string | null, env: NodeJS.ProcessEnv = {}, repo: string | null = 'xtrm-dev/core') {
    return resolveLaunchIdentity({ holder: 'w', roleName, cwd: home, env, deps: { home, repo } });
}

function preflight(roleName: string | null, env: NodeJS.ProcessEnv = {}, repo: string | null = 'xtrm-dev/core') {
    return preflightLaunchIdentity({ roleName, cwd: home, env, deps: { home, repo } });
}

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-launch-id-'));
});

afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
});

describe('no role map: identities are not configured', () => {
    it('exports nothing, refuses nothing, and says why for a named role', () => {
        expect(roleMapConfigured(home)).toBe(false);
        const result = resolve('chain-coordinator');
        expect(result.configured).toBe(false);
        expect(result.env).toEqual({});
        expect(result.refused).toBeNull();
        expect(result.note).toMatch(/role chain-coordinator has no identity mapping/);
    });

    it('never refuses a supervisor launch when nothing is configured', () => {
        const result = resolve(null, { SPECIALISTS_JOB_ID: 'job-1' });
        expect(result.refused).toBeNull();
        expect(result.env).toEqual({});
    });
});

describe('only the reviewer App exists (today)', () => {
    beforeEach(() => {
        writeRoleMap();
        writeApp('xtrm-reviewer', { 'xtrm-dev': '42' });
    });

    it('exports nothing for a worker and adds nothing it does not own', () => {
        const result = resolve(null);
        expect(result.configured).toBe(true);
        expect(result.exported).toBe(false);
        expect(result.env).toEqual({});
        // A plain worker launch is not a request for an identity: no stderr noise.
        expect(result.note).toBeNull();
    });

    it('exports nothing for a coordinator', () => {
        expect(resolve('coordinator').env).toEqual({});
    });

    it('appends the reviewer transport to the entries already in the environment', () => {
        const env = {
            GIT_CONFIG_COUNT: '2',
            GIT_CONFIG_KEY_0: 'http.proxy',
            GIT_CONFIG_VALUE_0: 'http://proxy:3128',
            GIT_CONFIG_KEY_1: 'credential.helper',
            GIT_CONFIG_VALUE_1: 'store',
        };
        const result = resolve('reviewer', env);
        expect(result.exported).toBe(true);
        expect(result.env.XTRM_ROLE).toBe('reviewer');
        expect(result.env.GIT_CONFIG_COUNT).toBe('7');
        expect(result.env.GIT_CONFIG_KEY_2).toBe('url.https://github.com/.insteadOf');
        expect(result.env.GIT_CONFIG_KEY_6).toBe('credential.https://github.com.useHttpPath');
        // The inherited entries are not rewritten by this layer.
        expect(result.env.GIT_CONFIG_KEY_0).toBeUndefined();
        expect(result.env.GIT_CONFIG_KEY_1).toBeUndefined();
    });

    it('refuses an explicit reviewer whose installation is for another account', () => {
        const result = resolve('reviewer', {}, 'somebody-else/core');
        expect(result.refused).toMatch(/refusing to launch a reviewer with the operator identity/);
        expect(result.env).toEqual({});
    });

    it('does not refuse a reviewer when the App is not configured at all (today)', () => {
        fs.rmSync(path.join(home, '.xtrm', 'identities', 'github-apps', 'xtrm-reviewer'), { recursive: true, force: true });
        const result = resolve('reviewer');
        expect(result.refused).toBeNull();
        expect(result.note).toMatch(/no xtrm-reviewer App is configured/);
    });

    it('refuses an explicit reviewer when the origin cannot be read (App present)', () => {
        const result = resolve('reviewer', {}, null);
        expect(result.refused).toMatch(/no github\.com origin/);
    });
});

describe('role resolution matches the runtime', () => {
    beforeEach(() => {
        writeRoleMap();
        writeApp('xtrm-reviewer', { 'xtrm-dev': '42' });
    });

    it('maps --role pr-reviewer to reviewer', () => {
        const result = resolve('pr-reviewer');
        expect(result.role).toBe('reviewer');
        expect(result.env.XTRM_ROLE).toBe('reviewer');
    });

    it('does not refuse an interactive unmapped role; it launches as today and says so', () => {
        const result = resolve('chain-coordinator');
        expect(result.refused).toBeNull();
        expect(result.env).toEqual({});
        expect(result.note).toMatch(/launching with the operator identity/);
        expect(preflight('chain-coordinator').refused).toBeNull();
        expect(preflight('chain-coordinator').warning).toMatch(/launching with the operator identity/);
    });

    it('refuses an invalid role identifier before anything is created', () => {
        for (const bad of ['../evil', 'a/b', '--force', 'space name']) {
            expect(resolve(bad).refused).toMatch(/not a valid role or specialist name/);
        }
    });

    it('never treats prototype keys as mapped specialists', () => {
        for (const key of ['constructor', '__proto__', 'toString']) {
            const result = resolve(null, { XTRM_ROLE: key });
            expect(result.refused).toBeNull();
            expect(result.env).toEqual({});
        }
    });

    it('uses the runtime rule for a null specialist entry', () => {
        writeRoleMap({ 'pr-reviewer': null, reviewer: null });
        const result = resolve(null, { XTRM_ROLE: 'reviewer' });
        expect(result.role).toBeNull();
        expect(result.env).toEqual({});
    });

    it('ignores the specialist default unless the launch is supervisor-driven', () => {
        expect(resolve(null, { XTRM_SPECIALIST_DEFAULT: 'pr-reviewer' }).env).toEqual({});
        expect(resolve(null, { XTRM_SPECIALIST_DEFAULT: 'pr-reviewer', SPECIALISTS_JOB_ID: 'job-1' }).env.XTRM_ROLE).toBe('reviewer');
        expect(resolve(null, { XTRM_SPECIALIST_DEFAULT: 'pr-reviewer', XTRM_SUPERVISOR_LAUNCH: '1' }).env.XTRM_ROLE).toBe('reviewer');
    });

    it('refuses a supervisor launch with no role at all', () => {
        const result = resolve(null, { SPECIALISTS_JOB_ID: 'job-1' });
        expect(result.refused).toMatch(/supervisor-launched activation names no role/);
    });

    it('refuses an unmapped specialist in a supervisor launch', () => {
        const result = resolve(null, { SPECIALISTS_JOB_ID: 'job-1', XTRM_ROLE: 'mystery-specialist' });
        expect(result.refused).toMatch(/no role mapping/);
    });

    it('behaves as today for an interactive launch with no name', () => {
        expect(resolve(null).role).toBe('worker');
        expect(resolve(null).refused).toBeNull();
    });
});

describe('cap, parity and silence (PR C1)', () => {
    beforeEach(() => {
        writeRoleMap();
        writeApp('xtrm-reviewer', { 'xtrm-dev': '42' });
    });

    it('caps an absurd inherited count instead of walking it', () => {
        const started = Date.now();
        const result = resolveLaunchIdentity({
            holder: 'w', roleName: 'reviewer', cwd: home,
            env: { GIT_CONFIG_COUNT: '99999999999' }, deps: { home, repo: 'xtrm-dev/core' },
            forwardInherited: true,
        });
        expect(Date.now() - started).toBeLessThan(2000);
        expect(result.env.GIT_CONFIG_COUNT).toBe('5');
        expect(result.note).toMatch(/exceeds 1024; ignoring the inherited entries/);
    });

    it('agrees with the runtime on a self-contradictory map', () => {
        fs.writeFileSync(path.join(home, '.xtrm', 'config', 'identity-role-map.json'), JSON.stringify({
            version: 1, default: 'worker', specialists: { reviewer: null, 'pr-reviewer': 'reviewer' },
            apps: { worker: 'xtrm-worker', reviewer: 'xtrm-reviewer', coordinator: 'xtrm-coord' },
        }));
        // `reviewer` is deliberately null; `pr-reviewer` maps to reviewer. The role
        // itself always comes from resolveAgentRole, so the two cannot disagree.
        expect(resolve('pr-reviewer').role).toBe('reviewer');
        expect(resolve('reviewer').role).toBeNull();
        expect(resolve(null, { XTRM_ROLE: 'reviewer' }).role).toBeNull();
        expect(resolve(null, { XTRM_ROLE: 'pr-reviewer' }).role).toBe('reviewer');
    });

    it('stays silent for an inherited worker marker on an unconfigured host', () => {
        fs.rmSync(path.join(home, '.xtrm'), { recursive: true, force: true });
        const result = resolveLaunchIdentity({ holder: 'w', roleName: null, cwd: home, env: { XTRM_ROLE: 'worker' }, deps: { home, repo: 'xtrm-dev/core' } });
        expect(result.note).toBeNull();
        // An explicit request on the same host still explains itself.
        expect(resolveLaunchIdentity({ holder: 'w', roleName: 'pr-reviewer', cwd: home, env: {}, deps: { home, repo: 'xtrm-dev/core' } }).note).toMatch(/no identity mapping/);
    });
});

describe('prototype pollution', () => {
    it('does not resolve a specialist injected on Object.prototype', () => {
        writeRoleMap();
        writeApp('xtrm-reviewer', { 'xtrm-dev': '42' });
        (Object.prototype as Record<string, unknown>).ghost = 'reviewer';
        try {
            const result = resolve('ghost');
            expect(result.role).toBeNull();
            expect(result.env).toEqual({});
            expect(result.refused).toBeNull();
        } finally {
            delete (Object.prototype as Record<string, unknown>).ghost;
        }
    });
});

describe('invalid role map (item 4)', () => {
    it('warns on a plain launch when the map file exists but cannot be parsed', () => {
        writeFile(path.join(home, '.xtrm', 'config', 'identity-role-map.json'), '{not json');
        const result = resolveLaunchIdentity({ holder: 'w', roleName: null, cwd: home, env: {}, deps: { home, repo: 'xtrm-dev/core' } });
        expect(result.configured).toBe(true);
        expect(result.env).toEqual({});
        expect(result.note).toMatch(/role map invalid at .* launching with the operator identity/);
    });
});

describe('append details from the review', () => {
    beforeEach(() => {
        writeRoleMap();
        writeApp('xtrm-reviewer', { 'xtrm-dev': '42' });
    });

    it('treats a non-numeric GIT_CONFIG_COUNT as 0 and says so', () => {
        const result = resolve('reviewer', { GIT_CONFIG_COUNT: '3abc', GIT_CONFIG_KEY_0: 'http.proxy' });
        expect(result.env.GIT_CONFIG_COUNT).toBe('5');
        expect(result.note).toMatch(/is not a number; treating it as 0/);
    });

    it('forwards the inherited entries for a tmux -e list (count 3)', () => {
        const env = {
            GIT_CONFIG_COUNT: '3',
            GIT_CONFIG_KEY_0: 'http.proxy',
            GIT_CONFIG_VALUE_0: 'http://proxy:3128',
            GIT_CONFIG_KEY_1: 'credential.helper',
            GIT_CONFIG_VALUE_1: 'store',
            GIT_CONFIG_KEY_2: 'safe.directory',
            GIT_CONFIG_VALUE_2: '*',
        };
        const result = resolveLaunchIdentity({ holder: 'w', roleName: 'reviewer', cwd: home, env, deps: { home, repo: 'xtrm-dev/core' }, forwardInherited: true });
        expect(result.env.GIT_CONFIG_COUNT).toBe('8');
        expect(result.env.GIT_CONFIG_KEY_0).toBe('http.proxy');
        expect(result.env.GIT_CONFIG_VALUE_2).toBe('*');
        expect(result.env.GIT_CONFIG_KEY_3).toBe('url.https://github.com/.insteadOf');
        expect(result.env.GIT_CONFIG_KEY_7).toBe('credential.https://github.com.useHttpPath');
    });

    it('does not forward inherited entries on a direct spawn (the env is inherited)', () => {
        const result = resolve('reviewer', { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.proxy', GIT_CONFIG_VALUE_0: 'x' });
        expect(result.env.GIT_CONFIG_COUNT).toBe('6');
        expect(result.env.GIT_CONFIG_KEY_0).toBeUndefined();
    });

    it('refuses a case-only near miss with a suggestion', () => {
        const result = resolve('Reviewer');
        expect(result.refused).toMatch(/did you mean 'reviewer'/);
        expect(resolve('PR-Reviewer').refused).toMatch(/did you mean 'pr-reviewer'/);
    });

    it('treats an explicitly requested null-mapped specialist as "no role", not a typo', () => {
        fs.writeFileSync(path.join(home, '.xtrm', 'config', 'identity-role-map.json'), JSON.stringify({
            version: 1, default: 'worker', specialists: { 'pr-reviewer': null },
            apps: { worker: 'xtrm-worker', reviewer: 'xtrm-reviewer', coordinator: 'xtrm-coord' },
        }));
        const result = resolve('pr-reviewer');
        expect(result.role).toBeNull();
        expect(result.refused).toBeNull();
        expect(result.note).toMatch(/pr-reviewer is mapped to no role/);
    });

    it('matches resolveAgentRole for every input (198-case table)', () => {
        const names = [
            'worker', 'reviewer', 'coordinator', 'pr-reviewer', 'seconder', 'reviewer-subagent',
            'chain-coordinator', 'mystery', 'Constructor', 'toString', '', 'a/b', '../x', '--force',
            'has space', 'UPPER', 'with.dots', 'with_underscores', 'with-dashes', 'x1', '1x', 'very-long-but-valid-name',
        ];
        const maps = [
            { 'pr-reviewer': 'reviewer', 'seconder': 'reviewer' },
            { 'pr-reviewer': null, 'seconder': 'reviewer' },
            { reviewer: null },
            { coordinator: 'reviewer' },
            { worker: 'reviewer', reviewer: 'worker' },
            { 'pr-reviewer': 'reviewer', 'chain-coordinator': 'coordinator', 'mystery': null },
            { 'Reviewer': 'reviewer' },
            {},
            { 'pr-reviewer': 'reviewer', 'pr-reviewer ': 'worker' },
        ] as Array<Record<string, string | null>>;
        let compared = 0;
        for (const specialists of maps) {
            fs.writeFileSync(path.join(home, '.xtrm', 'config', 'identity-role-map.json'), JSON.stringify({
                version: 1, default: 'worker', specialists, apps: { worker: 'xtrm-worker', reviewer: 'xtrm-reviewer', coordinator: 'xtrm-coord' },
            }));
            const map = { version: 1, default: 'worker' as const, specialists, apps: { worker: 'xtrm-worker', reviewer: 'xtrm-reviewer', coordinator: 'xtrm-coord' } };
            for (const name of names) {
                // Explicit --role and the hand-set marker must agree with the runtime.
                const explicit = resolveLaunchIdentity({ holder: 'w', roleName: name, cwd: home, env: {}, deps: { home, repo: 'xtrm-dev/core' } });
                const handSet = resolveLaunchIdentity({ holder: 'w', roleName: null, cwd: home, env: { XTRM_ROLE: name }, deps: { home, repo: 'xtrm-dev/core' } });
                const runtime = resolveAgentRole(name, map as never);
                if (!explicit.refused) expect(explicit.role).toBe(runtime);
                if (!handSet.refused) expect(handSet.role).toBe(runtime);
                compared += 2;
            }
        }
        // 9 maps x 22 names x 2 forms (explicit --role, hand-set marker) = 396 comparisons.
        expect(compared).toBe(396);
    });
});

describe('origin parsing', () => {
    it('accepts every github.com spelling and rejects other hosts', () => {
        const cases: Array<[string, string | null]> = [
            ['git@github.com:xtrm-dev/core.git', 'xtrm-dev/core'],
            ['git@github.com:xtrm-dev/core', 'xtrm-dev/core'],
            ['ssh://git@github.com/xtrm-dev/core.git', 'xtrm-dev/core'],
            ['ssh://git@github.com:22/xtrm-dev/core', 'xtrm-dev/core'],
            ['https://github.com/xtrm-dev/core', 'xtrm-dev/core'],
            ['https://user:token@github.com/xtrm-dev/core.git/', 'xtrm-dev/core'],
            ['https://www.github.com/xtrm-dev/core/', 'xtrm-dev/core'],
            ['git://github.com/xtrm-dev/core.git', 'xtrm-dev/core'],
            ['https://gitlab.com/xtrm-dev/core.git', null],
            ['git@gitlab.com:xtrm-dev/core.git', null],
            ['', null],
        ];
        for (const [url, expected] of cases) expect(parseGithubOrigin(url)).toBe(expected);
    });
});

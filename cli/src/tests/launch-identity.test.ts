// CORE-2528 remainder: launch-time identity.
//
// The rule under test (core-85 ruling): a launch exports XTRM_ROLE and the
// GIT_CONFIG_* transport rewrite ONLY when this host has the role's App AND an
// installation for the repo owner. Every other case keeps today's behaviour —
// holder and git author only — because only xtrm-reviewer exists today and
// rewriting transport without an App would break `git push` for workers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveLaunchIdentity, roleMapConfigured } from '../core/launch-identity.js';

let home = '';

function writeFile(file: string, body: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
}

function writeRoleMap(specialists: Record<string, string> = { 'pr-reviewer': 'reviewer' }): void {
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

function resolve(roleName: string | null, env: NodeJS.ProcessEnv = {}, repo = 'xtrm-dev/core') {
    return resolveLaunchIdentity({ holder: 'w', roleName, cwd: home, env, deps: { home, repo } });
}

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-launch-id-'));
});

afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
});

describe('no role map: identities are not configured', () => {
    it('exports nothing and never refuses, whatever the role', () => {
        expect(roleMapConfigured(home)).toBe(false);
        const result = resolve('worker');
        expect(result.configured).toBe(false);
        expect(result.env).toEqual({});
        expect(result.refused).toBeNull();
        expect(result.note).toMatch(/identities not configured/);
    });

    it('does not refuse a supervisor launch either', () => {
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

    it('exports nothing for a worker: byte-identical to today apart from holder and git author', () => {
        const result = resolve('worker');
        expect(result.configured).toBe(true);
        expect(result.exported).toBe(false);
        expect(result.env).toEqual({});
        expect(result.note).toMatch(/no xtrm-worker App is configured/);
    });

    it('exports nothing for a coordinator', () => {
        expect(resolve('coordinator').env).toEqual({});
    });

    it('exports the role and the transport for a reviewer whose installation matches', () => {
        const result = resolve('reviewer');
        expect(result.exported).toBe(true);
        expect(result.env.XTRM_ROLE).toBe('reviewer');
        expect(result.env.GIT_CONFIG_COUNT).toBe('5');
        expect(result.env.GIT_CONFIG_KEY_2).toBe('credential.https://github.com.helper');
    });

    it('exports nothing when the installation is for another account', () => {
        const result = resolve('reviewer', {}, 'somebody-else/core');
        expect(result.exported).toBe(false);
        expect(result.env).toEqual({});
        expect(result.note).toMatch(/not installed for somebody-else/);
    });

    it('exports nothing when the worktree has no github.com origin', () => {
        const result = resolveLaunchIdentity({ holder: 'w', roleName: 'reviewer', cwd: home, deps: { home, repo: null } });
        expect(result.exported).toBe(false);
        expect(result.note).toMatch(/no github\.com origin/);
    });
});

describe('role resolution', () => {
    beforeEach(() => {
        writeRoleMap();
        writeApp('xtrm-reviewer', { 'xtrm-dev': '42' });
    });

    it('maps --role pr-reviewer to reviewer', () => {
        const result = resolve('pr-reviewer');
        expect(result.role).toBe('reviewer');
        expect(result.env.XTRM_ROLE).toBe('reviewer');
    });

    it('refuses an unknown --role and lists the mapped specialists', () => {
        const result = resolve('nonsense');
        expect(result.refused).toMatch(/neither a role/);
        expect(result.refused).toMatch(/pr-reviewer/);
        expect(result.env).toEqual({});
    });

    it('refuses an unmapped specialist in a supervisor launch (configured host)', () => {
        const result = resolve(null, { SPECIALISTS_JOB_ID: 'job-1', XTRM_ROLE: 'mystery-specialist' });
        expect(result.refused).toMatch(/no role mapping/);
        expect(result.note).toBeNull();
    });

    it('accepts the supervisor default when it is mapped', () => {
        const result = resolve(null, { SPECIALISTS_JOB_ID: 'job-1', XTRM_SPECIALIST_DEFAULT: 'pr-reviewer' });
        expect(result.role).toBe('reviewer');
        expect(result.env.XTRM_ROLE).toBe('reviewer');
    });

    it('never lets a hand-set role be overridden by the default', () => {
        const result = resolve(null, { XTRM_ROLE: 'reviewer', XTRM_SPECIALIST_DEFAULT: 'worker' });
        expect(result.role).toBe('reviewer');
    });

    it('behaves as today for an interactive launch with no name', () => {
        expect(resolve(null).role).toBe('worker');
        expect(resolve(null).refused).toBeNull();
    });
});

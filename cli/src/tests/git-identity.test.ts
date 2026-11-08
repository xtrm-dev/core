// CORE-2525: the git author env an agent session carries. Hermetic: the git
// config lookup is injected, and the dispatcher env is built from a fake
// process table (see dispatcher-identity.test.ts for the fixture shape).

import { describe, expect, it } from 'vitest';

import {
    buildDispatcherEnv,
    DISPATCHER_ENV_KEYS,
    stripDispatcherEnv,
    type ProcessInfo,
} from '../core/dispatcher-identity.js';
import { buildGitIdentityEnv, GIT_IDENTITY_ENV_KEYS, resolveGitEmail } from '../core/git-identity.js';
import { readIdentityEnv } from '../commands/identity.js';

const TABLE: Record<number, ProcessInfo> = {
    300: { ppid: 200, startTime: '30' },
    200: { ppid: 100, startTime: '20' },
    100: { ppid: 1, startTime: '10' },
};
const readProcess = (pid: number): ProcessInfo | null => TABLE[pid] ?? null;
const noTmux = () => ({ status: 1, stdout: '' });
const deps = { startPid: 300, readProcess, sessionsDir: '/nonexistent/sessions', env: {}, tmux: noTmux };

describe('resolveGitEmail', () => {
    it('returns the configured address', () => {
        const got = resolveGitEmail({ run: () => ({ status: 0, stdout: 'op@example.com\n' }) });
        expect(got).toBe('op@example.com');
    });

    it('treats a missing or unusable value as unknown', () => {
        expect(resolveGitEmail({ run: () => ({ status: 1, stdout: '' }) })).toBeNull();
        expect(resolveGitEmail({ run: () => ({ status: 0, stdout: '   \n' }) })).toBeNull();
        expect(resolveGitEmail({ run: () => ({ status: 0, stdout: 'not an email\n' }) })).toBeNull();
    });

    it('survives a throwing runner', () => {
        expect(resolveGitEmail({ run: () => { throw new Error('git missing'); } })).toBeNull();
    });
});

describe('buildGitIdentityEnv', () => {
    it('names author and committer after the holder and sets one email for both', () => {
        expect(buildGitIdentityEnv({ holder: 'core-85', email: 'op@example.com' })).toEqual({
            GIT_AUTHOR_NAME: 'core-85',
            GIT_COMMITTER_NAME: 'core-85',
            GIT_AUTHOR_EMAIL: 'op@example.com',
            GIT_COMMITTER_EMAIL: 'op@example.com',
        });
    });

    it('leaves the email unset when unknown, so git keeps its own resolution', () => {
        expect(buildGitIdentityEnv({ holder: 'core-85', email: null })).toEqual({
            GIT_AUTHOR_NAME: 'core-85',
            GIT_COMMITTER_NAME: 'core-85',
        });
    });

    it('emits nothing without a holder (no placeholder identity)', () => {
        expect(buildGitIdentityEnv({ holder: '', email: 'op@example.com' })).toEqual({});
        expect(buildGitIdentityEnv({ holder: null })).toEqual({});
    });
});

describe('buildDispatcherEnv git identity', () => {
    it('adds the four git variables when the launcher supplies the email', () => {
        const out = buildDispatcherEnv('worker-a', { ...deps, gitEmail: 'op@example.com' });
        expect(out).toEqual({
            SUBSTRATE_HOLDER: 'worker-a',
            GIT_AUTHOR_NAME: 'worker-a',
            GIT_COMMITTER_NAME: 'worker-a',
            GIT_AUTHOR_EMAIL: 'op@example.com',
            GIT_COMMITTER_EMAIL: 'op@example.com',
        });
    });

    it('sets the names but no email when the email is unknown', () => {
        const out = buildDispatcherEnv('worker-a', { ...deps, gitEmail: null });
        expect(out.GIT_AUTHOR_NAME).toBe('worker-a');
        expect('GIT_AUTHOR_EMAIL' in out).toBe(false);
    });

    it('emits no git identity when the caller passes no email source', () => {
        expect(buildDispatcherEnv('worker-a', deps)).toEqual({ SUBSTRATE_HOLDER: 'worker-a' });
    });

    it('never inherits the dispatcher git identity as the worker identity', () => {
        const inherited = { GIT_AUTHOR_NAME: 'dispatcher', GIT_AUTHOR_EMAIL: 'disp@example.com' };
        const merged = { ...stripDispatcherEnv(inherited), ...buildDispatcherEnv('worker-a', { ...deps, gitEmail: 'op@example.com' }) };
        expect(merged.GIT_AUTHOR_NAME).toBe('worker-a');
        expect(merged.GIT_AUTHOR_EMAIL).toBe('op@example.com');
    });
});

describe('DISPATCHER_ENV_KEYS', () => {
    it('strips every git identity key from inherited env', () => {
        const keys = new Set<string>(DISPATCHER_ENV_KEYS);
        for (const key of GIT_IDENTITY_ENV_KEYS) expect(keys.has(key)).toBe(true);
        const stripped = stripDispatcherEnv({ GIT_AUTHOR_NAME: 'x', GIT_COMMITTER_EMAIL: 'y@z' });
        expect(stripped).toEqual({});
    });
});

describe('readIdentityEnv', () => {
    it('reports no identity for an operator session', () => {
        expect(readIdentityEnv({}, '/tmp')).toEqual({ holder: null, env: {} });
    });

    it('reports the holder and its git env', () => {
        const got = readIdentityEnv({ SUBSTRATE_HOLDER: 'worker-a' }, process.cwd());
        expect(got.holder).toBe('worker-a');
        expect(got.env.GIT_AUTHOR_NAME).toBe('worker-a');
        expect(got.env.GIT_COMMITTER_NAME).toBe('worker-a');
    });
});

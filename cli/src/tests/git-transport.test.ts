// CORE-2528: the git transport env and the credential helper. The helper must
// answer for the role's App and for nothing else — never the operator's key.

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    GIT_CONFIG_ENV_KEYS,
    buildGitTransportEnv,
    credentialAppFor,
    credentialResponse,
    parseCredentialRequest,
} from '../core/git-transport.js';
import { DEFAULT_ROLE_MAP } from '../core/identity-roles.js';
import { githubAppPaths } from '../core/github-apps.js';

let home = '';
let runtimeDir = '';

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-transport-home-'));
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-transport-run-'));
});
afterEach(() => {
    fs.removeSync(home);
    fs.removeSync(runtimeDir);
});

function writeApp(slug: string): void {
    const file = githubAppPaths(home, runtimeDir).appFile(slug);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeJsonSync(file, { slug, appId: '1', owner: 'xtrm-dev', installations: { 'xtrm-dev': '9' } });
}

describe('buildGitTransportEnv', () => {
    it('is empty for an operator and for a role whose App does not exist', () => {
        expect(buildGitTransportEnv({ role: null, deps: { home, runtimeDir } })).toEqual({});
        expect(buildGitTransportEnv({ role: 'worker', deps: { home, runtimeDir } })).toEqual({});
    });

    it('routes github.com over https through the credential helper for a configured role', () => {
        writeApp('xtrm-reviewer');
        const env = buildGitTransportEnv({ role: 'reviewer', map: DEFAULT_ROLE_MAP, deps: { home, runtimeDir } });
        expect(env.GIT_CONFIG_COUNT).toBe('3');
        expect(Object.keys(env).sort()).toEqual([...GIT_CONFIG_ENV_KEYS(3)].sort());
        expect(env.GIT_CONFIG_KEY_0).toBe('url.https://github.com/.insteadOf');
        expect(env.GIT_CONFIG_VALUE_0).toBe('git@github.com:');
        expect(env.GIT_CONFIG_VALUE_1).toBe('ssh://git@github.com/');
        expect(env.GIT_CONFIG_KEY_2).toBe('credential.https://github.com.helper');
        expect(env.GIT_CONFIG_VALUE_2).toBe('!xt identity credential');
        expect(JSON.stringify(env)).not.toContain('ghs_');
    });
});

describe('parseCredentialRequest', () => {
    it('reads the git credential protocol and tolerates blank/invalid lines', () => {
        const request = parseCredentialRequest('protocol=https\nhost=github.com\n\npath=xtrm-dev/core.git\nusername=git\nbadline\n');
        expect(request).toEqual({ protocol: 'https', host: 'github.com', path: 'xtrm-dev/core.git', username: 'git' });
        expect(parseCredentialRequest('')).toEqual({});
    });
});

describe('credentialAppFor', () => {
    it('answers only for https github.com owner repositories', () => {
        const request = { protocol: 'https', host: 'github.com', path: 'xtrm-dev/core.git' };
        expect(credentialAppFor(request, 'reviewer', DEFAULT_ROLE_MAP)).toEqual({ slug: 'xtrm-reviewer', account: 'xtrm-dev' });
        expect(credentialAppFor({ ...request, path: 'XTRM-DEV/core' }, 'worker', DEFAULT_ROLE_MAP))
            .toEqual({ slug: 'xtrm-worker', account: 'XTRM-DEV' });
    });

    it('stays silent for another host, ssh, a path without an owner, or no role', () => {
        expect(credentialAppFor({ protocol: 'https', host: 'gitlab.com', path: 'a/b' }, 'reviewer')).toBeNull();
        expect(credentialAppFor({ protocol: 'ssh', host: 'github.com', path: 'a/b' }, 'reviewer')).toBeNull();
        expect(credentialAppFor({ protocol: 'https', host: 'github.com', path: 'core.git' }, 'reviewer')).toBeNull();
        expect(credentialAppFor({ protocol: 'https', host: 'github.com', path: 'a/b' }, null)).toBeNull();
        expect(credentialAppFor({ protocol: 'https', host: 'github.com', path: 'a/b' }, 'reviewer', null)).toBeNull();
    });

    it('refuses when the role map itself is invalid', () => {
        expect(credentialAppFor({ protocol: 'https', host: 'github.com', path: 'a/b' }, 'reviewer', null)).toBeNull();
    });
});

describe('credentialResponse', () => {
    it('is the git credential protocol answer for a GitHub App token', () => {
        expect(credentialResponse('ghs_abc')).toBe('username=x-access-token\npassword=ghs_abc\n');
    });
});

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
        expect(env.GIT_CONFIG_COUNT).toBe('5');
        expect(Object.keys(env).sort()).toEqual([...GIT_CONFIG_ENV_KEYS(5)].sort());
        expect(env.GIT_CONFIG_KEY_0).toBe('url.https://github.com/.insteadOf');
        expect(env.GIT_CONFIG_VALUE_0).toBe('git@github.com:');
        expect(env.GIT_CONFIG_VALUE_1).toBe('ssh://git@github.com/');
        // The empty entry resets a global helper (`gh auth setup-git`) before ours.
        expect(env.GIT_CONFIG_KEY_2).toBe('credential.https://github.com.helper');
        expect(env.GIT_CONFIG_VALUE_2).toBe('');
        expect(env.GIT_CONFIG_KEY_3).toBe('credential.https://github.com.helper');
        expect(env.GIT_CONFIG_VALUE_3).toBe('!xt identity credential');
        // Git sends `path` to a helper only with useHttpPath; the helper needs it.
        expect(env.GIT_CONFIG_KEY_4).toBe('credential.https://github.com.useHttpPath');
        expect(env.GIT_CONFIG_VALUE_4).toBe('true');
        expect(JSON.stringify(env)).not.toContain('ghs_');
    });
});

describe('real git credential behaviour', () => {
    it('sends path to the helper and ignores a competing global helper', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-cred-'));
        try {
            const logged = path.join(dir, 'helper.stdin');
            const helper = path.join(dir, 'helper.sh');
            fs.writeFileSync(helper, `#!/bin/sh\ncat > ${JSON.stringify(logged)}\nprintf 'username=agent\\npassword=from-app\\n'\n`, { mode: 0o755 });
            const globalHelper = path.join(dir, 'global.sh');
            fs.writeFileSync(globalHelper, `#!/bin/sh\ncat > /dev/null\nprintf 'username=operator\\npassword=operator-token\\n'\n`, { mode: 0o755 });
            const globalConfig = path.join(dir, 'gitconfig');
            fs.writeFileSync(globalConfig, `[credential "https://github.com"]\n\thelper = ${globalHelper}\n`);

            // The same shape buildGitTransportEnv emits: reset, ours, useHttpPath.
            const env = {
                ...process.env,
                GIT_CONFIG_GLOBAL: globalConfig,
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_COUNT: '3',
                GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
                GIT_CONFIG_VALUE_0: '',
                GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
                GIT_CONFIG_VALUE_1: helper,
                GIT_CONFIG_KEY_2: 'credential.https://github.com.useHttpPath',
                GIT_CONFIG_VALUE_2: 'true',
            };
            const result = require('node:child_process').spawnSync('git', ['credential', 'fill'], {
                encoding: 'utf8',
                env,
                input: 'protocol=https\nhost=github.com\npath=xtrm-dev/core.git\n\n',
            });
            expect(result.status).toBe(0);
            // git only sends path with useHttpPath: the helper can scope itself.
            expect(fs.readFileSync(logged, 'utf8')).toContain('path=xtrm-dev/core.git');
            // The reset kept the global helper (the operator's token) out.
            expect(result.stdout).toContain('username=agent');
            expect(result.stdout).not.toContain('operator-token');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
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

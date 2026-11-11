// CORE-2528: GitHub App config, JWT and installation tokens. Hermetic: a
// generated RSA key, a temp HOME/runtime dir, and an injected fetch.

import { createVerify, generateKeyPairSync } from 'node:crypto';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    buildAppJwt,
    fileMode,
    githubAppPaths,
    installationForRepo,
    mintInstallationToken,
    readAppConfig,
    repoOwner,
    GitHubAppError,
} from '../core/github-apps.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

let home = '';
let runtimeDir = '';

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-apps-home-'));
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-apps-run-'));
});

afterEach(() => {
    fs.removeSync(home);
    fs.removeSync(runtimeDir);
});

function writeApp(slug: string, body: Record<string, unknown> = {}): string {
    const file = githubAppPaths(home, runtimeDir).appFile(slug);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeJsonSync(file, { slug, appId: '4711', owner: 'xtrm-dev', installations: { 'xtrm-dev': '99', Other: 100 }, ...body });
    const keyFile = path.join(home, '.secrets', 'github-apps', `${slug}.pem`);
    fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyFile, PEM, { mode: 0o600 });
    return keyFile;
}

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function fetchReturning(reply: (call: Call) => { status: number; data: unknown }, calls: Call[] = []) {
    return async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
        const call: Call = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body };
        calls.push(call);
        const result = reply(call);
        return { status: result.status, json: async () => result.data };
    };
}

describe('repoOwner', () => {
    it('refuses a dot or dot-dot repository part', () => {
        expect(repoOwner('xtrm-dev/core')).toBe('xtrm-dev');
        expect(repoOwner('xtrm-dev/.')).toBeNull();
        expect(repoOwner('xtrm-dev/..')).toBeNull();
        expect(repoOwner('../core')).toBeNull();
    });
});

describe('buildAppJwt', () => {
    it('signs RS256 with iss=appId and a sub-10-minute lifetime', () => {
        const jwt = buildAppJwt('4711', PEM, 1_700_000_000_000);
        const [header, payload, signature] = jwt.split('.');
        const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
        expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
        const claims = decode(payload);
        expect(claims.iss).toBe('4711');
        expect(claims.exp - claims.iat).toBe(600);
        const verifier = createVerify('RSA-SHA256');
        verifier.update(`${header}.${payload}`);
        expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    });
});

describe('readAppConfig', () => {
    it('reads a valid app.json and normalises numeric installation ids', () => {
        writeApp('xtrm-reviewer');
        const config = readAppConfig('xtrm-reviewer', { home, runtimeDir });
        expect(config?.appId).toBe('4711');
        expect(config?.installations).toEqual({ 'xtrm-dev': '99', Other: '100' });
        expect(config?.keyPath).toBe(path.join(home, '.secrets', 'github-apps', 'xtrm-reviewer.pem'));
    });

    it('returns null for a missing file, wrong slug or missing appId', () => {
        expect(readAppConfig('xtrm-reviewer', { home, runtimeDir })).toBeNull();
        writeApp('xtrm-coord');
        expect(readAppConfig('xtrm-reviewer', { home, runtimeDir })).toBeNull();
        writeApp('xtrm-worker', { appId: '' });
        expect(readAppConfig('xtrm-worker', { home, runtimeDir })).toBeNull();
    });
});

describe('installationForRepo', () => {
    const config = {
        slug: 'xtrm-reviewer', appId: '1', owner: 'xtrm-dev', keyPath: '/k',
        installations: { 'xtrm-dev': '99' },
    };
    it('matches the owner case-insensitively and never lists installations', () => {
        expect(installationForRepo(config, 'XTRM-DEV/core')).toEqual({ account: 'xtrm-dev', id: '99' });
        expect(installationForRepo(config, 'someone/core')).toBeNull();
        expect(installationForRepo(config, 'not-a-slug')).toBeNull();
        expect(repoOwner('a/b')).toBe('a');
        expect(repoOwner('/b')).toBeNull();
    });
});

describe('mintInstallationToken', () => {
    it('mints from the recorded installation, caches at mode 600, then reuses the cache', async () => {
        writeApp('xtrm-reviewer');
        const calls: Call[] = [];
        const deps = {
            home, runtimeDir,
            now: () => 1_700_000_000_000,
            fetch: fetchReturning(() => ({ status: 201, data: { token: 'ghs_test', expires_at: '2026-11-08T16:00:00Z' } }), calls),
        };
        const first = await mintInstallationToken({ slug: 'xtrm-reviewer', account: 'xtrm-dev' }, deps);
        expect(first).toMatchObject({ token: 'ghs_test', cached: false, installationId: '99', account: 'xtrm-dev' });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://api.github.com/app/installations/99/access_tokens');
        expect(calls[0].headers.Authorization).toMatch(/^Bearer ey/);
        const cacheFile = path.join(githubAppPaths(home, runtimeDir).tokenCacheDir, 'xtrm-reviewer-xtrm-dev.json');
        expect(fileMode(cacheFile)).toBe(0o600);

        const second = await mintInstallationToken({ slug: 'xtrm-reviewer', account: 'xtrm-dev' }, deps);
        expect(second.cached).toBe(true);
        expect(calls).toHaveLength(1);
    });

    it('tightens an existing wider token-cache directory to 0700 before writing', async () => {
        writeApp('xtrm-reviewer');
        const cacheDir = githubAppPaths(home, runtimeDir).tokenCacheDir;
        fs.mkdirSync(cacheDir, { recursive: true, mode: 0o777 });
        fs.chmodSync(cacheDir, 0o777);
        const deps = {
            home, runtimeDir,
            now: () => 1_700_000_000_000,
            fetch: fetchReturning(() => ({ status: 201, data: { token: 'ghs_test', expires_at: '2026-11-08T16:00:00Z' } }), []),
        };
        await mintInstallationToken({ slug: 'xtrm-reviewer', account: 'xtrm-dev' }, deps);
        expect(fs.statSync(cacheDir).mode & 0o777).toBe(0o700);
    });

    it('refuses to mint when the private key is readable by others', async () => {
        const keyFile = writeApp('xtrm-reviewer');
        fs.chmodSync(keyFile, 0o644);
        const deps = {
            home, runtimeDir,
            now: () => 1_700_000_000_000,
            fetch: fetchReturning(() => ({ status: 201, data: { token: 'ghs_test' } }), []),
        };
        await expect(mintInstallationToken({ slug: 'xtrm-reviewer', account: 'xtrm-dev' }, deps))
            .rejects.toThrow(/must be 600/);
    });

    it('re-mints when the cached token is inside the reuse skew', async () => {
        writeApp('xtrm-reviewer');
        const calls: Call[] = [];
        const deps = {
            home, runtimeDir,
            now: () => 1_700_000_000_000,
            fetch: fetchReturning(() => ({ status: 201, data: { token: 'ghs_new', expires_at: new Date(1_700_000_000_000 + 60_000).toISOString() } }), calls),
        };
        await mintInstallationToken({ slug: 'xtrm-reviewer', account: 'xtrm-dev' }, deps);
        const second = await mintInstallationToken({ slug: 'xtrm-reviewer', account: 'xtrm-dev' }, deps);
        expect(second.cached).toBe(false);
        expect(calls).toHaveLength(2);
    });

    it('fails closed without an App, a recorded installation or a readable key', async () => {
        const fetch = fetchReturning(() => ({ status: 201, data: { token: 'x' } }));
        await expect(mintInstallationToken({ slug: 'xtrm-reviewer', account: 'xtrm-dev' }, { home, runtimeDir, fetch }))
            .rejects.toBeInstanceOf(GitHubAppError);

        writeApp('xtrm-reviewer', { installations: { other: '5' } });
        await expect(mintInstallationToken({ slug: 'xtrm-reviewer', account: 'xtrm-dev' }, { home, runtimeDir, fetch }))
            .rejects.toThrow(/no recorded installation/);

        writeApp('xtrm-reviewer');
        fs.removeSync(path.join(home, '.secrets', 'github-apps', 'xtrm-reviewer.pem'));
        await expect(mintInstallationToken({ slug: 'xtrm-reviewer', account: 'xtrm-dev' }, { home, runtimeDir, fetch }))
            .rejects.toThrow(/cannot read the App private key/);
    });

    it('surfaces a refused mint and writes nothing', async () => {
        writeApp('xtrm-reviewer');
        const calls: Call[] = [];
        const deps = {
            home, runtimeDir,
            fetch: fetchReturning(() => ({ status: 403, data: { message: 'Resource not accessible' } }), calls),
        };
        await expect(mintInstallationToken({ slug: 'xtrm-reviewer', account: 'xtrm-dev' }, deps))
            .rejects.toThrow(/token mint refused \(HTTP 403\)/);
        expect(fs.existsSync(path.join(githubAppPaths(home, runtimeDir).tokenCacheDir, 'xtrm-reviewer-xtrm-dev.json'))).toBe(false);
    });

    it('never sends the key or the token anywhere but the token endpoint', async () => {
        writeApp('xtrm-reviewer');
        const calls: Call[] = [];
        const deps = {
            home, runtimeDir,
            fetch: fetchReturning(() => ({ status: 201, data: { token: 'ghs_secret', expires_at: '2026-11-08T16:00:00Z' } }), calls),
        };
        const minted = await mintInstallationToken({ slug: 'xtrm-reviewer', account: 'xtrm-dev' }, deps);
        expect(calls.every((call) => call.url.endsWith('/access_tokens'))).toBe(true);
        expect(JSON.stringify(calls)).not.toContain('PRIVATE KEY');
        expect(minted.token).toBe('ghs_secret');
    });

    it('accepts a numeric appId, as a hand-written app.json carries it (live finding)', () => {
        // CORE-2612: use the per-test sandbox, which afterEach removes; a second
        // mkdtemp here leaked one directory per run.
        const file = githubAppPaths(home).appFile('xtrm-reviewer');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ slug: 'xtrm-reviewer', appId: 5669067, owner: 'Jaggerxtrm', keyPath: '/tmp/x.pem', installations: { Jaggerxtrm: 179891878 } }));
        const config = readAppConfig('xtrm-reviewer', { home });
        expect(config?.appId).toBe('5669067');
        expect(config?.installations).toEqual({ Jaggerxtrm: '179891878' });
    });
});

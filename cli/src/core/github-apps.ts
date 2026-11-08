/**
 * GitHub App credentials for agent roles (CORE-2528, parent CORE-2524).
 *
 * An agent process never holds an App private key and never falls back to the
 * operator's `gh` login for review posting. It holds a ROLE NAME; this module
 * mints a one-hour installation token on demand from the key that stays in
 * `~/.secrets`, and caches it in `$XDG_RUNTIME_DIR` (mode 600) next to nothing
 * that is printed.
 *
 * Machine state (all non-secret except the key):
 *   ~/.xtrm/identities/github-apps/<slug>/app.json   slug, appId, owner, keyPath, installations
 *   ~/.secrets/github-apps/<slug>.pem                the private key (operator-created, mode 600)
 *   $XDG_RUNTIME_DIR/xtrm/gh-tokens/<slug>-<acct>.json  {token, expiresAt} mode 600
 *
 * The installation id is only ever read from app.json: a token minted for an
 * installation discovered at runtime is a capability leak (runbook section 1).
 * Fail closed: an unknown App, an unknown account or an unreadable key yields no
 * token, never a different identity.
 */

import { createSign } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_API_BASE = 'https://api.github.com';
/** Reuse a cached token only when it has more than this much life left. */
export const TOKEN_REUSE_SKEW_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 60 * 60 * 1000;

export interface AppConfig {
    slug: string;
    appId: string;
    owner: string;
    keyPath: string;
    /** account name -> installation id */
    installations: Record<string, string>;
    pollerHost?: string;
    inbound?: string;
}

export interface AppPaths {
    identitiesDir: string;
    tokenCacheDir: string;
    appFile: (slug: string) => string;
    defaultKeyPath: (slug: string) => string;
}

export interface FetchResponseLike {
    status: number;
    json: () => Promise<unknown>;
}

export type FetchLike = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}) => Promise<FetchResponseLike>;

export interface GitHubAppDeps {
    home?: string;
    runtimeDir?: string;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    fetch?: FetchLike;
    apiBase?: string;
    readFile?: (file: string) => string;
}

export interface InstallationToken {
    token: string;
    /** Epoch ms. */
    expiresAt: number;
    /** True when served from the cache instead of a fresh mint. */
    cached: boolean;
    slug: string;
    account: string;
    installationId: string;
}

export class GitHubAppError extends Error {
    constructor(message: string, readonly detail?: string) {
        super(message);
        this.name = 'GitHubAppError';
    }
}

export function githubAppPaths(home: string = os.homedir(), runtimeDir?: string): AppPaths {
    const identitiesDir = path.join(home, '.xtrm', 'identities', 'github-apps');
    const runtime = runtimeDir
        ?? process.env.XDG_RUNTIME_DIR
        ?? path.join(home, '.xtrm', 'run');
    return {
        identitiesDir,
        tokenCacheDir: path.join(runtime, 'xtrm', 'gh-tokens'),
        appFile: (slug: string) => path.join(identitiesDir, slug, 'app.json'),
        defaultKeyPath: (slug: string) => path.join(home, '.secrets', 'github-apps', `${slug}.pem`),
    };
}

/** Parse and validate app.json. Returns null when the file is absent or unusable. */
export function readAppConfig(slug: string, deps: GitHubAppDeps = {}): AppConfig | null {
    const read = deps.readFile ?? ((file: string) => readFileSync(file, 'utf8'));
    const file = githubAppPaths(deps.home, deps.runtimeDir).appFile(slug);
    let raw: unknown;
    try {
        raw = JSON.parse(read(file));
    } catch {
        return null;
    }
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;
    if (record.slug !== slug) return null;
    if (typeof record.appId !== 'string' || !record.appId.trim()) return null;
    const installations: Record<string, string> = {};
    const rawInstallations = record.installations;
    if (rawInstallations && typeof rawInstallations === 'object') {
        for (const [account, value] of Object.entries(rawInstallations as Record<string, unknown>)) {
            const id = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
            if (id) installations[account] = id;
        }
    }
    return {
        slug,
        appId: record.appId.trim(),
        owner: typeof record.owner === 'string' ? record.owner : '',
        keyPath: typeof record.keyPath === 'string' && record.keyPath.trim()
            ? record.keyPath
            : githubAppPaths(deps.home, deps.runtimeDir).defaultKeyPath(slug),
        installations,
        pollerHost: typeof record.pollerHost === 'string' ? record.pollerHost : undefined,
        inbound: typeof record.inbound === 'string' ? record.inbound : undefined,
    };
}

function base64url(value: Buffer | string): string {
    return Buffer.from(value)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * The App JWT GitHub expects on `/app/installations/<id>/access_tokens`:
 * RS256, `iss` = App id, `iat` 60s in the past for clock skew, `exp` under the
 * 10-minute ceiling.
 */
export function buildAppJwt(appId: string, privateKey: string, nowMs: number = Date.now()): string {
    const now = Math.floor(nowMs / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
    const signingInput = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    return `${signingInput}.${base64url(signer.sign(privateKey))}`;
}

/** `owner/name` -> owner. Returns null for anything that is not a repo slug. */
export function repoOwner(repo: string): string | null {
    const match = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/.exec(repo.trim());
    return match ? match[1] : null;
}

/** The recorded installation for the repository's owner, or null (never a listing call). */
export function installationForRepo(config: AppConfig, repo: string): { account: string; id: string } | null {
    const owner = repoOwner(repo);
    if (!owner) return null;
    for (const [account, id] of Object.entries(config.installations)) {
        if (account.toLowerCase() === owner.toLowerCase()) return { account, id };
    }
    return null;
}

interface CachedToken { token: string; expiresAt: number }

function readCached(file: string, deps: GitHubAppDeps): CachedToken | null {
    const read = deps.readFile ?? ((f: string) => readFileSync(f, 'utf8'));
    try {
        const parsed = JSON.parse(read(file)) as Partial<CachedToken>;
        if (typeof parsed.token === 'string' && parsed.token && typeof parsed.expiresAt === 'number') {
            return { token: parsed.token, expiresAt: parsed.expiresAt };
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * A directory that only this user may read, at mint time (CORE-2528 rev 4 F7).
 * `mkdirSync({mode})` only affects a NEW directory, so an existing wider one is
 * tightened; if it cannot be tightened, the mint refuses rather than writing a
 * token there.
 */
export function ensurePrivateDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let mode: number;
    try {
        mode = statSync(dir).mode & 0o777;
    } catch (error) {
        throw new GitHubAppError(`cannot stat the token cache directory ${dir}: ${(error as Error).message}`);
    }
    if ((mode & 0o077) !== 0) {
        try {
            chmodSync(dir, 0o700);
            mode = statSync(dir).mode & 0o777;
        } catch { /* fall through to the refusal below */ }
    }
    if ((mode & 0o077) !== 0) {
        throw new GitHubAppError(`the token cache directory ${dir} is mode ${mode.toString(8)}; refusing to write a token into a directory other users can read`);
    }
}

function writeCached(file: string, value: CachedToken): void {
    ensurePrivateDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, file);
    try {
        chmodSync(file, 0o600);
    } catch { /* best effort; the file was created 600 */ }
}

function requireFetch(deps: GitHubAppDeps): FetchLike {
    const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!fetchImpl) throw new GitHubAppError('no fetch implementation available');
    return fetchImpl;
}

async function readJson(response: FetchResponseLike): Promise<Record<string, unknown>> {
    try {
        const data = await response.json();
        return data && typeof data === 'object' ? data as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

/**
 * Mint (or reuse) a one-hour installation token for the role App that owns
 * `account`. Fail closed at every step; the token is never logged.
 */
export async function mintInstallationToken(
    input: { slug: string; account: string },
    deps: GitHubAppDeps = {},
): Promise<InstallationToken> {
    const paths = githubAppPaths(deps.home, deps.runtimeDir);
    const config = readAppConfig(input.slug, deps);
    if (!config) throw new GitHubAppError(`no app.json for ${input.slug}: the App is not configured on this machine`);
    const installationId = config.installations[input.account];
    if (!installationId) {
        throw new GitHubAppError(`${input.slug} has no recorded installation for account ${input.account}`);
    }
    const now = (deps.now ?? Date.now)();
    const cacheFile = path.join(paths.tokenCacheDir, `${config.slug}-${input.account}.json`);
    const cached = readCached(cacheFile, deps);
    if (cached && cached.expiresAt - now > TOKEN_REUSE_SKEW_MS) {
        return { token: cached.token, expiresAt: cached.expiresAt, cached: true, slug: config.slug, account: input.account, installationId };
    }

    // The key must be private at MINT time, not only when `doctor` runs.
    try {
        const mode = statSync(config.keyPath).mode & 0o777;
        if ((mode & 0o077) !== 0) {
            throw new GitHubAppError(`${config.slug}: the App private key ${config.keyPath} is mode ${mode.toString(8)}; it must be 600`);
        }
    } catch (error) {
        if (error instanceof GitHubAppError) throw error;
        // ENOENT: an injected reader (tests) or a path the doctor reports; the read below decides.
    }
    const read = deps.readFile ?? ((f: string) => readFileSync(f, 'utf8'));
    let privateKey: string;
    try {
        privateKey = read(config.keyPath);
    } catch {
        throw new GitHubAppError(`${config.slug}: cannot read the App private key at ${config.keyPath}`);
    }
    const jwt = buildAppJwt(config.appId, privateKey, now);
    const apiBase = deps.apiBase ?? DEFAULT_API_BASE;
    const response = await requireFetch(deps)(`${apiBase}/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
        },
        body: '{}',
    });
    const data = await readJson(response);
    if (response.status !== 201 && response.status !== 200) {
        throw new GitHubAppError(
            `${config.slug}: token mint refused (HTTP ${response.status})`,
            typeof data.message === 'string' ? data.message : undefined,
        );
    }
    const token = typeof data.token === 'string' ? data.token : '';
    if (!token) throw new GitHubAppError(`${config.slug}: token mint returned no token`);
    const expiresAt = typeof data.expires_at === 'string' && data.expires_at
        ? Date.parse(data.expires_at)
        : now + TOKEN_TTL_MS;
    const value: CachedToken = { token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : now + TOKEN_TTL_MS };
    // A cache we cannot make private is a refusal to cache, not a silent widening:
    // surface it, because the next call would otherwise re-mint with no hint.
    writeCached(cacheFile, value);
    return { token: value.token, expiresAt: value.expiresAt, cached: false, slug: config.slug, account: input.account, installationId };
}

/** `account=installation` pairs, for the doctor output. */
export function appInstallationSummary(config: AppConfig): string {
    return Object.entries(config.installations).map(([account, id]) => `${account}=${id}`).join(', ');
}

/** `stat -c '%a'` equivalent, for the doctor and its tests. */
export function fileMode(file: string): number | null {
    try {
        return statSync(file).mode & 0o777;
    } catch {
        return null;
    }
}

export interface GitHubRequestDeps extends GitHubAppDeps {
    token: string;
}

export interface GitHubResponse<T = unknown> {
    status: number;
    data: T;
}

/** One authenticated REST call with the installation token. Throws on transport failure. */
export async function githubRequest<T = unknown>(
    input: { method: string; path: string; body?: unknown },
    deps: GitHubRequestDeps,
): Promise<GitHubResponse<T>> {
    const response = await requireFetch(deps)(`${deps.apiBase ?? DEFAULT_API_BASE}${input.path}`, {
        method: input.method,
        headers: {
            Authorization: `Bearer ${deps.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const data = await readJson(response) as T;
    return { status: response.status, data };
}

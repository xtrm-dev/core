/**
 * Git transport for agent processes (CORE-2528).
 *
 * An agent must not push, fetch or merge with the operator's ssh key or `gh`
 * login. When the role's App is configured on this machine, the launcher emits
 * `GIT_CONFIG_*` for the whole session:
 *
 *   url.https://github.com/.insteadOf=git@github.com:
 *   url.https://github.com/.insteadOf=ssh://git@github.com/
 *   credential.https://github.com.helper=!xt identity credential
 *
 * and `xt identity credential` mints a one-hour installation token for this
 * role only. Gated on the App existing: until the operator creates the App
 * (and app.json), the agent keeps today's transport — the rollout order in the
 * GitHub Apps runbook.
 *
 * Fail closed: a role with no App, no installation for the account, or a failed
 * mint prints nothing, so git has no credential rather than the operator's.
 */

import { readAppConfig, repoOwner, type GitHubAppDeps } from './github-apps.js';
import { appSlugForRole, type AgentRole, type RoleMap, DEFAULT_ROLE_MAP } from './identity-roles.js';

export const GIT_CONFIG_ENV_KEYS = (count = 3): string[] => [
    'GIT_CONFIG_COUNT',
    ...Array.from({ length: count }, (_, index) => `GIT_CONFIG_KEY_${index}`),
    ...Array.from({ length: count }, (_, index) => `GIT_CONFIG_VALUE_${index}`),
];

export interface GitTransportInput {
    role: AgentRole | null;
    map?: RoleMap;
    deps?: GitHubAppDeps;
    /** The env the launcher is about to extend: its GIT_CONFIG_COUNT decides the base index. */
    env?: NodeJS.ProcessEnv;
    /**
     * Append to the caller's existing GIT_CONFIG_* entries instead of replacing
     * them (CORE-2528 review). An operator's http.proxy must survive a launch, so
     * the launcher never touches an index it did not write.
     */
    append?: boolean;
}

/** The transport env for this role, or {} when its App is not configured here. */
export function buildGitTransportEnv(input: GitTransportInput): Record<string, string> {
    if (!input.role) return {};
    const map = input.map ?? DEFAULT_ROLE_MAP;
    const slug = appSlugForRole(input.role, map);
    if (!readAppConfig(slug, input.deps)) return {};
    const entries: Array<[string, string]> = [
        ['url.https://github.com/.insteadOf', 'git@github.com:'],
        ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
        // Reset first: a global helper (`gh auth setup-git` writes one) is consulted
        // before ours otherwise, and git would answer with the OPERATOR's token.
        ['credential.https://github.com.helper', ''],
        ['credential.https://github.com.helper', '!xt identity credential'],
        // Without useHttpPath git sends no `path`, so the helper cannot tell which
        // repository it is answering for and refuses (it must, to stay scoped).
        ['credential.https://github.com.useHttpPath', 'true'],
    ];
    const inherited = input.append ? Number.parseInt((input.env ?? {}).GIT_CONFIG_COUNT ?? '0', 10) : 0;
    const base = Number.isInteger(inherited) && inherited > 0 ? inherited : 0;
    const env: Record<string, string> = { GIT_CONFIG_COUNT: String(base + entries.length) };
    entries.forEach(([key, value], offset) => {
        env[`GIT_CONFIG_KEY_${base + offset}`] = key;
        env[`GIT_CONFIG_VALUE_${base + offset}`] = value;
    });
    return env;
}

export interface CredentialRequest { protocol?: string; host?: string; path?: string; username?: string }

/** Parse the git credential protocol request (key=value lines, blank line ends). */
export function parseCredentialRequest(text: string): CredentialRequest {
    const out: CredentialRequest = {};
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const index = trimmed.indexOf('=');
        if (index <= 0) continue;
        const key = trimmed.slice(0, index);
        const value = trimmed.slice(index + 1);
        if (key === 'protocol' || key === 'host' || key === 'path' || key === 'username') out[key] = value;
    }
    return out;
}

/**
 * The role App that may answer this request, or null. Only github.com over
 * https, and only the role's own App for the repository's owner.
 */
export function credentialAppFor(input: CredentialRequest, role: AgentRole | null, map: RoleMap | null = DEFAULT_ROLE_MAP): { slug: string; account: string } | null {
    if (!role || !map) return null;
    if ((input.protocol ?? 'https') !== 'https') return null;
    if ((input.host ?? '').toLowerCase() !== 'github.com') return null;
    const account = repoOwner(input.path ?? '');
    if (!account) return null;
    return { slug: appSlugForRole(role, map), account };
}

/** The git credential answer: `x-access-token` + the installation token. */
export function credentialResponse(token: string): string {
    return `username=x-access-token\npassword=${token}\n`;
}

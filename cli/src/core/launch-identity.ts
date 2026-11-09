/**
 * Launch-time identity for `xt claude|pi|codex` (CORE-2528 remainder).
 *
 * One function decides what a launched session inherits:
 * - always: the dispatcher identity (holder, git author) that CORE-2525 exports;
 * - ONLY when this host has the role's App AND an installation for the repo
 *   owner: `XTRM_ROLE` plus the `GIT_CONFIG_*` transport rewrite. A role with no
 *   App keeps the operator identity: rewriting transport without an App would
 *   take `git push` away from workers today (only xtrm-reviewer exists).
 * - a supervisor-launched activation whose specialist maps to nothing is
 *   refused, but only when identities are configured on this host (a role map
 *   exists). Without a role map, the launcher behaves as before.
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { repoOwner, readAppConfig, installationForRepo, type GitHubAppDeps } from './github-apps.js';
import { buildGitTransportEnv } from './git-transport.js';
import { appSlugForRole, loadRoleMap, roleMapPath, type AgentRole, type RoleMap } from './identity-roles.js';

export const SPECIALIST_DEFAULT_ENV = 'XTRM_SPECIALIST_DEFAULT';
/** The supervisor sets these when it spawns a session, so the launch is not interactive. */
export const SUPERVISOR_MARKERS = ['SPECIALISTS_JOB_ID', 'XTRM_SUPERVISOR_LAUNCH'] as const;

const ROLE_NAMES: readonly AgentRole[] = ['reviewer', 'worker', 'coordinator'];

export interface LaunchIdentityDeps extends GitHubAppDeps {
    home?: string;
    /** Injected for tests: a role map exists (overrides the filesystem check). */
    roleMapExists?: boolean;
    /** Injected for tests: the repo slug (owner/name) of the worktree. */
    repo?: string | null;
}

export interface LaunchIdentityInput {
    holder: string;
    /** The launch's `--role` value, resolved through the role map. */
    roleName?: string | null;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    deps?: LaunchIdentityDeps;
}

export interface LaunchIdentityResult {
    /** Identity variables to merge into the child env (empty when nothing is exported). */
    env: Record<string, string>;
    role: AgentRole | null;
    configured: boolean;
    exported: boolean;
    /** Set when the launch must be refused before the runtime starts. */
    refused: string | null;
    /** One line for the operator: why the identity was or was not exported. */
    note: string | null;
}

export function roleMapConfigured(home?: string): boolean {
    return existsSync(roleMapPath(home));
}

function asRole(name: string): AgentRole | null {
    return (ROLE_NAMES as readonly string[]).includes(name) ? (name as AgentRole) : null;
}

function mappedSpecialists(map: RoleMap): string {
    const names = Object.keys(map.specialists).filter((name) => map.specialists[name] !== null);
    return names.length ? names.join(', ') : '(none)';
}

/** The repository slug of a worktree, from its origin remote. Unknown stays null. */
export function detectRepo(cwd: string): string | null {
    try {
        const result = spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5000 });
        if (result.status !== 0) return null;
        const url = String(result.stdout ?? '').trim();
        const https = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
        const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
        const match = https ?? ssh;
        return match ? `${match[1]}/${match[2]}` : null;
    } catch {
        return null;
    }
}

/**
 * Resolve the role of a launch: an explicit `--role`, then what the launch
 * environment names, then the role map's default. Unknown names are refused with
 * the mapped set.
 */
function resolveRoleName(input: LaunchIdentityInput, env: NodeJS.ProcessEnv, map: RoleMap, configured: boolean): {
    role: AgentRole | null;
    refused: string | null;
    source: string;
} {
    const explicit = (input.roleName ?? '').trim();
    if (explicit) {
        const direct = asRole(explicit);
        if (direct) return { role: direct, refused: null, source: 'explicit role' };
        const mapped = map.specialists[explicit];
        if (mapped) return { role: mapped, refused: null, source: `specialist ${explicit}` };
        return {
            role: null,
            refused: `role '${explicit}' is neither a role (${ROLE_NAMES.join(', ')}) nor a mapped specialist; mapped specialists: ${mappedSpecialists(map)}`,
            source: 'explicit',
        };
    }
    const supervisor = SUPERVISOR_MARKERS.some((marker) => (env[marker] ?? '').trim());
    const handSet = (env.XTRM_ROLE ?? '').trim();
    const candidates = [handSet, (env[SPECIALIST_DEFAULT_ENV] ?? '').trim()].filter(Boolean);
    for (const candidate of candidates) {
        const direct = asRole(candidate);
        if (direct) return { role: direct, refused: null, source: 'launch environment' };
        const mapped = map.specialists[candidate];
        if (mapped) return { role: mapped, refused: null, source: `specialist ${candidate}` };
        // An unmapped specialist name: fail closed, but only where identities are
        // configured. A launch in a repo with no App must never be refused.
        if (supervisor && configured) {
            return {
                role: null,
                refused: `specialist '${candidate}' has no role mapping; mapped specialists: ${mappedSpecialists(map)}`,
                source: 'launch environment',
            };
        }
    }
    if (supervisor && configured) {
        return {
            role: null,
            refused: `supervisor-launched activation names no role; set ${SPECIALIST_DEFAULT_ENV} or add the specialist to the role map (mapped: ${mappedSpecialists(map)})`,
            source: 'default',
        };
    }
    return { role: map.default, refused: null, source: 'role map default' };
}

export function resolveLaunchIdentity(input: LaunchIdentityInput): LaunchIdentityResult {
    const env = input.env ?? process.env;
    const deps = input.deps ?? {};
    const home = deps.home;
    const configured = deps.roleMapExists ?? roleMapConfigured(home);
    // No role map: identities are not configured, so nothing changes for a launch.
    if (!configured) {
        // No role map: a plain role name still names itself, a specialist cannot be
        // resolved, and nothing is exported. Today's behaviour, plus the note.
        const role = asRole((input.roleName ?? '').trim());
        return {
            env: {},
            role,
            configured: false,
            exported: false,
            refused: null,
            note: 'identities not configured (no role map at ~/.xtrm/config/identity-role-map.json); the launch keeps the operator identity',
        };
    }
    const map = loadRoleMap({ home });
    if (!map) {
        return { env: {}, role: null, configured: true, exported: false, refused: null, note: 'the role map is invalid; the launch keeps the operator identity' };
    }
    const resolved = resolveRoleName(input, env, map, configured);
    if (resolved.refused || !resolved.role) {
        return { env: {}, role: null, configured, exported: false, refused: resolved.refused, note: null };
    }
    const role = resolved.role;
    const slug = appSlugForRole(role, map);
    const repo = deps.repo ?? detectRepo(input.cwd);
    const owner = repo ? repoOwner(repo) : null;
    const config = readAppConfig(slug, deps);
    const installation = config && repo ? installationForRepo(config, repo) : null;
    if (!config || !installation) {
        const why = !repo
            ? 'the worktree has no github.com origin, so the installation cannot be checked'
            : !config
                ? `no ${slug} App is configured on this host`
                : `the ${slug} App is not installed for ${owner}`;
        return {
            env: {},
            role,
            configured,
            exported: false,
            refused: null,
            note: `role ${role}: ${why}; the launch keeps the operator identity (no XTRM_ROLE, no transport rewrite)`,
        };
    }
    return {
        env: { XTRM_ROLE: role, ...buildGitTransportEnv({ role, map, deps }) },
        role,
        configured,
        exported: true,
        refused: null,
        note: `role ${role} (${resolved.source}) uses the ${slug} App of ${installation.account}`,
    };
}

/**
 * The direct (non-tmux) spawn inherits the caller's environment, so an identity
 * exported by an outer agent session must not leak into the child: the launcher
 * decides the identity, and `resolveLaunchIdentity` supplies it.
 */
export function stripIdentityEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = { ...env };
    delete out.XTRM_ROLE;
    delete out[SPECIALIST_DEFAULT_ENV];
    for (const key of Object.keys(out)) {
        if (key === 'GIT_CONFIG_COUNT' || key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) delete out[key];
    }
    return out;
}

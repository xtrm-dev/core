/**
 * Launch-time identity for `xt claude|pi|codex` (CORE-2528 remainder).
 *
 * One function decides what a launched session inherits:
 * - always: the dispatcher identity (holder, git author) that CORE-2525 exports;
 * - ONLY when this host has the role's App AND an installation for the repo
 *   owner: `XTRM_ROLE` plus the `GIT_CONFIG_*` transport rewrite, APPENDED to the
 *   entries the caller already has. Nothing inherited is removed: an operator's
 *   `http.proxy` or a coordinator's `XTRM_ROLE` must survive a launch.
 * - an explicit reviewer launch that cannot export its identity on a host where
 *   the reviewer App IS configured is refused before any worktree exists — a
 *   reviewer that falls back to the operator login defeats the App.
 * - a supervisor-launched activation whose specialist maps to nothing is refused
 *   (only when a role map exists); an interactive `--role` that maps to nothing
 *   launches as today and says so on stderr.
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { repoOwner, readAppConfig, installationForRepo, type GitHubAppDeps } from './github-apps.js';
import { buildGitTransportEnv } from './git-transport.js';
import { appSlugForRole, loadRoleMap, resolveAgentRole, roleMapPath, type AgentRole, type RoleMap } from './identity-roles.js';

export const SPECIALIST_DEFAULT_ENV = 'XTRM_SPECIALIST_DEFAULT';
/** The supervisor sets these when it spawns a session, so the launch is not interactive. */
export const SUPERVISOR_MARKERS = ['SPECIALISTS_JOB_ID', 'XTRM_SUPERVISOR_LAUNCH'] as const;

const ROLE_NAMES: readonly AgentRole[] = ['reviewer', 'worker', 'coordinator'];
/** A role or specialist name: no path separators, no leading dash, bounded. */
const ROLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
    /** One line for stderr: why the identity was or was not exported. */
    note: string | null;
}

export interface LaunchPreflightInput {
    roleName?: string | null;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    deps?: LaunchIdentityDeps;
}

export interface LaunchPreflight {
    role: AgentRole | null;
    refused: string | null;
    warning: string | null;
}

export function roleMapConfigured(home?: string): boolean {
    return existsSync(roleMapPath(home));
}

function asRole(name: string): AgentRole | null {
    return (ROLE_NAMES as readonly string[]).includes(name) ? (name as AgentRole) : null;
}

function mappedRole(map: RoleMap, name: string): AgentRole | null | undefined {
    // Own property only: `constructor`, `__proto__` and friends must not resolve.
    if (!Object.hasOwn(map.specialists, name)) return undefined;
    return map.specialists[name];
}

function mappedSpecialists(map: RoleMap): string {
    const names = Object.keys(map.specialists).filter((name) => map.specialists[name]);
    return names.length ? names.join(', ') : '(none)';
}

/**
 * The repository slug of a worktree, from its origin remote. Accepts scp-style,
 * `ssh://`, `https://`, `git://`, credentials in the URL, a `.git` suffix and a
 * trailing slash; `www.github.com` is github.com. Another host is not a repo.
 */
export function parseGithubOrigin(url: string): string | null {
    const text = url.trim();
    if (!text) return null;
    const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(text);
    const uri = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(text);
    const host = (scp?.[1] ?? uri?.[1] ?? '').toLowerCase().replace(/^www\./, '');
    const pathPart = scp?.[2] ?? uri?.[2] ?? '';
    if (host !== 'github.com') return null;
    const cleaned = pathPart.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
    const match = /^([^/]+)\/([^/]+)$/.exec(cleaned);
    return match ? `${match[1]}/${match[2]}` : null;
}

export function detectRepo(cwd: string): string | null {
    try {
        const result = spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5000 });
        if (result.status !== 0) return null;
        return parseGithubOrigin(String(result.stdout ?? ''));
    } catch {
        return null;
    }
}

interface RoleResolution {
    role: AgentRole | null;
    /** The name the launch asked for, if any. */
    requested: string;
    refused: string | null;
    source: string;
}

/**
 * Resolve the role of a launch with the SAME rule the runtime uses
 * (`resolveAgentRole`: a specialist entry wins over a bare role name, and a
 * `null` entry means "no role"). An explicit `--role` is resolved here first.
 */
function resolveRole(input: { roleName?: string | null; env: NodeJS.ProcessEnv; map: RoleMap; configured: boolean; supervisor: boolean }): RoleResolution {
    const { env, map, configured, supervisor } = input;
    const explicit = (input.roleName ?? '').trim();
    if (explicit) {
        const direct = asRole(explicit);
        if (direct) return { role: direct, requested: explicit, refused: null, source: 'explicit role' };
        const mapped = mappedRole(map, explicit);
        if (mapped) return { role: mapped, requested: explicit, refused: null, source: `specialist ${explicit}` };
        if (mapped === null) return { role: null, requested: explicit, refused: null, source: `specialist ${explicit} is mapped to no role` };
        // An unmapped specialist: interactive launches keep today's behaviour; a
        // supervisor launch fails closed, because it has nobody to ask.
        if (supervisor && configured) {
            return {
                role: null,
                requested: explicit,
                refused: `specialist '${explicit}' has no role mapping; mapped specialists: ${mappedSpecialists(map)}`,
                source: 'explicit specialist',
            };
        }
        return { role: null, requested: explicit, refused: null, source: `specialist ${explicit} is not mapped` };
    }
    const handSet = (env.XTRM_ROLE ?? '').trim();
    if (handSet) {
        // The runtime's rule, not a second one: a specialist entry wins over a bare
        // role name, and an explicit null means no role.
        const runtime = resolveAgentRole(handSet, map);
        if (runtime === null && supervisor && configured && mappedRole(map, handSet) === undefined && !asRole(handSet)) {
            return {
                role: null,
                requested: handSet,
                refused: `specialist '${handSet}' has no role mapping; mapped specialists: ${mappedSpecialists(map)}`,
                source: 'launch environment',
            };
        }
        return { role: runtime, requested: handSet, refused: null, source: 'launch environment' };
    }
    const fallback = (env[SPECIALIST_DEFAULT_ENV] ?? '').trim();
    if (fallback && supervisor) {
        const direct = asRole(fallback);
        if (direct) return { role: direct, requested: fallback, refused: null, source: 'specialist default' };
        const mapped = mappedRole(map, fallback);
        if (mapped) return { role: mapped, requested: fallback, refused: null, source: `specialist default ${fallback}` };
        if (configured) {
            return {
                role: null,
                requested: fallback,
                refused: `specialist '${fallback}' has no role mapping; mapped specialists: ${mappedSpecialists(map)}`,
                source: 'specialist default',
            };
        }
    }
    if (supervisor && configured) {
        return {
            role: null,
            requested: '',
            refused: `supervisor-launched activation names no role; set ${SPECIALIST_DEFAULT_ENV} or add the specialist to the role map (mapped: ${mappedSpecialists(map)})`,
            source: 'supervisor',
        };
    }
    return { role: map.default, requested: '', refused: null, source: 'role map default' };
}

function isSupervisor(env: NodeJS.ProcessEnv): boolean {
    return SUPERVISOR_MARKERS.some((marker) => (env[marker] ?? '').trim());
}

function transportFor(role: AgentRole, map: RoleMap, deps: LaunchIdentityDeps, env: NodeJS.ProcessEnv): Record<string, string> {
    return buildGitTransportEnv({ role, map, deps, env, append: true });
}

/** Shared body of preflight and resolve: what this launch would do. */
function evaluate(input: LaunchPreflightInput & { holder?: string }): {
    role: AgentRole | null;
    requested: string;
    refused: string | null;
    note: string | null;
    env: Record<string, string>;
    configured: boolean;
} {
    const env = input.env ?? process.env;
    const deps = input.deps ?? {};
    const configured = deps.roleMapExists ?? roleMapConfigured(deps.home);
    const explicit = (input.roleName ?? '').trim();
    if (explicit && !ROLE_NAME.test(explicit)) {
        return {
            role: null,
            requested: explicit,
            refused: `role '${explicit}' is not a valid role or specialist name (letters, digits, '.', '_' and '-'; no path separators)`,
            note: null,
            env: {},
            configured,
        };
    }
    if (!configured) {
        return {
            role: asRole(explicit),
            requested: explicit,
            refused: null,
            note: explicit
                ? `role ${explicit} has no identity mapping; launching with the operator identity`
                : null,
            env: {},
            configured: false,
        };
    }
    const map = loadRoleMap({ home: deps.home });
    if (!map) {
        return {
            role: asRole(explicit),
            requested: explicit,
            refused: null,
            // Loud, never silent: the file exists but cannot be read, so the launch
            // keeps today's behaviour.
            note: `role map invalid at ${roleMapPath(deps.home)}; launching with the operator identity`,
            env: {},
            configured: true,
        };
    }
    const resolved = resolveRole({
        roleName: explicit,
        env,
        map,
        configured,
        supervisor: isSupervisor(env),
    });
    if (resolved.refused) {
        return { role: null, requested: resolved.requested, refused: resolved.refused, note: null, env: {}, configured };
    }
    if (!resolved.role) {
        return {
            role: null,
            requested: resolved.requested,
            refused: null,
            note: resolved.requested
                ? `role ${resolved.requested} has no identity mapping; launching with the operator identity`
                : null,
            env: {},
            configured,
        };
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
        const reviewerAsked = role === 'reviewer' || asRole(resolved.requested) === 'reviewer' || resolved.requested === 'reviewer';
        // An explicit reviewer launch on a host where the reviewer App IS configured
        // must not fall back to the operator login: refuse it before the worktree.
        const refused = reviewerAsked && config
            ? `role reviewer: ${why}; refusing to launch a reviewer with the operator identity`
            : null;
        return {
            role,
            requested: resolved.requested,
            refused,
            note: refused ? null : `${why}; launching with the operator identity (no XTRM_ROLE, no transport rewrite)`,
            env: {},
            configured,
        };
    }
    return {
        role,
        requested: resolved.requested,
        refused: null,
        note: `role ${role} uses the ${slug} App of ${installation.account}`,
        env: { XTRM_ROLE: role, ...transportFor(role, map, deps, env) },
        configured,
    };
}

/** Run BEFORE any worktree or branch exists: it decides whether to start at all. */
export function preflightLaunchIdentity(input: LaunchPreflightInput): LaunchPreflight {
    const evaluated = evaluate(input);
    return {
        role: evaluated.role,
        refused: evaluated.refused,
        // A launch that asked for a role but will not carry it says so once.
        warning: !evaluated.refused && evaluated.note && (evaluated.requested || evaluated.role) ? evaluated.note : null,
    };
}

export function resolveLaunchIdentity(input: LaunchIdentityInput): LaunchIdentityResult {
    const evaluated = evaluate(input);
    return {
        env: evaluated.env,
        role: evaluated.role,
        configured: evaluated.configured,
        exported: Object.keys(evaluated.env).length > 0,
        refused: evaluated.refused,
        note: evaluated.note,
    };
}

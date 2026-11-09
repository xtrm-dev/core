/**
 * Launch-time identity for `xt claude|pi|codex` (CORE-2528 remainder).
 *
 * One rule: the launcher adds identity variables, and removes nothing.
 * - `XTRM_ROLE` and the `GIT_CONFIG_*` transport are exported ONLY when this
 *   host has the role's App and an installation for the repo owner; the
 *   transport APPENDS at the inherited count (strictly parsed) so an operator's
 *   `http.proxy` and a coordinator's marker survive a launch.
 * - The tmux `-e` paths forward the inherited entries too: a pane does not
 *   inherit xt's environment, so a bare `COUNT=base+5` with only our keys makes
 *   every `git` command in the pane fail.
 * - Role resolution delegates to `resolveAgentRole`, the runtime's rule, in every
 *   branch (explicit `--role`, hand-set marker, supervisor default); the launcher
 *   only decides the gates (refuse / note).
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
const COUNT = /^\d+$/;

export interface LaunchIdentityDeps extends GitHubAppDeps {
    home?: string;
    /** Injected for tests: a role map exists (overrides the filesystem check). */
    roleMapExists?: boolean;
    /** Injected for tests: the repo slug (owner/name) of the worktree. */
    repo?: string | null;
}

export interface LaunchIdentityInput {
    holder: string;
    /** The launch's `--role` value. */
    roleName?: string | null;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    deps?: LaunchIdentityDeps;
    /**
     * tmux `-e` paths: forward the inherited GIT_CONFIG_* entries as well, because
     * the pane does not inherit xt's environment (CORE-2528 review).
     */
    forwardInherited?: boolean;
}

export interface LaunchIdentityResult {
    /** Identity variables to merge into the child env (empty when nothing is exported). */
    env: Record<string, string>;
    role: AgentRole | null;
    configured: boolean;
    exported: boolean;
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

function hasEntry(map: RoleMap, name: string): boolean {
    // Own property only: `constructor`, `__proto__` and friends must not resolve.
    return Object.hasOwn(map.specialists, name);
}

function mappedSpecialists(map: RoleMap): string {
    const names = Object.keys(map.specialists).filter((name) => map.specialists[name]);
    return names.length ? names.join(', ') : '(none)';
}

/** The closest known name, case-insensitively, for a "did you mean" refusal. */
function nearMiss(map: RoleMap, name: string): string | null {
    const wanted = name.toLowerCase();
    const known = [...ROLE_NAMES, ...Object.keys(map.specialists)];
    // A same-spelling entry that maps to null is a deliberate "no role", not a typo.
    return known.find((candidate) => candidate !== name && candidate.toLowerCase() === wanted) ?? null;
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
    /** Non-empty only when the launch explicitly asked for a role. */
    requested: string;
    refused: string | null;
    source: string;
}

function isSupervisor(env: NodeJS.ProcessEnv): boolean {
    return SUPERVISOR_MARKERS.some((marker) => (env[marker] ?? '').trim());
}

/**
 * Resolve through `resolveAgentRole` in every branch, then apply only the launch
 * gates. The runtime and the launcher must never disagree about the role.
 */
function resolveRole(input: { roleName?: string | null; env: NodeJS.ProcessEnv; map: RoleMap; configured: boolean }): RoleResolution {
    const { env, map, configured } = input;
    const supervisor = isSupervisor(env);
    const explicit = (input.roleName ?? '').trim();
    const handSet = (env.XTRM_ROLE ?? '').trim();
    const fallback = (env[SPECIALIST_DEFAULT_ENV] ?? '').trim();
    const asked = explicit || handSet || (supervisor ? fallback : '');
    if (!asked) {
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
    // One resolver: the runtime decides, including a specialist entry that maps to
    // null and a specialist name that shadows a role name.
    const role = resolveAgentRole(asked, map);
    if (role) return { role, requested: asked, refused: null, source: explicit === asked ? 'explicit' : 'launch environment' };
    const deliberateNull = hasEntry(map, asked) && map.specialists[asked] === null;
    if (deliberateNull) {
        return { role: null, requested: asked, refused: null, source: `${asked} is mapped to no role` };
    }
    if (supervisor && configured) {
        return {
            role: null,
            requested: asked,
            refused: `specialist '${asked}' has no role mapping; mapped specialists: ${mappedSpecialists(map)}`,
            source: 'supervisor',
        };
    }
    return { role: null, requested: asked, refused: null, source: `${asked} is not mapped` };
}

interface Evaluation {
    role: AgentRole | null;
    requested: string;
    refused: string | null;
    notes: string[];
    env: Record<string, string>;
    configured: boolean;
}

function evaluate(input: LaunchPreflightInput & { holder?: string; forwardInherited?: boolean }): Evaluation {
    const env = input.env ?? process.env;
    const deps = input.deps ?? {};
    const configured = deps.roleMapExists ?? roleMapConfigured(deps.home);
    const notes: string[] = [];
    const explicit = (input.roleName ?? '').trim();
    if (explicit && !ROLE_NAME.test(explicit)) {
        return {
            role: null,
            requested: explicit,
            refused: `role '${explicit}' is not a valid role or specialist name (letters, digits, '.', '_' and '-'; no path separators)`,
            notes,
            env: {},
            configured,
        };
    }
    // A role map that exists but cannot be parsed is loud on EVERY launch, even one
    // that names no role: silence is what made this defect invisible.
    const map = loadRoleMap({ home: deps.home });
    if (configured && !map) {
        notes.push(`role map invalid at ${roleMapPath(deps.home)}; launching with the operator identity`);
        return { role: asRole(explicit), requested: explicit, refused: null, notes, env: {}, configured };
    }
    const effectiveMap = map ?? { version: 1, default: 'worker' as AgentRole, specialists: {}, apps: { worker: 'xtrm-worker', reviewer: 'xtrm-reviewer', coordinator: 'xtrm-coord' } };
    const resolved = resolveRole({ roleName: explicit, env, map: effectiveMap, configured });
    if (resolved.refused) {
        return { role: null, requested: resolved.requested, refused: resolved.refused, notes, env: {}, configured };
    }
    // A case-only near miss is a typo, not an unmapped specialist: refuse it before
    // the worktree rather than launching with the operator identity.
    if (!resolved.role && resolved.requested) {
        const suggestion = nearMiss(effectiveMap, resolved.requested);
        if (suggestion) {
            return {
                role: null,
                requested: resolved.requested,
                refused: `role '${resolved.requested}' is not mapped; did you mean '${suggestion}'?`,
                notes,
                env: {},
                configured,
            };
        }
    }
    if (!configured) {
        if (resolved.requested) notes.push(`role ${resolved.requested} has no identity mapping; launching with the operator identity`);
        return { role: resolved.role, requested: resolved.requested, refused: null, notes, env: {}, configured: false };
    }
    if (!resolved.role) {
        if (resolved.requested) {
            notes.push(resolved.source.includes('mapped to no role')
                ? `role ${resolved.requested} is mapped to no role; launching with the operator identity`
                : `role ${resolved.requested} has no identity mapping; launching with the operator identity`);
        }
        return { role: null, requested: resolved.requested, refused: null, notes, env: {}, configured };
    }
    const role = resolved.role;
    const slug = appSlugForRole(role, effectiveMap);
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
        const reviewerAsked = role === 'reviewer';
        if (reviewerAsked && config) {
            return {
                role,
                requested: resolved.requested,
                refused: `role reviewer: ${why}; refusing to launch a reviewer with the operator identity`,
                notes,
                env: {},
                configured,
            };
        }
        if (resolved.requested) notes.push(`${why}; launching with the operator identity (no XTRM_ROLE, no transport rewrite)`);
        return { role, requested: resolved.requested, refused: null, notes, env: {}, configured };
    }
    // Strictly parse the inherited count: parseInt('3abc') would silently shift every
    // index and break git in the child.
    const rawCount = (env.GIT_CONFIG_COUNT ?? '').trim();
    const base = COUNT.test(rawCount) ? Number.parseInt(rawCount, 10) : 0;
    if (rawCount && !COUNT.test(rawCount)) {
        notes.push(`GIT_CONFIG_COUNT='${rawCount}' is not a number; treating it as 0`);
    }
    const transport = buildGitTransportEnv({ role, map: effectiveMap, deps, append: true, baseCount: base });
    const out: Record<string, string> = { XTRM_ROLE: role };
    if (input.forwardInherited) {
        // The pane does not inherit xt's env, so the list must be self-consistent.
        for (let index = 0; index < base; index += 1) {
            const key = env[`GIT_CONFIG_KEY_${index}`];
            const value = env[`GIT_CONFIG_VALUE_${index}`];
            if (key !== undefined) out[`GIT_CONFIG_KEY_${index}`] = key;
            if (value !== undefined) out[`GIT_CONFIG_VALUE_${index}`] = value;
        }
    }
    return { role, requested: resolved.requested, refused: null, notes, env: { ...out, ...transport }, configured };
}

/** Run BEFORE any worktree or branch exists: it decides whether to start at all. */
export function preflightLaunchIdentity(input: LaunchPreflightInput): LaunchPreflight {
    const evaluated = evaluate(input);
    return {
        role: evaluated.role,
        refused: evaluated.refused,
        // One note per launch, and only when the launch asked for a role or the role
        // map itself is broken.
        warning: !evaluated.refused && evaluated.notes.length ? evaluated.notes.join('; ') : null,
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
        note: evaluated.notes.length ? evaluated.notes.join('; ') : null,
    };
}

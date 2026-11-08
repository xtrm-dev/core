/**
 * The role map: which GitHub App an agent process may act as (CORE-2528).
 *
 * One versioned file, `~/.xtrm/config/identity-role-map.json`, keyed by role or
 * specialist name. It is never read from a specialist definition: a repository's
 * `.specialists/user` override could otherwise grant itself a role.
 *
 *   { "version": 1,
 *     "default": "worker",
 *     "specialists": { "reviewer": "reviewer", "seconder": "reviewer", "pr-reviewer": "reviewer" },
 *     "apps": { "reviewer": "xtrm-reviewer", "coordinator": "xtrm-coord", "worker": "xtrm-worker" } }
 *
 * Resolution rules (fail closed, never guessed):
 * - no name at all -> `default` (a plain `xt claude|pi|codex <name>` session is worker);
 * - a name mapped to a role -> that role;
 * - a name mapped to null -> NO role, hence no GitHub write credential;
 * - an unknown name -> `default` (other specialists are workers);
 * - a file with a different version or an invalid role -> no map at all, so no
 *   role resolves and no credential is minted.
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AgentRole = 'reviewer' | 'coordinator' | 'worker';
export const AGENT_ROLES: readonly AgentRole[] = ['reviewer', 'coordinator', 'worker'] as const;
export const ROLE_MAP_VERSION = 1;
/** The env var carrying the launching role or specialist name (never a token). */
/**
 * The role marker a launch sets (CORE-2528). It is SPOOFABLE: any process under
 * the same unix user can set XTRM_ROLE=reviewer and mint the reviewer token. The
 * design buys attribution and least privilege against mistakes, not isolation
 * from a hostile agent. Compensating controls: a review of the holder's own PR
 * is refused, every review carries the agent/run marker and a Journal receipt,
 * and the merge guard reads GitHub's review state, not the local declaration.
 */
export const ROLE_ENV_VAR = 'XTRM_ROLE';

export interface RoleMap {
    version: number;
    default: AgentRole;
    specialists: Record<string, AgentRole | null>;
    apps: Record<AgentRole, string>;
}

export const DEFAULT_ROLE_MAP: RoleMap = {
    version: ROLE_MAP_VERSION,
    default: 'worker',
    specialists: {
        reviewer: 'reviewer',
        seconder: 'reviewer',
        'pr-reviewer': 'reviewer',
    },
    apps: {
        reviewer: 'xtrm-reviewer',
        coordinator: 'xtrm-coord',
        worker: 'xtrm-worker',
    },
};

export interface RoleMapDeps {
    home?: string;
    readFile?: (file: string) => string;
}

export function roleMapPath(home: string = os.homedir()): string {
    return path.join(home, '.xtrm', 'config', 'identity-role-map.json');
}

function isRole(value: unknown): value is AgentRole {
    return typeof value === 'string' && (AGENT_ROLES as readonly string[]).includes(value);
}

/** Strict parse: any structural problem returns null so no role can resolve. */
export function parseRoleMap(raw: unknown): RoleMap | null {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;
    if (record.version !== ROLE_MAP_VERSION) return null;
    if (!isRole(record.default)) return null;
    const specialists: Record<string, AgentRole | null> = {};
    if (record.specialists !== undefined) {
        if (!record.specialists || typeof record.specialists !== 'object') return null;
        for (const [name, role] of Object.entries(record.specialists as Record<string, unknown>)) {
            if (role === null) specialists[name] = null;
            else if (isRole(role)) specialists[name] = role;
            else return null;
        }
    }
    const apps: Record<AgentRole, string> = { ...DEFAULT_ROLE_MAP.apps };
    if (record.apps !== undefined) {
        if (!record.apps || typeof record.apps !== 'object') return null;
        for (const role of AGENT_ROLES) {
            const slug = (record.apps as Record<string, unknown>)[role];
            if (slug === undefined) continue;
            if (typeof slug !== 'string' || !slug.trim()) return null;
            apps[role] = slug.trim();
        }
    }
    return { version: ROLE_MAP_VERSION, default: record.default, specialists, apps };
}

/**
 * The effective map. No file means the shipped defaults; an unreadable or
 * invalid file means NO map (fail closed, so nothing mints a token silently).
 */
export function loadRoleMap(deps: RoleMapDeps = {}): RoleMap | null {
    const read = deps.readFile ?? ((file: string) => readFileSync(file, 'utf8'));
    let text: string;
    try {
        text = read(roleMapPath(deps.home));
    } catch {
        return { ...DEFAULT_ROLE_MAP };
    }
    try {
        return parseRoleMap(JSON.parse(text));
    } catch {
        return null;
    }
}

/**
 * Role for a launching name. `null` means "no GitHub write credential", which
 * the callers must treat as a refusal, not as a fallback to the operator.
 */
export function resolveAgentRole(name: string | null | undefined, map: RoleMap | null = DEFAULT_ROLE_MAP): AgentRole | null {
    if (!map) return null;
    const wanted = (name ?? '').trim();
    if (!wanted) return map.default;
    // An explicit specialists entry wins over the bare role name: reviewer,
    // worker and coordinator are both role names and specialist names, and an
    // operator's `null` there means "this specialist gets no credential".
    if (Object.prototype.hasOwnProperty.call(map.specialists, wanted)) {
        return map.specialists[wanted];
    }
    if (isRole(wanted)) return wanted;
    // Unknown fails closed (CORE-2528 rev 4 R1): a name that is neither a role
    // nor a mapped specialist gets NO credential. It never falls back to worker,
    // because that would hand an unmapped process a write identity.
    return null;
}

/** Why a role was resolved, for `xt identity role` and for honest refusal text. */
export function explainAgentRole(
    env: NodeJS.ProcessEnv = process.env,
    map: RoleMap | null = DEFAULT_ROLE_MAP,
): { role: AgentRole | null; source: 'operator' | 'env-role' | 'specialist' | 'default' | 'unknown' } {
    const holder = (env.SUBSTRATE_HOLDER ?? '').trim();
    const name = (env[ROLE_ENV_VAR] ?? '').trim();
    if (!map) return { role: null, source: 'unknown' };
    if (!holder && !name) return { role: null, source: 'operator' };
    if (!name) return { role: map.default, source: 'default' };
    if (Object.prototype.hasOwnProperty.call(map.specialists, name)) {
        return { role: map.specialists[name], source: 'specialist' };
    }
    if (isRole(name)) return { role: name, source: 'env-role' };
    return { role: null, source: 'unknown' };
}

/** Role of the CURRENT process: operator (null) outside an agent tree. */
export function processAgentRole(
    env: NodeJS.ProcessEnv = process.env,
    map: RoleMap | null = DEFAULT_ROLE_MAP,
): AgentRole | null {
    const holder = (env.SUBSTRATE_HOLDER ?? '').trim();
    const name = (env[ROLE_ENV_VAR] ?? '').trim();
    if (!holder && !name) return null; // a shell outside any agent tree keeps the operator identity
    return resolveAgentRole(name || null, map);
}

/** The App slug a role acts as. */
export function appSlugForRole(role: AgentRole, map: RoleMap = DEFAULT_ROLE_MAP): string {
    return map.apps[role] ?? DEFAULT_ROLE_MAP.apps[role];
}

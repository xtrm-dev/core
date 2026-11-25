import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { basename } from 'node:path';

import { isValidRoleName } from './launch-identity.js';

/**
 * CORE-2792: the launch identity a worktree session was started with.
 *
 * A launcher writes this identity onto the tmux pane (`@agent_*` options) and
 * into the pane environment (`XTMUX_AGENT_*`, `XTRM_ROLE`, `XTRM_SESSION_*`).
 * Both die with the pane: a power loss, a reopened terminal or a restarted tmux
 * server leaves the worktree intact and the identity gone, which is exactly the
 * state `xt attach` had to resume from. The worktree session record lives on
 * disk, so this module owns the durable copy and the validation for it.
 *
 * Every field mirrors one value the launcher sets. An absent field means the
 * launch did not set it; attach must not turn absence into a value of its own.
 */

export interface SessionLaunchMeta {
    /** The canonical `@agent_role` value; absent for a bare launch. */
    role?: string;
    /** The operator-typed `--role` value; re-resolved for `XTRM_ROLE` on attach. */
    requestedRole?: string;
    /** The `@agent_task` value: `role:<role>` or `session:<slug>`. */
    task?: string;
    /** The `@agent_worktree` value. */
    worktree?: string;
    /** The `@agent_branch` value (short branch name, no `refs/heads/`). */
    branch?: string;
    /** The `@agent_parent_session` value. */
    parentSession?: string;
    /** The tmux session the launch created or joined; a resume keeps its own. */
    sessionName?: string;
    /**
     * The runtime's session display name (`--name`, the pane title, the session
     * list). A resume re-establishes it because the runtime is started fresh
     * even though the conversation is continued.
     */
    displayName?: string;
    /**
     * Explicit `--model` override, when the operator gave one. A role's default
     * model is NOT recorded: the role name re-derives it, and a stale copy must
     * not override a role whose default changed.
     */
    model?: string;
    /** Explicit `--thinking` override (Pi), when the operator gave one. */
    thinking?: string;
    /**
     * Extra `--skill <path>` entries the operator requested on top of the role's
     * declared skills (Pi). A resume replays them: the pool is rebuilt from
     * scratch, so an unrecorded extra skill silently disappears.
     */
    skills?: string[];
}

const LAUNCH_FIELDS = [
    'role',
    'requestedRole',
    'task',
    'worktree',
    'branch',
    'parentSession',
    'sessionName',
    'displayName',
    'model',
    'thinking',
] as const satisfies ReadonlyArray<keyof SessionLaunchMeta>;

const MAX_LAUNCH_VALUE = 4096;
/** Enough for a role's pool plus operator additions; a longer list is not a launch. */
const MAX_LAUNCH_SKILLS = 64;
// Control characters would corrupt a tmux option value or a spawned env entry.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** The task label a role launch records; the launcher and attach share this rule. */
export function taskForRole(role: string): string {
    return `role:${role}`;
}

/**
 * The task a forced `--role` gives a restored launch: a role task follows the named
 * role, a session task stays (that launch was not a role launch), and a launch with
 * no task at all gets the role's.
 */
export function taskWithRole(task: string | undefined, role: string): string {
    return !task || task.startsWith('role:') ? taskForRole(role) : task;
}

/** A record value this module is willing to write or trust: bounded, trimmed text. */
export function cleanLaunchValue(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (!text || text.length > MAX_LAUNCH_VALUE || CONTROL_CHARS.test(text)) return undefined;
    return text;
}

/**
 * A role name the launch record may carry. The record is a file inside the
 * worker's own worktree, so a forged value must not be able to name a path, a
 * flag or a second role: the same grammar the launcher accepts is the only one
 * attach will act on (CORE-2792 review, trust).
 */
function cleanRoleValue(value: unknown): string | undefined {
    const text = cleanLaunchValue(value);
    return text && isValidRoleName(text) ? text : undefined;
}

function cleanSkillList(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const out: string[] = [];
    for (const entry of value) {
        const path = cleanLaunchValue(entry);
        if (path && !out.includes(path)) out.push(path);
        if (out.length >= MAX_LAUNCH_SKILLS) break;
    }
    return out.length > 0 ? out : undefined;
}

/** The launch record without empty, non-string or unusable values — never a placeholder. */
export function compactLaunchMeta(launch: SessionLaunchMeta): SessionLaunchMeta {
    const out: SessionLaunchMeta = {};
    for (const key of LAUNCH_FIELDS) {
        const value = key === 'role' || key === 'requestedRole'
            ? cleanRoleValue(launch[key])
            : cleanLaunchValue(launch[key]);
        if (value) out[key] = value;
    }
    const skills = cleanSkillList(launch.skills);
    if (skills) out.skills = skills;
    return out;
}

/**
 * The trusted launch record from a session record read off disk. Anything a
 * damaged or hand-edited file carries beyond the known fields is dropped, and a
 * record with no usable field reads as absent rather than as an empty launch.
 */
export function readSessionLaunch(record: { launch?: unknown } | null | undefined): SessionLaunchMeta | null {
    if (!record || typeof record.launch !== 'object' || record.launch === null) return null;
    const raw = record.launch as Record<string, unknown>;
    const out: SessionLaunchMeta = {};
    for (const key of LAUNCH_FIELDS) {
        const value = key === 'role' || key === 'requestedRole'
            ? cleanRoleValue(raw[key])
            : cleanLaunchValue(raw[key]);
        if (value) out[key] = value;
    }
    const skills = cleanSkillList(raw.skills);
    if (skills) out.skills = skills;
    return Object.keys(out).length > 0 ? out : null;
}

/**
 * CORE-2792 review (trust): the in-worktree record is writable by the worker it
 * describes, so it cannot be the only word on which role — and therefore which
 * GitHub App identity — a resume adopts. The launcher also writes the same block
 * OUTSIDE the worktree, under `$HOME/.xtrm/state/launch-identity/`, and when that
 * ledger exists attach takes `role`/`requestedRole` from it ALONE, never from the
 * worktree record (attach.ts `trustedLaunchMeta`).
 *
 * Honest limit: on a single-user host the worker runs as the same uid and can
 * write that ledger too. The ledger raises the cost of an accidental or partial
 * forgery (a hand-edited copy, a damaged checkout, a stale worktree record) and
 * makes the disagreement visible; it is not a privilege boundary. A real one
 * needs a record written by another security principal — proposal in
 * docs/xt-attach-parity.md §8.7.
 */
export interface LaunchLedgerEntry {
    worktree: string;
    runtime: string;
    launch: SessionLaunchMeta;
}

/** Where the out-of-worktree copy lives; `home` is injectable for tests. */
export function launchLedgerPath(home: string, worktreePath: string): string {
    const canonical = canonicalWorktreePath(worktreePath);
    const slug = (basename(canonical) || 'worktree').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 64);
    const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
    return path.join(home, '.xtrm', 'state', 'launch-identity', `${slug}-${digest}.json`);
}

/**
 * The path a ledger is keyed by: real, absolute, no trailing slash. Without this
 * a trailing slash or a symlinked route to the same directory (both spellings a
 * shell hands out) would hash to a different file and the ledger would read as
 * absent. A path that does not exist keeps its resolved spelling, so a write for
 * a worktree that is about to disappear still lands somewhere predictable.
 */
export function canonicalWorktreePath(worktreePath: string): string {
    try {
        return realpathSync.native(worktreePath);
    } catch {
        return path.resolve(worktreePath);
    }
}

/** Write a JSON file in one step: a reader never sees a half-written record. */
export function writeJsonAtomic(dest: string, data: unknown): boolean {
    const temporary = `${dest}.${process.pid}.tmp`;
    try {
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(temporary, JSON.stringify(data, null, 2));
        renameSync(temporary, dest);
        return true;
    } catch {
        try {
            rmSync(temporary, { force: true });
        } catch {
            // Nothing left to clean up.
        }
        return false;
    }
}

/** Fail-soft: a launch never fails because the ledger could not be written. */
export function writeLaunchLedger(
    home: string,
    worktreePath: string,
    runtime: string,
    launch: SessionLaunchMeta,
): boolean {
    const compact = compactLaunchMeta(launch);
    if (Object.keys(compact).length === 0) return false;
    const entry: LaunchLedgerEntry = { worktree: canonicalWorktreePath(worktreePath), runtime, launch: compact };
    return writeJsonAtomic(launchLedgerPath(home, worktreePath), entry);
}

/**
 * Drop the ledger of a worktree that is going away. Called on removal so the
 * state directory does not accumulate identities for paths that no longer
 * exist; a leftover entry is only ever read for its own path, so a failure here
 * is untidy, never unsafe.
 */
export function removeLaunchLedger(home: string, worktreePath: string): boolean {
    try {
        rmSync(launchLedgerPath(home, worktreePath), { force: true });
        return true;
    } catch {
        return false;
    }
}

/**
 * The ledger entry for THIS worktree, or null. An entry that names a different
 * worktree is not an answer for this one: the path is part of the identity, so a
 * hash collision or a moved ledger file reads as absent.
 */
export function readLaunchLedger(home: string, worktreePath: string): SessionLaunchMeta | null {
    try {
        const raw = JSON.parse(readFileSync(launchLedgerPath(home, worktreePath), 'utf8')) as unknown;
        if (!raw || typeof raw !== 'object') return null;
        const entry = raw as Record<string, unknown>;
        if (typeof entry.worktree !== 'string') return null;
        if (canonicalWorktreePath(entry.worktree) !== canonicalWorktreePath(worktreePath)) return null;
        return readSessionLaunch({ launch: entry.launch });
    } catch {
        return null;
    }
}

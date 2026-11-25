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
    /** Explicit `--model` override (or the role model), when the launch carried one. */
    model?: string;
    /** Explicit `--thinking` override (Pi), when the launch carried one. */
    thinking?: string;
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
// Control characters would corrupt a tmux option value or a spawned env entry.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** A record value this module is willing to write or trust: bounded, trimmed text. */
export function cleanLaunchValue(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (!text || text.length > MAX_LAUNCH_VALUE || CONTROL_CHARS.test(text)) return undefined;
    return text;
}

/** The launch record without empty, non-string or unusable values — never a placeholder. */
export function compactLaunchMeta(launch: SessionLaunchMeta): SessionLaunchMeta {
    const out: SessionLaunchMeta = {};
    for (const key of LAUNCH_FIELDS) {
        const value = cleanLaunchValue(launch[key]);
        if (value) out[key] = value;
    }
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
        const value = cleanLaunchValue(raw[key]);
        if (value) out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : null;
}

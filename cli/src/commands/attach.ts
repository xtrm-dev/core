import { Command, Option } from 'commander';
import kleur from 'kleur';
import prompts from 'prompts';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { t } from '../utils/theme.js';
import { runPiLaunchPreflight } from '../core/pi-runtime.js';
import { listXtWorktrees, getRepoRoot } from './worktree.js';
import { readCodexWorktreeSession } from '../core/codex-session.js';
import { buildCodexResumeArgs } from '../core/codex-runtime.js';
import { resolveWorktreePaneIssue } from '../utils/worktree-pane-issue.js';
import { SPECIALISTS_CHANNEL_ENTRY, buildAgentEnv, claudeMcpEnv, resolveRequestedSkills, resolveRole, specialistsPluginInstalled, readSessionMeta, readSessionLaunch, launchWorktreeSession, type ResolvedRole, type SessionLaunchMeta, type SessionMeta, type WorktreeSessionOptions } from '../utils/worktree-session.js';
import { launchCodexWorktreeSession } from '../utils/codex-worktree-session.js';
import {
    SUBSTRATE_HOLDER_VAR,
    XTRM_AGENT_NAME_VAR,
    attachDispatcherEnv,
    cleanAgentName,
    stripDispatcherEnv,
} from '../core/dispatcher-identity.js';
import { buildGitIdentityEnv, resolveGitEmail } from '../core/git-identity.js';
import { isValidRoleName, resolveLaunchIdentity } from '../core/launch-identity.js';
import { loadRoleMap, resolveAgentRole } from '../core/identity-roles.js';
import { readLaunchLedger, taskWithRole } from '../core/session-launch.js';
import { buildSessionIdentityEnv, resolveCurrentTmuxSessionIdentity } from '../core/session-identity.js';
import { addPlacementOptions } from '../utils/launch-placement-options.js';
import type { WorktreeInfo } from './worktree.js';

/** Last-activity timestamp, for recency ordering. */
export function recency(wt: WorktreeInfo): number {
    return wt.lastLogTime?.getTime() ?? (wt.launchedAt ? new Date(wt.launchedAt).getTime() : 0);
}

export function mostRecent(worktrees: WorktreeInfo[]): WorktreeInfo {
    return [...worktrees].sort((a, b) => recency(b) - recency(a))[0];
}

/**
 * Match an attach target by, in order: full or short branch name, worktree
 * directory name, directory-name suffix with a `-` boundary (so "7trm" hits
 * "core-xt-pi-7trm" but "trm" does not). First match wins.
 */
export function matchWorktree(worktrees: WorktreeInfo[], name: string): WorktreeInfo | undefined {
    const shortBranch = name.replace(/^refs\/heads\//, '');
    const norm = shortBranch.startsWith('xt/') ? `refs/heads/${shortBranch}` : `refs/heads/xt/${shortBranch}`;
    return worktrees.find(wt => wt.branch === norm || wt.branch === `refs/heads/${shortBranch}` || wt.branch === shortBranch)
        ?? worktrees.find(wt => basename(wt.path) === name)
        ?? worktrees.find(wt => basename(wt.path).endsWith(`-${name}`));
}

/**
 * Spawn environment for a resumed session (CORE-2432 R8). `dispatcherEnv` is the
 * dispatcher RESTORED from the worker's launch binding (CORE-2728) — never a
 * value resolved from the attacher's environment or ancestor chain. Separated
 * for tests; the action passes the binding-derived record (live lookup).
 */
export function buildAttachEnv(
    base: NodeJS.ProcessEnv,
    runtime: string,
    dispatcherEnv: Record<string, string> = {},
    holder: string | null = null,
    worktreePath: string | null = null,
    restoredPaneOptions: ReadonlyArray<{ key: string; value: string }> = [],
    resolvedRoleIdentity: ReturnType<typeof resolveLaunchIdentity> | null = null,
): NodeJS.ProcessEnv {
    // D6 (CORE-2727): `base` is the ATTACHER's environment. Its dispatcher keys,
    // agent name, parent pane/session and git identity describe the session the
    // operator typed in, not the session being resumed, so they are stripped
    // before anything is re-added: only the restored dispatcher and the resumed
    // worker's own identity may survive. Unknown stays absent.
    //
    // CORE-2792: the same rule now covers every value this command RESTORES from
    // the worktree record — the attacher's `XTMUX_AGENT_*`, `XTRM_ROLE`,
    // `XTRM_SESSION_*` and inherited `GIT_CONFIG_*` transport describe the
    // attacher (a coordinator pane, typically), never the resumed worker.
    const stripped = stripRestoredEnv(stripDispatcherEnv(base));
    // Lead decision (CORE-2727): the resumed session is its own worker, so it gets
    // its own holder identity back — SUBSTRATE_HOLDER, the git author of that
    // holder, and XTRM_AGENT_NAME from the worktree directory — and never the
    // attacher's. Without a holder there is nothing to re-add: absent, not wrong.
    const ownEnv: Record<string, string> = {};
    const ownHolder = (holder ?? '').trim();
    if (ownHolder) {
        ownEnv[SUBSTRATE_HOLDER_VAR] = ownHolder;
        const email = worktreePath ? resolveGitEmail({ cwd: worktreePath }) : null;
        Object.assign(ownEnv, buildGitIdentityEnv({ holder: ownHolder, email }));
        const ownAgentName = cleanAgentName(worktreePath ? basename(worktreePath) : null);
        if (ownAgentName) ownEnv[XTRM_AGENT_NAME_VAR] = ownAgentName;
    }
    // The pane options this command just rewritten on the resumed pane are the
    // launch identity the launcher exported; restore the matching environment
    // from them (CORE-2792), plus the session identity of the pane that now
    // hosts the worker and the role identity of the recorded role.
    const agentEnv = buildAgentEnv(restoredPaneOptions);
    const sessionEnv = base.TMUX ? buildSessionIdentityEnv(resolveCurrentTmuxSessionIdentity(undefined, base)) : {};
    const restoredRole = restoredPaneOptions.find(option => option.key === '@agent_role')?.value ?? '';
    // The attacher's inherited git transport is already gone from `stripped`, and the
    // resolver must read THAT environment: with no `env` it falls back to process.env
    // and re-adds the attacher's credential helper ahead of the worker's (CORE-2792
    // review, credential leak).
    const roleIdentity = restoredRole && worktreePath
        ? resolvedRoleIdentity ?? resolveLaunchIdentity({
            holder: holder ?? '',
            roleName: restoredRole,
            cwd: worktreePath,
            env: stripped,
            forwardInherited: true,
        })
        : null;
    const roleEnv = roleIdentity ? roleIdentity.env : {};
    const runtimeEnv: Record<string, string> = runtime === 'codex' ? { XTMUX_AGENT_RUNTIME: 'codex' } : {};
    const restored = { ...runtimeEnv, ...agentEnv, ...sessionEnv, ...roleEnv };
    return runtime === 'claude'
        ? { ...stripped, ...dispatcherEnv, ...ownEnv, ...restored, ...claudeMcpEnv(runtime) }
        : { ...stripped, ...dispatcherEnv, ...ownEnv, ...restored };
}

/**
 * Environment keys that describe ONE launch — the pane options, the session a
 * runtime runs in, the role identity, the git transport derived from it, and the
 * supervisor markers of the session attach was typed in. The launcher exports them;
 * the attacher's inherited copies must not survive into a resumed worker (CORE-2792,
 * same rule as stripDispatcherEnv).
 */
const RESTORED_ENV_KEYS = /^(?:XTMUX_AGENT_[A-Z0-9_]+|XTRM_SESSION_ID|XTRM_SESSION_NAME|XTRM_ROLE|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|SPECIALISTS_JOB_ID|XTRM_SUPERVISOR_LAUNCH)$/;

export function stripRestoredEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
        if (!RESTORED_ENV_KEYS.test(key)) out[key] = value;
    }
    return out;
}

/**
 * The environment a FRESH launch started by attach hands to the launcher's identity
 * resolver (CORE-2792 review, gap 2).
 *
 * `xt attach --fresh` runs inside whatever session the operator typed it in — often
 * another agent's pane. The launcher resolves the new session's App identity from
 * `process.env` unless it is given an environment, so without this the new worker
 * inherits the ATTACHER's `XTRM_ROLE` and `GIT_CONFIG_*` transport ahead of its own,
 * exactly the leak the resume path closes. Dispatcher and pane keys go too, as on
 * the resume path.
 *
 * The supervisor markers go for the same reason, and the decision is deliberate
 * (CORE-2792 review, item 3): `SPECIALISTS_JOB_ID` and `XTRM_SUPERVISOR_LAUNCH`
 * describe the session attach was typed in, and the started session is not that
 * job's specialist. Keeping them would make the launcher's supervisor refusal
 * (`launch-identity.ts:161`) veto a role the durable record or `--role` asked for.
 * The role authority here is the record, not an inherited marker. A plain
 * `xt claude|pi` launcher keeps the markers and keeps refusing.
 */
export function attachLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    // stripRestoredEnv already drops the supervisor markers, so both attach paths
    // (the resumed spawn env and the --fresh identity environment) agree on them.
    return stripRestoredEnv(stripDispatcherEnv(env));
}

/**
 * The pane options a role launch writes and a resume owns (CORE-2792). attach
 * unsets every one of them before it restores the record's values: a pane that
 * hosted a coordinator keeps `@agent_role=lead` and the old issue otherwise,
 * because setting an option never clears a stale one (review finding 2).
 */
export const RESTORED_PANE_KEYS = [
    '@agent_parent_session',
    '@agent_task',
    '@agent_worktree',
    '@agent_branch',
    '@agent_issue',
    '@agent_role',
    '@agent_holder',
    '@agent_dispatcher',
    '@agent_parent_pane',
    // Legacy name: never written again, cleared so a pre-CORE-2801 pane cannot show a stale value.
    '@agent_bead',
] as const;

/**
 * The launch record this command is willing to act on (CORE-2792 review, trust).
 *
 * The worktree record is writable by the worker it describes, so `launch.role`
 * from that file alone could let a worker adopt another role — and with it
 * another GitHub App identity — on the next attach. The launcher writes the same
 * block outside the worktree; when that ledger exists, IDENTITY comes from it
 * alone: `role` and `requestedRole` are taken from the ledger and never from the
 * worktree record, so a worker that launches without a role cannot write one
 * into its own record and have attach restore it (the round-2 HIGH finding).
 *
 * The rest of the block (task, branch, parent, display name, model, thinking,
 * skills) is not identity: the ledger wins each field it carries, and the record
 * fills the gaps, which is what makes a ledger written before a field existed
 * still usable.
 *
 * With NO valid ledger — missing, damaged, naming another worktree, or deleted by
 * the worker (same uid) — the record still answers for everything except IDENTITY:
 * `role` and `requestedRole` are dropped too, because a record the worker can write
 * is exactly the file a plain direct `xt claude` never gets, and writing
 * `launch.role` into one would otherwise be enough to adopt another identity. The
 * caller reports the ignored role and the operator restores one with `--role`.
 * Losing the role on a pre-fix worktree is the safe loss (CORE-2792 review, item 1).
 */
export function trustedLaunchMeta(
    recordLaunch: SessionLaunchMeta | null,
    ledgerLaunch: SessionLaunchMeta | null,
): { launch: SessionLaunchMeta | null; conflictRole: string | null; ignoredRecordRole: string | null } {
    if (!ledgerLaunch && !recordLaunch)
        return { launch: null, conflictRole: null, ignoredRecordRole: null };
    if (!recordLaunch) return { launch: ledgerLaunch, conflictRole: null, ignoredRecordRole: null };
    const recordRole = recordLaunch.role ?? null;
    const ledgerRole = ledgerLaunch?.role ?? null;
    // Identity comes from the ledger only, and a record with no ledger behind it
    // has no identity at all. Strip both role fields from the record before
    // merging, so a record that names a role the ledger does not know is an
    // ignored claim rather than a restored one.
    const { role: _recordRole, requestedRole: _recordRequestedRole, ...recordRest } = recordLaunch;
    const merged: SessionLaunchMeta = { ...recordRest, ...(ledgerLaunch ?? {}) };
    delete merged.role;
    delete merged.requestedRole;
    if (ledgerRole) merged.role = ledgerRole;
    if (ledgerLaunch?.requestedRole) merged.requestedRole = ledgerLaunch.requestedRole;
    // The task is derived from the role at launch (`role:<name>`), so a task that
    // still names the ignored role would restore the identity the role restore
    // just refused.
    if (recordRole && ledgerRole !== recordRole && merged.task === `role:${recordRole}`) delete merged.task;
    const conflictRole = recordRole && ledgerRole && recordRole !== ledgerRole ? recordRole : null;
    const ignoredRecordRole = recordRole && !ledgerRole ? recordRole : null;
    return { launch: merged, conflictRole, ignoredRecordRole };
}

/**
 * The pane options a resumed launch must carry (CORE-2792). The launcher writes
 * these onto the pane; a resumed pane either lost them (power loss, reopened
 * terminal) or never had them (a pre-CORE-2792 record). Every value here has a
 * durable source — the worktree record's launch block, the worktree path, its
 * branch, or the Issue ref the record names — and nothing is invented: a value
 * the record does not name stays absent. The worktree path itself is always the
 * live one this command resolved.
 *
 * `@agent_state` and `@agent_instance_id` are deliberately NOT written: the
 * runtime's own agent-state hook owns them for the session it runs.
 */
export function restoredAttachPaneOptions(input: {
    launch: SessionLaunchMeta | null;
    worktreePath: string;
    branch: string;
    issue: string | null;
    /**
     * The tmux session hosting the resumed pane. A resumed pane always has a
     * parent session — the one it now runs in — so `@agent_parent_session` is
     * re-asserted even when the record names none (XTRM-1069: every resumed pane
     * showed it empty while a fresh launch showed its session id).
     */
    currentSessionId?: string | null;
    /** CORE-2801: the worker's Substrate holder (launch slug), which owns claim sync for the pane. */
    holder?: string | null;
    /**
     * CORE-2801: the restored dispatcher's Substrate participant. `@agent_parent_pane` is NOT
     * restored: a pane id does not survive the loss of the pane, so a resumed pane has none
     * (the key is unset with the other launch keys) rather than a stale or invented one.
     */
    dispatcher?: string | null;
}): Array<{ key: string; value: string }> {
    const { launch, worktreePath, branch, issue, currentSessionId, holder, dispatcher } = input;
    const options: Array<{ key: string; value: string }> = [];
    const parentSession = (launch?.parentSession ?? '').trim() || (currentSessionId ?? '').trim();
    if (parentSession) options.push({ key: '@agent_parent_session', value: parentSession });
    const task = launch?.task ?? (launch?.role ? `role:${launch.role}` : '');
    if (task) options.push({ key: '@agent_task', value: task });
    // The live worktree path wins over the recorded one: attach resolved it, and a
    // worktree that moved must not advertise the path it used to have.
    options.push({ key: '@agent_worktree', value: worktreePath });
    options.push({ key: '@agent_branch', value: launch?.branch ?? branch });
    if (issue) options.push({ key: '@agent_issue', value: issue });
    if (launch?.role) options.push({ key: '@agent_role', value: launch.role });
    if (holder) options.push({ key: '@agent_holder', value: holder });
    if (dispatcher) options.push({ key: '@agent_dispatcher', value: dispatcher });
    return options;
}

/** A tmux pane id this command may address; never a session name or an index. */
const PANE_ID = /^%[0-9]+$/;

/**
 * The pane this `xt attach` runs in — the pane the resumed worker will occupy.
 * `$TMUX_PANE` is exact when tmux exported it; otherwise ask the server. Null
 * outside tmux, where there is no pane to restore onto (env only).
 */
export function currentPaneId(env: NodeJS.ProcessEnv = process.env): string | null {
    // A pane id without a server to ask is a leftover variable, not a pane
    // (CORE-2792 review): `TMUX` is what proves this process runs inside tmux.
    if (!env.TMUX) return null;
    const fromEnv = (env.TMUX_PANE ?? '').trim();
    if (PANE_ID.test(fromEnv)) return fromEnv;
    const probe = spawnSync('tmux', ['display-message', '-p', '#{pane_id}'], { stdio: 'pipe', encoding: 'utf8' });
    const paneId = (probe.stdout ?? '').trim();
    return PANE_ID.test(paneId) ? paneId : null;
}

/**
 * The launch slug of an xt worktree, which is the worker's Substrate holder. Taken from the
 * directory name `<repo>-xt-<runtime>-<slug>` (first match), not from the branch: branches get
 * renamed while the holder stays the launch slug. Null when the name does not follow the pattern.
 */
export function holderFromWorktreePath(worktreePath: string): string | null {
    const match = /^.+?-xt-(?:claude|pi|codex)-(.+)$/.exec(basename(worktreePath));
    return match?.[1] ?? null;
}

/** A Substrate/Beads issue reference this command may pass to `sb` (no flags, no spaces). */
const SAFE_ISSUE_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What the issue lookup may read; every seam is injectable for tests. */
export interface WorkerIssueDeps {
    readMeta?: (worktreePath: string) => SessionMeta | null;
    /** The issue a live pane records for this worktree; null when none or ambiguous. */
    paneIssue?: (worktreePath: string) => string | null;
}

/** The Issue a resumed worktree was launched for, and how sure we are of it. */
export interface WorkerIssue {
    ref: string;
    /**
     * 'meta' = the worker's own session record; 'pane' = a live pane's
     * `@agent_issue` (CORE-2740 F2). A pane's metadata is written by whoever can
     * reach the live pane, so the caller must not let it choose a foreign
     * dispatcher binding.
     */
    source: 'meta' | 'pane';
    /** The exact binding this launch wrote, when the worker's own record names one. */
    bindingId: string | null;
}

/** A binding id read back from a session record (CORE-2740); no shell, no flags. */
const SAFE_BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * The session record a resumed worktree wrote. A Codex record is validated by its
 * own reader (CORE-2728 S1 carries the issue there), so a damaged Codex file cannot
 * hand the attach a issue the reader would reject; anything else is the plain
 * launcher record.
 */
function readSessionRecord(worktreePath: string): SessionMeta | null {
    const codex = readCodexWorktreeSession(worktreePath);
    if (codex) {
        return {
            runtime: 'codex',
            launchedAt: codex.launchedAt,
            ...(codex.issue ? { issue: codex.issue } : {}),
            ...(codex.launch ? { launch: codex.launch } : {}),
        };
    }
    const meta = readSessionMeta(worktreePath);
    if (!meta) return null;
    // CORE-2792: the launch block is re-read through its validator, so a damaged
    // or hand-edited file cannot name a role, a model or a parent this command
    // then writes onto a pane. An unusable block reads as absent.
    const { launch: rawLaunch, ...rest } = meta;
    const launch = readSessionLaunch({ launch: rawLaunch });
    return launch ? { ...rest, launch } : rest;
}

/**
 * The Substrate Issue a resumed worktree was launched for (CORE-2728), with its
 * provenance and the launch binding the record names (CORE-2740). The launcher's
 * session record persists it; a live pane's recorded issue is the fallback. A
 * non-string, malformed or ambiguous value is ABSENT — never a guess and never a
 * TypeError.
 */
export function resolveWorkerIssue(worktreePath: string, deps: WorkerIssueDeps = {}): WorkerIssue | null {
    const meta = (deps.readMeta ?? readSessionRecord)(worktreePath);
    // Records written before CORE-2801 name the field `bead`; read-only fallback.
    const raw = meta ? (meta.issue ?? (meta as { bead?: unknown }).bead) : undefined;
    const fromMeta = typeof raw === 'string' ? raw.trim() : '';
    if (fromMeta && SAFE_ISSUE_REF.test(fromMeta)) {
        return { ref: fromMeta, source: 'meta', bindingId: bindingIdFromMeta(meta) };
    }
    const paneIssue = deps.paneIssue ?? resolveWorktreePaneIssue;
    let fromPane: unknown;
    try {
        fromPane = paneIssue(worktreePath);
    } catch {
        return null;
    }
    const candidate = typeof fromPane === 'string' ? fromPane.trim() : '';
    if (candidate && SAFE_ISSUE_REF.test(candidate)) {
        // A pane never carries a binding: only the workspace may then say which
        // binding is this worker's own (CORE-2740 F2).
        return { ref: candidate, source: 'pane', bindingId: null };
    }
    return null;
}

/** The binding id a session record names, when it is a plausible one. */
function bindingIdFromMeta(meta: SessionMeta | null): string | null {
    const value = typeof meta?.bindingId === 'string' ? meta.bindingId.trim() : '';
    return value && SAFE_BINDING_ID.test(value) ? value : null;
}

/** The Issue ref only; kept for callers that need nothing else. */
export function resolveWorkerIssueRef(worktreePath: string, deps: WorkerIssueDeps = {}): string | null {
    return resolveWorkerIssue(worktreePath, deps)?.ref ?? null;
}

/** What `xt attach --fresh` accepts: the launch flags of `xt claude|pi`, minus what creates a worktree. */
export interface FreshAttachOptions {
    role?: string;
    model?: string;
    /**
     * Pi `--thinking` level. No flag yet: a restart restores the level the
     * original launch recorded (CORE-2792); an operator override is a follow-up.
     */
    thinking?: string;
    /** Text, or `@<file>` to read it from a file. */
    prompt?: string;
    issue?: string;
    bead?: string;
    attach?: boolean;
    window?: boolean;
    newSession?: boolean;
    pane?: string;
    workers?: boolean;
    windowName?: string;
    session?: string;
    layout?: string;
    parent?: string;
    /** Argv after `--`, forwarded verbatim to the runtime (guarded by the launcher). */
    passthrough?: string[];
}

/** The fresh-only options a caller gave; without --fresh they would be silently ignored. */
export function freshOnlyOptions(opts: FreshAttachOptions & { yolo?: boolean }): string[] {
    const given: string[] = [];
    if (opts.model !== undefined) given.push('--model');
    if (opts.prompt !== undefined) given.push('--prompt');
    if (opts.issue !== undefined || opts.bead !== undefined) given.push('--issue');
    if (opts.window) given.push('--window');
    if (opts.newSession) given.push('--new-session');
    if (opts.pane !== undefined) given.push('--pane');
    if (opts.workers) given.push('--workers');
    if (opts.windowName !== undefined) given.push('--window-name');
    if (opts.session !== undefined) given.push('--session');
    if (opts.layout !== undefined) given.push('--layout');
    if (opts.parent !== undefined) given.push('--parent');
    if (opts.attach === false) given.push('--no-attach');
    if (opts.yolo !== undefined) given.push(opts.yolo ? '--yolo' : '--no-yolo');
    return given;
}

/** `@file` reads the prompt from the file; anything else is the prompt itself. */
export function readFreshPrompt(raw: string | undefined, read: (file: string) => string = (f) => readFileSync(f, 'utf8')): string | undefined {
    if (raw === undefined) return undefined;
    if (!raw.startsWith('@')) return raw;
    return read(raw.slice(1));
}

/**
 * `--role` on either attach path: one helper, so a resume and a `--fresh` launch
 * cannot validate the same flag differently. `undefined` when the operator gave
 * no role.
 */
function parseAttachRole(raw: string | undefined): string | undefined {
    const value = (raw ?? '').trim();
    if (!value) return undefined;
    if (!isValidRoleName(value)) {
        console.error(kleur.red(`\n  ✗ --role '${value}' is not a role name (letters, digits, '.', '_' and '-', at most 64, first character alphanumeric)\n`));
        process.exit(1);
    }
    return value;
}

/**
 * The launch a FRESH session in an existing xt worktree is made from (CORE-2775).
 * The options feed the same launcher as `xt claude|pi|codex`; the worktree-derived
 * identity (slug = holder, name, branch) and the dispatcher restored from the
 * worktree's own launch binding replace what a first launch derives or creates.
 * Throws a one-line message when the worktree does not carry enough to restart.
 */
export function buildFreshLaunchOptions(
    target: WorktreeInfo,
    opts: FreshAttachOptions,
    deps: { issue?: WorkerIssue | null; dispatcher?: Record<string, string>; home?: string } = {},
): WorktreeSessionOptions {
    const slug = holderFromWorktreePath(target.path);
    if (!slug) throw new Error(`the worktree name ${basename(target.path)} does not follow <repo>-xt-<runtime>-<slug>; cannot derive its holder`);
    const issue = deps.issue === undefined ? resolveWorkerIssue(target.path) : deps.issue;
    // CORE-2792: a restart is the same launch identity, not a bare one. The role,
    // model and thinking the original launch carried are restored from the
    // worktree record unless the operator gives them explicitly; nothing else is
    // inferred (no prompt, no issue beyond the recorded Issue).
    const trusted = trustedLaunchMeta(
        readSessionLaunch(readSessionRecord(target.path)),
        readLaunchLedger(deps.home ?? homedir(), target.path),
    );
    const launch = trusted.launch;
    if (trusted.conflictRole) {
        console.error(kleur.yellow(`  ⚠ the worktree record names role '${trusted.conflictRole}' but the launch ledger disagrees; restoring the ledger's role`));
    }
    if (trusted.ignoredRecordRole) {
        console.error(kleur.yellow(`  ⚠ the worktree record names role '${trusted.ignoredRecordRole}' but the launch ledger names none; ignoring the record's role`));
    }
    // Model and thinking belong to the role they came from (review finding 3): a
    // restart under a DIFFERENT role must not inherit the old role's defaults, and
    // a recorded value is only ever an explicit operator override now.
    const recordedRole = launch?.role ?? launch?.requestedRole;
    const requestedRole = parseAttachRole(opts.role);
    // A launch records the role the operator ASKED for (`requestedRole`) beside the
    // one it mapped to (`role`). Naming either the same role, or any name the map
    // resolves to that role, is the same launch — otherwise `--fresh --role
    // senior-engineer` would drop the recorded model/thinking of the `worker`
    // launch it re-creates (review finding 3).
    const roleUnchanged = !requestedRole
        || requestedRole === recordedRole
        || requestedRole === launch?.requestedRole
        || (launch?.role != null
            && resolveAgentRole(requestedRole, loadRoleMap()) === launch.role);
    const dispatcher = deps.dispatcher ?? attachDispatcherEnv(issue?.ref ?? null, {
        bindingId: issue?.bindingId ?? null,
        workspace: target.path,
    });
    return {
        runtime: target.runtime === 'pi' ? 'pi' : 'claude',
        role: requestedRole ?? recordedRole,
        issue: opts.issue ?? opts.bead ?? issue?.ref,
        prompt: readFreshPrompt(opts.prompt),
        model: opts.model ?? (roleUnchanged ? launch?.model : undefined),
        thinking: opts.thinking ?? (roleUnchanged ? launch?.thinking : undefined),
        attach: opts.attach,
        window: Boolean(opts.window),
        newSession: Boolean(opts.newSession),
        pane: opts.pane,
        workers: Boolean(opts.workers),
        windowName: opts.windowName,
        session: opts.session,
        layout: opts.layout,
        parent: opts.parent,
        passthrough: opts.passthrough,
        // The attacher's own identity must not travel into the new session.
        identityEnv: attachLaunchEnv(process.env),
        existingWorktree: {
            path: target.path,
            branch: target.branch.replace('refs/heads/', ''),
            slug,
            dispatcher,
        },
    };
}

export function createAttachCommand(): Command {
    return addPlacementOptions(new Command('attach'))
        .description('Re-attach to an existing xt worktree and resume its Claude, Pi, or Codex session')
        .argument('[name]', 'Worktree slug, directory name, or branch to attach to (e.g. "7trm", "core-xt-pi-7trm", or "fix/my-branch")')
        .option('--fresh', 'Start a NEW session in the existing worktree (not --continue), through the same launcher as xt claude|pi: same env, runtime args and pane options; identity restores from the worktree binding')
        .option('--role <name>', 'Resume as this specialist role, or with --fresh launch as it (default: the role the launch ledger records; a role only the worktree record names is never restored)')
        .option('--model <name>', 'With --fresh: forward --model <name> to the runtime')
        .option('--prompt <text|@file>', 'With --fresh: the initial user prompt, or @<file> to read it from a file')
        .option('--issue <id>', 'With --fresh: the Issue to bind (default: the one the worktree was launched for); metadata only, the prompt is yours')
        .addOption(new Option('--bead <id>', 'Deprecated alias of --issue').hideHelp())
        .option('--window', 'With --fresh, open a detached window in the current session; prints <session>:<pane_id>')

        .option('--new-session', 'With --fresh: force a new session')
        .option('--no-attach', 'With --fresh: create the session detached and print session:pane')
        .option('--parent <target>', 'With --fresh: @agent_parent_session of the pane (session name or id)')
        .addHelpText('after', `
Without --fresh, xt attach resumes the worktree's previous conversation; with --fresh it
starts a new one with the same launch settings. Example: xt attach worker-name --fresh --workers --no-attach
`)
        .option('--yolo', 'With --fresh on a Codex worktree: disable sandboxing and approval prompts (default)')
        .option('--no-yolo', 'With --fresh on a Codex worktree: workspace-write sandbox with on-request approval')
        .allowExcessArguments(true)
        .action(async (name: string | undefined, opts: FreshAttachOptions & { fresh?: boolean; yolo?: boolean }, command: Command) => {
            // Words after `--` reach commander as excess arguments; only --fresh forwards them to the runtime.
            const extra = command.args.slice(name === undefined ? 0 : 1);
            const freshOnly = freshOnlyOptions(opts);
            if (!opts.fresh && (freshOnly.length > 0 || extra.length > 0)) {
                const what = freshOnly.length > 0 ? `${freshOnly.join(', ')} need --fresh` : `unexpected argument${extra.length > 1 ? 's' : ''}: ${extra.join(' ')}`;
                console.error(kleur.red(`\n  ✗ ${what}\n`));
                process.exit(1);
            }
            if (opts.fresh && !name) {
                console.error(kleur.red('\n  ✗ --fresh needs the worktree name (no interactive picker for a restart)\n'));
                process.exit(1);
            }
            const repoRoot = getRepoRoot(process.cwd());
            const worktrees = listXtWorktrees(repoRoot);

            if (worktrees.length === 0) {
                console.log(kleur.dim('\n  No xt worktrees found — start one with: xt claude, xt pi, or xt codex\n'));
                return;
            }

            let target = mostRecent(worktrees);

            if (name) {
                const found = matchWorktree(worktrees, name);
                if (!found) {
                    console.error(kleur.red(`\n  ✗ No xt worktree found matching "${name}"\n`));
                    console.log(kleur.dim('  Run: xt worktree list\n'));
                    process.exit(1);
                }
                target = found;
            } else if (worktrees.length > 1) {
                // Most recent first; slug is the worktree directory name, which
                // is the stable identity across branch conventions.
                const sorted = [...worktrees].sort((a, b) => recency(b) - recency(a));
                const choices = sorted.map(wt => {
                    const branch = wt.branch.replace('refs/heads/', '');
                    const slug = basename(wt.path);
                    const runtime = wt.runtime ? ` [${wt.runtime}]` : '';
                    const time = wt.lastLogTime
                        ? wt.lastLogTime.toLocaleString()
                        : wt.launchedAt
                            ? new Date(wt.launchedAt).toLocaleString()
                            : 'unknown';
                    const msg = wt.lastLogMsg ? `  "${wt.lastLogMsg.slice(0, 50)}"` : '';
                    return {
                        title: `${slug}  (${branch})${runtime}  —  ${time}${msg}`,
                        value: slug,
                    };
                });

                const { picked } = await prompts({
                    type: 'select',
                    name: 'picked',
                    message: 'Select worktree to attach',
                    choices,
                });

                if (!picked) {
                    console.log(kleur.dim('  Cancelled\n'));
                    return;
                }

                target = sorted.find(wt => basename(wt.path) === picked) ?? target;
            }

            const branch = target.branch.replace('refs/heads/', '');
            if (opts.fresh && !target.runtime && !process.stdin.isTTY) {
                // No session record names the runtime and nobody can answer a prompt (a timer wake).
                console.error(kleur.red(`\n  ✗ cannot tell which runtime ${basename(target.path)} was launched with (no session record) and there is no terminal to ask\n`));
                process.exit(1);
            }
            const runtime = target.runtime ?? await pickRuntime();

            if (opts.fresh) {
                let launch: WorktreeSessionOptions;
                try {
                    launch = buildFreshLaunchOptions(target, { ...opts, passthrough: extra });
                } catch (error) {
                    console.error(kleur.red(`\n  ✗ ${error instanceof Error ? error.message : String(error)}\n`));
                    process.exit(1);
                }
                launch.runtime = runtime === 'pi' ? 'pi' : 'claude';
                if (runtime === 'codex') {
                    if (opts.parent) {
                        console.error(kleur.red('\n  ✗ --parent is not supported for a Codex session\n'));
                        process.exit(1);
                    }
                    // --new-session is implied: the Codex launcher always creates its own session.
                    await launchCodexWorktreeSession({
                        role: launch.role, issue: launch.issue, prompt: launch.prompt, model: launch.model,
                        attach: launch.attach, window: launch.window, yolo: opts.yolo !== false,
                        passthrough: extra, existingWorktree: launch.existingWorktree,
                        identityEnv: launch.identityEnv,
                    });
                } else {
                    await launchWorktreeSession(launch);
                }
                return;
            }

            // CORE-2792: the launch identity outlives the pane in the worktree
            // record, and a resume restarts the runtime binary even though it
            // continues the conversation — so the record is read once, here, for
            // both the argv below and the pane metadata further down.
            const record = readSessionRecord(target.path);
            // CORE-2792 review (trust): the worktree copy is the worker's own file.
            // The launcher's out-of-worktree ledger is merged in, and a disagreement
            // over the role takes the role from the ledger alone, so a worker that
            // wrote a role into its own record gains nothing.
            const trusted = trustedLaunchMeta(record?.launch ?? null, readLaunchLedger(homedir(), target.path));
            const launch = trusted.launch;
            if (trusted.conflictRole) {
                console.error(kleur.yellow(`  ⚠ the worktree record names role '${trusted.conflictRole}' but the launch ledger disagrees; restoring the ledger's role`));
            }
            if (trusted.ignoredRecordRole) {
                console.error(kleur.yellow(`  ⚠ the worktree record names role '${trusted.ignoredRecordRole}' but the launch ledger names none or disagrees; ignoring the record's role (pass --role ${trusted.ignoredRecordRole} to restore it)`));
            }
            // Review item 1: a role the durable ledger does not name is never
            // restored from the worker's own file. The operator can still ask for
            // it explicitly, and that flag is validated like a launch's --role.
            const requestedRole = parseAttachRole(opts.role) ?? '';
            const effectiveRole = requestedRole || launch?.role || null;
            const launchForRestore: SessionLaunchMeta | null = effectiveRole && effectiveRole !== launch?.role
                ? { ...(launch ?? {}), role: effectiveRole, task: taskWithRole(launch?.task, effectiveRole) }
                : launch;
            // A role launch carried its identity as an inline system prompt and,
            // for pi, an isolated skill pool. Both are derivable from the role
            // name the record kept. A failed resolution warns and never blocks the
            // resume: the conversation still continues, without the role prompt.
            let resumedRole: ResolvedRole | null = null;
            let resumedSkillPaths: string[] = [];
            if (effectiveRole && runtime !== 'codex') {
                try {
                    resumedRole = resolveRole(effectiveRole, repoRoot, runtime === 'pi' ? 'pi' : 'claude');
                    // The launcher resolves the role's declared paths through the
                    // same skill resolver before it emits --skill (worktree-session
                    // buildRoleTmuxPlan); a bare name must resolve identically here.
                    if (runtime === 'pi') {
                        resumedSkillPaths = resolveRequestedSkills(repoRoot, resumedRole.skillPaths, 'pi');
                    }
                } catch (error) {
                    resumedRole = null;
                    resumedSkillPaths = [];
                    const message = error instanceof Error ? error.message : String(error);
                    console.error(kleur.dim(`  warning: could not resolve role '${effectiveRole}' (${message}); resuming without its system prompt`));
                }
            }
            const restoredName = launch?.displayName;
            const restoredPrompt = resumedRole && resumedRole.systemPrompt.trim().length > 0 ? resumedRole.systemPrompt : null;

            // The launcher refuses to start a role session on the operator
            // identity (worktree-session.ts preflight). A resume restarts the
            // runtime, so it must refuse too: otherwise the pane is labelled
            // @agent_role=reviewer, the reviewer prompt is applied, and the
            // session silently holds the operator's credentials (review
            // finding 2). Resolved once, and the same result builds the env.
            const restoredRoleIdentity = effectiveRole && runtime !== 'codex'
                ? resolveLaunchIdentity({
                    holder: holderFromWorktreePath(target.path) ?? '',
                    roleName: effectiveRole,
                    cwd: target.path,
                    env: attachLaunchEnv(process.env),
                    forwardInherited: true,
                })
                : null;
            if (restoredRoleIdentity?.refused) {
                console.error(kleur.red(`\n  \u2717 ${restoredRoleIdentity.refused}\n`));
                process.exit(1);
            }
            if (restoredRoleIdentity?.note) {
                console.error(kleur.dim(`  ${restoredRoleIdentity.note}`));
            }

            let resumeArgs: string[];
            if (runtime === 'codex') {
                const session = readCodexWorktreeSession(target.path);
                if (!session) {
                    console.error(kleur.red('\n  ✗ Codex session metadata is missing or invalid; refusing positional resume\n'));
                    process.exit(1);
                }
                resumeArgs = buildCodexResumeArgs(session.threadId, session.safetyProfile, session.profileName);
            } else if (runtime === 'claude') {
                // Same channel wake path as the launch plans (XTRM-249, CORE-2283).
                // A resumed session without it cannot be woken by a settling
                // specialist and the coordinator has to poll. Fail-soft: a
                // detection failure omits the flag and never blocks attach,
                // because Claude Code drops an unusable entry silently anyway.
                // CORE-2284.
                resumeArgs = ['--continue', '--dangerously-skip-permissions'];
                if (specialistsPluginInstalled()) {
                    resumeArgs.push('--channels', SPECIALISTS_CHANNEL_ENTRY);
                }
                // Launcher-owned display name and role system prompt (CORE-2792).
                // Claude rebuilds its system prompt for every request, so the
                // launch's --append-system-prompt is gone unless it is repeated.
                if (restoredName) resumeArgs.push('--name', restoredName);
                if (restoredPrompt) resumeArgs.push('--append-system-prompt', restoredPrompt);
            } else {
                resumeArgs = ['-c'];
                if (restoredName) resumeArgs.push('--name', restoredName);
                if (restoredPrompt) resumeArgs.push('--append-system-prompt', restoredPrompt);
                // Extra --skill entries the operator gave at launch (review nit):
                // the pool is rebuilt here, so an unrecorded addition would vanish.
                // A path that no longer exists is dropped with a warning rather than
                // handed to pi as a hard error.
                const recordedSkills = launch?.skills ?? [];
                const extraSkills: string[] = [];
                for (const skill of recordedSkills) {
                    if (existsSync(skill)) extraSkills.push(skill);
                    else console.error(kleur.dim(`  warning: recorded skill '${skill}' no longer exists; not passing it to pi`));
                }
                if (resumedRole || extraSkills.length > 0) {
                    // Same pool policy as the launcher: no global skill discovery,
                    // exactly the role's declared skills plus the recorded extras.
                    resumeArgs.push('--no-skills');
                    for (const skill of [...resumedSkillPaths, ...extraSkills]) resumeArgs.push('--skill', skill);
                }
            }

            console.log(t.bold(`\n  Attaching to ${branch}`));
            console.log(kleur.dim(`  runtime: ${runtime}  (resuming session)`));
            console.log(kleur.dim(`  path:    ${target.path}\n`));

            if (runtime === 'pi') {
                try {
                    await runPiLaunchPreflight(target.path, false);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.log(kleur.dim(`  warning: pi launch preflight failed (${message})`));
                }
            }

            // Substrate MCP needs these before the process starts; claude only. CORE-2290.
            // CORE-2728 (operator decision b): the resumed session gets its ORIGINAL
            // dispatcher back, read from the binding this worker's launch wrote. No
            // binding leaves the dispatcher absent — the attacher is never adopted.
            // CORE-2740 F2: only the binding THIS worker recorded (or one made in
            // this worktree) may answer; a issue taken from a pane cannot elect a
            // foreign dispatcher.
            const issue = resolveWorkerIssue(target.path);
            const restoredDispatcher = attachDispatcherEnv(issue?.ref ?? null, {
                bindingId: issue?.bindingId ?? null,
                workspace: target.path,
            });

            // CORE-2792: the launcher's pane options die with the pane, so a
            // resumed pane came back with an empty @agent_role and no worktree,
            // branch or issue. Restore every one of them that the worktree record
            // still answers, onto the pane this command runs in, before the
            // runtime starts — the runtime's own hook then owns @agent_state.
            const restoredOptions = restoredAttachPaneOptions({
                launch: launchForRestore,
                worktreePath: target.path,
                branch,
                issue: issue?.ref ?? (record?.issue ?? (record as { bead?: string } | null)?.bead) ?? null,
                holder: holderFromWorktreePath(target.path),
                dispatcher: restoredDispatcher.XTRM_DISPATCHER_PARTICIPANT ?? null,
                // XTRM-1069: a resumed pane's parent session is the session it now
                // runs in; the record only has the launch's own (older) one.
                currentSessionId: process.env.TMUX
                    ? resolveCurrentTmuxSessionIdentity().sessionId
                    : null,
            });
            const paneId = currentPaneId();
            if (paneId) {
                // Review finding 2: a pane that hosted a coordinator keeps
                // @agent_role=lead and the old issue, because setting an option never
                // clears a stale one. Unset the six keys first, so a value the record
                // does not name ends up ABSENT. They are not unset on exit: they
                // describe the pane that hosts the worker while it runs, and a pane
                // still showing its output must not lose the identity it ran under.
                for (const key of RESTORED_PANE_KEYS) {
                    spawnSync('tmux', ['set-option', '-p', '-u', '-t', paneId, key], { stdio: 'pipe' });
                }
                for (const { key, value } of restoredOptions) {
                    spawnSync('tmux', ['set-option', '-p', '-t', paneId, key, value], { stdio: 'pipe' });
                }
                // The launcher titles the pane after the session's display name;
                // the resume restores it only when the record carries one.
                if (restoredName) {
                    spawnSync('tmux', ['select-pane', '-t', paneId, '-T', restoredName], { stdio: 'pipe' });
                }
                console.log(kleur.dim(`  restored: ${restoredOptions.map(option => `${option.key}=${option.value}`).join(' ')}`));
            } else if (!launchForRestore) {
                console.log(kleur.dim('  restored: nothing (no launch record; outside tmux)'));
            }

            const result = spawnSync(runtime, resumeArgs, {
                cwd: target.path,
                stdio: 'inherit',
                env: buildAttachEnv(process.env, runtime, restoredDispatcher, holderFromWorktreePath(target.path), target.path, restoredOptions, restoredRoleIdentity),
            });

            process.exit(result.status ?? 0);
        });
}

async function pickRuntime(): Promise<'claude' | 'pi'> {
    const { runtime } = await prompts({
        type: 'select',
        name: 'runtime',
        message: 'No session metadata found — which runtime?',
        choices: [
            { title: 'claude', value: 'claude' },
            { title: 'pi', value: 'pi' },
        ],
        initial: 0,
    });
    return runtime ?? 'claude';
}

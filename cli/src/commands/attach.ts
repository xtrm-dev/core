import { Command } from 'commander';
import kleur from 'kleur';
import prompts from 'prompts';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { t } from '../utils/theme.js';
import { runPiLaunchPreflight } from '../core/pi-runtime.js';
import { listXtWorktrees, getRepoRoot } from './worktree.js';
import { readCodexWorktreeSession } from '../core/codex-session.js';
import { buildCodexResumeArgs } from '../core/codex-runtime.js';
import { resolveWorktreePaneBead } from '../utils/worktree-pane-bead.js';
import { SPECIALISTS_CHANNEL_ENTRY, claudeMcpEnv, specialistsPluginInstalled, readSessionMeta, launchWorktreeSession, type SessionMeta, type WorktreeSessionOptions } from '../utils/worktree-session.js';
import { launchCodexWorktreeSession } from '../utils/codex-worktree-session.js';
import {
    SUBSTRATE_HOLDER_VAR,
    XTRM_AGENT_NAME_VAR,
    attachDispatcherEnv,
    cleanAgentName,
    stripDispatcherEnv,
} from '../core/dispatcher-identity.js';
import { buildGitIdentityEnv, resolveGitEmail } from '../core/git-identity.js';
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
): NodeJS.ProcessEnv {
    // D6 (CORE-2727): `base` is the ATTACHER's environment. Its dispatcher keys,
    // agent name, parent pane/session and git identity describe the session the
    // operator typed in, not the session being resumed, so they are stripped
    // before anything is re-added: only the restored dispatcher and the resumed
    // worker's own identity may survive. Unknown stays absent.
    const stripped = stripDispatcherEnv(base);
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
    return runtime === 'claude'
        ? { ...stripped, ...dispatcherEnv, ...ownEnv, ...claudeMcpEnv(runtime) }
        : { ...stripped, ...dispatcherEnv, ...ownEnv };
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
    /** The bead a live pane records for this worktree; null when none or ambiguous. */
    paneBead?: (worktreePath: string) => string | null;
}

/** The Issue a resumed worktree was launched for, and how sure we are of it. */
export interface WorkerIssue {
    ref: string;
    /**
     * 'meta' = the worker's own session record; 'pane' = a live pane's
     * `@agent_bead` (CORE-2740 F2). A pane's metadata is written by whoever can
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
 * own reader (CORE-2728 S1 carries the bead there), so a damaged Codex file cannot
 * hand the attach a bead the reader would reject; anything else is the plain
 * launcher record.
 */
function readSessionRecord(worktreePath: string): SessionMeta | null {
    const codex = readCodexWorktreeSession(worktreePath);
    if (codex) {
        return {
            runtime: 'codex',
            launchedAt: codex.launchedAt,
            ...(codex.bead ? { bead: codex.bead } : {}),
        };
    }
    return readSessionMeta(worktreePath);
}

/**
 * The Substrate Issue a resumed worktree was launched for (CORE-2728), with its
 * provenance and the launch binding the record names (CORE-2740). The launcher's
 * session record persists it; a live pane's recorded bead is the fallback. A
 * non-string, malformed or ambiguous value is ABSENT — never a guess and never a
 * TypeError.
 */
export function resolveWorkerIssue(worktreePath: string, deps: WorkerIssueDeps = {}): WorkerIssue | null {
    const meta = (deps.readMeta ?? readSessionRecord)(worktreePath);
    const raw = meta ? meta.bead : undefined;
    const fromMeta = typeof raw === 'string' ? raw.trim() : '';
    if (fromMeta && SAFE_ISSUE_REF.test(fromMeta)) {
        return { ref: fromMeta, source: 'meta', bindingId: bindingIdFromMeta(meta) };
    }
    const paneBead = deps.paneBead ?? resolveWorktreePaneBead;
    let fromPane: unknown;
    try {
        fromPane = paneBead(worktreePath);
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
    /** Text, or `@<file>` to read it from a file. */
    prompt?: string;
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
    if (opts.role !== undefined) given.push('--role');
    if (opts.model !== undefined) given.push('--model');
    if (opts.prompt !== undefined) given.push('--prompt');
    if (opts.bead !== undefined) given.push('--bead');
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
 * The launch a FRESH session in an existing xt worktree is made from (CORE-2775).
 * The options feed the same launcher as `xt claude|pi|codex`; the worktree-derived
 * identity (slug = holder, name, branch) and the dispatcher restored from the
 * worktree's own launch binding replace what a first launch derives or creates.
 * Throws a one-line message when the worktree does not carry enough to restart.
 */
export function buildFreshLaunchOptions(
    target: WorktreeInfo,
    opts: FreshAttachOptions,
    deps: { issue?: WorkerIssue | null; dispatcher?: Record<string, string> } = {},
): WorktreeSessionOptions {
    const slug = holderFromWorktreePath(target.path);
    if (!slug) throw new Error(`the worktree name ${basename(target.path)} does not follow <repo>-xt-<runtime>-<slug>; cannot derive its holder`);
    const issue = deps.issue === undefined ? resolveWorkerIssue(target.path) : deps.issue;
    const dispatcher = deps.dispatcher ?? attachDispatcherEnv(issue?.ref ?? null, {
        bindingId: issue?.bindingId ?? null,
        workspace: target.path,
    });
    return {
        runtime: target.runtime === 'pi' ? 'pi' : 'claude',
        role: opts.role,
        bead: opts.bead ?? issue?.ref,
        prompt: readFreshPrompt(opts.prompt),
        model: opts.model,
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
        .option('--role <name>', 'With --fresh: launch as this specialist role')
        .option('--model <name>', 'With --fresh: forward --model <name> to the runtime')
        .option('--prompt <text|@file>', 'With --fresh: the initial user prompt, or @<file> to read it from a file')
        .option('--bead <id>', 'With --fresh: the Issue to bind (default: the one the worktree was launched for); metadata only, the prompt is yours')
        .option('--window', 'With --fresh, open a detached window in the current session; prints <session>:<pane_id>')

        .option('--new-session', 'With --fresh: force a new session')
        .option('--no-attach', 'With --fresh: create the session detached and print session:pane')
        .option('--parent <target>', 'With --fresh: @agent_parent_session of the pane (session name or id)')
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
                        role: launch.role, bead: launch.bead, prompt: launch.prompt, model: launch.model,
                        attach: launch.attach, window: launch.window, yolo: opts.yolo !== false,
                        passthrough: extra, existingWorktree: launch.existingWorktree,
                    });
                } else {
                    await launchWorktreeSession(launch);
                }
                return;
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
            } else {
                resumeArgs = ['-c'];
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
            // this worktree) may answer; a bead taken from a pane cannot elect a
            // foreign dispatcher.
            const issue = resolveWorkerIssue(target.path);
            const restoredDispatcher = attachDispatcherEnv(issue?.ref ?? null, {
                bindingId: issue?.bindingId ?? null,
                workspace: target.path,
            });
            const result = spawnSync(runtime, resumeArgs, { cwd: target.path, stdio: 'inherit', env: buildAttachEnv(process.env, runtime, restoredDispatcher, holderFromWorktreePath(target.path), target.path) });

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

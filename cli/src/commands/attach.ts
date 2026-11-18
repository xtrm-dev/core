import { Command } from 'commander';
import kleur from 'kleur';
import prompts from 'prompts';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { t } from '../utils/theme.js';
import { runPiLaunchPreflight } from '../core/pi-runtime.js';
import { listXtWorktrees, getRepoRoot } from './worktree.js';
import { readCodexWorktreeSession } from '../core/codex-session.js';
import { buildCodexResumeArgs } from '../core/codex-runtime.js';
import { SPECIALISTS_CHANNEL_ENTRY, claudeMcpEnv, specialistsPluginInstalled, readSessionMeta, type SessionMeta } from '../utils/worktree-session.js';
import {
    SUBSTRATE_HOLDER_VAR,
    XTRM_AGENT_NAME_VAR,
    attachDispatcherEnv,
    cleanAgentName,
    stripDispatcherEnv,
} from '../core/dispatcher-identity.js';
import { buildGitIdentityEnv, resolveGitEmail } from '../core/git-identity.js';
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

/** What the issue lookup may read; both seams are injectable for tests. */
export interface WorkerIssueDeps {
    readMeta?: (worktreePath: string) => SessionMeta | null;
    /** The tmux pane listing (`path<TAB>worktree<TAB>bead` per line). */
    listPanes?: () => string;
}

function defaultListPanes(): string {
    const result = spawnSync('tmux', ['list-panes', '-a', '-F', '#{pane_current_path}\t#{@agent_worktree}\t#{@agent_bead}'], {
        encoding: 'utf8', stdio: 'pipe',
    });
    return result.status === 0 ? String(result.stdout ?? '') : '';
}

/**
 * The Substrate Issue a resumed worktree was launched for (CORE-2728). The
 * launcher's session metadata persists it; a live pane's `@agent_bead` is the
 * fallback. Unknown stays absent, so a missing ref never becomes a wrong one.
 */
export function resolveWorkerIssueRef(worktreePath: string, deps: WorkerIssueDeps = {}): string | null {
    const meta = (deps.readMeta ?? readSessionMeta)(worktreePath);
    const fromMeta = (meta?.bead ?? '').trim();
    if (fromMeta && SAFE_ISSUE_REF.test(fromMeta)) return fromMeta;
    let listing: string;
    try {
        listing = (deps.listPanes ?? defaultListPanes)();
    } catch {
        return null;
    }
    for (const line of listing.split(/\r?\n/)) {
        const [currentPath = '', agentWorktree = '', bead = ''] = line.split('\t');
        if (currentPath !== worktreePath && agentWorktree !== worktreePath) continue;
        const candidate = bead.trim();
        if (candidate && SAFE_ISSUE_REF.test(candidate)) return candidate;
    }
    return null;
}

export function createAttachCommand(): Command {
    return new Command('attach')
        .description('Re-attach to an existing xt worktree and resume its Claude, Pi, or Codex session')
        .argument('[name]', 'Worktree slug, directory name, or branch to attach to (e.g. "7trm", "core-xt-pi-7trm", or "fix/my-branch")')
        .action(async (name: string | undefined) => {
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
            const runtime = target.runtime ?? await pickRuntime();

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
            // binding (or no live session) leaves the dispatcher absent — the
            // attacher is never adopted.
            const issueRef = resolveWorkerIssueRef(target.path);
            const restoredDispatcher = attachDispatcherEnv(issueRef);
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

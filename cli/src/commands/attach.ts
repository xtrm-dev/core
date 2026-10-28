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
import { SPECIALISTS_CHANNEL_ENTRY, claudeMcpEnv, specialistsPluginInstalled } from '../utils/worktree-session.js';
import { SUBSTRATE_HOLDER_VAR, refreshDispatcherEnv, type DispatcherIdentityDeps } from '../core/dispatcher-identity.js';
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
 * Spawn environment for a resumed session (CORE-2432 R8): freshly resolved
 * dispatcher identity on top of the base env, plus the Claude MCP env for
 * claude resumes. Separated for tests; the action passes no deps (live lookup).
 */
export function buildAttachEnv(
    base: NodeJS.ProcessEnv,
    runtime: string,
    dispatcherDeps: DispatcherIdentityDeps = {},
    holder: string | null = null,
): NodeJS.ProcessEnv {
    const dispatcherEnv = refreshDispatcherEnv(dispatcherDeps);
    // `base` is the operator's shell, which never carries the worker's holder: set it again,
    // overriding anything inherited. CORE-2536 (XT-184).
    const holderEnv = holder ? { [SUBSTRATE_HOLDER_VAR]: holder } : {};
    return runtime === 'claude'
        ? { ...base, ...dispatcherEnv, ...holderEnv, ...claudeMcpEnv(runtime) }
        : { ...base, ...dispatcherEnv, ...holderEnv };
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
            // CORE-2432 R8: a resumed session gets freshly resolved dispatcher
            // identity instead of stale inherited XTRM_DISPATCHER_* values.
            const result = spawnSync(runtime, resumeArgs, { cwd: target.path, stdio: 'inherit', env: buildAttachEnv(process.env, runtime, {}, holderFromWorktreePath(target.path)) });

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

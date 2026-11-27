/**
 * The tmux side of `xt worktree release`.
 *
 * Separated from worktree-release.ts so the predicate keeps no mutation path and can
 * be tested without a tmux server. Everything here either asks tmux a question, types
 * one nudge into a guarded agent pane, or removes a tree the predicate already passed.
 *
 * Invariants, each one learned from a live probe or from the advisor review:
 * - the removal is never forced, and never follows a `--force` exit path;
 * - a failed confirmation never falls through to removal;
 * - the nudge is never typed into a shell or a pane in copy mode;
 * - the pane options are unset explicitly after the respawn (respawn preserves them).
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
    AGENT_PANE_COMMANDS,
    checkRelease,
    keybindingPaths,
    keybindingProbes,
    launcherLinks,
    logEvent,
    NUDGEABLE_KINDS,
    processTree,
    readPpidMap,
    readTextIfExists,
    renderKeybindingSnippet,
    renderNudge,
    selfAncestry,
    sourceLine,
    TMUX_SOURCE_MARKER,
    validateClientName,
    validatePaneId,
    configSourcesSnippet,
} from './worktree-release.js';
import type { KeybindingProbe, ReleaseBlocker } from './worktree-release.js';
import { TMUX_FIELD_SEP, splitTmuxFields } from './tmux-format.js';

/**
 * '|' and not U+001F or a TAB: under a non-UTF-8 locale tmux rewrites a control
 * character inside a format argument to '_' (CORE-2802), so a control-separated
 * row collapses into one field and the pane reads as unbound (CORE-2811). Every
 * field is quoted because '|' is legal inside a worktree path, a branch name and
 * a bead ref, and a release decides on those values.
 */
const FIELD_SEP = TMUX_FIELD_SEP;

/** Same expectations the binding resolves, read in one round trip. */
export const PANE_FORMAT = [
    '#{q:@agent_worktree}',
    '#{q:@agent_branch}',
    '#{q:@agent_bead}',
    '#{q:pane_pid}',
    '#{q:pane_current_command}',
    '#{q:pane_dead}',
    '#{q:pane_in_mode}',
    '#{q:pane_current_path}',
].join(FIELD_SEP);

/** The eight fields `PANE_FORMAT` asks for, in order. */
const PANE_FIELD_COUNT = 8;

export function tmux(args: string[], timeoutMs = 15_000): { ok: boolean; out: string; err: string } {
    const r = spawnSync('tmux', args, { encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs });
    return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function sleep(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A message the operator sees in the status line. The log is written by the caller,
 *  which knows whether the outcome was a refusal, a nudge or a release. */
export function notify(text: string, paneId?: string): void {
    if (!process.env.TMUX) {
        console.error(text);
        return;
    }
    const args = ['display-message', '-d', '8000'];
    if (paneId) args.push('-t', paneId);
    args.push(text);
    tmux(args);
}

export interface PaneInfo {
    paneId: string;
    worktree: string;
    branch: string;
    bead: string;
    panePid: number;
    command: string;
    dead: boolean;
    inMode: boolean;
    currentPath: string;
}

export function readPaneInfo(paneId: string): { pane?: PaneInfo; error?: string } {
    const result = tmux(['display-message', '-p', '-t', paneId, '-F', PANE_FORMAT]);
    if (!result.ok) return { error: result.err || 'tmux could not read the pane' };

    const { fields, ok } = splitTmuxFields(result.out, FIELD_SEP);
    if (!ok || fields.length !== PANE_FIELD_COUNT) return { error: 'tmux returned an unreadable pane record' };
    const [worktree = '', branch = '', bead = '', panePidRaw = '', command = '', dead = '', inMode = '', currentPath = ''] = fields;
    const panePid = Number(panePidRaw);

    return {
        pane: {
            paneId,
            worktree: worktree.trim(),
            branch: branch.trim(),
            bead: bead.trim(),
            panePid: Number.isFinite(panePid) ? panePid : -1,
            command: command.trim(),
            dead: dead.trim() === '1',
            inMode: inMode.trim() === '1',
            currentPath: currentPath.trim(),
        },
    };
}

/** Main checkout root for a linked worktree. */
export function mainRootFor(worktreePath: string): string | null {
    const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: worktreePath, encoding: 'utf8', stdio: 'pipe' });
    if (r.status !== 0) return null;
    const common = (r.stdout ?? '').trim();
    if (!common) return null;
    const absolute = isAbsolute(common) ? common : resolve(worktreePath, common);
    return absolute.endsWith('/.git') || absolute.endsWith('\\.git') ? dirname(absolute) : absolute;
}

export interface NudgeResult {
    ok: boolean;
    detail: string;
}

/**
 * Type the nudge into the pane. Guarded three ways: the pane must be alive, must not be
 * in copy mode, and its foreground process must be an agent — pasting a paragraph into
 * a shell would run the first line as a command.
 */
export function nudgePane(pane: PaneInfo, text: string): NudgeResult {
    if (pane.dead) return { ok: false, detail: 'pane is dead' };
    if (pane.inMode) return { ok: false, detail: 'pane is in copy mode' };
    if (!AGENT_PANE_COMMANDS.includes(pane.command)) {
        return { ok: false, detail: `pane foreground is '${pane.command || 'unknown'}', not an agent` };
    }

    // The buffer name is ours alone: nothing here is derived from pane input, so there is
    // no sanitisation step that could be bypassed by a crafted name.
    const buffer = `xt-release-${process.pid}-${Date.now()}`;
    const set = tmux(['set-buffer', '-b', buffer, '--', text]);
    if (!set.ok) return { ok: false, detail: `set-buffer failed: ${set.err}` };

    const paste = tmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', pane.paneId]);
    if (!paste.ok) return { ok: false, detail: `paste-buffer failed: ${paste.err}` };

    sleep(400);
    const enter = tmux(['send-keys', '-t', pane.paneId, 'Enter']);
    if (!enter.ok) return { ok: false, detail: `send-keys failed: ${enter.err}` };

    return { ok: true, detail: 'nudge pasted and submitted' };
}

export type ReleaseAction = 'released' | 'nudged' | 'refused' | 'confirmed' | 'checked';

export interface ReleaseOutcome {
    action: ReleaseAction;
    paneId: string;
    worktree?: string;
    branch?: string;
    blockers: ReleaseBlocker[];
    detail: string;
}

function addAllowed(pid: number, allowed: Set<number>, ppids: Map<number, number>): void {
    if (pid <= 0) return;
    for (const child of processTree(pid, ppids)) allowed.add(child);
}

function headOf(worktree: string): string | null {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8', stdio: 'pipe' });
    return r.status === 0 ? (r.stdout ?? '').trim() || null : null;
}

const CONFIRM_TIMEOUT_MS = 120_000;
const CONFIRM_MARKER = 'xt-release-confirmed';

/**
 * `-p` is a tmux FORMAT: `#(cmd)` in the prompt text runs a shell command at draw time.
 * So every `#` in caller-supplied text is doubled and newlines collapse to spaces.
 */
export function escapePromptText(value: string): string {
    return value.replace(/[\r\n]+/g, ' ').replace(/#/g, '##');
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type ConfirmVerdict = 'confirmed' | 'declined';
export type ConfirmFn = (input: { client: string; prompt: string }) => ConfirmVerdict;

/**
 * Show the prompt and wait for the answer. `confirm-before` without `-b` blocks the
 * invoking client and exits 0 only when the operator confirms (1 for n, Esc, or a client
 * that went away), so the answer comes back to THIS process: no ticket, no second
 * invocation, nothing on disk that could be written by hand.
 */
export function confirmWith(
    spawn: typeof spawnSync,
    { client, prompt }: { client: string; prompt: string },
): ConfirmVerdict {
    // `confirm-before` takes ONE command argument: passing the command as separate argv
    // elements fails with "too many arguments" and the prompt never appears — every press
    // then reads as a decline. spawnSync also blocks this process while the prompt is open,
    // so the prompt must be shown by the xt process itself, never inside a loop that has
    // other work to do.
    const command = `display-message -p ${CONFIRM_MARKER}`;
    const result = spawn('tmux', ['confirm-before', '-t', client, '-p', prompt, command], {
        encoding: 'utf8', stdio: 'pipe', timeout: CONFIRM_TIMEOUT_MS,
    });

    if (result.error || result.status !== 0) return 'declined';
    // rc alone distinguishes y from n; the marker also proves the confirmed command ran,
    // so a tmux that returns 0 for another reason cannot pass as a confirmation.
    return (result.stdout ?? '').includes(CONFIRM_MARKER) ? 'confirmed' : 'declined';
}

export const confirmRelease: ConfirmFn = input => confirmWith(spawnSync, input);

export interface ReleaseOptions {
    paneId: string;
    client?: string;
    dryRun: boolean;
    procRoot?: string;
    /** Test seam: the prompt is otherwise shown with `tmux confirm-before`. */
    confirm?: ConfirmFn;
}

/**
 * The press. Every early return is deliberate: the removal is the last statement, and
 * nothing before it can be skipped by a flag.
 */
export async function releasePane(opts: ReleaseOptions): Promise<ReleaseOutcome> {
    // Every refusal leaves a log row: the operator pressed a key that could have deleted
    // a tree, so "why nothing happened" must survive the press.
    const refuse = (detail: string, worktree?: string): ReleaseOutcome => {
        notify(detail, opts.paneId);
        logEvent({ action: 'refused', pane: opts.paneId, worktree, detail });
        return { action: 'refused', paneId: opts.paneId, ...(worktree ? { worktree } : {}), blockers: [], detail };
    };

    const paneError = validatePaneId(opts.paneId);
    if (paneError) return refuse(`release refused: ${paneError}`);

    if (opts.client !== undefined && opts.client !== '') {
        const clientError = validateClientName(opts.client);
        if (clientError) return refuse(`release refused: ${clientError}`);
    }
    if (!process.env.TMUX) {
        return refuse('not inside tmux — release acts on the pane that pressed the key');
    }

    const info = readPaneInfo(opts.paneId);
    if (!info.pane) {
        return refuse(`cannot read pane ${opts.paneId}: ${info.error ?? 'unknown error'}`);
    }
    const pane = info.pane;

    if (pane.dead) return refuse('pane is dead; nothing to release', pane.worktree);
    if (!pane.worktree) {
        return refuse('pane has no @agent_worktree — it is not an xt agent worktree');
    }

    const repoRoot = mainRootFor(pane.worktree);
    if (!repoRoot) {
        return refuse(`cannot resolve the main checkout for ${pane.worktree}`, pane.worktree);
    }

    const allowed = new Set<number>();
    try {
        const ppids = readPpidMap(opts.procRoot ?? '/proc');
        addAllowed(pane.panePid, allowed, ppids);
        for (const pid of selfAncestry(ppids)) allowed.add(pid);
    } catch {
        // checkRelease reports an unreadable table as a blocker; nothing to add here.
    }

    const check = checkRelease({
        worktree: pane.worktree,
        repoRoot,
        allowedPids: allowed,
        procRoot: opts.procRoot,
    });

    const base = {
        paneId: opts.paneId,
        worktree: pane.worktree,
        branch: check.facts.branch ?? pane.branch ?? undefined,
        blockers: check.blockers,
    };

    if (!check.ok) {
        const workBlockers = check.blockers.filter(blocker => NUDGEABLE_KINDS.has(blocker.kind));
        if (workBlockers.length > 0) {
            const nudge = nudgePane(pane, renderNudge({ branch: check.facts.branch, blockers: workBlockers }));
            const summary = check.blockers.map(blocker => `${blocker.kind}: ${blocker.detail}`).join('; ');
            if (nudge.ok) {
                notify(`release blocked (${check.blockers.length}): nudge sent — press prefix+X again when the agent is done`, opts.paneId);
                logEvent({
                    action: 'nudged', pane: opts.paneId, worktree: pane.worktree,
                    branch: check.facts.branch, head: check.facts.head, detail: summary,
                });
                return { ...base, action: 'nudged', detail: summary };
            }
            notify(`release blocked: ${summary} (nudge not sent: ${nudge.detail})`, opts.paneId);
            logEvent({
                action: 'refused', pane: opts.paneId, worktree: pane.worktree,
                branch: check.facts.branch, head: check.facts.head,
                detail: `${summary}; nudge skipped: ${nudge.detail}`,
            });
            return { ...base, action: 'refused', detail: `${summary}; nudge skipped: ${nudge.detail}` };
        }

        // Nothing to fix by working: report and stop. "Not registered" is already released.
        if (check.blockers.some(blocker => blocker.kind === 'not-registered')) {
            notify(`release: ${pane.worktree} is not registered by git — already released`, opts.paneId);
            return { ...base, action: 'released', detail: 'not registered — already released' };
        }

        const summary = check.blockers.map(blocker => `${blocker.kind}: ${blocker.detail}`).join('; ');
        notify(`release refused: ${summary}`, opts.paneId);
        logEvent({
            action: 'refused', pane: opts.paneId, worktree: pane.worktree,
            branch: check.facts.branch, head: check.facts.head, detail: summary,
        });
        return { ...base, action: 'refused', detail: summary };
    }

    const head = check.facts.head ?? headOf(pane.worktree);
    if (!head) {
        const detail = 'cannot read HEAD';
        notify(`release refused: ${detail}`, opts.paneId);
        return { ...base, action: 'refused', detail };
    }

    if (opts.dryRun) {
        notify(`release-ready: ${pane.worktree} (${check.facts.branch ?? 'detached'}) at ${head.slice(0, 12)}`, opts.paneId);
        return { ...base, action: 'checked', detail: `ready at ${head.slice(0, 12)}` };
    }

    // --- confirmation ---------------------------------------------------------
    // One phase. The prompt is shown by THIS process and blocks it until the operator
    // answers, so nothing downstream needs a receipt: there is no flag, no ticket and no
    // second invocation that could start the removal.
    if (!opts.client) {
        const detail = 'needs confirmation: press prefix+X from the tmux client (or pass --client)';
        notify(`release-ready: ${check.facts.branch ?? 'detached'} — ${detail}`, opts.paneId);
        logEvent({
            action: 'refused', pane: opts.paneId, worktree: pane.worktree,
            branch: check.facts.branch, head, detail,
        });
        return { ...base, action: 'checked', detail };
    }

    const prompt = `release ${escapePromptText(check.facts.branch ?? 'detached')} and move this pane to the main checkout? its .specialists runtime state goes too. y/n`;
    logEvent({
        action: 'prompted', pane: opts.paneId, client: opts.client, worktree: pane.worktree,
        branch: check.facts.branch, head, detail: 'prompt shown to the pressing client',
    });

    const verdict = (opts.confirm ?? confirmRelease)({ client: opts.client, prompt });
    if (verdict === 'declined') {
        const detail = 'not confirmed — nothing removed';
        notify(`release ${detail}`, opts.paneId);
        logEvent({
            action: 'declined', pane: opts.paneId, client: opts.client, worktree: pane.worktree,
            branch: check.facts.branch, head, detail,
        });
        return { ...base, action: 'refused', detail };
    }

    logEvent({
        action: 'confirmed', pane: opts.paneId, client: opts.client, worktree: pane.worktree,
        branch: check.facts.branch, head, detail: 'operator answered y',
    });

    // The tree could have changed while the prompt was open: the whole predicate runs
    // again, with HEAD pinned, before anything is touched.
    const reconfirm = checkRelease({
        worktree: pane.worktree,
        repoRoot,
        expectHead: head,
        allowedPids: allowed,
        procRoot: opts.procRoot,
    });
    if (!reconfirm.ok) {
        const summary = reconfirm.blockers.map(blocker => `${blocker.kind}: ${blocker.detail}`).join('; ');
        const detail = `state changed while the prompt was open (${summary}); nothing removed`;
        notify(`release refused: ${detail}`, opts.paneId);
        logEvent({
            action: 'refused', pane: opts.paneId, client: opts.client, worktree: pane.worktree,
            branch: check.facts.branch, head, detail,
        });
        return { ...base, blockers: reconfirm.blockers, action: 'refused', detail };
    }

    // --- confirmed path -------------------------------------------------------
    const respawn = tmux(['respawn-pane', '-k', '-t', opts.paneId, '-c', repoRoot]);
    if (!respawn.ok) {
        const detail = `respawn-pane failed: ${respawn.err || 'unknown error'}; nothing removed`;
        notify(`release failed: ${detail}`, opts.paneId);
        logEvent({ action: 'failed', pane: opts.paneId, worktree: pane.worktree, head, detail });
        return { ...base, action: 'refused', detail };
    }

    // The respawned shell starts in the main checkout; anything still inside the tree is a
    // user. Wait briefly for the old process tree to disappear.
    const deadline = Date.now() + 5_000;
    let verify = checkRelease({ worktree: pane.worktree, repoRoot, expectHead: head, procRoot: opts.procRoot });
    while (!verify.ok && Date.now() < deadline && verify.blockers.every(blocker => blocker.kind === 'held-by-process')) {
        sleep(250);
        verify = checkRelease({ worktree: pane.worktree, repoRoot, expectHead: head, procRoot: opts.procRoot });
    }

    if (!verify.ok) {
        const summary = verify.blockers.map(blocker => `${blocker.kind}: ${blocker.detail}`).join('; ');
        const detail = `re-check after respawn failed: ${summary}; nothing removed`;
        notify(`release failed: ${detail}`, opts.paneId);
        logEvent({
            action: 'failed', pane: opts.paneId, worktree: pane.worktree,
            branch: check.facts.branch, head, detail,
        });
        return { ...base, blockers: verify.blockers, action: 'refused', detail };
    }

    // Unlink only the launcher's own links, re-verified now, and say so: an operator who
    // looks after a failed removal must know the tree is no longer wired to the main
    // checkout's skills.
    const links = launcherLinks(pane.worktree, repoRoot);
    const unlinked: Array<{ linkPath: string; target: string }> = [];
    for (const name of links) {
        const linkPath = join(pane.worktree, '.specialists', name);
        try {
            // Remembered so a failed removal can put the tree back the way it was.
            const target = readlinkSync(linkPath);
            unlinkSync(linkPath);
            unlinked.push({ linkPath, target });
            logEvent({ action: 'released', pane: opts.paneId, worktree: pane.worktree, head, detail: `unlinked ${linkPath}` });
        } catch (error) {
            logEvent({
                action: 'failed', pane: opts.paneId, worktree: pane.worktree, head,
                detail: `could not unlink ${linkPath}: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }

    // Never forced: if git still sees something, the tree stays and the operator keeps the work.
    const remove = spawnSync('git', ['worktree', 'remove', pane.worktree], {
        cwd: repoRoot, encoding: 'utf8', stdio: 'pipe',
    });

    if (remove.status !== 0) {
        const reason = (remove.stderr ?? '').trim() || 'unknown error';
        const detail = `git worktree remove refused: ${reason}`;
        // Put the launch links back: the tree stays, so it must stay wired to the
        // main checkout's skills exactly as it was.
        const restored = restoreLauncherLinks(unlinked);
        const linksNote = unlinked.length > 0
            ? `; ${restored}/${unlinked.length} launch links restored`
            : '';
        notify(`release failed: ${reason.split('\n')[0]} — nothing was forced${linksNote}`, opts.paneId);
        logEvent({
            action: 'failed', pane: opts.paneId, worktree: pane.worktree, branch: check.facts.branch, head,
            detail: `${reason}; exact command: git -C ${repoRoot} worktree remove ${pane.worktree}${linksNote}`,
        });
        return { ...base, action: 'refused', detail };
    }

    for (const option of ['@agent_worktree', '@agent_branch', '@agent_bead']) {
        tmux(['set-option', '-p', '-u', '-t', opts.paneId, option]);
    }

    notify(`released ${pane.worktree} (${check.facts.branch ?? 'detached'}); branch kept, .specialists runtime state removed with the tree`, opts.paneId);
    logEvent({
        action: 'released', pane: opts.paneId, worktree: pane.worktree,
        branch: check.facts.branch, head, detail: 'removed; branch kept; .specialists runtime state removed',
    });
    return { ...base, action: 'released', detail: `removed ${pane.worktree}; branch ${check.facts.branch ?? '(detached)'} kept` };
}

export interface UnlinkedLauncherLink {
    linkPath: string;
    target: string;
}

/**
 * Undo the unlink when the removal still fails: a tree that stays must stay wired to the
 * main checkout's skills. Returns how many links were recreated.
 */
export function restoreLauncherLinks(unlinked: UnlinkedLauncherLink[]): number {
    let restored = 0;
    for (const { linkPath, target } of unlinked) {
        try {
            if (!existsSync(linkPath) && lstatSync(dirname(linkPath)).isDirectory()) {
                symlinkSync(target, linkPath);
                restored += 1;
            }
        } catch {
            // A link that cannot be restored is reported by the caller; the tree is intact.
        }
    }
    return restored;
}

/** The prefix checkbox, before anything is written. */
function existingPrefixXBinding(): string | null {
    const result = tmux(['list-keys', '-T', 'prefix', 'X']);
    if (!result.ok) return null;
    return result.out;
}

export interface InstallKeybindingResult {
    snippetPath: string;
    tmuxConfPath: string;
    written: string[];
    messages: string[];
}

/**
 * Write the managed snippet and make ~/.tmux.conf source it.
 *
 * Refuses when prefix X is already bound to something else: silently replacing a binding
 * the operator wrote would be worse than not installing.
 */
export async function installKeybinding(opts: { dryRun: boolean; yes: boolean }): Promise<InstallKeybindingResult> {
    const paths = keybindingPaths();
    const snippet = renderKeybindingSnippet();
    const written: string[] = [];
    const messages: string[] = [];

    const existing = existingPrefixXBinding();
    if (existing && existing.trim() && !existing.includes('worktree release')) {
        throw new Error(`prefix X is already bound: ${existing.split('\n')[0]}`);
    }
    if (existing && existing.includes('worktree release') && !opts.dryRun) {
        messages.push('prefix X already bound to xt worktree release — rewriting the snippet only');
    }

    if (opts.dryRun) return { snippetPath: paths.snippetPath, tmuxConfPath: paths.tmuxConfPath, written: [], messages: [snippet] };

    if (!opts.yes) {
        const { confirmDestructiveAction } = await import('../utils/confirmation.js');
        const proceed = await confirmDestructiveAction({
            yes: false,
            message: `Write ${paths.snippetPath} and add its source line to ${paths.tmuxConfPath}?`,
            initial: false,
        });
        if (!proceed) {
            messages.push('cancelled — nothing written');
            return { snippetPath: paths.snippetPath, tmuxConfPath: paths.tmuxConfPath, written, messages };
        }
    }

    mkdirSync(dirname(paths.snippetPath), { recursive: true, mode: 0o755 });
    writeFileSync(paths.snippetPath, snippet, 'utf8');
    chmodSync(paths.snippetPath, 0o644);
    written.push(paths.snippetPath);

    const tmuxConf = readTextIfExists(paths.tmuxConfPath);
    if (tmuxConf === null) {
        writeFileSync(paths.tmuxConfPath, `${TMUX_SOURCE_MARKER}\n${sourceLine(paths)}\n`, 'utf8');
        chmodSync(paths.tmuxConfPath, 0o644);
        written.push(paths.tmuxConfPath);
    } else if (!configSourcesSnippet(tmuxConf, paths)) {
        const separator = tmuxConf.endsWith('\n') || tmuxConf.length === 0 ? '' : '\n';
        writeFileSync(paths.tmuxConfPath, `${tmuxConf}${separator}\n${TMUX_SOURCE_MARKER}\n${sourceLine(paths)}\n`, 'utf8');
        written.push(paths.tmuxConfPath);
    } else {
        messages.push(`${paths.tmuxConfPath} already sources the snippet`);
    }

    if (process.env.TMUX) {
        const loaded = tmux(['source-file', paths.snippetPath]);
        messages.push(loaded.ok ? 'snippet loaded into the running server' : `source-file failed: ${loaded.err}`);
    } else {
        messages.push('not inside tmux — the snippet loads with the next server start');
    }

    return { snippetPath: paths.snippetPath, tmuxConfPath: paths.tmuxConfPath, written, messages };
}

/** Probe whether `xt` resolves inside tmux's own environment. */
function xtOnTmuxPath(): boolean | null {
    let dir: string;
    try {
        dir = mkdtempSync(join(tmpdir(), 'xt-tmux-path-'));
    } catch {
        return null;
    }
    const probe = join(dir, 'value');
    const run = tmux(['run-shell', '-b', `command -v xt > ${shellQuote(probe)} 2>/dev/null || echo MISSING > ${shellQuote(probe)}`]);
    if (!run.ok) return null;

    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
        if (existsSync(probe)) {
            const value = (readTextIfExists(probe) ?? '').trim();
            const found = value.length > 0 && value !== 'MISSING';
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                // best effort
            }
            return found;
        }
        sleep(100);
    }
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        // best effort
    }
    return null;
}

export function gatherKeybindingProbes(): KeybindingProbe[] {
    const paths = keybindingPaths();
    const snippet = readTextIfExists(paths.snippetPath);
    const tmuxConf = readTextIfExists(paths.tmuxConfPath);
    const binding = process.env.TMUX ? existingPrefixXBinding() : null;

    return keybindingProbes({
        snippetExists: snippet !== null,
        snippetHasBinding: Boolean(snippet && snippet.includes('bind X') && snippet.includes('worktree release')),
        tmuxConfExists: tmuxConf !== null,
        tmuxConfSources: tmuxConf !== null && configSourcesSnippet(tmuxConf, paths),
        binding,
        xtOnPath: process.env.TMUX ? xtOnTmuxPath() : null,
    });
}


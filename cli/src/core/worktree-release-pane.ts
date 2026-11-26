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
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
    AGENT_PANE_COMMANDS,
    checkRelease,
    keybindingPaths,
    keybindingProbes,
    logRelease,
    launcherLinks,
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

const FIELD_SEP = '\u001f';

/** Same expectations the binding resolves, read in one round trip. */
const PANE_FORMAT = [
    '#{@agent_worktree}',
    '#{@agent_branch}',
    '#{@agent_bead}',
    '#{pane_pid}',
    '#{pane_current_command}',
    '#{pane_dead}',
    '#{pane_in_mode}',
    '#{pane_current_path}',
].join(FIELD_SEP);

export function tmux(args: string[], timeoutMs = 15_000): { ok: boolean; out: string; err: string } {
    const r = spawnSync('tmux', args, { encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs });
    return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function sleep(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A message the operator sees in the status line, and a line in the log for later. */
export function notify(text: string, paneId?: string): void {
    logRelease(text);
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

    const [worktree = '', branch = '', bead = '', panePidRaw = '', command = '', dead = '', inMode = '', currentPath = ''] = result.out.split(FIELD_SEP);
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

/** The command the confirmation re-runs: the whole check again, pinned to this head. */
function rerunCommand(opts: { paneId: string; client: string; head: string; ticket: string }): string {
    const which = spawnSync('which', ['xt'], { encoding: 'utf8', stdio: 'pipe' });
    const binary = which.status === 0 && which.stdout.trim()
        ? which.stdout.trim()
        : `${process.execPath} ${process.argv[1] ?? 'xt'}`;
    // Every token here is validated before it is used: %<digits>, a client name of
    // [A-Za-z0-9/_.-], a 32-hex ticket and a 40-hex head. shellQuote is still applied so
    // the /bin/sh run-shell layer sees one token per argument.
    return [binary, 'worktree', 'release', '--pane', opts.paneId, '--client', opts.client, '--ticket', opts.ticket, '--expect-head', opts.head]
        .map(shellQuote)
        .join(' ');
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

const TICKET_TTL_MS = 120_000;
const TICKET_ID = /^[0-9a-f]{32}$/;

interface ReleaseTicket {
    paneId: string;
    client: string;
    head: string;
    createdAt: number;
}

function ticketDir(): string {
    return join(homedir(), '.cache', 'xt', 'worktree-release');
}

/**
 * A one-shot ticket is what makes the confirmation unbypassable. There is no `--yes`:
 * the removal path runs only when it presents a ticket that this machine wrote moments
 * ago and that names the same pane and the same head. Deleting the tree needs an
 * operator keypress, not a flag anyone can add to a command line.
 */
export function createTicket(input: { paneId: string; client: string; head: string }): string | null {
    try {
        const dir = ticketDir();
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const id = randomBytes(16).toString('hex');
        const body: ReleaseTicket = { ...input, createdAt: Date.now() };
        writeFileSync(join(dir, `${id}.json`), JSON.stringify(body), { encoding: 'utf8', mode: 0o600 });
        return id;
    } catch (error) {
        logRelease(`could not write the confirmation ticket: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

export function consumeTicket(id: string, input: { paneId: string; head: string }): { ok: true } | { ok: false; detail: string } {
    if (!TICKET_ID.test(id)) return { ok: false, detail: 'confirmation ticket is malformed' };
    const file = join(ticketDir(), `${id}.json`);
    let raw: string;
    try {
        raw = readFileSync(file, 'utf8');
    } catch {
        return { ok: false, detail: 'confirmation ticket not found — nothing removed' };
    }
    // Single use, before any other decision: a replayed ticket cannot remove a second tree.
    try {
        unlinkSync(file);
    } catch {
        return { ok: false, detail: 'confirmation ticket could not be consumed — nothing removed' };
    }
    let ticket: ReleaseTicket;
    try {
        ticket = JSON.parse(raw) as ReleaseTicket;
    } catch {
        return { ok: false, detail: 'confirmation ticket is unreadable — nothing removed' };
    }
    if (ticket.paneId !== input.paneId) return { ok: false, detail: 'confirmation ticket belongs to another pane' };
    if (Date.now() - ticket.createdAt > TICKET_TTL_MS) return { ok: false, detail: 'confirmation ticket expired — press prefix+X again' };
    if (ticket.head !== input.head) return { ok: false, detail: 'HEAD moved since the prompt — press prefix+X again' };
    return { ok: true };
}

export interface ReleaseOptions {
    paneId: string;
    client?: string;
    ticket?: string;
    dryRun: boolean;
    expectHead?: string;
    procRoot?: string;
}

/** Blocker kinds a nagging agent can resolve; everything else is a refusal. */
const NUDGEABLE_KINDS = new Set<string>(['dirty', 'ignored-work', 'skip-worktree', 'unpushed', 'detached-head', 'held-by-process']);

/**
 * The press. Every early return is deliberate: the removal is the last statement, and
 * nothing before it can be skipped by a flag.
 */
export async function releasePane(opts: ReleaseOptions): Promise<ReleaseOutcome> {
    const paneError = validatePaneId(opts.paneId);
    if (paneError) {
        notify(`release refused: ${paneError}`);
        return { action: 'refused', paneId: opts.paneId, blockers: [], detail: paneError };
    }
    if (opts.client !== undefined && opts.client !== '') {
        const clientError = validateClientName(opts.client);
        if (clientError) {
            notify(`release refused: ${clientError}`);
            return { action: 'refused', paneId: opts.paneId, blockers: [], detail: clientError };
        }
    }
    if (!process.env.TMUX && !opts.ticket) {
        const detail = 'not inside tmux — release acts on the pane that pressed the key';
        notify(detail);
        return { action: 'refused', paneId: opts.paneId, blockers: [], detail };
    }

    const info = readPaneInfo(opts.paneId);
    if (!info.pane) {
        const detail = `cannot read pane ${opts.paneId}: ${info.error ?? 'unknown error'}`;
        notify(detail, opts.paneId);
        return { action: 'refused', paneId: opts.paneId, blockers: [], detail };
    }
    const pane = info.pane;

    if (pane.dead) {
        const detail = 'pane is dead; nothing to release';
        notify(detail, opts.paneId);
        return { action: 'refused', paneId: opts.paneId, blockers: [], detail };
    }
    if (!pane.worktree) {
        const detail = 'pane has no @agent_worktree — it is not an xt agent worktree';
        notify(detail, opts.paneId);
        return { action: 'refused', paneId: opts.paneId, blockers: [], detail };
    }

    const repoRoot = mainRootFor(pane.worktree);
    if (!repoRoot) {
        const detail = `cannot resolve the main checkout for ${pane.worktree}`;
        notify(detail, opts.paneId);
        return { action: 'refused', paneId: opts.paneId, worktree: pane.worktree, blockers: [], detail };
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
        expectHead: opts.expectHead,
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
                logRelease(`nudged pane ${opts.paneId} in ${pane.worktree}: ${summary}`);
                return { ...base, action: 'nudged', detail: summary };
            }
            notify(`release blocked: ${summary} (nudge not sent: ${nudge.detail})`, opts.paneId);
            logRelease(`release refused for pane ${opts.paneId} in ${pane.worktree}: ${summary}; nudge skipped: ${nudge.detail}`);
            return { ...base, action: 'refused', detail: `${summary}; nudge skipped: ${nudge.detail}` };
        }

        // Nothing to fix by working: report and stop. "Not registered" is already released.
        if (check.blockers.some(blocker => blocker.kind === 'not-registered')) {
            notify(`release: ${pane.worktree} is not registered by git — already released`, opts.paneId);
            return { ...base, action: 'released', detail: 'not registered — already released' };
        }

        const summary = check.blockers.map(blocker => `${blocker.kind}: ${blocker.detail}`).join('; ');
        notify(`release refused: ${summary}`, opts.paneId);
        logRelease(`release refused for pane ${opts.paneId} in ${pane.worktree}: ${summary}`);
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
    // Two paths reach the removal below: a ticket this machine issued for this pane and
    // head moments ago, or nothing. There is no flag that skips the prompt.
    let ticketHead = head;
    if (opts.ticket) {
        const consumed = consumeTicket(opts.ticket, { paneId: opts.paneId, head });
        if (!consumed.ok) {
            notify(`release refused: ${consumed.detail}`, opts.paneId);
            logRelease(`release refused for pane ${opts.paneId} in ${pane.worktree}: ${consumed.detail}`);
            return { ...base, action: 'refused', detail: consumed.detail };
        }
        ticketHead = head;
    } else {
        if (!opts.client) {
            const detail = 'needs confirmation: press prefix+X from the tmux client (or pass --client)';
            notify(`release-ready: ${check.facts.branch ?? 'detached'} — ${detail}`, opts.paneId);
            return { ...base, action: 'checked', detail };
        }

        const ticket = createTicket({ paneId: opts.paneId, client: opts.client, head });
        if (!ticket) {
            const detail = 'could not write a confirmation ticket — nothing removed';
            notify(`release not confirmed: ${detail}`, opts.paneId);
            return { ...base, action: 'refused', detail };
        }

        const confirm = tmux([
            'confirm-before', '-t', opts.client,
            '-p', `release ${check.facts.branch ?? 'detached'} and move this pane to the main checkout? y/n`,
            'run-shell', '-b', rerunCommand({ paneId: opts.paneId, client: opts.client, head, ticket }),
        ]);

        if (!confirm.ok) {
            // Fail closed: no prompt, no removal, and the ticket cannot outlive a prompt
            // that was never shown.
            try {
                rmSync(join(ticketDir(), `${ticket}.json`), { force: true });
            } catch {
                // best effort
            }
            const detail = `confirmation could not be shown (${confirm.err || 'tmux refused'}); nothing removed`;
            notify(`release not confirmed: ${confirm.err || 'tmux refused'} — nothing removed`, opts.paneId);
            logRelease(`release not confirmed for pane ${opts.paneId} in ${pane.worktree}: ${detail}`);
            return { ...base, action: 'refused', detail };
        }

        logRelease(`confirmation shown for pane ${opts.paneId} in ${pane.worktree} at ${head.slice(0, 12)}`);
        return { ...base, action: 'confirmed', detail: 'awaiting y/n in the pressing client' };
    }

    // --- confirmed path -------------------------------------------------------
    const respawn = tmux(['respawn-pane', '-k', '-t', opts.paneId, '-c', repoRoot]);
    if (!respawn.ok) {
        const detail = `respawn-pane failed: ${respawn.err || 'unknown error'}; nothing removed`;
        notify(`release failed: ${detail}`, opts.paneId);
        logRelease(`release failed for pane ${opts.paneId}: ${detail}`);
        return { ...base, action: 'refused', detail };
    }

    // The respawned shell starts in the main checkout; anything still inside the tree is a
    // user. Wait briefly for the old process tree to disappear.
    const deadline = Date.now() + 5_000;
    let verify = checkRelease({ worktree: pane.worktree, repoRoot, expectHead: ticketHead, procRoot: opts.procRoot });
    while (!verify.ok && Date.now() < deadline && verify.blockers.every(blocker => blocker.kind === 'held-by-process')) {
        sleep(250);
        verify = checkRelease({ worktree: pane.worktree, repoRoot, expectHead: ticketHead, procRoot: opts.procRoot });
    }

    if (!verify.ok) {
        const summary = verify.blockers.map(blocker => `${blocker.kind}: ${blocker.detail}`).join('; ');
        const detail = `re-check after respawn failed: ${summary}; nothing removed`;
        notify(`release failed: ${detail}`, opts.paneId);
        logRelease(`release failed for pane ${opts.paneId} in ${pane.worktree}: ${detail}`);
        return { ...base, blockers: verify.blockers, action: 'refused', detail };
    }

    // Unlink only the launcher's own links, re-verified now, and say so: an operator who
    // looks after a failed removal must know the tree is no longer wired to the main
    // checkout's skills.
    const links = launcherLinks(pane.worktree, repoRoot);
    for (const name of links) {
        const linkPath = join(pane.worktree, '.specialists', name);
        try {
            unlinkSync(linkPath);
            logRelease(`unlinked ${linkPath}`);
        } catch (error) {
            logRelease(`could not unlink ${linkPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // Never forced: if git still sees something, the tree stays and the operator keeps the work.
    const remove = spawnSync('git', ['worktree', 'remove', pane.worktree], {
        cwd: repoRoot, encoding: 'utf8', stdio: 'pipe',
    });

    if (remove.status !== 0) {
        const reason = (remove.stderr ?? '').trim() || 'unknown error';
        const detail = `git worktree remove refused: ${reason}`;
        notify(`release failed: ${reason.split('\n')[0]} — nothing was forced`, opts.paneId);
        logRelease(`release failed for ${pane.worktree}: ${reason}; exact command: git -C ${repoRoot} worktree remove ${pane.worktree}`);
        return { ...base, action: 'refused', detail };
    }

    for (const option of ['@agent_worktree', '@agent_branch', '@agent_bead']) {
        tmux(['set-option', '-p', '-u', '-t', opts.paneId, option]);
    }

    notify(`released ${pane.worktree} (${check.facts.branch ?? 'detached'}); launch links removed, branch kept`, opts.paneId);
    logRelease(`released ${pane.worktree} for pane ${opts.paneId} at ${head.slice(0, 12)}; branch kept`);
    return { ...base, action: 'released', detail: `removed ${pane.worktree}; branch ${check.facts.branch ?? '(detached)'} kept` };
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


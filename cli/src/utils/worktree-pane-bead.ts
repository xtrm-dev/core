/**
 * The Substrate Issue a live agent pane records for a worktree (CORE-2728).
 *
 * `xt attach` resolves the worker's Issue after a pause: the launcher's session
 * record is the primary source, and a live pane's `@agent_bead` is the fallback.
 * The probe lives in this module, not in the attach command, because a resumed
 * session is pane-free by contract — cli/test/codex-k1-failure-residue asserts
 * that attach does not transport a session through the multiplexer, and this is
 * the one place allowed to read the pane listing.
 *
 * Unknown stays absent: no pane, an unreadable listing and an ambiguous set of
 * panes all answer null, never a guess.
 */

import { spawnSync } from 'node:child_process';

/** The tmux format: pane cwd, the worktree the launcher recorded, the bead. */
export const PANE_LISTING_FORMAT = '#{pane_current_path}\t#{@agent_worktree}\t#{@agent_bead}';

/**
 * Hard ceiling for the pane probe (CORE-2740 F3). `xt attach` waits on this
 * listing before it starts a runtime, so a wedged tmux server (or a tmux socket
 * a same-user process made stop answering) must not hang the attach: past this
 * bound the probe is killed and reads as absent.
 */
export const PANE_PROBE_TIMEOUT_MS = 2_000;

/**
 * Every pane's `path<TAB>worktree<TAB>bead` row, or '' when tmux cannot answer
 * (no server, no binary, or no answer within `timeoutMs`). Never throws.
 */
export function listAgentPanes(timeoutMs: number = PANE_PROBE_TIMEOUT_MS): string {
    try {
        const result = spawnSync('tmux', ['list-panes', '-a', '-F', PANE_LISTING_FORMAT], {
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: timeoutMs,
            killSignal: 'SIGKILL',
        });
        // A timeout leaves status null (the process was killed), so a hung probe
        // and a failing probe read the same way: absent.
        return result.status === 0 ? String(result.stdout ?? '') : '';
    } catch {
        return '';
    }
}

/**
 * The bead of the pane(s) that sit in `worktreePath`. A pane matches on an
 * EXACT path: its current cwd or the worktree the launcher recorded for it, never
 * a suffix or a basename. Several panes naming different beads are ambiguous, so
 * the answer is absent rather than whichever row came first.
 */
export function beadFromPaneListing(listing: string, worktreePath: string): string | null {
    const beads = new Set<string>();
    for (const line of String(listing ?? '').split(/\r?\n/)) {
        const [currentPath = '', agentWorktree = '', bead = ''] = line.split('\t');
        if (currentPath !== worktreePath && agentWorktree !== worktreePath) continue;
        const candidate = bead.trim();
        if (candidate) beads.add(candidate);
    }
    return beads.size === 1 ? [...beads][0] ?? null : null;
}

/**
 * Resolve the pane bead for one worktree. `probe` is the listing seam: tests
 * inject a listing, production runs `listAgentPanes`. Never throws.
 */
export function resolveWorktreePaneBead(
    worktreePath: string,
    probe: () => string = listAgentPanes,
): string | null {
    try {
        return beadFromPaneListing(probe(), worktreePath);
    } catch {
        return null;
    }
}

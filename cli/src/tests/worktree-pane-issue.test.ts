// CORE-2728: the pane probe lives in its own module (attach stays pane-free), so
// its parsing is pinned here: EXACT path match, and an ambiguous set of panes is
// absent rather than whichever row came first.

import { describe, expect, it } from 'vitest';

import { issueFromPaneListing, resolveWorktreePaneIssue } from '../utils/worktree-pane-issue.js';

const WT = '/repo/.xtrm/worktrees/repo-xt-pi-worker';

/** One row in the real format: pane cwd, recorded worktree, issue. */
function row(currentPath: string, agentWorktree: string, issue: string): string {
    return `${currentPath}|${agentWorktree}|${issue}`;
}

describe('issueFromPaneListing: the pane issue of one worktree (CORE-2728 F7)', () => {
    it('matches the pane cwd and the recorded worktree, both EXACTLY', () => {
        expect(issueFromPaneListing(row(WT, '', 'CORE-2728'), WT)).toBe('CORE-2728');
        expect(issueFromPaneListing(row('/elsewhere', WT, 'CORE-2728'), WT)).toBe('CORE-2728');
        // A second pane in the same worktree naming the same issue is not ambiguous.
        expect(issueFromPaneListing([row(WT, '', 'CORE-2728'), row('/elsewhere', WT, 'CORE-2728')].join('\n'), WT)).toBe('CORE-2728');
    });

    it('never matches a suffix, a prefix or a neighbouring worktree', () => {
        // Exact path only: no basename or suffix fuzziness.
        expect(issueFromPaneListing(row(`${WT}-2`, '', 'CORE-9999'), WT)).toBeNull();
        expect(issueFromPaneListing(row(`/repo/.xtrm/worktrees/other`, '', 'CORE-9999'), WT)).toBeNull();
        expect(issueFromPaneListing(row('/elsewhere', '/elsewhere', 'CORE-9999'), WT)).toBeNull();
        expect(issueFromPaneListing('', WT)).toBeNull();
        expect(issueFromPaneListing(row(WT, '', '  '), WT)).toBeNull();
    });

    it('is absent when two matching panes name different beads', () => {
        const listing = [row(WT, '', 'CORE-1'), row('/elsewhere', WT, 'CORE-2')].join('\n');
        expect(issueFromPaneListing(listing, WT)).toBeNull();
        // Order never decides: the same rows reversed are still ambiguous.
        expect(issueFromPaneListing([row('/elsewhere', WT, 'CORE-2'), row(WT, '', 'CORE-1')].join('\n'), WT)).toBeNull();
    });
});

describe('resolveWorktreePaneIssue: the injected listing seam', () => {
    it('reads the injected listing and survives a throwing probe', () => {
        expect(resolveWorktreePaneIssue(WT, () => row(WT, '', 'CORE-2728'))).toBe('CORE-2728');
        expect(resolveWorktreePaneIssue(WT, () => {
            throw new Error('no server');
        })).toBeNull();
    });
});

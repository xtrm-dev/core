import { describe, expect, it } from 'vitest';
import { matchWorktree, mostRecent, recency } from '../commands/attach.js';
import type { WorktreeInfo } from '../commands/worktree.js';

function wt(path: string, branch: string, lastLogTime?: Date): WorktreeInfo {
    return { path, branch, head: '', prunable: false, ...(lastLogTime ? { lastLogTime } : {}) };
}

const fixtures = [
    wt('/r/.xtrm/worktrees/core-xt-pi-7trm', 'refs/heads/fix/substrate-suggest-wake-chrome', new Date('2026-10-03T18:21:19Z')),
    wt('/r/.xtrm/worktrees/core-xt-claude-frame-stall-runs', 'refs/heads/xt/frame-stall-runs', new Date('2026-10-01T10:00:00Z')),
    wt('/r/.xtrm/worktrees/core-xt-claude-auth', 'refs/heads/feature/XTRM-599-auth-contracts'),
];

describe('matchWorktree', () => {
    it('matches by directory-name suffix with a - boundary', () => {
        expect(matchWorktree(fixtures, '7trm')?.branch).toContain('substrate-suggest');
    });
    it('matches by full directory name', () => {
        expect(matchWorktree(fixtures, 'core-xt-pi-7trm')?.branch).toContain('substrate-suggest');
    });
    it('matches by feature branch name (non-xt convention)', () => {
        expect(matchWorktree(fixtures, 'feature/XTRM-599-auth-contracts')?.path).toContain('auth');
    });
    it('still matches legacy xt/ branches by slug', () => {
        expect(matchWorktree(fixtures, 'frame-stall-runs')?.path).toContain('frame-stall-runs');
    });
    it('returns undefined for unknown names', () => {
        expect(matchWorktree(fixtures, 'nope')).toBeUndefined();
        // suffix must respect the - boundary: no partial-token match
        expect(matchWorktree(fixtures, 'trm')).toBeUndefined();
    });
});

describe('recency ordering', () => {
    it('picks the latest lastLogTime, falling back to zero', () => {
        expect(recency(fixtures[0])).toBeGreaterThan(recency(fixtures[1]));
        expect(recency(fixtures[2])).toBe(0);
        expect(mostRecent(fixtures)).toBe(fixtures[0]);
    });
});

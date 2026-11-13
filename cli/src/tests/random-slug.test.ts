import { describe, expect, it } from 'vitest';

import { randomSlug } from '../utils/worktree-session.js';

// CORE-2637: CodeQL #52 flagged Math.random() in randomSlug. The slug names a
// session and reaches paths, tmux names and environment values treated as
// identity, so it must come from node:crypto. These assertions pin the contract
// callers depend on, which a rewrite could otherwise change silently.
describe('randomSlug (CORE-2637)', () => {
    it('returns exactly len characters from [a-z0-9]', () => {
        for (let i = 0; i < 1000; i += 1) {
            expect(randomSlug(12)).toMatch(/^[a-z0-9]{12}$/);
        }
    });

    it('honours the default length and longer lengths', () => {
        expect(randomSlug()).toMatch(/^[a-z0-9]{4}$/);
        expect(randomSlug(1)).toMatch(/^[a-z0-9]$/);
        expect(randomSlug(64)).toMatch(/^[a-z0-9]{64}$/);
    });

    it('does not repeat across many draws', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 500; i += 1) seen.add(randomSlug(8));
        // A 36^8 space: 500 draws colliding would mean a broken generator.
        expect(seen.size).toBe(500);
    });

    it('draws from the whole alphabet, not just its start', () => {
        const joined = Array.from({ length: 200 }, () => randomSlug(8)).join('');
        expect(joined).toMatch(/[a-z]/);
        expect(joined).toMatch(/[0-9]/);
    });
});

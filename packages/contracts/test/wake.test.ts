import { describe, it, expect } from 'vitest';
import { stableWakeMessageId } from '../src/wake.js';

describe('stableWakeMessageId (I1 R9)', () => {
    it('is a stable 32-char lowercase hex id for one (participant, payloadRef) pair', () => {
        const first = stableWakeMessageId('test-session', 'bg_abc123');
        expect(first).toMatch(/^[0-9a-f]{32}$/);
        expect(stableWakeMessageId('test-session', 'bg_abc123')).toBe(first);
    });

    it('differs across participants and across payload refs', () => {
        const base = stableWakeMessageId('session-a', 'bg_abc123');
        expect(stableWakeMessageId('session-b', 'bg_abc123')).not.toBe(base);
        expect(stableWakeMessageId('session-a', 'bg_other')).not.toBe(base);
    });

    it('joins the pair with a NUL separator so adjacent splits cannot collide', () => {
        // Without a separator ("a"+"bc" vs "ab"+"c") two different pairs
        // would share one id and a redelivery would wake twice or not at all.
        expect(stableWakeMessageId('a', 'bc')).not.toBe(stableWakeMessageId('ab', 'c'));
    });

    it('is deterministic across calls (redelivery deduplicates instead of waking twice)', () => {
        const ids = new Set(
            Array.from({ length: 5 }, () => stableWakeMessageId('monitor-session', 'mon_xyz:3')),
        );
        expect(ids.size).toBe(1);
    });
});

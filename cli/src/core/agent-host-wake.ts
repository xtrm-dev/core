/**
 * Wake contract helpers (CORE-2432 I1, ADR rev 2).
 *
 * One wake contract exists in core: `wake(participant, payloadRef)` returns a
 * message id and a delivery state from the fixed vocabulary `queued, held,
 * delivered, refused, undelivered, expired`. The wake carries a payload
 * reference only, never a contract or a decision; Substrate stays the work
 * authority.
 *
 * This module holds the pure pieces (stable ids, participant matching). The
 * `AgentHostRegistry` owns the live wake records and delivery.
 */

import type { WakeDeliveryState, WakeResult } from '@xtrm/contracts';
/**
 * Single stable-id helper (CORE-2436 I5 unification): the duplicate that
 * lived here now re-exports the @xtrm/contracts copy (packages/contracts/src/wake.ts).
 */
export { stableWakeMessageId } from '@xtrm/contracts';

export type { WakeDeliveryState, WakeResult };

/** Fixed delivery vocabulary; keep in sync with `WakeDeliveryState`. */
export const WAKE_STATES: readonly WakeDeliveryState[] = [
    'queued',
    'held',
    'delivered',
    'refused',
    'undelivered',
    'expired',
];

/** How long a queued or held wake is retained before it reads as expired. */
export const DEFAULT_WAKE_TTL_MS = 5 * 60_000;

/** Upper bound on retained wake records; the oldest settled record is evicted first. */
export const MAX_WAKE_RECORDS = 1024;

/** Minimal session shape participant matching needs. */
export interface WakeResolvableSession {
    sessionId: string;
    sessionName?: string;
    workItemRef?: string;
    lastActivityAt?: number;
}

/**
 * Resolve a participant to one live session id (R7, R8).
 *
 * Order: exact sessionId, then exact sessionName, then exact workItem ref (so a
 * worker resolves its dispatcher across worktrees and restarts, CORE-2418 seq 2).
 * Matching is exact only. An exact name shared by several sessions is an error
 * that names every candidate. Unknown participants return null: `wake()` holds
 * the message until the participant registers.
 */
export function resolveWakeParticipant(
    sessions: readonly WakeResolvableSession[],
    participant: string,
): { sessionId: string } | null {
    const direct = sessions.find((s) => s.sessionId === participant);
    if (direct) return { sessionId: direct.sessionId };
    const named = sessions.filter((s) => s.sessionName === participant);
    if (named.length > 1) {
        const candidates = named.map((s) => s.sessionId).sort().join(', ');
        throw new Error(`ambiguous participant "${participant}": ${candidates}`);
    }
    if (named.length === 1) return { sessionId: named[0].sessionId };
    const byWorkItem = sessions.filter((s) => s.workItemRef === participant);
    if (byWorkItem.length > 1) {
        const candidates = byWorkItem.map((s) => s.sessionId).sort().join(', ');
        throw new Error(`ambiguous participant "${participant}": ${candidates}`);
    }
    if (byWorkItem.length === 1) return { sessionId: byWorkItem[0].sessionId };
    return null;
}

/** One retained wake message. */
export interface WakeRecord {
    messageId: string;
    participant: string;
    payloadRef: string;
    /**
     * True when the message id was caller-supplied (CORE-2436 I5 follow-up b):
     * the id is an idempotency key across terminal states, so a retry with
     * the same id returns the recorded state and never resends. Stable
     * (derived) ids keep the F5 resend-after-terminal behaviour.
     */
    callerMessageId: boolean;
    /** Sender address for the from-envelope (CORE-2436 I5). */
    from?: string;
    /** Sender display name for the from-name attribute. */
    fromName?: string;
    /** Sender session id for exact reply routing. */
    fromSessionId?: string;
    /** This message answers an earlier ask with this message id. */
    replyTo?: string;
    /** The sender wants one idle notice (or the 12 h expiry notice). */
    notifyWhenIdle?: boolean;
    /** Live session the wake is addressed to; null while held for an unknown participant. */
    sessionId: string | null;
    state: WakeDeliveryState;
    createdAt: number;
    expiresAt: number;
    /** How many times the wake frame was sent to a producer. */
    sendCount: number;
}

/** A queued or held record whose TTL passed reads as expired. */
export function wakeStateNow(record: WakeRecord, now: number = Date.now()): WakeDeliveryState {
    if ((record.state === 'queued' || record.state === 'held') && now >= record.expiresAt) return 'expired';
    return record.state;
}

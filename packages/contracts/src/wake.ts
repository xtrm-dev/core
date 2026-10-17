// I1 wake-contract helpers (CORE-2432). Pure Node runtime module: kept out of
// types.ts so the hand-authored type mirror stays dependency-free.
import { createHash } from 'node:crypto';

/**
 * Stable message id for one (participant, payloadRef) pair (I1 R9).
 * Redelivery of the same pair computes the same id, so receivers deduplicate
 * instead of waking twice. Hex sha256 over the pair joined by a NUL separator.
 *
 * Note: cli/src/core/agent-host-wake.ts keeps an identical copy; the copy
 * stays until a slice owns unifying them (background B1 must not refactor cli).
 */
export function stableWakeMessageId(participant: string, payloadRef: string): string {
    return createHash('sha256').update(`${participant}\0${payloadRef}`, 'utf8').digest('hex').slice(0, 32);
}

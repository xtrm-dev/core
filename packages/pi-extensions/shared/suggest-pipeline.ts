/**
 * The shared suggestion pipeline (CORE-2549).
 *
 * Both suggest extensions used to decide alone and synchronously: skill-suggest
 * awaited Jev before pi handled the prompt, substrate-suggest awaited up to
 * three Jev calls at agent_end, and both could fire in the same turn. Now:
 *
 *   observe (sync, in-memory) -> classify (detached, parallel) ->
 *   arbitrate (here) -> deliver (steer, triggerTurn: false)
 *
 * The arbiter is process-global (both extensions load into one pi process):
 * at most one delivery per agent run across both, session-wide dedupe, and an
 * answer whose evidence moved on (a newer prompt arrived) is dropped as stale.
 * Delivery uses the rule measured in CORE-2548: steer reaches the next model
 * request mid-run, and is read at the next prompt when the run has ended.
 */

export type ProposalOutcome = "delivered" | "stale" | "turn_taken" | "duplicate";

interface Arbiter {
  /** Bumped once per operator prompt; answers carry the epoch they were asked in. */
  epoch: number;
  lastPrompt: unknown;
  /** One delivery per agent run, across both extensions. */
  slotTaken: boolean;
  /** Session-wide dedupe of delivered suggestion keys. */
  delivered: Set<string>;
  /** Detached classifications in flight, for tests and shutdown. */
  pending: Set<Promise<unknown>>;
}

const KEY = Symbol.for("xtrm.suggest.pipeline");
function arbiter(): Arbiter {
  const g = globalThis as unknown as Record<symbol, Arbiter | undefined>;
  return (g[KEY] ??= { epoch: 0, lastPrompt: null, slotTaken: false, delivered: new Set(), pending: new Set() });
}

/**
 * A new operator prompt: evidence moves on. Idempotent per event object, so
 * both extensions may call it for the same input event.
 */
export function notePrompt(event: unknown): number {
  const a = arbiter();
  if (event !== a.lastPrompt) {
    a.lastPrompt = event;
    a.epoch += 1;
  }
  return a.epoch;
}

/** A new agent run: the per-run delivery slot opens. Idempotent. */
export function noteRunStart(): void {
  arbiter().slotTaken = false;
}

export function currentEpoch(): number {
  return arbiter().epoch;
}

/** New session: forget dedupe and slot state. */
export function resetSession(): void {
  const a = arbiter();
  a.slotTaken = false;
  a.delivered.clear();
}

/**
 * Offer one suggestion. `deliver` runs only when the answer is still current,
 * the run's slot is free and the key was not delivered this session.
 */
export function propose(p: { epoch: number; key: string; deliver: () => void }): ProposalOutcome {
  const a = arbiter();
  if (p.epoch !== a.epoch) return "stale";
  if (a.delivered.has(p.key)) return "duplicate";
  if (a.slotTaken) return "turn_taken";
  a.slotTaken = true;
  a.delivered.add(p.key);
  try {
    p.deliver();
  } catch {
    /* fail-open: a delivery failure never breaks a turn */
  }
  return "delivered";
}

/** Run classification work off the handler's critical path. Never rejects. */
export function detach(work: () => Promise<unknown>): void {
  const a = arbiter();
  const job: Promise<unknown> = Promise.resolve()
    .then(work)
    .catch(() => undefined)
    .finally(() => a.pending.delete(job));
  a.pending.add(job);
}

/** Wait until every detached job, including ones they start, has finished. */
export async function settle(): Promise<void> {
  const a = arbiter();
  while (a.pending.size > 0) await Promise.all([...a.pending]);
}

/** Test hook: a fresh arbiter. */
export function resetPipeline(): void {
  const g = globalThis as unknown as Record<symbol, Arbiter | undefined>;
  g[KEY] = undefined;
}

/** The delivery options every suggestion uses (CORE-2548 decision). */
export const DELIVERY = { deliverAs: "steer", triggerTurn: false } as const;

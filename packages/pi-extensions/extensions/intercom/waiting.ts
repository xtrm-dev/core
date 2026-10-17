/**
 * Intercom waiting-count source and footer chip (CORE-2435 I4, XT-91 ADR rev 2
 * + amendment 1, D5 as amended: the chip shows only while something waits).
 *
 * The chip reads "intercom · 1 pending ask" (the contract's example) and is
 * hidden otherwise. It renders through custom-footer's registerFooterSection
 * under the intercom key, in the theme default with no ANSI and no hex
 * colours: the section seam passes width only, so the chip inherits the
 * footer style instead of inventing its own.
 *
 * The store is the seam I5's SendMessage feeds: pending asks it opened and
 * undelivered messages it noticed. Tests inject counts directly.
 */

import { registerFooterSection } from "../custom-footer/index.ts";

export interface WaitingStore {
  getPendingAsks(): number;
  getUndelivered(): number;
  setPendingAsks(count: number): void;
  setUndelivered(count: number): void;
  total(): number;
  subscribe(listener: () => void): () => void;
}

function clampCount(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  return Math.max(0, n);
}

/** Small waiting-count source. I5 feeds it; the chip reads it. */
export function createWaitingStore(): WaitingStore {
  let pendingAsks = 0;
  let undelivered = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* a faulty listener must never break the count */
      }
    }
  };
  return {
    getPendingAsks: () => pendingAsks,
    getUndelivered: () => undelivered,
    setPendingAsks: (count: number) => {
      pendingAsks = clampCount(count);
      emit();
    },
    setUndelivered: (count: number) => {
      undelivered = clampCount(count);
      emit();
    },
    total: () => pendingAsks + undelivered,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The session-wide store I5's SendMessage feeds. */
export const intercomWaiting = createWaitingStore();

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The chip text, or null while nothing waits. Plain text only: no ANSI, no
 * colours — it inherits the footer theme.
 */
export function formatIntercomChip(store: Pick<WaitingStore, "getPendingAsks" | "getUndelivered" | "total">): string | null {
  if (store.total() === 0) return null;
  const parts = ["intercom"];
  const asks = clampCount(store.getPendingAsks());
  const undelivered = clampCount(store.getUndelivered());
  if (asks > 0) parts.push(plural(asks, "pending ask", "pending asks"));
  if (undelivered > 0) parts.push(plural(undelivered, "undelivered message", "undelivered messages"));
  if (parts.length === 1) return null;
  return parts.join(" · ");
}

/** Footer section lines: the chip while something waits, nothing otherwise. */
export function footerLines(store: Pick<WaitingStore, "getPendingAsks" | "getUndelivered" | "total">, _width: number): string[] {
  const chip = formatIntercomChip(store);
  return chip ? [chip] : [];
}

/** Register the waiting-only chip under the intercom key. */
export function registerIntercomFooter(store: Pick<WaitingStore, "getPendingAsks" | "getUndelivered" | "total"> = intercomWaiting): () => void {
  return registerFooterSection("intercom", (width: number) => footerLines(store, width));
}

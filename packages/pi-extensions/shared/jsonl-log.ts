/**
 * Buffered async JSONL decision log (CORE-2534).
 *
 * Both suggest extensions logged with mkdirSync + appendFileSync on every row,
 * inside pi event handlers. Rows now go to an in-memory queue and are written
 * by one chained async append; `append` never touches the filesystem and never
 * throws. `flush` lets tests (and shutdown) wait for the queue to drain.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface JsonlLog {
  append(row: Record<string, unknown>): void;
  flush(): Promise<void>;
}

/** `dir` is resolved per write, so a test can redirect the log after import. */
export function createJsonlLog(dir: () => string, file = "log.jsonl"): JsonlLog {
  let queue: string[] = [];
  let writing: Promise<void> = Promise.resolve();
  let scheduled = false;
  const made = new Set<string>();

  const drain = async () => {
    scheduled = false;
    const lines = queue;
    queue = [];
    if (lines.length === 0) return;
    try {
      const target = dir();
      if (!made.has(target)) {
        await mkdir(target, { recursive: true });
        made.add(target);
      }
      await appendFile(join(target, file), lines.join(""));
    } catch {
      /* logging is best-effort, never load-bearing */
    }
  };

  return {
    append(row) {
      try {
        queue.push(`${JSON.stringify(row)}\n`);
      } catch {
        return; // an unserialisable row is dropped, never thrown into a turn
      }
      if (!scheduled) {
        scheduled = true;
        writing = writing.then(drain);
      }
    },
    async flush() {
      // A row appended while a drain is in flight schedules another link.
      while (scheduled || queue.length > 0) {
        if (!scheduled) {
          scheduled = true;
          writing = writing.then(drain);
        }
        await writing;
      }
      await writing;
    },
  };
}

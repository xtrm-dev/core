/**
 * The one place the reviewer routing text lives (CORE-2530).
 *
 * `gh pr create` earns a reminder, not a block. The reminder is installed to
 * `~/.xtrm/config/reviewer-routing.md` by `xt identity setup`; the hook reads
 * that file, so an operator can refine the wording without a code change. The
 * text names tiers, never repositories.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REVIEWER_ROUTING_FILE = 'reviewer-routing.md';

export function routingReminderPath(home: string = os.homedir()): string {
    return path.join(home, '.xtrm', 'config', REVIEWER_ROUTING_FILE);
}

export const DEFAULT_REVIEWER_ROUTING = `# Reviewer routing

A PR merges only with a review by the reviewer App at its current head.

| SCRUTINY | who reviews |
| --- | --- |
| HIGH or critical | Claude-backed: the reviewer subagent in PR mode, or \`xt claude --role pr-reviewer\` |
| MEDIUM or LOW | the \`pr-reviewer\` specialist verdict is acceptable |

- Read the pushed head, then post one review at that head: PASS -> APPROVE,
  PARTIAL -> COMMENT, FAIL -> REQUEST_CHANGES.
- PARTIAL needs a coordinator decision entry for that head in the Issue Journal.
- \`gh pr merge\` runs \`xt identity merge-check\` and refuses a missing, stale or
  CHANGES_REQUESTED review. The override is for the coordinator and the operator.
`;

/** Write the reminder when absent; an operator edit is never overwritten. */
export function installRoutingReminder(home: string = os.homedir()): { path: string; written: boolean } {
    const file = routingReminderPath(home);
    try {
        readFileSync(file);
        return { path: file, written: false };
    } catch {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, DEFAULT_REVIEWER_ROUTING);
        return { path: file, written: true };
    }
}

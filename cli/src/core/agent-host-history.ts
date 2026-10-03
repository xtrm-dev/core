/**
 * Session history read of the XTRM agent host (PRD xtrm-app §26, §36.11 criterion 28; XTRM-604).
 *
 * `GET /v1/sessions/:id/history` answers with the Frame-relevant entries of a Pi session journal,
 * so a client can project every Frame, not only those still in the bounded replay buffer. The
 * journal stays authoritative and is opened read-only; the host keeps no copy of it.
 *
 * - The journal is the session's `sessionFile` (live registry, else the session index). It must
 *   open with a Pi `session` header whose id is the requested session; anything else is refused,
 *   so a producer-reported path cannot expose another file.
 * - Entries are the journal's own, in order, on the active branch: the path from the last entry
 *   back to the root through `parentId`. Other branches are left out (tree projection is separate).
 * - Only `message` and `compaction` entries are returned. Strings longer than 64 KiB are cut and
 *   image data is dropped; `truncated` says that this happened.
 */

import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import type { AgentHostApiV1 } from '@xtrm/contracts';

export type SessionHistory = Extract<AgentHostApiV1, { kind: 'session_history' }>;

/** Longest string kept in one entry; the app shows at most 64 KiB of a tool result. */
export const HISTORY_STRING_MAX = 64 * 1024;
const HISTORY_TYPES = new Set(['message', 'compaction']);

export class HistoryRejection extends Error {
    constructor(
        readonly code: 'history_not_found' | 'history_unsupported',
        message: string,
    ) {
        super(message);
    }
}

type Entry = Record<string, unknown> & { id?: unknown; parentId?: unknown; type?: unknown };

/** Strings above the bound are cut; image parts lose their data. Returns whether anything changed. */
function bound(value: unknown, cut: { done: boolean }): unknown {
    if (typeof value === 'string') {
        if (value.length <= HISTORY_STRING_MAX) return value;
        cut.done = true;
        return `${value.slice(0, HISTORY_STRING_MAX)}\n… truncated`;
    }
    if (Array.isArray(value)) return value.map((v) => bound(v, cut));
    if (value && typeof value === 'object') {
        const o = value as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(o)) {
            if (k === 'data' && o.type === 'image') {
                cut.done = true;
                continue;
            }
            out[k] = bound(v, cut);
        }
        return out;
    }
    return value;
}

/** Read a Pi journal and return its Frame-relevant entries on the active branch. */
export async function readPiHistory(file: string, sessionId: string): Promise<SessionHistory> {
    const entries: Entry[] = [];
    let header = false;
    const stream = createReadStream(file, { encoding: 'utf8', flags: 'r' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            if (!line.trim()) continue;
            let entry: Entry;
            try {
                entry = JSON.parse(line) as Entry;
            } catch {
                continue; // a partial last line while Pi is still writing it
            }
            if (!header) {
                if (entry.type !== 'session' || entry.id !== sessionId) {
                    throw new HistoryRejection('history_not_found', `${file} is not the journal of session ${sessionId}`);
                }
                header = true;
                continue;
            }
            entries.push(entry);
        }
    } catch (error) {
        if (error instanceof HistoryRejection) throw error;
        throw new HistoryRejection('history_not_found', `cannot read the journal of session ${sessionId}`);
    } finally {
        lines.close();
        stream.destroy();
    }
    if (!header) throw new HistoryRejection('history_not_found', `the journal of session ${sessionId} is empty`);

    const cut = { done: false };
    const kept = activeBranch(entries)
        .filter((e) => HISTORY_TYPES.has(e.type as string))
        .map((e) => bound(e, cut) as Record<string, unknown>);
    return {
        schema: 'xtrm.agent-host-api.v1',
        kind: 'session_history',
        sessionId,
        provider: 'pi',
        entries: kept,
        ...(cut.done ? { truncated: true } : {}),
    };
}

/** Entries on the path from the last entry to the root; file order when entries carry no ids. */
export function activeBranch(entries: Entry[]): Entry[] {
    const byId = new Map<string, Entry>();
    for (const e of entries) if (typeof e.id === 'string') byId.set(e.id, e);
    if (byId.size === 0) return entries;
    let leaf: Entry | undefined;
    for (let i = entries.length - 1; i >= 0 && !leaf; i -= 1) if (typeof entries[i]!.id === 'string') leaf = entries[i];
    const path: Entry[] = [];
    const seen = new Set<string>();
    for (let e = leaf; e && typeof e.id === 'string' && !seen.has(e.id); e = typeof e.parentId === 'string' ? byId.get(e.parentId) : undefined) {
        seen.add(e.id);
        path.push(e);
    }
    return path.reverse();
}

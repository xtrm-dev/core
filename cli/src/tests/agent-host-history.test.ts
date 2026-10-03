// XTRM-604: the agent host's session history read — active branch, entry filter, bounds, refusal.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HISTORY_STRING_MAX, readPiHistory } from '../core/agent-host-history.js';

const sessionId = '019f9a10-0000-7000-8000-0000000000aa';
const header = { type: 'session', version: 3, id: sessionId, timestamp: '2026-10-02T10:00:00.000Z', cwd: '/w' };
const msg = (id: string, parentId: string | null, role: string, content: unknown) => ({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-10-02T10:00:01.000Z',
    message: { role, content, timestamp: 1 },
});

describe('readPiHistory (XTRM-604)', () => {
    let dir: string;
    let file: string;
    const write = (entries: unknown[], tail = '') => writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n${tail}`);

    beforeEach(() => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'xt-history-'));
        file = path.join(dir, 's.jsonl');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('returns message and compaction entries on the path from the last entry to the root', async () => {
        write([
            header,
            msg('u1', null, 'user', 'first'),
            msg('x1', 'u1', 'assistant', 'abandoned branch'),
            msg('a1', 'u1', 'assistant', 'kept'),
            { type: 'label', id: 'l1', parentId: 'a1', timestamp: header.timestamp, targetId: 'a1', label: 'x' },
            { type: 'compaction', id: 'c1', parentId: 'l1', timestamp: header.timestamp, summary: 's', firstKeptEntryId: 'a1', tokensBefore: 9 },
            msg('u2', 'c1', 'user', 'second'),
        ], '{"type":"message","id":"partial');
        const h = await readPiHistory(file, sessionId);
        expect(h.entries.map((e) => e.id)).toEqual(['u1', 'a1', 'c1', 'u2']);
        expect(h).not.toHaveProperty('truncated');
    });

    it('cuts long strings and drops image data, and says so', async () => {
        const long = 'x'.repeat(HISTORY_STRING_MAX * 2);
        write([header, msg('t1', null, 'toolResult', [{ type: 'text', text: long }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }])]);
        const h = await readPiHistory(file, sessionId);
        const content = (h.entries[0]!.message as { content: Record<string, unknown>[] }).content;
        expect((content[0]!.text as string).length).toBeLessThan(long.length);
        expect(content[1]).toEqual({ type: 'image', mimeType: 'image/png' });
        expect(h.truncated).toBe(true);
    });

    it('refuses a file that is not the journal of the session', async () => {
        write([{ ...header, id: 'another' }, msg('u1', null, 'user', 'x')]);
        await expect(readPiHistory(file, sessionId)).rejects.toMatchObject({ code: 'history_not_found' });
        await expect(readPiHistory(path.join(dir, 'missing.jsonl'), sessionId)).rejects.toMatchObject({ code: 'history_not_found' });
    });
});

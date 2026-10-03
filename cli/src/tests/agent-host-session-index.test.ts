// XTRM-565: the incremental session index — stopped sessions from Pi and Claude journals,
// served history-only through the agent host API, merged with live sessions without duplicates.

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame } from '@xtrm/contracts';
import type { AgentEventV1, AgentHostApiV1, AgentSessionSummary } from '@xtrm/contracts';
import { AGENT_HOST_BIND_ADDRESS, startAgentHost, type AgentHost } from '../core/agent-host.js';
import { SessionIndex, type SessionIndexOptions } from '../core/agent-host-session-index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
    readFileSync(path.resolve(here, '../../../packages/contracts/fixtures/agent-protocol.json'), 'utf8'),
) as { events: AgentEventV1[] };
const identity = fixtures.events[0];
const liveId = identity.sessionId;

async function until<T>(probe: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = probe();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, 10));
    }
}

async function untilList(list: () => Promise<AgentSessionSummary[]>, ok: (l: AgentSessionSummary[]) => boolean): Promise<AgentSessionSummary[]> {
    const deadline = Date.now() + 5000;
    for (;;) {
        const value = await list();
        if (ok(value)) return value;
        if (Date.now() > deadline) throw new Error('timed out waiting for the session list');
        await new Promise((r) => setTimeout(r, 10));
    }
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

function piJournal(id: string, cwd: string, extra: unknown[] = []): string {
    return [
        { type: 'session', version: 3, id, timestamp: '2026-10-01T10:00:00.000Z', cwd },
        { type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-10-01T10:00:00.001Z', provider: 'opencode-go', modelId: 'deepseek-v4.1-flash' },
        { type: 'message', id: 'u1', parentId: 'm1', timestamp: '2026-10-01T10:00:05.000Z', message: { role: 'user', content: [{ type: 'text', text: 'fix the\nflaky test' }], timestamp: 1 } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-10-01T10:00:09.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
        { type: 'message', id: 't1', parentId: 'a1', timestamp: '2026-10-01T10:00:10.000Z', message: { role: 'toolResult', content: [] } },
        ...extra,
    ]
        .map(line)
        .join('');
}

function claudeJournal(cwd: string): string {
    const base = { isSidechain: false, cwd, sessionId: 'ignored-by-index' };
    return [
        { type: 'permission-mode', permissionMode: 'default', sessionId: 'x' },
        { ...base, type: 'user', timestamp: '2026-10-02T08:00:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: 'review the PR' } },
        { ...base, type: 'assistant', timestamp: '2026-10-02T08:00:03.000Z', message: { role: 'assistant', model: 'claude-opus-5-5', content: [] } },
        { ...base, type: 'user', timestamp: '2026-10-02T08:00:04.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' }] } },
        { ...base, type: 'user', timestamp: '2026-10-02T08:00:05.000Z', isMeta: true, message: { role: 'user', content: 'meta' } },
        { ...base, type: 'user', timestamp: '2026-10-02T08:00:06.000Z', origin: { kind: 'task-notification' }, message: { role: 'user', content: 'bg done' } },
        { ...base, type: 'user', timestamp: '2026-10-02T08:00:07.000Z', isSidechain: true, message: { role: 'user', content: 'side' } },
        { ...base, type: 'user', timestamp: '2026-10-02T08:01:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: 'and merge it' } },
        { type: 'ai-title', aiTitle: 'Review and merge', sessionId: 'x' },
        { ...base, type: 'assistant', timestamp: '2026-10-02T08:01:30.000Z', message: { role: 'assistant', model: '<synthetic>', content: [] } },
    ]
        .map(line)
        .join('');
}

describe('session index (XTRM-565)', () => {
    let dir: string;
    let piRoot: string;
    let claudeRoot: string;
    let options: SessionIndexOptions;
    const open: SessionIndex[] = [];

    function startIndex(): SessionIndex {
        const index = new SessionIndex(options);
        open.push(index);
        return index;
    }

    beforeEach(() => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'xt-session-index-'));
        piRoot = path.join(dir, 'pi');
        claudeRoot = path.join(dir, 'claude');
        mkdirSync(path.join(piRoot, '--work-core--'), { recursive: true });
        mkdirSync(path.join(claudeRoot, '-work-app', 'c1', 'subagents'), { recursive: true });
        options = {
            roots: [
                { provider: 'pi', dir: piRoot },
                { provider: 'claude', dir: claudeRoot },
            ],
            cachePath: path.join(dir, 'cache', 'session-index.json'),
        };
    });

    afterEach(async () => {
        await Promise.all(open.splice(0).map((index) => index.close()));
        rmSync(dir, { recursive: true, force: true });
    });

    it('derives title, cwd, model, started, last activity and Frame count from Pi and Claude journals', async () => {
        const piFile = path.join(piRoot, '--work-core--', '2026-10-01T10-00-00-000Z_p1.jsonl');
        writeFileSync(piFile, piJournal('p1', '/work/core'));
        writeFileSync(path.join(piRoot, '--work-core--', 'not-a-session.jsonl'), line({ type: 'message', id: 'x' }));
        writeFileSync(path.join(claudeRoot, '-work-app', 'c1.jsonl'), claudeJournal('/work/app'));
        writeFileSync(path.join(claudeRoot, '-work-app', 'c1', 'subagents', 'agent-1.jsonl'), claudeJournal('/work/sub'));

        const index = startIndex();
        await index.ready;
        const sessions = index.list();
        expect(sessions.map((s) => s.sessionId)).toEqual(['c1', 'p1']);
        expect(index.get('p1')).toEqual({
            sessionId: 'p1',
            provider: 'pi',
            state: 'history_only',
            name: 'fix the flaky test',
            cwd: '/work/core',
            extensionConnected: false,
            capabilities: [],
            model: 'opencode-go/deepseek-v4.1-flash',
            frameCount: 1,
            startedAt: Date.parse('2026-10-01T10:00:00.000Z'),
            lastActivityAt: Date.parse('2026-10-01T10:00:09.000Z'),
            sessionFile: piFile,
        });
        expect(index.get('c1')).toMatchObject({
            provider: 'claude',
            name: 'Review and merge',
            cwd: '/work/app',
            model: 'claude-opus-5-5',
            frameCount: 2,
            startedAt: Date.parse('2026-10-02T08:00:00.000Z'),
            lastActivityAt: Date.parse('2026-10-02T08:01:30.000Z'),
        });
        for (const session of sessions) {
            const decoded = decodeFrame('xtrm.agent-host-api.v1', JSON.stringify({ schema: 'xtrm.agent-host-api.v1', kind: 'session_list', sessions: [session] }));
            expect(decoded.ok, decoded.ok ? '' : decoded.detail).toBe(true);
        }
    });

    it('follows appends, partial lines, renames, new project directories and deletions from file-watch events', async () => {
        const piDir = path.join(piRoot, '--work-core--');
        const piFile = path.join(piDir, 'a_p1.jsonl');
        writeFileSync(piFile, piJournal('p1', '/work/core'));
        const index = startIndex();
        await index.ready;
        expect(index.get('p1')?.frameCount).toBe(1);

        // A half-written line is not consumed until its newline arrives.
        const next = line({ type: 'message', id: 'u2', parentId: 'a1', timestamp: '2026-10-01T11:00:00.000Z', message: { role: 'user', content: 'again' } });
        appendFileSync(piFile, next.slice(0, 40));
        appendFileSync(piFile, line({ type: 'session_info', id: 'i1', parentId: 'u2', timestamp: '2026-10-01T11:00:01.000Z', name: 'renamed' }).replace(/^/, next.slice(40)));
        await until(() => index.get('p1')?.frameCount === 2);
        expect(index.get('p1')).toMatchObject({ name: 'renamed', lastActivityAt: Date.parse('2026-10-01T11:00:00.000Z') });

        // An explicit empty name clears the title back to the first prompt.
        appendFileSync(piFile, line({ type: 'session_info', id: 'i2', parentId: 'i1', timestamp: '2026-10-01T11:00:02.000Z', name: '' }));
        await until(() => index.get('p1')?.name === 'fix the flaky test');

        // A new project directory and its journal appear without a rescan.
        const newDir = path.join(piRoot, '--work-other--');
        mkdirSync(newDir);
        writeFileSync(path.join(newDir, 'b_p2.jsonl'), piJournal('p2', '/work/other'));
        await until(() => index.get('p2'));

        // A journal replaced by a shorter file is re-read from the start.
        const replacement = path.join(piDir, 'tmp');
        writeFileSync(replacement, piJournal('p1', '/work/core-moved'));
        renameSync(replacement, piFile);
        await until(() => index.get('p1')?.cwd === '/work/core-moved');
        expect(index.get('p1')?.frameCount).toBe(1);

        rmSync(piFile);
        await until(() => index.get('p1') === null);
        expect(index.list().map((s) => s.sessionId)).toEqual(['p2']);
    });

    it('rebuilds the same list from the journals after the cache is deleted, and reuses the cache otherwise', async () => {
        writeFileSync(path.join(piRoot, '--work-core--', 'a_p1.jsonl'), piJournal('p1', '/work/core'));
        writeFileSync(path.join(claudeRoot, '-work-app', 'c1.jsonl'), claudeJournal('/work/app'));
        const first = startIndex();
        await first.ready;
        const expected = first.list();
        await first.close();
        expect(JSON.parse(readFileSync(options.cachePath!, 'utf8')).journals).toBeTypeOf('object');

        // Appended while the host was down: the cached offset is resumed, not restarted.
        appendFileSync(
            path.join(piRoot, '--work-core--', 'a_p1.jsonl'),
            line({ type: 'message', id: 'u2', parentId: 't1', timestamp: '2026-10-01T12:00:00.000Z', message: { role: 'user', content: 'more' } }),
        );
        const warm = startIndex();
        await warm.ready;
        expect(warm.get('p1')?.frameCount).toBe(2);
        const withAppend = warm.list();
        await warm.close();

        rmSync(options.cachePath!);
        const rebuilt = startIndex();
        await rebuilt.ready;
        expect(rebuilt.list()).toEqual(withAppend);
        expect(withAppend.find((s) => s.sessionId === 'c1')).toEqual(expected.find((s) => s.sessionId === 'c1'));
    });
});

describe('xt host serves history-only sessions (XTRM-565)', () => {
    let dir: string;
    let host: AgentHost;
    let socketPath: string;
    let hostOptions: Parameters<typeof startAgentHost>[0];

    function get(route: string): Promise<{ status: number; body: AgentHostApiV1 }> {
        return new Promise((resolve, reject) => {
            http.get({ host: AGENT_HOST_BIND_ADDRESS, port: host.info.port, path: route }, (res) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (c: string) => (text += c));
                res.on('end', () => {
                    const decoded = decodeFrame('xtrm.agent-host-api.v1', text);
                    if (!decoded.ok) reject(new Error(`invalid API body: ${decoded.detail}`));
                    else resolve({ status: res.statusCode ?? 0, body: decoded.value });
                });
            }).on('error', reject);
        });
    }

    async function sessions(): Promise<AgentSessionSummary[]> {
        const { body } = await get('/v1/sessions');
        if (body.kind !== 'session_list') throw new Error(`unexpected ${body.kind}`);
        return body.sessions;
    }

    beforeEach(async () => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'xt-host-history-'));
        socketPath = path.join(dir, 'agent-host.sock');
        const piDir = path.join(dir, 'pi', '--home-op-dev-core--');
        mkdirSync(piDir, { recursive: true });
        mkdirSync(path.join(dir, 'claude'));
        writeFileSync(path.join(piDir, `2026-10-01_${liveId}.jsonl`), piJournal(liveId, '/home/op/dev/core'));
        writeFileSync(path.join(piDir, '2026-09-30_older.jsonl'), piJournal('older', '/home/op/dev/core'));
        hostOptions = {
            socketPath,
            infoPath: path.join(dir, 'agent-host.json'),
            log: () => {},
            sessionIndex: {
                roots: [
                    { provider: 'pi', dir: path.join(dir, 'pi') },
                    { provider: 'claude', dir: path.join(dir, 'claude') },
                ],
                cachePath: path.join(dir, 'cache', 'session-index.json'),
            },
        };
        host = await startAgentHost(hostOptions);
        await host.sessionIndex!.ready;
    });

    afterEach(async () => {
        await host.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it('lists a stopped session history-only, shows it once as live while it runs, and serves its detail', async () => {
        const before = await sessions();
        expect(before.filter((s) => s.sessionId === liveId)).toEqual([expect.objectContaining({ state: 'history_only', extensionConnected: false })]);
        const detail = await get(`/v1/sessions/${liveId}`);
        expect(detail.status).toBe(200);
        expect(detail.body).toMatchObject({ kind: 'session_detail', session: { sessionId: liveId, state: 'history_only', frameCount: 1 } });

        const socket = await new Promise<net.Socket>((resolve, reject) => {
            const s = net.connect(socketPath, () => resolve(s));
            s.once('error', reject);
        });
        socket.write(encodeFrame(identity));
        const during = await untilList(sessions, (list) => list.some((s) => s.sessionId === liveId && s.state !== 'history_only'));
        expect(during.filter((s) => s.sessionId === liveId)).toHaveLength(1);
        expect(during[0]).toMatchObject({ sessionId: liveId, extensionConnected: true });
        expect(during.map((s) => s.sessionId).sort()).toEqual([liveId, 'older'].sort());
        expect((await get(`/v1/sessions/${liveId}`)).body).toMatchObject({ session: { extensionConnected: true } });

        // Once the extension disconnects, the journal entry is served again.
        socket.end();
        const after = await untilList(sessions, (list) => list.some((s) => s.sessionId === liveId && s.state === 'history_only'));
        expect(after.filter((s) => s.sessionId === liveId)).toHaveLength(1);
        expect((await get('/v1/sessions/nope')).status).toBe(404);
    });

    it('rebuilds the same list after the cache is deleted and the host restarts', async () => {
        const original = await sessions();
        expect(original.map((s) => s.sessionId).sort()).toEqual([liveId, 'older'].sort());
        await host.close();
        rmSync(path.join(dir, 'cache'), { recursive: true, force: true });
        host = await startAgentHost(hostOptions);
        await host.sessionIndex!.ready;
        expect(await sessions()).toEqual(original);
    });
});

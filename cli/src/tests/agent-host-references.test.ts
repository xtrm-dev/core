// XTRM-570: typed @ reference resolution on a real agent host — @file against a temporary cwd
// (ranges, budgets, escape attempts), @commit from a temporary git repository, and @session /
// @agent / @frame for a fixture session pushed through the producer socket.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeFrame, validate } from '@xtrm/contracts';
import type { AgentEventV1, AgentHostApiV1, ContextReference } from '@xtrm/contracts';
import { AGENT_HOST_BIND_ADDRESS, startAgentHost, type AgentHost } from '../core/agent-host.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
    readFileSync(path.resolve(here, '../../../packages/contracts/fixtures/agent-protocol.json'), 'utf8'),
) as { events: AgentEventV1[] };
const identity = fixtures.events[0];
const sessionId = identity.sessionId;
const SESSION_NAME = 'refs-fixture';
const RESPONSE = 'The contracts test passes now.';

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=Ref Tester', '-c', 'user.email=ref@test.invalid', ...args], {
        cwd,
        env: gitEnv,
        encoding: 'utf8',
    }).trim();
}

async function until<T>(probe: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = probe();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, 10));
    }
}

function post(host: AgentHost, body: unknown): Promise<{ status: number; body: AgentHostApiV1 }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: AGENT_HOST_BIND_ADDRESS,
                port: host.info.port,
                method: 'POST',
                path: '/v1/references/resolve',
                headers: { 'content-type': 'application/json' },
            },
            (res) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (c: string) => (text += c));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
            },
        );
        req.on('error', reject);
        req.end(JSON.stringify(body));
    });
}

describe('xt host reference resolution (XTRM-570)', () => {
    let dir: string;
    let cwd: string;
    let outside: string;
    let host: AgentHost;
    let producer: net.Socket;
    let commit: string;

    async function resolve(references: string[], target: string | null = sessionId) {
        const reply = await post(host, {
            schema: 'xtrm.agent-host-api.v1',
            kind: 'reference_resolve_request',
            ...(target ? { sessionId: target } : {}),
            references,
        });
        expect(validate('xtrm.agent-host-api.v1', reply.body).errors).toEqual([]);
        return reply;
    }

    async function refs(references: string[], target: string | null = sessionId): Promise<ContextReference[]> {
        const reply = await resolve(references, target);
        expect(reply.status).toBe(200);
        if (reply.body.kind !== 'reference_resolve_result') throw new Error(`unexpected ${reply.body.kind}`);
        return reply.body.references;
    }

    beforeAll(async () => {
        dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'xt-host-refs-')));
        cwd = path.join(dir, 'repo');
        outside = path.join(dir, 'outside');
        mkdirSync(path.join(cwd, 'src'), { recursive: true });
        mkdirSync(outside);
        writeFileSync(path.join(outside, 'secret.txt'), 'outside the cwd\n');
        writeFileSync(path.join(cwd, 'src', 'a.ts'), 'line one\nline two\nline three\nline four\n');
        // 400 lines of 100 bytes: 40 000 bytes, above the 32 KB @file budget.
        writeFileSync(path.join(cwd, 'big.txt'), Array.from({ length: 400 }, (_, i) => `${String(i + 1).padStart(4, '0')} ${'x'.repeat(94)}\n`).join(''));
        for (let i = 0; i < 4; i += 1) writeFileSync(path.join(cwd, `part${i}.txt`), `${'y'.repeat(99)}\n`.repeat(300));
        writeFileSync(path.join(cwd, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
        symlinkSync(path.join(outside, 'secret.txt'), path.join(cwd, 'link-out.txt'));
        symlinkSync(outside, path.join(cwd, 'dir-out'));
        symlinkSync(path.join(cwd, 'src', 'a.ts'), path.join(cwd, 'link-in.ts'));
        execFileSync('mkfifo', [path.join(cwd, 'pipe')]);

        git(cwd, 'init', '-q');
        git(cwd, 'add', 'src/a.ts', 'big.txt');
        git(cwd, 'commit', '-q', '-m', 'feat: add the reference fixtures\n\nBody line of the commit.');
        commit = git(cwd, 'rev-parse', 'HEAD');

        host = await startAgentHost({
            socketPath: path.join(dir, 'agent-host.sock'),
            infoPath: path.join(dir, 'agent-host.json'),
            log: () => {},
        });
        producer = await new Promise<net.Socket>((ok, fail) => {
            const socket = net.connect(host.info.socket, () => ok(socket));
            socket.once('error', fail);
        });
        let seq = 0;
        const push = (payload: Record<string, unknown>) =>
            producer.write(encodeFrame({ schema: 'xtrm.agent-event.v1', seq: seq++, sessionId, at: Date.now(), payload } as AgentEventV1));
        push({ ...identity.payload, cwd, sessionName: SESSION_NAME, sessionFile: undefined });
        push({ type: 'before_agent_start', prompt: 'Fix the failing contracts test', ingress: { origin: 'gui' } });
        push({ type: 'agent_start' });
        push({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Running the tests.' }] } });
        push({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: RESPONSE }] }] });
        push({ type: 'agent_settled' });
        await until(() => host.registry.frames(sessionId)?.[0]?.settled);
    });

    afterAll(async () => {
        producer?.destroy();
        await host?.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it('resolves @file whole and by #L range with a content-hash revision', async () => {
        const text = readFileSync(path.join(cwd, 'src', 'a.ts'));
        const revision = `sha256:${createHash('sha256').update(text).digest('hex')}`;
        const [whole, range, viaLink, absoluteInside] = await refs([
            '@file:src/a.ts',
            '@file:src/a.ts#L2-3',
            '@file:link-in.ts',
            `@file:${path.join(cwd, 'src', 'a.ts')}`,
        ]);
        expect(whole).toMatchObject({
            kind: 'file',
            status: 'resolved',
            title: 'src/a.ts',
            revision,
            content: 'line one\nline two\nline three\nline four',
            truncated: false,
            budgetBytes: 32 * 1024,
        });
        expect(whole.bytes).toBe(Buffer.byteLength(whole.content!));
        expect(range).toMatchObject({ status: 'resolved', title: 'src/a.ts#L2-3', revision, content: 'line two\nline three' });
        // A symlink that stays inside the cwd and an absolute path inside the cwd both resolve.
        expect(viaLink).toMatchObject({ status: 'resolved', title: 'src/a.ts', revision });
        expect(absoluteInside).toMatchObject({ status: 'resolved', revision });
    });

    it('turns an @file above the 32 KB budget into an excerpt plus pointer', async () => {
        const [whole, range] = await refs(['@file:big.txt', '@file:big.txt#L10-12']);
        expect(whole).toMatchObject({ status: 'resolved', truncated: true, pointer: '@file:big.txt#L1-400' });
        // §36.12 item 2: without a range, the first 200 lines.
        expect(whole.content!.split('\n')).toHaveLength(200);
        expect(whole.content!.startsWith('0001 ')).toBe(true);
        expect(whole.bytes).toBeLessThanOrEqual(32 * 1024);
        expect(range).toMatchObject({ status: 'resolved', truncated: false });
        expect(range.content!.split('\n').map((l) => l.slice(0, 4))).toEqual(['0010', '0011', '0012']);
    });

    it('rejects @file escapes: absolute paths outside the cwd, .. and symlinks resolving outside', async () => {
        const results = await refs([
            '@file:/etc/passwd',
            `@file:${path.join(outside, 'secret.txt')}`,
            '@file:../outside/secret.txt',
            '@file:src/../../outside/secret.txt',
            '@file:link-out.txt',
            '@file:dir-out/secret.txt',
        ]);
        for (const ref of results) {
            expect(ref).toMatchObject({ kind: 'file', status: 'unresolved', error: 'path_outside_cwd' });
            expect(ref.content).toBeUndefined();
        }
    });

    it('reports per-reference @file errors for missing, non-regular, binary and bad ranges', async () => {
        const [missing, directory, fifo, binary, outOfRange, badRange] = await refs([
            '@file:nope.ts',
            '@file:src',
            '@file:pipe',
            '@file:blob.bin',
            '@file:src/a.ts#L9-10',
            '@file:src/a.ts#L3-2',
        ]);
        expect(missing).toMatchObject({ status: 'unresolved', error: 'file_not_found' });
        expect(directory).toMatchObject({ status: 'unresolved', error: 'not_a_file' });
        expect(fifo).toMatchObject({ status: 'unresolved', error: 'not_a_file' });
        expect(binary).toMatchObject({ status: 'resolved', truncated: true, bytes: 0, pointer: '@file:blob.bin' });
        expect(binary.content).toBeUndefined();
        expect(outOfRange).toMatchObject({ status: 'unresolved', error: 'line_out_of_range' });
        expect(badRange).toMatchObject({ status: 'unresolved', error: 'invalid_line_range' });
    });

    it('resolves @commit from local git with message, author and stat; the diff is a pointer', async () => {
        const [full, short, unknown, injected] = await refs([
            `@commit:${commit}`,
            `@commit:${commit.slice(0, 8)}`,
            '@commit:deadbeefdeadbeef',
            '@commit:--output=/tmp/x',
        ]);
        expect(full).toMatchObject({
            kind: 'commit',
            status: 'resolved',
            title: 'feat: add the reference fixtures',
            revision: commit,
            pointer: `git show ${commit}`,
            truncated: false,
            budgetBytes: 4 * 1024,
        });
        expect(full.content).toContain('Author: Ref Tester <ref@test.invalid>');
        expect(full.content).toContain('Body line of the commit.');
        expect(full.content).toMatch(/big\.txt\s+\|\s+400 \+/);
        expect(full.content).toMatch(/2 files changed/);
        expect(full.content).not.toContain('diff --git');
        expect(short).toMatchObject({ status: 'resolved', revision: commit });
        expect(unknown).toMatchObject({ status: 'unresolved', error: 'commit_not_found' });
        expect(injected).toMatchObject({ status: 'unresolved', error: 'invalid_reference' });
    });

    it('resolves @session, @agent and @frame for the fixture session without sending it anything', async () => {
        const [byId, byName, agent, frame, missingFrame] = await refs([
            `@session:${sessionId}`,
            `@session:${SESSION_NAME}`,
            `@agent:${SESSION_NAME}`,
            `@frame:${SESSION_NAME}/1`,
            `@frame:${sessionId}/2`,
        ]);
        for (const ref of [byId, byName, agent]) {
            expect(ref).toMatchObject({ status: 'resolved', title: SESSION_NAME, budgetBytes: 4 * 1024 });
            expect(ref.revision).toMatch(/^seq:\d+$/);
            expect(ref.content).toContain(`session ${sessionId} "${SESSION_NAME}"`);
            expect(ref.content).toContain('state: settled');
            expect(ref.content).toContain(`cwd: ${cwd}`);
            expect(ref.content).toContain(`last settled response (frame 1):\n${RESPONSE}`);
        }
        expect(agent.kind).toBe('agent');
        expect(frame).toMatchObject({ kind: 'frame', status: 'resolved', truncated: false, budgetBytes: 8 * 1024 });
        expect(frame.content).toContain('(settled)');
        expect(frame.content).toContain('request:\nFix the failing contracts test');
        expect(frame.content).toContain(`response:\n${RESPONSE}`);
        expect(missingFrame).toMatchObject({ status: 'unresolved', error: 'frame_not_found' });
    });

    it('gives an unresolvable reference a per-reference error without failing the request', async () => {
        const reply = await resolve(['@session:no-such-session', '@issue:XTRM-570', '@agent:nobody', '@file:src/a.ts']);
        expect(reply.status).toBe(200);
        if (reply.body.kind !== 'reference_resolve_result') throw new Error(reply.body.kind);
        const [session, issue, agent, file] = reply.body.references;
        expect(session).toMatchObject({ kind: 'session', status: 'unresolved', error: 'session_not_found' });
        expect(issue).toMatchObject({ kind: 'issue', status: 'unresolved', error: 'not_host_resolved' });
        expect(agent).toMatchObject({ kind: 'agent', status: 'unresolved', error: 'agent_not_live' });
        expect(file.status).toBe('resolved');
        expect(reply.body.totalBytes).toBe(file.bytes);
        expect(reply.body.overBudget).toBe(false);

        // Files and commits need a session cwd.
        const [noSession] = await refs(['@file:src/a.ts'], null);
        expect(noSession).toMatchObject({ status: 'unresolved', error: 'session_required' });
        const [unknownSession] = await refs(['@file:src/a.ts'], 'no-such-session');
        expect(unknownSession).toMatchObject({ status: 'unresolved', error: 'session_not_found' });
    });

    it('sets overBudget when the resolved references exceed 96 KB in total', async () => {
        const reply = await resolve(['@file:part0.txt', '@file:part1.txt', '@file:part2.txt', '@file:part3.txt']);
        if (reply.body.kind !== 'reference_resolve_result') throw new Error(reply.body.kind);
        expect(reply.body.references.every((r) => r.status === 'resolved' && r.truncated === false)).toBe(true);
        expect(reply.body.totalBytes).toBe(reply.body.references.reduce((sum, r) => sum + (r.bytes ?? 0), 0));
        expect(reply.body.totalBytes).toBeGreaterThan(96 * 1024);
        expect(reply.body.overBudget).toBe(true);
    });

    it('rejects a request it cannot parse per reference with 400', async () => {
        const unknownKind = await resolve(['@nope:x']);
        expect(unknownKind.status).toBe(400);
        expect(unknownKind.body).toMatchObject({ kind: 'error', code: 'invalid_reference' });
        const wrongKind = await post(host, { schema: 'xtrm.agent-host-api.v1', kind: 'submit_request', sessionId, command: {} });
        expect(wrongKind.status).toBe(400);
        const tooMany = await resolve(Array.from({ length: 65 }, () => '@file:src/a.ts'));
        expect(tooMany.status).toBe(400);
        expect(tooMany.body).toMatchObject({ kind: 'error', code: 'too_many_references' });
    });
});

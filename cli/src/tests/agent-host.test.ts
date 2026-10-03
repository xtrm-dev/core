// XTRM-563: the agent host end to end — a fake Pi extension on the producer socket, clients
// on the loopback HTTP + SSE API, and the §35.8 item 5 concurrent-submit policy.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame, validate } from '@xtrm/contracts';
import type { AgentCommandV1, AgentEventV1, AgentHostApiV1 } from '@xtrm/contracts';
import { AGENT_HOST_BIND_ADDRESS, startAgentHost, type AgentHost } from '../core/agent-host.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
    readFileSync(path.resolve(here, '../../../packages/contracts/fixtures/agent-protocol.json'), 'utf8'),
) as { events: AgentEventV1[] };
const identity = fixtures.events[0];
const sessionId = identity.sessionId;
/** One full Frame: identity, session_start, before_agent_start … agent_settled (the shutdown is left out). */
const frameEvents = fixtures.events.filter((e) => e.payload.type !== 'session_shutdown');

async function until<T>(probe: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = probe();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, 10));
    }
}

class FakeExtension {
    readonly commands: AgentCommandV1[] = [];
    private readonly socket: net.Socket;
    private seq = 0;
    private buffer = '';

    private constructor(socket: net.Socket) {
        this.socket = socket;
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
            this.buffer += chunk;
            let nl: number;
            while ((nl = this.buffer.indexOf('\n')) !== -1) {
                const decoded = decodeFrame('xtrm.agent-command.v1', this.buffer.slice(0, nl));
                this.buffer = this.buffer.slice(nl + 1);
                if (!decoded.ok) throw new Error(`host sent an invalid command frame: ${decoded.detail}`);
                this.commands.push(decoded.value);
            }
        });
    }

    static connect(socketPath: string): Promise<FakeExtension> {
        return new Promise((resolve, reject) => {
            const socket = net.connect(socketPath, () => resolve(new FakeExtension(socket)));
            socket.once('error', reject);
        });
    }

    push(event: AgentEventV1): void {
        this.socket.write(encodeFrame({ ...event, seq: this.seq++ }));
    }

    payload(type: AgentEventV1['payload']['type'], extra: Record<string, unknown> = {}): void {
        this.push({ schema: 'xtrm.agent-event.v1', seq: 0, sessionId, at: Date.now(), payload: { type, ...extra } as never });
    }

    answer(command: AgentCommandV1, status: 'accepted' | 'rejected' | 'failed' = 'accepted'): void {
        this.payload('command_result', { commandId: command.payload.commandId, status });
    }

    close(): void {
        this.socket.end();
    }
}

interface Reply {
    status: number;
    body: AgentHostApiV1;
}

function request(host: AgentHost, method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: AGENT_HOST_BIND_ADDRESS,
                port: host.info.port,
                method,
                path: route,
                headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
            },
            (res) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (c: string) => (text += c));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
            },
        );
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

function prompt(host: AgentHost, commandId: string, target = sessionId): Promise<Reply> {
    return request(host, 'POST', '/v1/submit', {
        schema: 'xtrm.agent-host-api.v1',
        kind: 'submit_request',
        sessionId: target,
        command: { type: 'prompt', commandId, message: 'run the tests' },
    });
}

function openEvents(host: AgentHost): Promise<{ messages: AgentHostApiV1[]; close(): void }> {
    return new Promise((resolve, reject) => {
        const messages: AgentHostApiV1[] = [];
        const req = http.get({ host: AGENT_HOST_BIND_ADDRESS, port: host.info.port, path: '/v1/events' }, (res) => {
            expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
            let buffer = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
                buffer += chunk;
                let end: number;
                while ((end = buffer.indexOf('\n\n')) !== -1) {
                    const block = buffer.slice(0, end);
                    buffer = buffer.slice(end + 2);
                    const data = block.split('\n').find((l) => l.startsWith('data: '));
                    if (data) messages.push(JSON.parse(data.slice(6)));
                }
            });
            resolve({ messages, close: () => req.destroy() });
        });
        req.on('error', reject);
    });
}

describe('xt host agent host (XTRM-563)', () => {
    let dir: string;
    let host: AgentHost;
    let socketPath: string;

    beforeEach(async () => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'xt-host-'));
        socketPath = path.join(dir, 'agent-host.sock');
        host = await startAgentHost({
            socketPath,
            infoPath: path.join(dir, 'agent-host.json'),
            commandTimeoutMs: 2000,
            log: () => {},
        });
    });

    afterEach(async () => {
        await host.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it('binds the client API to 127.0.0.1 only and writes a 0600 socket plus the info file', () => {
        expect(host.info.address).toBe('127.0.0.1');
        expect(statSync(socketPath).mode & 0o777).toBe(0o600);
        const info = JSON.parse(readFileSync(path.join(dir, 'agent-host.json'), 'utf8'));
        expect(info).toMatchObject({ pid: process.pid, port: host.info.port, address: '127.0.0.1', protocol: { major: 1 } });
    });

    it('streams a pushed Frame in order, routes a prompt as xtrm.agent-command.v1, and rejects a submit while working with busy', async () => {
        const events = await openEvents(host);
        const ext = await FakeExtension.connect(socketPath);
        for (const event of frameEvents) ext.push(event);

        await until(() => events.messages.length >= frameEvents.length);
        const cursors: number[] = [];
        events.messages.forEach((message, i) => {
            expect(validate('xtrm.agent-host-api.v1', message).errors).toEqual([]);
            if (message.kind !== 'event') throw new Error(`unexpected ${message.kind}`);
            // The host sets tool origin (XTRM-571); every other field passes through unchanged.
            const { origin: _sent, ...sent } = frameEvents[i].payload as { origin?: unknown };
            const { origin: _set, ...got } = message.frame.payload as { origin?: unknown };
            expect(got).toEqual(sent);
            cursors.push(Number(message.cursor));
        });
        expect(cursors).toEqual([...cursors].sort((a, b) => a - b));

        const list = await request(host, 'GET', '/v1/sessions');
        expect(validate('xtrm.agent-host-api.v1', list.body).errors).toEqual([]);
        expect(list.body).toMatchObject({
            kind: 'session_list',
            sessions: [{ sessionId, provider: 'pi', state: 'settled', extensionConnected: true, frameCount: 1 }],
        });

        // A client prompt reaches the extension as one xtrm.agent-command.v1 frame.
        const first = prompt(host, 'cmd-1');
        const routed = await until(() => ext.commands[0]);
        expect(routed).toMatchObject({
            schema: 'xtrm.agent-command.v1',
            sessionId,
            payload: { type: 'prompt', commandId: 'cmd-1', message: 'run the tests' },
        });
        ext.answer(routed);
        expect((await first).body).toMatchObject({ kind: 'submit_result', commandId: 'cmd-1', status: 'accepted' });

        // The session is now working: a normal submit is refused, never queued.
        ext.payload('before_agent_start', { prompt: 'run the tests', ingress: { origin: 'gui', commandId: 'cmd-1' } });
        ext.payload('agent_start');
        await until(() => host.registry.list()[0]?.state === 'working');
        const busy = await prompt(host, 'cmd-2');
        expect(validate('xtrm.agent-host-api.v1', busy.body).errors).toEqual([]);
        expect(busy.body).toMatchObject({ kind: 'submit_result', commandId: 'cmd-2', status: 'busy' });
        expect(ext.commands).toHaveLength(1);

        // agent_end never settles; agent_settled does, and prompts are accepted again.
        ext.payload('agent_end', { messages: [] });
        expect((await prompt(host, 'cmd-3')).body).toMatchObject({ status: 'busy' });
        ext.payload('agent_settled');
        await until(() => host.registry.list()[0]?.state === 'settled');
        const next = prompt(host, 'cmd-4');
        ext.answer(await until(() => ext.commands[1]));
        expect((await next).body).toMatchObject({ commandId: 'cmd-4', status: 'accepted' });

        events.close();
        ext.close();
    });

    it('lets the first of two concurrent GUI prompts win; the second gets busy', async () => {
        const ext = await FakeExtension.connect(socketPath);
        ext.push(identity);
        await until(() => host.registry.list().length === 1);

        const [a, b] = [prompt(host, 'gui-a'), prompt(host, 'gui-b')];
        const routed = await until(() => ext.commands[0]);
        ext.answer(routed);
        const statuses = [(await a).body, (await b).body].map((r) => (r as { status: string }).status).sort();
        expect(statuses).toEqual(['accepted', 'busy']);
        expect(ext.commands).toHaveLength(1);
        ext.close();
    });

    it('answers unknown sessions, non-loopback Host headers and non-JSON bodies with typed errors', async () => {
        expect((await prompt(host, 'x-1', 'no-such-session')).body).toMatchObject({ status: 'not_found' });

        const forbidden = await request(host, 'GET', '/v1/sessions', undefined, { host: 'evil.example:80' });
        expect(forbidden.status).toBe(403);
        expect(forbidden.body).toMatchObject({ kind: 'error', code: 'forbidden_host' });

        const plain = await request(host, 'POST', '/v1/submit', { kind: 'submit_request' }, { 'content-type': 'text/plain' });
        expect(plain.status).toBe(415);

        const invalid = await request(host, 'POST', '/v1/submit', { schema: 'xtrm.agent-host-api.v1', kind: 'session_list' });
        expect(invalid.status).toBe(400);
        expect(validate('xtrm.agent-host-api.v1', invalid.body).errors).toEqual([]);
    });

    it('sets PRD §36.7 tool origin from the registration record, fixed at tool_execution_start (XTRM-571)', async () => {
        const events = await openEvents(host);
        const ext = await FakeExtension.connect(socketPath);
        ext.push(identity);
        const adapterDir = path.join(dir, 'pi-mcp-adapter');
        mkdirSync(adapterDir);
        writeFileSync(path.join(adapterDir, 'package.json'), JSON.stringify({ name: 'pi-mcp-adapter', version: '2.38.0' }));
        const adapter = { sourceInfo: { path: `${adapterDir}/index.ts`, source: 'npm:pi-mcp-adapter', scope: 'user', origin: 'package', baseDir: adapterDir } };
        // A producer-supplied origin is replaced: the host owns classification.
        ext.payload('tool_execution_start', { toolCallId: 'p1', toolName: 'mcp', args: { server: 'everything', tool: 'echo' }, tool: adapter, origin: { class: 'native' } });
        ext.payload('tool_execution_update', { toolCallId: 'p1', toolName: 'mcp', args: {}, partialResult: {}, tool: adapter });
        ext.payload('tool_execution_end', { toolCallId: 'p1', toolName: 'mcp', result: {}, isError: false, tool: adapter });
        ext.payload('tool_execution_start', { toolCallId: 'r1', toolName: 'read', args: { path: 'a' }, tool: { sourceInfo: { path: 'builtin:read', source: 'builtin', scope: 'temporary', origin: 'top-level' } } });
        ext.payload('tool_execution_start', { toolCallId: 'x1', toolName: 'intercom', args: {}, tool: { sourceInfo: { path: '/p/pi-intercom/index.ts', source: 'npm:pi-intercom', scope: 'user', origin: 'package', baseDir: '/p/pi-intercom' } } });
        ext.payload('tool_execution_start', { toolCallId: 's1', toolName: 'custom', args: {} });

        const tools = await until(() => {
            const frames = events.messages.flatMap((m) => (m.kind === 'event' && m.frame.payload.type.startsWith('tool_') ? [m] : []));
            return frames.length === 6 && frames;
        });
        for (const message of tools) expect(validate('xtrm.agent-host-api.v1', message).errors).toEqual([]);
        expect(tools.map((m) => (m.kind === 'event' ? (m.frame.payload as { origin?: unknown }).origin : null))).toEqual([
            { class: 'mcp', server: 'everything' },
            { class: 'mcp', server: 'everything' },
            { class: 'mcp', server: 'everything' },
            { class: 'native' },
            { class: 'coordination', extension: 'npm:pi-intercom' },
            { class: 'extension', extension: 'unknown' },
        ]);
        events.close();
        ext.close();
    });

    it('drops a persistent session from the live registry when its extension disconnects', async () => {
        const ext = await FakeExtension.connect(socketPath);
        ext.push(identity);
        await until(() => host.registry.list().length === 1);
        ext.close();
        await until(() => host.registry.list().length === 0);
        expect((await request(host, 'GET', `/v1/sessions/${sessionId}`)).status).toBe(404);
    });
});

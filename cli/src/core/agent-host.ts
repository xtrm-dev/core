/**
 * The XTRM agent host server (PRD xtrm-app §35.5, §35.8 item 1; XTRM-563).
 *
 * - Producer socket: NDJSON xtrm.agent-event.v1 in / xtrm.agent-command.v1 out on a Unix
 *   domain socket (mode 0600) at $XDG_RUNTIME_DIR/xtrm/agent-host.sock, falling back to
 *   ~/.xtrm/run/agent-host.sock. File permissions are the same-user authentication.
 * - Client API: xtrm.agent-host-api.v1 over HTTP + Server-Sent Events, bound to 127.0.0.1
 *   only. Remote clients reach it through SSH port forwarding.
 * - Info file: ~/.xtrm/run/agent-host.json carries pid and port for clients and `xt host status`.
 *
 * Idle cost is the registry plus a bounded replay buffer; no provider adapter is resident.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { decodeFrame, encodeFrame } from '@xtrm/contracts';
import type { AgentCommandPayload, AgentEventV1, AgentHostApiV1 } from '@xtrm/contracts';
import { AgentHostRegistry, type ProducerConnection, type SubmitRequest } from './agent-host-registry.js';

/** The client API never binds anything else by default (§35.5). */
export const AGENT_HOST_BIND_ADDRESS = '127.0.0.1';
export const AGENT_HOST_PROTOCOL_MAJOR = 1;

const MAX_SOCKET_LINE_BYTES = 32 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
/** A client further behind than this is disconnected rather than buffered without bound. */
const MAX_SSE_BACKLOG_BYTES = 8 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 15_000;
const DEFAULT_REPLAY_LIMIT = 1024;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
    const runtimeDir = env.XDG_RUNTIME_DIR;
    if (runtimeDir) return path.join(runtimeDir, 'xtrm', 'agent-host.sock');
    return path.join(os.homedir(), '.xtrm', 'run', 'agent-host.sock');
}

export function defaultInfoPath(): string {
    return path.join(os.homedir(), '.xtrm', 'run', 'agent-host.json');
}

export interface AgentHostInfo {
    pid: number;
    address: string;
    port: number;
    socket: string;
    version: string;
    protocol: { major: number };
    startedAt: number;
}

export interface AgentHostOptions {
    socketPath?: string;
    infoPath?: string;
    /** 0 picks a free port. */
    port?: number;
    version?: string;
    commandTimeoutMs?: number;
    replayLimit?: number;
    log?: (message: string) => void;
}

export interface AgentHost {
    readonly info: AgentHostInfo;
    readonly registry: AgentHostRegistry;
    close(): Promise<void>;
}

type HostEventMessage = Extract<AgentHostApiV1, { kind: 'event' }>;

export function readAgentHostInfo(infoPath = defaultInfoPath()): AgentHostInfo | null {
    try {
        return JSON.parse(readFileSync(infoPath, 'utf8')) as AgentHostInfo;
    } catch {
        return null;
    }
}

export async function startAgentHost(options: AgentHostOptions = {}): Promise<AgentHost> {
    const socketPath = options.socketPath ?? defaultSocketPath();
    const infoPath = options.infoPath ?? defaultInfoPath();
    const log = options.log ?? ((message: string) => process.stderr.write(`[xt host] ${message}\n`));
    const replayLimit = options.replayLimit ?? DEFAULT_REPLAY_LIMIT;
    const registry = new AgentHostRegistry({ commandTimeoutMs: options.commandTimeoutMs, log });

    await claimSocketPath(socketPath);

    // --- fan-out: host-assigned cursors, bounded replay for Last-Event-ID resume ---
    let cursor = 0;
    const replay: HostEventMessage[] = [];
    const streams = new Set<{ res: http.ServerResponse; sessionId: string | null }>();
    registry.subscribe((frame) => {
        cursor += 1;
        const message: HostEventMessage = { schema: 'xtrm.agent-host-api.v1', kind: 'event', cursor: String(cursor), frame };
        replay.push(message);
        if (replay.length > replayLimit) replay.shift();
        for (const stream of streams) writeEvent(stream, message);
    });

    // --- producer socket ---
    const producers = new Set<net.Socket>();
    const socketServer = net.createServer((socket) => {
        producers.add(socket);
        let commandSeq = 0;
        const connection: ProducerConnection = {
            sendCommand(sessionId: string, payload: AgentCommandPayload) {
                socket.write(
                    encodeFrame({ schema: 'xtrm.agent-command.v1', seq: commandSeq++, sessionId, at: Date.now(), payload }),
                );
            },
        };
        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
            buffer += chunk;
            let newline = buffer.indexOf('\n');
            while (newline !== -1) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                if (line.trim()) handleLine(line);
                newline = buffer.indexOf('\n');
            }
            if (buffer.length > MAX_SOCKET_LINE_BYTES) {
                log('producer frame exceeds the line limit; closing the connection');
                socket.destroy();
            }
        });
        socket.on('error', (error) => log(`producer socket error: ${error.message}`));
        socket.on('close', () => {
            producers.delete(socket);
            registry.disconnect(connection);
        });

        function handleLine(line: string): void {
            const decoded = decodeFrame('xtrm.agent-event.v1', line);
            if (decoded.ok) {
                registry.ingest(connection, decoded.value as AgentEventV1);
                return;
            }
            log(`rejected producer frame (${decoded.reason}): ${decoded.detail}`);
            // Another contract or major cannot be spoken on this connection at all.
            if (decoded.reason !== 'invalid_json' && decoded.reason !== 'invalid_payload') socket.destroy();
        }
    });
    await listen(socketServer, socketPath);
    chmodSync(socketPath, 0o600);

    // --- client API ---
    const httpServer = http.createServer((req, res) => {
        handleRequest(req, res).catch((error: Error) => {
            log(`request failed: ${error.message}`);
            if (!res.headersSent) sendJson(res, 500, apiError('internal_error', 'the agent host failed to handle the request'));
            else res.destroy();
        });
    });

    async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // DNS-rebinding guard: only loopback host names reach the API.
        const hostname = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
        if (!LOOPBACK_HOSTNAMES.has(hostname)) {
            sendJson(res, 403, apiError('forbidden_host', 'the agent host only answers loopback host names'));
            return;
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const route = `${req.method} /${parts.join('/')}`;

        if (route === 'GET /v1/sessions') {
            sendJson(res, 200, { schema: 'xtrm.agent-host-api.v1', kind: 'session_list', sessions: registry.list() });
            return;
        }
        if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'sessions') {
            const detail = registry.detail(parts[2]);
            if (detail) sendJson(res, 200, detail);
            else sendJson(res, 404, apiError('session_not_found', `no live session ${parts[2]}`));
            return;
        }
        if (route === 'GET /v1/events') {
            openStream(req, res, url.searchParams.get('sessionId'));
            return;
        }
        if (route === 'POST /v1/submit') {
            const body = await readJsonBody(req, res);
            if (body === null) return;
            const decoded = decodeFrame('xtrm.agent-host-api.v1', body);
            if (!decoded.ok || decoded.value.kind !== 'submit_request') {
                const detail = decoded.ok ? `expected submit_request, received ${decoded.value.kind}` : decoded.detail;
                sendJson(res, 400, apiError('invalid_request', detail));
                return;
            }
            sendJson(res, 200, await registry.submit(decoded.value as SubmitRequest));
            return;
        }
        if (route === 'POST /v1/launch' || route === 'POST /v1/references/resolve') {
            sendJson(res, 501, apiError('not_implemented', `${url.pathname} is not served by this agent host yet`));
            return;
        }
        sendJson(res, 404, apiError('not_found', `no route ${route}`));
    }

    function openStream(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string | null): void {
        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
        });
        res.write(': xtrm agent host\n\n');
        const stream = { res, sessionId };
        const lastEventId = Number(req.headers['last-event-id']);
        if (Number.isInteger(lastEventId) && lastEventId >= 0) {
            for (const message of replay) if (Number(message.cursor) > lastEventId) writeEvent(stream, message);
        }
        streams.add(stream);
        const heartbeat = setInterval(() => res.write(': keepalive\n\n'), SSE_HEARTBEAT_MS);
        heartbeat.unref();
        const drop = () => {
            clearInterval(heartbeat);
            streams.delete(stream);
        };
        req.on('close', drop);
        res.on('close', drop);
    }

    function writeEvent(stream: { res: http.ServerResponse; sessionId: string | null }, message: HostEventMessage): void {
        if (stream.sessionId && message.frame.sessionId !== stream.sessionId) return;
        if (stream.res.writableLength > MAX_SSE_BACKLOG_BYTES) {
            log('event client is too far behind; closing its stream');
            stream.res.destroy();
            return;
        }
        stream.res.write(`id: ${message.cursor}\ndata: ${JSON.stringify(message)}\n\n`);
    }

    async function readJsonBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<string | null> {
        // A JSON content type forces a CORS preflight, which this API never answers.
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
            sendJson(res, 415, apiError('unsupported_media_type', 'POST bodies must be application/json'));
            return null;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
            size += (chunk as Buffer).length;
            if (size > MAX_REQUEST_BODY_BYTES) {
                sendJson(res, 413, apiError('body_too_large', 'request body exceeds the limit'));
                return null;
            }
            chunks.push(chunk as Buffer);
        }
        return Buffer.concat(chunks).toString('utf8');
    }

    try {
        await listen(httpServer, options.port ?? 0, AGENT_HOST_BIND_ADDRESS);
    } catch (error) {
        await closeServer(socketServer);
        safeUnlink(socketPath);
        throw error;
    }
    const address = httpServer.address() as net.AddressInfo;

    const info: AgentHostInfo = {
        pid: process.pid,
        address: address.address,
        port: address.port,
        socket: socketPath,
        version: options.version ?? '0.0.0',
        protocol: { major: AGENT_HOST_PROTOCOL_MAJOR },
        startedAt: Date.now(),
    };
    writeInfoFile(infoPath, info);

    let closing: Promise<void> | null = null;
    return {
        info,
        registry,
        close() {
            closing ??= (async () => {
                registry.close();
                for (const stream of streams) stream.res.end();
                streams.clear();
                for (const socket of producers) socket.destroy();
                httpServer.closeAllConnections();
                await Promise.all([closeServer(httpServer), closeServer(socketServer)]);
                safeUnlink(socketPath);
                if (readAgentHostInfo(infoPath)?.pid === process.pid) safeUnlink(infoPath);
            })();
            return closing;
        },
    };
}

/**
 * Prepare the socket path: a 0700 parent directory, and no live host already on it.
 * A socket file nobody answers on is a leftover from a crashed host and is removed.
 */
async function claimSocketPath(socketPath: string): Promise<void> {
    const dir = path.dirname(socketPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(socketPath)) return;
    const alive = await new Promise<boolean>((resolve) => {
        const probe = net.connect(socketPath);
        probe.once('connect', () => {
            probe.destroy();
            resolve(true);
        });
        probe.once('error', () => resolve(false));
    });
    if (alive) throw new Error(`an agent host is already listening on ${socketPath}`);
    unlinkSync(socketPath);
}

function writeInfoFile(infoPath: string, info: AgentHostInfo): void {
    mkdirSync(path.dirname(infoPath), { recursive: true, mode: 0o700 });
    const tmp = `${infoPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, infoPath);
}

function apiError(code: string, message: string): Extract<AgentHostApiV1, { kind: 'error' }> {
    return { schema: 'xtrm.agent-host-api.v1', kind: 'error', code, message: message.slice(0, 1024) };
}

function sendJson(res: http.ServerResponse, status: number, body: AgentHostApiV1): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
}

function listen(server: net.Server, target: string | number, host?: string): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        const done = () => {
            server.off('error', reject);
            resolve();
        };
        if (typeof target === 'string') server.listen(target, done);
        else server.listen(target, host, done);
    });
}

function closeServer(server: net.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

function safeUnlink(file: string): void {
    try {
        unlinkSync(file);
    } catch {
        /* already gone */
    }
}

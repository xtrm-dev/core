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
 * - Session index (XTRM-565): stopped sessions from provider journals, listed as `history_only`
 *   after the live registry; a live session wins over its history entry.
 *
 * - Launch (XTRM-566): POST /v1/launch starts `xt pi` or bare `pi` in a detached tmux session and
 *   binds the pane to the session whose extension reports it.
 *
 * - References (XTRM-570): POST /v1/references/resolve resolves @file, @commit, @session, @agent
 *   and @frame against the session on this host, within the PRD §36.12 item 2 budgets.
 *
 * - Direct mode (XTRM-568): off by default. With it, remote clients behind an HTTPS front such as
 *   `tailscale serve` reach the same loopback listener; every non-local request needs a device
 *   session from a one-time pairing token (agent-host-auth.ts). Without it, proxied requests are
 *   refused. The listener stays on 127.0.0.1 in every mode.
 *
 * Idle cost is the registry, the index, and a bounded replay buffer; no provider adapter is resident.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { decodeFrame, encodeFrame } from '@xtrm/contracts';
import type { AgentCommandPayload, AgentEventV1, AgentHostApiV1 } from '@xtrm/contracts';
import {
    AGENT_HOST_AUTH_SCHEMA,
    bearerToken,
    DeviceAuthority,
    isLocalRequest,
    LOOPBACK_HOSTNAMES,
    normalizeDirectHostname,
    parsePairRequest,
    type AgentHostAuthMessage,
    type DeviceSummary,
    type DirectModeOptions,
} from './agent-host-auth.js';
import { AgentHostLauncher, LaunchRejection, type AgentHostLaunchOptions, type LaunchRequest } from './agent-host-launch.js';
import { ReferenceRejection, resolveReferences, type ReferenceResolveRequest } from './agent-host-references.js';
import { AgentHostRegistry, type ProducerConnection, type SubmitRequest } from './agent-host-registry.js';
import { SessionIndex, type SessionIndexOptions } from './agent-host-session-index.js';

/** The client API never binds anything else by default (§35.5). */
export const AGENT_HOST_BIND_ADDRESS = '127.0.0.1';
export const AGENT_HOST_PROTOCOL_MAJOR = 1;

const MAX_SOCKET_LINE_BYTES = 32 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
/** A client further behind than this is disconnected rather than buffered without bound. */
const MAX_SSE_BACKLOG_BYTES = 8 * 1024 * 1024;
const SSE_HEARTBEAT_MS = 15_000;
const DEFAULT_REPLAY_LIMIT = 1024;

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
    /** Present only when direct mode is on: the host names its HTTPS front forwards. */
    direct?: { hostnames: string[] };
}

export interface AgentHostOptions {
    socketPath?: string;
    infoPath?: string;
    /** 0 picks a free port. */
    port?: number;
    version?: string;
    commandTimeoutMs?: number;
    replayLimit?: number;
    /** Incremental index of stopped sessions; off unless given (`xt host start` passes the defaults). */
    sessionIndex?: SessionIndexOptions;
    /** POST /v1/launch: the xt build and environment launched agents start from. */
    launch?: AgentHostLaunchOptions;
    /** Direct connection mode (XTRM-568); off unless given. Never changes the bind address. */
    direct?: DirectModeOptions;
    log?: (message: string) => void;
}

export interface AgentHost {
    readonly info: AgentHostInfo;
    readonly registry: AgentHostRegistry;
    readonly sessionIndex: SessionIndex | null;
    close(): Promise<void>;
}

type HostEventMessage = Extract<AgentHostApiV1, { kind: 'event' }>;
/** `deviceId` is set for a stream a remote device opened, so revoking the device can end it. */
type EventStream = { res: http.ServerResponse; sessionId: string | null; deviceId: string | null };

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
    const sessionIndex = options.sessionIndex ? new SessionIndex({ log, ...options.sessionIndex }) : null;
    const launcher = new AgentHostLauncher(options.launch);
    const directHostnames = (options.direct?.hostnames ?? []).map(normalizeDirectHostname);
    if (options.direct && directHostnames.length === 0) throw new Error('direct mode needs at least one host name');
    const authority = options.direct
        ? new DeviceAuthority({
              storePath: options.direct.storePath,
              pairingTtlMs: options.direct.pairingTtlMs,
              now: options.direct.now,
          })
        : null;
    const allowedHostnames = new Set([...LOOPBACK_HOSTNAMES, ...directHostnames]);

    await claimSocketPath(socketPath);

    // --- fan-out: host-assigned cursors, bounded replay for Last-Event-ID resume ---
    let cursor = 0;
    const replay: HostEventMessage[] = [];
    const streams = new Set<EventStream>();
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
        // DNS-rebinding guard: only loopback host names, plus the direct-mode front names, reach the API.
        const hostname = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
        if (!allowedHostnames.has(hostname)) {
            sendJson(res, 403, apiError('forbidden_host', 'the agent host only answers loopback host names'));
            return;
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const route = `${req.method} /${parts.join('/')}`;

        // Direct-mode authentication (XTRM-568): only a local request goes without a device session.
        const local = isLocalRequest(req);
        let device: DeviceSummary | null = null;
        if (!local) {
            if (!authority) {
                sendJson(res, 403, apiError('direct_mode_disabled', 'proxied or non-local requests need direct mode'));
                return;
            }
            if (route !== 'POST /v1/pair') {
                device = authority.authenticate(bearerToken(req.headers));
                if (!device) {
                    sendJson(res, 401, apiError('unauthorized', 'a device session bearer token is required'), {
                        'www-authenticate': 'Bearer realm="xt-host"',
                    });
                    return;
                }
            }
        }
        if (await handleAuthRoute(route, parts, req, res, local)) return;

        if (route === 'GET /v1/sessions') {
            const live = registry.list();
            let sessions = live;
            if (sessionIndex) {
                const liveIds = new Set(live.map((s) => s.sessionId));
                sessions = live.concat(sessionIndex.list().filter((s) => !liveIds.has(s.sessionId)));
            }
            sendJson(res, 200, { schema: 'xtrm.agent-host-api.v1', kind: 'session_list', sessions });
            return;
        }
        if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'sessions') {
            const detail = registry.detail(parts[2]) ?? sessionIndex?.detail(parts[2]) ?? null;
            if (detail) sendJson(res, 200, detail);
            else sendJson(res, 404, apiError('session_not_found', `no session ${parts[2]}`));
            return;
        }
        if (route === 'GET /v1/events') {
            openStream(req, res, url.searchParams.get('sessionId'), device?.deviceId ?? null);
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
        if (route === 'POST /v1/launch') {
            const body = await readJsonBody(req, res);
            if (body === null) return;
            const decoded = decodeFrame('xtrm.agent-host-api.v1', body);
            if (!decoded.ok || decoded.value.kind !== 'launch_request') {
                const detail = decoded.ok ? `expected launch_request, received ${decoded.value.kind}` : decoded.detail;
                sendJson(res, 400, apiError('invalid_request', detail));
                return;
            }
            let result;
            try {
                result = await launcher.launch(decoded.value as LaunchRequest);
            } catch (error) {
                if (!(error instanceof LaunchRejection)) throw error;
                sendJson(res, 400, apiError(error.code, error.message));
                return;
            }
            const paneId = result.tmux?.paneId;
            if (paneId) {
                registry.expectLaunchedPane(paneId);
                log(`launched ${decoded.value.command} in ${result.tmux!.session}:${paneId}`);
            } else {
                log(`launch failed (${result.outcome.reason_code}): ${result.outcome.summary}`);
            }
            sendJson(res, 200, result);
            return;
        }
        if (route === 'POST /v1/references/resolve') {
            const body = await readJsonBody(req, res);
            if (body === null) return;
            const decoded = decodeFrame('xtrm.agent-host-api.v1', body);
            if (!decoded.ok || decoded.value.kind !== 'reference_resolve_request') {
                const detail = decoded.ok ? `expected reference_resolve_request, received ${decoded.value.kind}` : decoded.detail;
                sendJson(res, 400, apiError('invalid_request', detail));
                return;
            }
            try {
                sendJson(res, 200, await resolveReferences(decoded.value as ReferenceResolveRequest, { registry, sessionIndex }));
            } catch (error) {
                if (!(error instanceof ReferenceRejection)) throw error;
                sendJson(res, 400, apiError(error.code, error.message));
            }
            return;
        }
        sendJson(res, 404, apiError('not_found', `no route ${route}`));
    }

    /** Pairing and device routes; true when the route was one of them and has been answered. */
    async function handleAuthRoute(
        route: string,
        parts: string[],
        req: http.IncomingMessage,
        res: http.ServerResponse,
        local: boolean,
    ): Promise<boolean> {
        const revoke = req.method === 'DELETE' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'devices';
        const pair = route === 'POST /v1/pair';
        if (!pair && !revoke && route !== 'POST /v1/pairing' && route !== 'GET /v1/devices') return false;
        if (!authority) {
            sendJson(res, 409, apiError('direct_mode_disabled', 'start the host with --direct to pair devices'));
            return true;
        }
        if (pair) {
            const body = await readJsonBody(req, res);
            if (body === null) return true;
            const request = parsePairRequest(body);
            if (!request) {
                sendJson(res, 400, apiError('invalid_request', 'expected an xtrm.agent-host-auth.v1 pair_request'));
                return true;
            }
            const paired = authority.exchange(request.pairingToken, request.deviceName);
            if (!paired) {
                sendJson(res, 401, apiError('invalid_pairing_token', 'the pairing token is unknown, used or expired'));
                return true;
            }
            log(`paired device ${paired.device.deviceId} (${paired.device.name})`);
            sendJson(res, 200, { schema: AGENT_HOST_AUTH_SCHEMA, kind: 'device_session', ...paired });
            return true;
        }
        // Issuing pairing tokens and managing devices stays with the local operator.
        if (!local) {
            sendJson(res, 403, apiError('local_only', 'this route only answers local clients'));
            return true;
        }
        if (route === 'POST /v1/pairing') {
            if ((await readJsonBody(req, res)) === null) return true;
            const issued = authority.issuePairingToken();
            log(`issued a pairing token, expires ${new Date(issued.expiresAt).toISOString()}`);
            sendJson(res, 200, { schema: AGENT_HOST_AUTH_SCHEMA, kind: 'pairing_token', ...issued });
            return true;
        }
        if (route === 'GET /v1/devices') {
            sendJson(res, 200, { schema: AGENT_HOST_AUTH_SCHEMA, kind: 'device_list', devices: authority.list() });
            return true;
        }
        const deviceId = parts[2];
        if (!authority.revoke(deviceId)) {
            sendJson(res, 404, apiError('device_not_found', `no device ${deviceId}`));
            return true;
        }
        // A revoked device loses its open event streams at once.
        for (const stream of streams) if (stream.deviceId === deviceId) stream.res.destroy();
        log(`revoked device ${deviceId}`);
        sendJson(res, 200, { schema: AGENT_HOST_AUTH_SCHEMA, kind: 'device_revoked', deviceId });
        return true;
    }

    function openStream(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string | null, deviceId: string | null): void {
        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
        });
        res.write(': xtrm agent host\n\n');
        const stream: EventStream = { res, sessionId, deviceId };
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

    function writeEvent(stream: EventStream, message: HostEventMessage): void {
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
        await sessionIndex?.close();
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
        ...(authority ? { direct: { hostnames: directHostnames } } : {}),
    };
    writeInfoFile(infoPath, info);

    let closing: Promise<void> | null = null;
    return {
        info,
        registry,
        sessionIndex,
        close() {
            closing ??= (async () => {
                registry.close();
                for (const stream of streams) stream.res.end();
                streams.clear();
                for (const socket of producers) socket.destroy();
                httpServer.closeAllConnections();
                await Promise.all([closeServer(httpServer), closeServer(socketServer), sessionIndex?.close()]);
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

function sendJson(
    res: http.ServerResponse,
    status: number,
    body: AgentHostApiV1 | AgentHostAuthMessage,
    headers: Record<string, string> = {},
): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        ...headers,
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        // Pairing replies carry secrets; nothing from this API belongs in a cache.
        'cache-control': 'no-store',
    });
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

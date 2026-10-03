/**
 * Live session registry and command router of the XTRM agent host
 * (PRD xtrm-app §35.5, §35.8 items 1 and 5; XTRM-563).
 *
 * State is pushed by in-session producers as xtrm.agent-event.v1 frames; nothing
 * is polled. The registry derives each session's xtrm.agent-host-api.v1 summary
 * from those frames, routes client commands to the producer connection as
 * xtrm.agent-command.v1 payloads, and enforces the concurrent-submit policy.
 *
 * Transport-free: the server in agent-host.ts owns sockets and HTTP.
 */

import type {
    AgentCapability,
    AgentCommandPayload,
    AgentEventV1,
    AgentHostApiV1,
    AgentSessionIdentity,
    AgentSessionSummary,
    AgentToolOrigin,
} from '@xtrm/contracts';
import { classifyClaudeTool, ToolOriginClassifier } from './agent-host-origin.js';

export type SubmitRequest = Extract<AgentHostApiV1, { kind: 'submit_request' }>;
export type SubmitResult = Extract<AgentHostApiV1, { kind: 'submit_result' }>;
export type SessionDetail = Extract<AgentHostApiV1, { kind: 'session_detail' }>;

/** One producer connection (a Pi extension socket, or one Claude hook invocation). */
export interface ProducerConnection {
    sendCommand(sessionId: string, payload: AgentCommandPayload): void;
}

interface LiveSession {
    identity: AgentSessionIdentity;
    connection: ProducerConnection | null;
    /** A Frame is open between before_agent_start/agent_start and agent_settled. */
    frameOpen: boolean;
    /** commandId of a routed prompt whose Frame has not settled yet (§35.8 item 5). */
    promptPending: string | null;
    /** extension_ui_request ids awaiting an answer. */
    pendingUi: Set<string>;
    /** Origin per in-flight toolCallId, fixed at tool_execution_start (end carries no args). */
    toolOrigins: Map<string, AgentToolOrigin>;
    frameCount: number;
    startedAt: number;
    lastActivityAt: number;
    lastSeq: number;
}

interface PendingCommand {
    sessionId: string;
    connection: ProducerConnection;
    payload: AgentCommandPayload;
    timer: NodeJS.Timeout;
    resolve(result: SubmitResult): void;
}

const CAPABILITY_FOR: Record<AgentCommandPayload['type'], AgentCapability> = {
    prompt: 'prompt',
    steer: 'steer',
    follow_up: 'follow_up',
    abort: 'abort',
    extension_ui_response: 'extension_ui',
};

/** Presence-only sessions (Claude hooks) outlive their short-lived connections; cap how many are kept. */
const MAX_DISCONNECTED_SESSIONS = 256;

export interface AgentHostRegistryOptions {
    /** How long a routed command waits for the producer's command_result. */
    commandTimeoutMs?: number;
    log?: (message: string) => void;
}

export class AgentHostRegistry {
    private readonly sessions = new Map<string, LiveSession>();
    private readonly pending = new Map<string, PendingCommand>();
    private readonly listeners = new Set<(frame: AgentEventV1) => void>();
    private readonly classifier = new ToolOriginClassifier();
    private readonly commandTimeoutMs: number;
    private readonly log: (message: string) => void;

    constructor(options: AgentHostRegistryOptions = {}) {
        this.commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
        this.log = options.log ?? (() => {});
    }

    /** Subscribe to every accepted event frame, in arrival order. Returns an unsubscribe function. */
    subscribe(listener: (frame: AgentEventV1) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * Apply one decoded event frame from `connection` and fan it out.
     * Returns false when the frame is dropped (no session_identity seen for its session).
     */
    ingest(connection: ProducerConnection, frame: AgentEventV1): boolean {
        const { payload, sessionId } = frame;
        let session = this.sessions.get(sessionId);

        if (payload.type === 'session_identity') {
            if (session) {
                session.identity = payload;
                session.connection = connection;
            } else {
                session = {
                    identity: payload,
                    connection,
                    frameOpen: false,
                    promptPending: null,
                    pendingUi: new Set(),
                    toolOrigins: new Map(),
                    frameCount: 0,
                    startedAt: frame.at,
                    lastActivityAt: frame.at,
                    lastSeq: frame.seq,
                };
                this.sessions.set(sessionId, session);
            }
        } else if (!session) {
            this.log(`dropped ${payload.type} for session ${sessionId}: no session_identity received`);
            return false;
        } else {
            // Frames may arrive on a newer connection (one per Claude hook); route through the latest.
            session.connection = connection;
        }

        session.lastActivityAt = Math.max(session.lastActivityAt, frame.at);
        session.lastSeq = frame.seq;

        switch (payload.type) {
            case 'before_agent_start':
            case 'agent_start':
                if (!session.frameOpen) {
                    session.frameOpen = true;
                    session.frameCount += 1;
                }
                break;
            case 'agent_settled':
                // The only Frame close; agent_end (with or without willRetry) never settles.
                session.frameOpen = false;
                session.promptPending = null;
                session.pendingUi.clear();
                session.toolOrigins.clear();
                break;
            case 'extension_ui_request':
                session.pendingUi.add(payload.id);
                break;
            case 'extension_ui_resolved':
                // Answered in the terminal, cancelled, or answered by the host: the prompt is gone.
                session.pendingUi.delete(payload.id);
                break;
            case 'command_result':
                this.settleCommand(sessionId, payload.commandId, payload.status, payload.reason, payload.message);
                break;
            case 'tool_execution_start':
            case 'tool_execution_update':
            case 'tool_execution_end':
                frame = { ...frame, payload: { ...payload, origin: this.toolOrigin(session, payload) } };
                break;
            default:
                break;
        }

        for (const listener of this.listeners) listener(frame);

        if (payload.type === 'session_shutdown') this.removeSession(sessionId);
        return true;
    }

    /**
     * The producer connection closed. Sessions with a persistent producer (any capability
     * beyond presence) are gone from the live registry; presence-only sessions report through
     * one connection per hook, so they stay until session_shutdown.
     */
    disconnect(connection: ProducerConnection): void {
        for (const [commandId, entry] of this.pending) {
            if (entry.connection === connection) {
                this.finishPending(commandId, 'failed', 'extension_disconnected', 'the session producer disconnected');
            }
        }
        for (const [sessionId, session] of this.sessions) {
            if (session.connection !== connection) continue;
            session.connection = null;
            const persistent = session.identity.capabilities.some((c) => c !== 'presence');
            if (persistent) this.removeSession(sessionId);
        }
        this.pruneDisconnected();
    }

    list(): AgentSessionSummary[] {
        return [...this.sessions.keys()].map((id) => this.summarize(id)!);
    }

    detail(sessionId: string): SessionDetail | null {
        const session = this.sessions.get(sessionId);
        if (!session) return null;
        return {
            schema: 'xtrm.agent-host-api.v1',
            kind: 'session_detail',
            session: this.summarize(sessionId)!,
            identity: session.identity,
            lastSeq: session.lastSeq,
        };
    }

    /**
     * Route one client command. Policy decisions run synchronously, so submits to one
     * session are serialized by the event loop: the first accepted prompt marks the session
     * busy before any other request is examined (§35.8 item 5). The result resolves when the
     * producer answers with command_result, or fails after the command timeout.
     */
    submit(request: SubmitRequest): Promise<SubmitResult> {
        const { sessionId, command } = request;
        const reject = (status: SubmitResult['status'], reason: string, message: string) =>
            Promise.resolve(this.result(command.commandId, status, reason, message));

        const session = this.sessions.get(sessionId);
        if (!session) return reject('not_found', 'session_not_found', `no live session ${sessionId}`);
        if (!session.identity.capabilities.includes(CAPABILITY_FOR[command.type])) {
            return reject('unsupported', 'capability_not_advertised', `session does not advertise ${CAPABILITY_FOR[command.type]}`);
        }
        const unresolved = request.references?.find((ref) => ref.status !== 'resolved');
        if (unresolved) return reject('rejected', 'unresolved_reference', `reference ${unresolved.raw} is unresolved`);
        if (this.pending.has(command.commandId)) {
            return reject('rejected', 'duplicate_command_id', `command ${command.commandId} is already in flight`);
        }
        const connection = session.connection;
        if (!connection) return reject('failed', 'extension_disconnected', 'the session producer is not connected');

        switch (command.type) {
            case 'prompt':
                // Never merged, never queued implicitly: the operator chooses steer or follow-up.
                if (session.frameOpen || session.promptPending) {
                    return reject('busy', 'session_working', 'the session is working; use steer or follow_up');
                }
                session.promptPending = command.commandId;
                break;
            case 'steer':
            case 'follow_up':
                if (!session.frameOpen && !session.promptPending) {
                    return reject('rejected', 'session_idle', `${command.type} needs a running Frame; submit a prompt`);
                }
                break;
            case 'extension_ui_response':
                if (!session.pendingUi.has(command.id)) {
                    return reject('rejected', 'unknown_ui_request', `no pending extension UI request ${command.id}`);
                }
                break;
            case 'abort':
                break;
        }

        return new Promise<SubmitResult>((resolve) => {
            const timer = setTimeout(
                () => this.finishPending(command.commandId, 'failed', 'command_timeout', 'the session producer did not answer'),
                this.commandTimeoutMs,
            );
            timer.unref?.();
            this.pending.set(command.commandId, { sessionId, connection, payload: command, timer, resolve });
            try {
                connection.sendCommand(sessionId, command);
            } catch (error) {
                this.finishPending(command.commandId, 'failed', 'send_failed', (error as Error).message);
            }
        });
    }

    /**
     * PRD §36.7: the host, not the producer, sets origin from the registration record.
     * The class is fixed at tool_execution_start, whose args name the MCP proxy's server.
     */
    private toolOrigin(
        session: LiveSession,
        payload: Extract<AgentEventV1['payload'], { type: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end' }>,
    ): AgentToolOrigin {
        let origin = session.toolOrigins.get(payload.toolCallId);
        if (!origin) {
            const args = 'args' in payload ? payload.args : undefined;
            origin =
                session.identity.runtime.name === 'claude'
                    ? classifyClaudeTool(payload.toolName)
                    : this.classifier.classifyPi(payload.toolName, payload.tool, args);
            if (payload.type !== 'tool_execution_end') session.toolOrigins.set(payload.toolCallId, origin);
        }
        if (payload.type === 'tool_execution_end') session.toolOrigins.delete(payload.toolCallId);
        return origin;
    }

    /** Fail every in-flight command; used on host shutdown. */
    close(): void {
        for (const commandId of [...this.pending.keys()]) {
            this.finishPending(commandId, 'failed', 'host_shutdown', 'the agent host is shutting down');
        }
    }

    private settleCommand(
        sessionId: string,
        commandId: string,
        status: 'accepted' | 'rejected' | 'failed',
        reason?: string,
        message?: string,
    ): void {
        const entry = this.pending.get(commandId);
        if (!entry || entry.sessionId !== sessionId) return;
        this.finishPending(commandId, status, reason, message);
    }

    private finishPending(commandId: string, status: SubmitResult['status'], reason?: string, message?: string): void {
        const entry = this.pending.get(commandId);
        if (!entry) return;
        this.pending.delete(commandId);
        clearTimeout(entry.timer);

        const session = this.sessions.get(entry.sessionId);
        if (session) {
            const { payload } = entry;
            if (payload.type === 'prompt' && status !== 'accepted' && session.promptPending === commandId) {
                session.promptPending = null;
            }
            if (payload.type === 'abort' && status === 'accepted' && !session.frameOpen) {
                session.promptPending = null;
            }
            if (payload.type === 'extension_ui_response' && status === 'accepted') {
                session.pendingUi.delete(payload.id);
            }
        }
        entry.resolve(this.result(commandId, status, reason, message));
    }

    private result(commandId: string, status: SubmitResult['status'], reason?: string, message?: string): SubmitResult {
        return {
            schema: 'xtrm.agent-host-api.v1',
            kind: 'submit_result',
            commandId,
            status,
            ...(reason ? { reason } : {}),
            ...(message ? { message: message.slice(0, 1024) } : {}),
        };
    }

    private removeSession(sessionId: string): void {
        for (const [commandId, entry] of this.pending) {
            if (entry.sessionId === sessionId) {
                this.finishPending(commandId, 'failed', 'session_ended', 'the session ended');
            }
        }
        this.sessions.delete(sessionId);
    }

    private pruneDisconnected(): void {
        const disconnected = [...this.sessions.entries()].filter(([, s]) => !s.connection);
        if (disconnected.length <= MAX_DISCONNECTED_SESSIONS) return;
        disconnected.sort(([, a], [, b]) => a.lastActivityAt - b.lastActivityAt);
        for (const [sessionId] of disconnected.slice(0, disconnected.length - MAX_DISCONNECTED_SESSIONS)) {
            this.sessions.delete(sessionId);
        }
    }

    private summarize(sessionId: string): AgentSessionSummary | null {
        const session = this.sessions.get(sessionId);
        if (!session) return null;
        const id = session.identity;
        let childCount = 0;
        for (const other of this.sessions.values()) if (other.identity.parentSessionId === sessionId) childCount += 1;
        return {
            sessionId,
            provider: id.runtime.name,
            state: session.pendingUi.size > 0 ? 'waiting_for_input' : session.frameOpen ? 'working' : 'settled',
            ...(id.sessionName ? { name: id.sessionName } : {}),
            cwd: id.cwd,
            ...(id.worktree ? { worktree: id.worktree } : {}),
            ...(id.branch ? { branch: id.branch } : {}),
            ...(id.role ? { role: id.role } : {}),
            ...(id.workItem ? { workItem: id.workItem } : {}),
            ...(id.parentSessionId ? { parentSessionId: id.parentSessionId } : {}),
            childCount,
            ...(id.tmux ? { tmux: id.tmux } : {}),
            ...(id.launch ? { launch: id.launch } : {}),
            extensionConnected: session.connection !== null,
            capabilities: id.capabilities,
            frameCount: session.frameCount,
            startedAt: session.startedAt,
            lastActivityAt: session.lastActivityAt,
            ...(id.sessionFile ? { sessionFile: id.sessionFile } : {}),
        };
    }
}

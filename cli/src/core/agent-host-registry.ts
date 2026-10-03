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
    AgentMessagePassthrough,
    AgentSessionIdentity,
    AgentSessionStatus,
    AgentSessionSummary,
    AgentToolOrigin,
} from '@xtrm/contracts';
import { classifyClaudeTool, ToolOriginClassifier } from './agent-host-origin.js';

export type SubmitRequest = Extract<AgentHostApiV1, { kind: 'submit_request' }>;
export type SubmitResult = Extract<AgentHostApiV1, { kind: 'submit_result' }>;
export type SessionDetail = Extract<AgentHostApiV1, { kind: 'session_detail' }>;

/**
 * The request and settled response of one Frame, kept for @frame and @session references
 * (PRD §36.6). Text is stored up to FRAME_TEXT_MAX_BYTES; the *Bytes fields hold the full size.
 */
export interface FrameRecord {
    /** 1-based, matching the session summary's frameCount. */
    n: number;
    request?: string;
    requestBytes: number;
    response?: string;
    responseBytes: number;
    settled: boolean;
    /** seq of the last frame applied to this Frame (agent_settled once settled). */
    seq: number;
}

/** One producer connection (a Pi extension socket, or one Claude hook invocation). */
export interface ProducerConnection {
    sendCommand(sessionId: string, payload: AgentCommandPayload): void;
}

interface LiveSession {
    identity: AgentSessionIdentity;
    /** The latest session_status (model, thinking level, context usage); each one replaces the last. */
    status: AgentSessionStatus | null;
    connection: ProducerConnection | null;
    /** A Frame is open between before_agent_start/agent_start and agent_settled. */
    frameOpen: boolean;
    /** commandId of a routed prompt whose Frame has not settled yet (§35.8 item 5). */
    promptPending: string | null;
    /** extension_ui_request ids awaiting an answer. */
    pendingUi: Set<string>;
    /** A runtime notification (Claude permission or elicitation prompt) awaits local input. */
    awaitingLocalInput: boolean;
    /** Origin per in-flight toolCallId, fixed at tool_execution_start (end carries no args). */
    toolOrigins: Map<string, AgentToolOrigin>;
    frameCount: number;
    /** The most recent Frames, oldest first (bounded by MAX_FRAME_RECORDS). */
    frames: FrameRecord[];
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

/** Claude notification kinds that block the session on operator input in the terminal. */
const INPUT_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog']);

/** Presence-only sessions (Claude hooks) outlive their short-lived connections; cap how many are kept. */
const MAX_DISCONNECTED_SESSIONS = 256;

/** Launched panes remembered for binding; pane ids are unique for a tmux server's lifetime. */
const MAX_LAUNCHED_PANES = 256;

/** Frames retained per session for references; older Frames resolve as not retained. */
const MAX_FRAME_RECORDS = 16;
/** Stored request/response text per Frame; above the largest reference budget (8 KB) with margin. */
const FRAME_TEXT_MAX_BYTES = 16 * 1024;

/** Presence-only producers (Claude hooks) report through one short connection per hook. */
function isPresenceOnly(session: LiveSession): boolean {
    return session.identity.capabilities.every((c) => c === 'presence');
}

export interface AgentHostRegistryOptions {
    /** How long a routed command waits for the producer's command_result. */
    commandTimeoutMs?: number;
    log?: (message: string) => void;
}

export class AgentHostRegistry {
    private readonly sessions = new Map<string, LiveSession>();
    private readonly pending = new Map<string, PendingCommand>();
    /** tmux panes the host launched agents into, oldest first (bounded). */
    private readonly launchedPanes = new Set<string>();
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
            const identity = this.bindLaunchedPane(sessionId, payload);
            if (session) {
                session.identity = identity;
                session.connection = connection;
            } else {
                session = {
                    identity,
                    status: null,
                    connection,
                    frameOpen: false,
                    promptPending: null,
                    pendingUi: new Set(),
                    awaitingLocalInput: false,
                    toolOrigins: new Map(),
                    frameCount: 0,
                    frames: [],
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
        if (session.frameOpen) session.frames.at(-1)!.seq = frame.seq;
        // A notification-driven wait ends with the next lifecycle or tool event: the operator answered.
        if (payload.type !== 'session_identity' && payload.type !== 'session_status' && payload.type !== 'subagent_end') {
            session.awaitingLocalInput = false;
        }

        switch (payload.type) {
            case 'session_status':
                session.status = payload;
                break;
            case 'before_agent_start':
            case 'agent_start':
                if (!session.frameOpen) this.openFrame(session, frame.seq);
                if (payload.type === 'before_agent_start') {
                    const record = session.frames.at(-1);
                    if (record && record.request === undefined) {
                        [record.request, record.requestBytes] = boundText(payload.prompt);
                    }
                }
                break;
            case 'message_end':
                this.recordResponse(session, [payload.message]);
                break;
            case 'agent_end':
                this.recordResponse(session, payload.messages);
                break;
            case 'agent_settled': {
                // The only Frame close; agent_end (with or without willRetry) never settles.
                const record = session.frameOpen ? session.frames.at(-1) : undefined;
                if (record) record.settled = true;
                session.frameOpen = false;
                session.promptPending = null;
                session.pendingUi.clear();
                session.toolOrigins.clear();
                break;
            }
            case 'extension_ui_request':
                session.pendingUi.add(payload.id);
                break;
            case 'extension_ui_resolved':
                // Answered in the terminal, cancelled, or answered by the host: the prompt is gone.
                session.pendingUi.delete(payload.id);
                break;
            case 'notification':
                session.awaitingLocalInput = INPUT_NOTIFICATIONS.has(payload.kind);
                break;
            case 'command_result':
                this.settleCommand(sessionId, payload.commandId, payload.status, payload.reason, payload.message);
                break;
            case 'tool_execution_start':
                // Hook producers have no persistent turn state: a tool call after Stop (a Stop hook
                // that continued the turn) or after a host restart still means the session works.
                if (!session.frameOpen && isPresenceOnly(session)) this.openFrame(session, frame.seq);
                frame = { ...frame, payload: { ...payload, origin: this.toolOrigin(session, payload) } };
                break;
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
            if (!isPresenceOnly(session)) this.removeSession(sessionId);
        }
        this.pruneDisconnected();
    }

    /**
     * Record a tmux pane the host just launched an agent into (§35.4). The session whose
     * session_identity names this pane is bound to the launch and reports `launch: gui`,
     * whether its extension connected before or after this call.
     */
    expectLaunchedPane(paneId: string): void {
        this.launchedPanes.delete(paneId);
        this.launchedPanes.add(paneId);
        if (this.launchedPanes.size > MAX_LAUNCHED_PANES) {
            this.launchedPanes.delete(this.launchedPanes.values().next().value as string);
        }
        for (const [sessionId, session] of this.sessions) {
            if (session.identity.tmux?.paneId !== paneId) continue;
            session.identity = this.bindLaunchedPane(sessionId, session.identity);
        }
    }

    private bindLaunchedPane(sessionId: string, identity: AgentSessionIdentity): AgentSessionIdentity {
        const paneId = identity.tmux?.paneId;
        if (!paneId || !this.launchedPanes.has(paneId) || identity.launch === 'gui') return identity;
        this.log(`bound launched pane ${paneId} to session ${sessionId}`);
        return { ...identity, launch: 'gui' };
    }

    /** Retained Frames of a live session, oldest first; null when the session is not live. */
    frames(sessionId: string): readonly FrameRecord[] | null {
        return this.sessions.get(sessionId)?.frames ?? null;
    }

    private openFrame(session: LiveSession, seq: number): void {
        session.frameOpen = true;
        session.frameCount += 1;
        session.frames.push({ n: session.frameCount, requestBytes: 0, responseBytes: 0, settled: false, seq });
        if (session.frames.length > MAX_FRAME_RECORDS) session.frames.shift();
    }

    /** The last assistant text of an open Frame is its response so far; it is final once settled. */
    private recordResponse(session: LiveSession, messages: readonly AgentMessagePassthrough[]): void {
        const record = session.frameOpen ? session.frames.at(-1) : undefined;
        if (!record) return;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i]?.role !== 'assistant') continue;
            const text = messageText(messages[i]);
            if (!text) continue;
            [record.response, record.responseBytes] = boundText(text);
            return;
        }
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
        const status = session.status;
        let childCount = 0;
        for (const other of this.sessions.values()) if (other.identity.parentSessionId === sessionId) childCount += 1;
        return {
            sessionId,
            provider: id.runtime.name,
            state:
                session.pendingUi.size > 0 || session.awaitingLocalInput
                    ? 'waiting_for_input'
                    : session.frameOpen
                      ? 'working'
                      : 'settled',
            ...(id.sessionName ? { name: id.sessionName } : {}),
            cwd: id.cwd,
            ...(id.repository ? { repository: id.repository } : {}),
            ...(id.repositoryPath ? { repositoryPath: id.repositoryPath } : {}),
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
            ...(status?.model ? { model: status.model } : {}),
            ...(status?.thinkingLevel ? { thinkingLevel: status.thinkingLevel } : {}),
            // Unknown tokens (after compaction) clear the meter instead of showing a stale value.
            ...(status?.contextUsage && status.contextUsage.tokens !== null
                ? { contextUsage: { tokens: status.contextUsage.tokens, contextWindow: status.contextUsage.contextWindow } }
                : {}),
            frameCount: session.frameCount,
            startedAt: session.startedAt,
            lastActivityAt: session.lastActivityAt,
            ...(id.sessionFile ? { sessionFile: id.sessionFile } : {}),
        };
    }
}

/** Text parts of a provider message: a string content, or the `text` parts of a content array. */
function messageText(message: AgentMessagePassthrough): string {
    const { content } = message;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    let text = '';
    for (const part of content) {
        if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
            const value = (part as { text?: unknown }).text;
            if (typeof value === 'string') text += value;
        }
    }
    return text;
}

/** Store at most FRAME_TEXT_MAX_BYTES of UTF-8 text; returns the stored text and the full byte size. */
function boundText(text: string): [string, number] {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= FRAME_TEXT_MAX_BYTES) return [text, bytes];
    const buffer = Buffer.from(text, 'utf8');
    let end = FRAME_TEXT_MAX_BYTES;
    while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
    return [buffer.subarray(0, end).toString('utf8'), bytes];
}

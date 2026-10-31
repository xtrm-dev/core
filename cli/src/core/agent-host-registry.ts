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
    WakeResult,
} from '@xtrm/contracts';
import { classifyClaudeTool, ToolOriginClassifier } from './agent-host-origin.js';
import {
    DEFAULT_SWEEP_INTERVAL_MS,
    DEFAULT_WAKE_TTL_MS,
    MAX_LIVE_WAKES_PER_RECEIVER,
    MAX_WAKE_RECORDS,
    resolveWakeParticipant,
    stableWakeMessageId,
    wakeStateNow,
    type WakeRecord,
} from './agent-host-wake.js';

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
    /**
     * Pids this session replaced (CORE-2436 I5 follow-up c): every pid ever
     * replaced on this session, so after A→B→C replacements neither A nor B
     * can win the binding back. A set, never a single slot.
     */
    replacedPids: Set<number>;
    /** The latest session_status (model, thinking level, context usage); each one replaces the last. */
    status: AgentSessionStatus | null;
    connection: ProducerConnection | null;
    /** A Frame is open between before_agent_start/agent_start and agent_settled. */
    frameOpen: boolean;
    /** commandId of a routed prompt whose Frame has not settled yet (§35.8 item 5). */
    promptPending: string | null;
    /** Runs while an accepted prompt has not opened its Frame; see PROMPT_START_TIMEOUT_MS. */
    promptStartTimer: NodeJS.Timeout | null;
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
    /** Wake message id when this pending command is a wake delivery (CORE-2432). */
    wakeId?: string;
}

const CAPABILITY_FOR: Record<AgentCommandPayload['type'], AgentCapability> = {
    prompt: 'prompt',
    steer: 'steer',
    follow_up: 'follow_up',
    abort: 'abort',
    // Wake delivery is a message for the agent: only sessions that take prompts can receive one.
    wake: 'prompt',
    listener_replaced: 'prompt',
    extension_ui_response: 'extension_ui',
};

/** Claude notification kinds that block the session on operator input in the terminal. */
const INPUT_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog']);

/** Presence-only sessions (Claude hooks) outlive their short-lived connections; cap how many are kept. */
const MAX_DISCONNECTED_SESSIONS = 256;

/** Session start times remembered across reconnects (CORE-2554 D5). */
const MAX_REMEMBERED_STARTS = 1024;

/** Launched panes remembered for binding; pane ids are unique for a tmux server's lifetime. */
const MAX_LAUNCHED_PANES = 256;

/**
 * How long an accepted prompt may take to open its Frame (XTRM-605). A Pi input handler can
 * handle the prompt itself, or Pi preflight can throw (no model, no API key): Pi then emits no
 * before_agent_start, agent_start or agent_settled, and promptPending would refuse every later
 * prompt as busy. Matches the xtrm-agent-host extension's STARTUP_STALE_MS, after which the
 * extension stops counting the run as starting.
 */
const PROMPT_START_TIMEOUT_MS = 60_000;

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
    /** How long an accepted prompt may take to open its Frame before the host fails it. */
    promptStartTimeoutMs?: number;
    log?: (message: string) => void;
    /**
     * What a second listener for one listener identity does (CORE-2432 R2).
     * `refuse` (default) refuses it loudly; `handover` drains the binding to the
     * new connection explicitly. Signatures are unchanged; only the behaviour differs.
     */
    duplicateListener?: 'refuse' | 'handover';
    /** How long a queued or held wake is retained before it reads as expired. */
    wakeTtlMs?: number;
    /**
     * How often the registry sweeps for expired wakes on an idle host
     * (CORE-2437 F3): expiry (and its notice) must reach the sender within
     * a bounded time even when nobody sends or polls. Unref'd.
     */
    sweepIntervalMs?: number;
}

export class AgentHostRegistry {
    private readonly sessions = new Map<string, LiveSession>();
    private readonly pending = new Map<string, PendingCommand>();
    /** tmux panes the host launched agents into, oldest first (bounded). */
    private readonly launchedPanes = new Set<string>();
    private readonly listeners = new Set<(frame: AgentEventV1) => void>();
    private readonly classifier = new ToolOriginClassifier();
    private readonly commandTimeoutMs: number;
    private readonly promptStartTimeoutMs: number;
    private readonly log: (message: string) => void;
    private readonly duplicateListener: 'refuse' | 'handover';
    private readonly wakeTtlMs: number;
    /** Retained wake messages by stable message id (CORE-2432 R9). */
    private readonly wakes = new Map<string, WakeRecord>();
    /** Unref'd periodic expiry sweep (CORE-2437 F3); cleared on close(). */
    private readonly sweepTimer: ReturnType<typeof setInterval> | null;
    private wakeCommandSeq = 0;
    /**
     * Connections whose listener binding was refused (duplicate, stale,
     * win-back, legacy). Later frames from them are dropped so a refused
     * listener can neither hijack the binding nor ping-pong a replacement (F1, F3).
     */
    private readonly refusedConnections = new Set<ProducerConnection>();

    constructor(options: AgentHostRegistryOptions = {}) {
        this.commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
        this.promptStartTimeoutMs = options.promptStartTimeoutMs ?? PROMPT_START_TIMEOUT_MS;
        this.log = options.log ?? (() => {});
        this.duplicateListener = options.duplicateListener ?? 'refuse';
        this.wakeTtlMs = options.wakeTtlMs ?? DEFAULT_WAKE_TTL_MS;
        // CORE-2437 F3: expiry must fire on an idle host too. Unref'd, so a
        // registry never holds the process open; cleared on close().
        const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
        if (sweepIntervalMs > 0) {
            this.sweepTimer = setInterval(() => this.sweepWakes(Date.now()), sweepIntervalMs);
            this.sweepTimer.unref?.();
        } else {
            this.sweepTimer = null;
        }
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
        // F1/F3: a refused connection stays refused; its later frames are
        // dropped instead of hijacking the live binding.
        if (this.refusedConnections.has(connection)) {
            this.log(`dropped ${payload.type} for session ${sessionId}: connection was refused a listener binding`);
            return false;
        }
        let session = this.sessions.get(sessionId);

        if (payload.type === 'session_identity') {
            const identity = this.bindLaunchedPane(sessionId, payload);
            // CORE-2432 R2/R6: a second listener for one listener identity no
            // longer silently overwrites the first, and writes are
            // compare-and-swap on generation. Legacy identities without
            // pid+generation keep the old overwrite behaviour.
            const verdict = this.checkListener(sessionId, session ?? null, identity, connection);
            if (verdict === 'duplicate' || verdict === 'stale' || verdict === 'winback' || verdict === 'legacy') {
                if (verdict === 'duplicate') {
                    this.log(
                        `refused second listener for session ${sessionId} (${describeListener(identity)}): ` +
                            `already bound; reconnect after disconnect or use drain-and-handover`,
                    );
                } else if (verdict === 'stale') {
                    this.log(
                        `refused stale session_identity for session ${sessionId}: ` +
                            `generation ${identity.generation} < ${session?.identity.generation}`,
                    );
                } else if (verdict === 'winback') {
                    // F1: replacement is not a reason to win back; refuse the
                    // ping-pong and tell the producer, as for legacy refusals.
                    this.log(
                        `refused win-back session_identity for session ${sessionId} (${describeListener(identity)}): ` +
                            `replacement is not a reason to win the binding back`,
                    );
                    this.notifyRefused(sessionId, connection, 'winback_refused', session?.identity.generation);
                } else {
                    // F3: a legacy frame must not displace a pid+generation binding.
                    this.log(
                        `refused legacy session_identity for session ${sessionId}: ` +
                            `the live binding carries pid+generation; re-assert with both`,
                    );
                    this.notifyRefused(sessionId, connection, 'legacy_identity_refused');
                }
                this.refusedConnections.add(connection);
                return false;
            }
            const previousConnection =
                session && session.connection !== null && session.connection !== connection ? session.connection : null;
            if (session) {
                // F1: remember whom this session just replaced, so a win-back
                // re-assert from that pid is refused instead of ping-ponging.
                if (previousConnection && (verdict === 'replace' || verdict === 'handover')) {
                    if (typeof session.identity.pid === 'number') session.replacedPids.add(session.identity.pid);
                }
                session.identity = identity;
                session.connection = connection;
                if (verdict === 'handover') {
                    // Explicit drain-and-handover: in-flight commands drain to the new listener.
                    for (const entry of this.pending.values()) {
                        if (entry.sessionId === sessionId) entry.connection = connection;
                    }
                }
            } else {
                session = {
                    identity,
                    replacedPids: new Set(),
                    status: null,
                    connection,
                    frameOpen: false,
                    promptPending: null,
                    promptStartTimer: null,
                    pendingUi: new Set(),
                    awaitingLocalInput: false,
                    toolOrigins: new Map(),
                    frameCount: 0,
                    frames: [],
                    // CORE-2554 D5: a session that reconnects (extension restart, host
                    // hiccup) keeps the start it first registered with.
                    startedAt: this.startedAtBySession.get(sessionId) ?? frame.at,
                    lastActivityAt: frame.at,
                    lastSeq: frame.seq,
                };
                this.sessions.set(sessionId, session);
                this.rememberStartedAt(sessionId, session.startedAt);
            }
            if (previousConnection && (verdict === 'replace' || verdict === 'handover')) {
                // R5: the replaced listener is told, so it can re-assert with a bumped generation.
                this.notifyReplaced(sessionId, previousConnection, identity, verdict);
            }
            this.flushWakes(sessionId);
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
                this.clearPromptPending(session);
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

        // CORE-2437 F2: a graceful shutdown parks the session's wakes as
        // held (same as a transport loss); they flush to the next session
        // with that name or id, or expire by TTL with the expired notice.
        // Only a host shutdown reports pending wakes as undelivered.
        if (payload.type === 'session_shutdown') this.removeSession(sessionId, { revokeWakes: false });
        return true;
    }

    /**
     * The producer connection closed. Sessions with a persistent producer (any capability
     * beyond presence) are gone from the live registry; presence-only sessions report through
     * one connection per hook, so they stay until session_shutdown.
     */
    /**
     * CORE-2437 mailbox (F2): park one in-flight wake as held for a receiver
     * restart instead of failing it. The submit still answers failed (the
     * frame was never accepted); only a host shutdown reports undelivered.
     */
    private parkWakeEntry(commandId: string, entry: PendingCommand, reason: string, message: string): void {
        const record = entry.wakeId ? this.wakes.get(entry.wakeId) : undefined;
        clearTimeout(entry.timer);
        this.pending.delete(commandId);
        if (record && (record.state === 'queued' || record.state === 'held')) record.state = 'held';
        entry.resolve(this.result(commandId, 'failed', reason, message));
    }

    disconnect(connection: ProducerConnection): void {
        for (const [commandId, entry] of [...this.pending]) {
            if (entry.connection !== connection) continue;
            if (entry.wakeId) {
                this.parkWakeEntry(commandId, entry, 'extension_disconnected', 'the session producer disconnected');
            } else {
                this.finishPending(commandId, 'failed', 'extension_disconnected', 'the session producer disconnected');
            }
        }
        for (const [sessionId, session] of this.sessions) {
            if (session.connection !== connection) continue;
            session.connection = null;
            // Presence-only sessions stay (unchanged). A persistent producer
            // may re-register on a new connection and flush its parked
            // wakes; the session record itself goes away so dead sessions
            // never list. Only a host shutdown reports pending wakes as
            // undelivered; session end parks them for a restart (F2).
            if (!isPresenceOnly(session)) this.removeSession(sessionId, { revokeWakes: false });
        }
        this.refusedConnections.delete(connection);
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

    /**
     * Listener binding verdict for one session_identity frame (CORE-2432 R2/R6).
     * The listener identity is pid + sessionId + generation (R1). `adopt` keeps
     * the frame, `replace` adopts a newer generation, `handover` drains an
     * explicit takeover, `duplicate` refuses a second listener for one identity,
     * and `stale` refuses a compare-and-swap write on an older generation.
     */
    private checkListener(
        _sessionId: string,
        previous: LiveSession | null,
        identity: AgentSessionIdentity,
        connection: ProducerConnection,
    ): 'adopt' | 'replace' | 'handover' | 'duplicate' | 'stale' | 'winback' | 'legacy' {
        if (!previous) return 'adopt';
        // The same listener re-asserting over its own socket is always accepted.
        if (previous.connection === connection) return 'adopt';
        const stored = previous.identity;
        const incomingScoped =
            typeof identity.pid === 'number' && typeof identity.generation === 'number';
        const storedScoped = typeof stored.pid === 'number' && typeof stored.generation === 'number';
        // F3: a legacy frame (no pid+generation) never displaces a scoped binding.
        if (!incomingScoped && storedScoped) return 'legacy';
        if (incomingScoped && storedScoped) {
            if (identity.generation! < stored.generation!) return 'stale';
            if (identity.generation! > stored.generation!) {
                // F1: the pid this session just replaced does not win the
                // binding back by bumping its generation (ping-pong refusal).
                if (typeof identity.pid === 'number' && previous.replacedPids.has(identity.pid)) return 'winback';
                return 'replace';
            }
            // Equal generation on another connection: a re-assert after the old
            // socket went away adopts; two concurrent listeners for one identity
            // are refused, or drained explicitly under the handover policy.
            if (previous.connection === null) return 'adopt';
            if (identity.pid !== stored.pid) return 'duplicate';
            return this.duplicateListener === 'handover' ? 'handover' : 'duplicate';
        }
        return 'adopt';
    }

    /** F3: tell a refused producer why, on its own connection. */
    private notifyRefused(sessionId: string, connection: ProducerConnection, reason: string, generation?: number): void {
        const command: AgentCommandPayload = {
            type: 'listener_replaced',
            commandId: `lr-${++this.wakeCommandSeq}`,
            generation: generation ?? 1,
            reason,
        };
        try {
            connection.sendCommand(sessionId, command);
        } catch (error) {
            this.log(`refused listener for session ${sessionId} is unreachable: ${(error as Error).message}`);
        }
    }

    private notifyReplaced(
        sessionId: string,
        previousConnection: ProducerConnection,
        identity: AgentSessionIdentity,
        verdict: 'replace' | 'handover',
    ): void {
        const command: AgentCommandPayload = {
            type: 'listener_replaced',
            commandId: `lr-${++this.wakeCommandSeq}`,
            generation: identity.generation ?? 1,
            reason: verdict === 'handover' ? 'handover' : 'replaced_by_newer_generation',
        };
        try {
            previousConnection.sendCommand(sessionId, command);
        } catch (error) {
            this.log(`replaced listener for session ${sessionId} is unreachable: ${(error as Error).message}`);
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
        this.stopPromptStartTimer(session);
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
            case 'wake':
                // Client-submitted wakes route like abort (no turn-taking policy);
                // tracked delivery with a stable message id goes through wake().
                break;
            case 'listener_replaced':
                return reject('rejected', 'registry_originated', 'listener_replaced is sent by the registry, not by clients');
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
     * The class is fixed at tool_execution_start.
     */
    private toolOrigin(
        session: LiveSession,
        payload: Extract<AgentEventV1['payload'], { type: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end' }>,
    ): AgentToolOrigin {
        let origin = session.toolOrigins.get(payload.toolCallId);
        if (!origin) {
            origin =
                session.identity.runtime.name === 'claude'
                    ? classifyClaudeTool(payload.toolName)
                    : this.classifier.classifyPi(payload.toolName, payload.tool);
            if (payload.type !== 'tool_execution_end') session.toolOrigins.set(payload.toolCallId, origin);
        }
        if (payload.type === 'tool_execution_end') session.toolOrigins.delete(payload.toolCallId);
        return origin;
    }

    /** Fail every in-flight command; used on host shutdown. */
    close(): void {
        if (this.sweepTimer) clearInterval(this.sweepTimer);
        for (const commandId of [...this.pending.keys()]) {
            this.finishPending(commandId, 'failed', 'host_shutdown', 'the agent host is shutting down');
        }
        // R4: teardown revokes the binding and reports every pending wake as undelivered.
        for (const record of this.wakes.values()) {
            if (record.state === 'queued' || record.state === 'held') record.state = 'undelivered';
        }
        for (const session of this.sessions.values()) this.stopPromptStartTimer(session);
    }

    // --- wake contract (CORE-2432) --------------------------------------------------------

    /**
     * Wake one participant with a payload reference. Returns a stable message id
     * (R9: the same pair always computes the same id and is never sent twice)
     * and one delivery state: `queued` once the wake frame is sent and the
     * receiver has not answered yet, `held` while no live listener can take it,
     * `delivered` only after the receiver accepted (R3), `refused` when the
     * receiver rejected it, `undelivered` after teardown with the wake pending
     * (R4), `expired` past its TTL. Ambiguous participants throw naming every
     * candidate (R7); unknown participants are held until they register (R8).
     */
    wake(
        participant: string,
        payloadRef: string,
        opts: {
            ttlMs?: number;
            messageId?: string;
            from?: string;
            fromName?: string;
            fromSessionId?: string;
            replyTo?: string;
            notifyWhenIdle?: boolean;
        } = {},
    ): WakeResult {
        if (!participant || !participant.trim()) throw new Error('wake needs a participant');
        if (!payloadRef || !payloadRef.trim()) throw new Error('wake needs a payload reference');
        const now = Date.now();
        this.sweepWakes(now);
        // F5: a caller-supplied message id keys dedupe; otherwise the stable id does.
        let messageId: string;
        if (opts.messageId !== undefined) {
            messageId = opts.messageId.trim();
            if (!messageId || messageId.length > 128 || /[\u0000-\u001F\u007F]/.test(messageId)) {
                throw new Error('wake needs a valid message id');
            }
        } else {
            messageId = stableWakeMessageId(participant, payloadRef);
        }
        const existing = this.wakes.get(messageId);
        if (existing) {
            const state = wakeStateNow(existing, now);
            // F5: dedupe only while queued or held; a new wake after a
            // terminal state sends again under the same stable id.
            if (state === 'queued' || state === 'held') return { messageId, state };
            // CORE-2436 I5 (b): a caller-supplied id is an idempotency key
            // across terminal states. A retry with the same id after
            // delivered/refused/undelivered/expired returns the recorded
            // state and does not resend; a new id resends.
            if (existing.callerMessageId && opts.messageId !== undefined && opts.messageId.trim() === messageId) {
                return { messageId, state };
            }
            this.wakes.delete(messageId);
        }
        const record: WakeRecord = {
            messageId,
            participant,
            payloadRef,
            callerMessageId: opts.messageId !== undefined,
            ...(opts.from !== undefined ? { from: opts.from } : {}),
            ...(opts.fromName !== undefined ? { fromName: opts.fromName } : {}),
            ...(opts.fromSessionId !== undefined ? { fromSessionId: opts.fromSessionId } : {}),
            ...(opts.replyTo !== undefined ? { replyTo: opts.replyTo } : {}),
            ...(opts.notifyWhenIdle !== undefined ? { notifyWhenIdle: opts.notifyWhenIdle } : {}),
            sessionId: null,
            state: 'held',
            createdAt: now,
            expiresAt: now + (opts.ttlMs ?? this.wakeTtlMs),
            sendCount: 0,
        };
        const resolved = resolveWakeParticipant(this.wakeSessions(), participant);
        if (!resolved) {
            this.storeWake(record);
            return { messageId, state: wakeStateNow(record, now) };
        }
        record.sessionId = resolved.sessionId;
        this.storeWake(record);
        this.sendWake(record);
        return { messageId, state: wakeStateNow(record, now) };
    }

    /** Current state of one wake message; null when unknown. */
    wakeStatus(messageId: string): WakeResult | null {
        // Sweep here as well as in wake(): expiry (and its notice) must not
        // wait for the next send while a sender is polling for an answer.
        this.sweepWakes(Date.now());
        const record = this.wakes.get(messageId);
        return record ? { messageId, state: wakeStateNow(record) } : null;
    }

    /**
     * Resolve a participant to one live session id (R7/R8): exact sessionId,
     * exact sessionName, or exact work-item ref for cross-worktree resolution.
     * Throws naming every candidate when ambiguous; null when unknown.
     */
    resolveParticipant(participant: string): string | null {
        return resolveWakeParticipant(this.wakeSessions(), participant)?.sessionId ?? null;
    }

    private wakeSessions(): { sessionId: string; sessionName?: string; workItemRef?: string; lastActivityAt?: number }[] {
        return [...this.sessions.entries()].map(([sessionId, session]) => ({
            sessionId,
            sessionName: session.identity.sessionName,
            workItemRef: session.identity.workItem?.ref,
            lastActivityAt: session.lastActivityAt,
        }));
    }

    private storeWake(record: WakeRecord): void {
        // N1: notices never trigger eviction. They are the honesty
        // mechanism; evicting on their behalf re-selected the same victim
        // and recursed to a stack overflow on a full live mailbox. A notice
        // that arrives at a full map still stores; notices are transient
        // (TTL-bound) so the overflow is bounded.
        if (!record.notice) {
            if (record.state === 'queued' || record.state === 'held') {
                // CORE-2437 F5: per-receiver bound first, so one crowded receiver
                // never evicts another receiver's wakes.
                const key = this.wakeReceiverKey(record);
                if (this.countLiveForReceiver(key) >= MAX_LIVE_WAKES_PER_RECEIVER) {
                    this.evictForReceiver(key, Date.now());
                }
            }
            if (this.wakes.size >= MAX_WAKE_RECORDS) {
                const candidates = [...this.wakes.values()].filter((r) => !r.notice);
                const settled = candidates
                    .filter((r) => r.state !== 'queued' && r.state !== 'held')
                    .sort((a, b) => a.createdAt - b.createdAt);
                const victim =
                    settled[0] ??
                    candidates.filter((r) => r.state === 'queued' || r.state === 'held').sort((a, b) => a.createdAt - b.createdAt)[0];
                if (victim && victim.messageId !== record.messageId) {
                    // N1: delete FIRST, then notify. Posting before
                    // deleting re-selected the same victim and recursed.
                    // CORE-2437 bounded retention: settled records evict
                    // first; a live victim only drops under a full mailbox of
                    // live wakes. Either way the evicted sender is told.
                    this.wakes.delete(victim.messageId);
                    if (victim.state === 'queued' || victim.state === 'held') {
                        this.log(`mailbox full: evicted live wake ${victim.messageId} (${victim.state}) to store ${record.messageId}`);
                        this.postMailboxNotice(victim, Date.now(), 'undelivered');
                    }
                }
            }
        }
        this.wakes.set(record.messageId, record);
    }

    private sendWake(record: WakeRecord): void {
        if (record.sessionId === null) {
            record.state = 'held';
            return;
        }
        const session = this.sessions.get(record.sessionId);
        const connection = session?.connection ?? null;
        if (!session || !connection) {
            record.state = 'held';
            return;
        }
        const command: AgentCommandPayload = {
            type: 'wake',
            commandId: record.messageId,
            messageId: record.messageId,
            payloadRef: record.payloadRef,
            ...(record.from !== undefined ? { from: record.from } : {}),
            ...(record.fromName !== undefined ? { fromName: record.fromName } : {}),
            ...(record.fromSessionId !== undefined ? { fromSessionId: record.fromSessionId } : {}),
            ...(record.replyTo !== undefined ? { replyTo: record.replyTo } : {}),
            ...(record.notifyWhenIdle !== undefined ? { notifyWhenIdle: record.notifyWhenIdle } : {}),
        };
        if (this.pending.has(command.commandId)) return;
        record.state = 'queued';
        record.sendCount += 1;
        const timer = setTimeout(
            () => this.finishPending(command.commandId, 'failed', 'command_timeout', 'the session producer did not answer'),
            this.commandTimeoutMs,
        );
        timer.unref?.();
        this.pending.set(command.commandId, {
            sessionId: record.sessionId,
            connection,
            payload: command,
            timer,
            resolve: () => {},
            wakeId: record.messageId,
        });
        try {
            connection.sendCommand(record.sessionId, command);
        } catch (error) {
            this.finishPending(command.commandId, 'failed', 'send_failed', (error as Error).message);
        }
    }

    /** Deliver held wakes addressed to one session (on bind and on re-assert). */
    private flushWakes(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session || !session.connection) return;
        const now = Date.now();
        for (const record of this.wakes.values()) {
            if (record.state !== 'held' || now >= record.expiresAt) continue;
            let resolved: string | null = null;
            try {
                resolved = resolveWakeParticipant(this.wakeSessions(), record.participant)?.sessionId ?? null;
            } catch {
                continue; // Newly ambiguous: stays held until the operator disambiguates.
            }
            if (resolved !== sessionId) continue;
            record.sessionId = sessionId;
            this.sendWake(record);
        }
    }

    /** R4: teardown revokes the binding and reports every pending wake as undelivered. */
    private revokeWakes(sessionId: string, reason: string): void {
        for (const [commandId, entry] of [...this.pending]) {
            if (entry.sessionId === sessionId && entry.wakeId) {
                this.finishPending(commandId, 'failed', reason, 'the session ended before the wake was accepted');
            }
        }
        for (const record of this.wakes.values()) {
            if (record.sessionId === sessionId && (record.state === 'queued' || record.state === 'held')) {
                record.state = 'undelivered';
            }
        }
    }

    /**
     * R3/F7: a wake is delivered only after the receiver accepted. Rejected
     * maps to refused, except reason `held` (deferred while the session starts:
     * the wake stays held); any failure maps to undelivered.
     */
    private settleWake(messageId: string, status: SubmitResult['status'], reason?: string): void {
        const record = this.wakes.get(messageId);
        if (!record || record.state !== 'queued') return;
        if (status === 'accepted') record.state = 'delivered';
        else if (status === 'rejected' && reason === 'held') record.state = 'held';
        else if (status === 'rejected') record.state = 'refused';
        else record.state = 'undelivered';
    }

    /**
     * CORE-2437 mailbox: a queued or held wake past its TTL reads as
     * expired, and the sender hears about it exactly once through an
     * expired notice addressed to its session. The notice itself carries no
     * sender session, so its own expiry stays silent (no cascading
     * notices). Undelivered wakes never notify: the sender already saw the
     * undelivered state on its send.
     */
    private sweepWakes(now: number): void {
        for (const record of this.wakes.values()) {
            if ((record.state === 'queued' || record.state === 'held') && now >= record.expiresAt) {
                record.state = 'expired';
                this.postExpiryNotice(record, now);
            }
        }
    }

    /**
     * Host-originated notice to the sender of one dead wake (CORE-2437 F5):
     * `expired` when its TTL passed, `undelivered` when its receiver's
     * mailbox evicted it. The notice carries no sender session, so its own
     * expiry stays silent, and it is marked so the per-receiver cap never
     * counts it.
     */
    private postMailboxNotice(record: WakeRecord, now: number, kind: 'expired' | 'undelivered'): void {
        const sender = record.fromSessionId;
        if (!sender) return;
        const noticeId = stableWakeMessageId(`${kind}-notice:${record.messageId}`, record.participant);
        if (this.wakes.has(noticeId)) return;
        const resolved = resolveWakeParticipant(this.wakeSessions(), sender);
        const payloadRef =
            kind === 'expired'
                ? `[Cross-session delivery notice] Message ${record.messageId} to ${record.participant} expired before delivery.`
                : `[Cross-session delivery notice] Message ${record.messageId} to ${record.participant} was undelivered: the receiver's mailbox is full.`;
        const notice: WakeRecord = {
            messageId: noticeId,
            participant: sender,
            payloadRef,
            callerMessageId: false,
            // The dead message's addressee, for context: replying answers
            // them by name. No fromSessionId: a notice never threads a reply
            // and never notifies again when it expires itself.
            from: record.participant,
            fromName: record.participant,
            sessionId: resolved?.sessionId ?? null,
            state: 'held',
            createdAt: now,
            expiresAt: now + this.wakeTtlMs,
            sendCount: 0,
            notice: true,
        };
        this.storeWake(notice);
        if (resolved) this.sendWake(notice);
    }

    private postExpiryNotice(record: WakeRecord, now: number): void {
        this.postMailboxNotice(record, now, 'expired');
    }

    /**
     * Live-mailbox key (N3): the participant string, stable across a
     * receiver restart. A wake parked under a participant and later bound
     * to a session id shares the 64 cap. (One session addressed by both
     * id and name counts under two keys; exact-only addressing rarely
     * mixes both for the same peer.)
     */
    private wakeReceiverKey(record: WakeRecord): string {
        return record.participant;
    }

    /**
     * Evict the oldest live non-notice wake for one receiver when its
     * mailbox is full (CORE-2437 F5). The evicted sender gets an
     * undelivered notice, never silence.
     */
    private evictForReceiver(key: string, now: number): void {
        const oldest = [...this.wakes.values()]
            .filter((r) => !r.notice && (r.state === 'queued' || r.state === 'held') && this.wakeReceiverKey(r) === key)
            .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!oldest) return;
        this.log(`mailbox full for receiver ${key}: evicted live wake ${oldest.messageId}`);
        this.wakes.delete(oldest.messageId);
        this.postMailboxNotice(oldest, now, 'undelivered');
    }

    private countLiveForReceiver(key: string): number {
        let count = 0;
        for (const record of this.wakes.values()) {
            if (!record.notice && (record.state === 'queued' || record.state === 'held') && this.wakeReceiverKey(record) === key) {
                count += 1;
            }
        }
        return count;
    }

    private clearPromptPending(session: LiveSession): void {
        session.promptPending = null;
        this.stopPromptStartTimer(session);
    }

    private stopPromptStartTimer(session: LiveSession): void {
        if (session.promptStartTimer) clearTimeout(session.promptStartTimer);
        session.promptStartTimer = null;
    }

    /**
     * An accepted prompt that opens no Frame within the bound never started a run. The host frees
     * the session for the next prompt and reports the prompt as failed with a reason through a
     * host-originated command_result (the submit itself was already answered accepted).
     */
    private armPromptStart(sessionId: string, session: LiveSession, commandId: string): void {
        this.stopPromptStartTimer(session);
        const timer = setTimeout(() => {
            if (this.sessions.get(sessionId) !== session || session.promptPending !== commandId || session.frameOpen) return;
            this.clearPromptPending(session);
            const seconds = Math.round(this.promptStartTimeoutMs / 1000);
            this.log(`prompt ${commandId} for session ${sessionId} opened no Frame within ${seconds} s; failed as prompt_not_started`);
            const frame: AgentEventV1 = {
                schema: 'xtrm.agent-event.v1',
                seq: session.lastSeq,
                sessionId,
                at: Date.now(),
                payload: {
                    type: 'command_result',
                    commandId,
                    status: 'failed',
                    reason: 'prompt_not_started',
                    message: `the agent started no run for this prompt within ${seconds} s: an input handler handled it, or the agent refused it before the run (for example no model or no API key)`,
                },
            };
            for (const listener of this.listeners) listener(frame);
        }, this.promptStartTimeoutMs);
        timer.unref?.();
        session.promptStartTimer = timer;
    }

    private settleCommand(
        sessionId: string,
        commandId: string,
        status: 'accepted' | 'rejected' | 'failed',
        reason?: string,
        message?: string,
    ): void {
        const entry = this.pending.get(commandId);
        if (!entry || entry.sessionId !== sessionId) {
            // F7: a late acceptance for a held wake that was actually sent
            // still completes it as delivered.
            if (status === 'accepted') this.acceptHeldWake(sessionId, commandId);
            // CORE-2436 I5 review: a flush-time answer (grace or agent_start)
            // for a wake whose pending already settled on held still settles
            // the record: failed answers must report undelivered, never strand
            // the wake as held until expiry.
            else this.settleOrphanWake(sessionId, commandId, status, reason);
            return;
        }
        this.finishPending(commandId, status, reason, message);
    }

    /**
     * Settle a wake record from a command_result with no open pending (a
     * flush-time answer after the original pending settled on held).
     * Terminal records never move; queued/held ones follow the same mapping
     * as settleWake.
     */
    private settleOrphanWake(
        sessionId: string,
        commandId: string,
        status: 'accepted' | 'rejected' | 'failed',
        reason?: string,
    ): void {
        const record = this.wakes.get(commandId);
        if (!record || record.sessionId !== sessionId) return;
        if (record.state !== 'queued' && record.state !== 'held') return;
        if (status === 'rejected' && reason === 'held') record.state = 'held';
        else if (status === 'rejected') record.state = 'refused';
        else if (status === 'failed') record.state = 'undelivered';
    }

    private acceptHeldWake(sessionId: string, commandId: string): void {
        const record = this.wakes.get(commandId);
        if (
            record &&
            record.sessionId === sessionId &&
            record.sendCount > 0 &&
            (record.state === 'held' || record.state === 'queued')
        ) {
            record.state = 'delivered';
        }
    }

    private finishPending(commandId: string, status: SubmitResult['status'], reason?: string, message?: string): void {
        const entry = this.pending.get(commandId);
        if (!entry) return;
        this.pending.delete(commandId);
        clearTimeout(entry.timer);
        if (entry.wakeId) this.settleWake(entry.wakeId, status, reason);

        const session = this.sessions.get(entry.sessionId);
        if (session) {
            const { payload } = entry;
            if (payload.type === 'prompt' && session.promptPending === commandId) {
                if (status !== 'accepted') this.clearPromptPending(session);
                else if (!session.frameOpen) this.armPromptStart(entry.sessionId, session, commandId);
            }
            if (payload.type === 'abort' && status === 'accepted' && !session.frameOpen) {
                this.clearPromptPending(session);
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

    /**
     * Drop one session record. `revokeWakes: false` keeps the session's
     * queued/held wakes parked for a receiver restart (CORE-2437 mailbox,
     * transport loss); the default revokes them as undelivered for a real
     * session end (R4 teardown via session_shutdown).
     */
    private removeSession(sessionId: string, opts: { revokeWakes?: boolean } = {}): void {
        if (opts.revokeWakes ?? true) this.revokeWakes(sessionId, 'session_ended');
        for (const [commandId, entry] of [...this.pending]) {
            if (entry.sessionId !== sessionId) continue;
            // CORE-2437 F2: without revocation the wake parks as held for a
            // receiver restart; the submit still answers failed.
            if (entry.wakeId && !(opts.revokeWakes ?? true)) {
                this.parkWakeEntry(commandId, entry, 'session_ended', 'the session ended');
            } else {
                this.finishPending(commandId, 'failed', 'session_ended', 'the session ended');
            }
        }
        const session = this.sessions.get(sessionId);
        if (session) this.stopPromptStartTimer(session);
        this.sessions.delete(sessionId);
    }

    /** First registration time per session id, bounded (oldest evicted first). */
    private readonly startedAtBySession = new Map<string, number>();

    private rememberStartedAt(sessionId: string, startedAt: number): void {
        if (this.startedAtBySession.has(sessionId)) return;
        this.startedAtBySession.set(sessionId, startedAt);
        while (this.startedAtBySession.size > MAX_REMEMBERED_STARTS) {
            const oldest = this.startedAtBySession.keys().next().value;
            if (oldest === undefined) break;
            this.startedAtBySession.delete(oldest);
        }
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

/** `pid/generation` listener identity for loud duplicate/stale refusal logs (R1, R2). */
function describeListener(identity: AgentSessionIdentity): string {
    return `pid ${identity.pid ?? '?'} generation ${identity.generation ?? '?'}`;
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

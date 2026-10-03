// Hand-authored TypeScript types mirroring the JSON Schemas under ../schemas.
// The JSON Schema files are the source of truth; these mirror them for
// consumers who want compile-time shapes. Keep them in sync when a schema
// changes (the fixture test guards the schema<->fixture agreement, not this).

/** Canonical schema ids shipped by this package. */
export const SCHEMA_ID = {
    runtimeCompatibility: 'xtrm.runtime-compatibility.v1',
    interactiveRoleEnvelope: 'xtrm.interactive-role-envelope.v1',
    piExtensionManifest: 'xtrm.pi-extension-manifest.v1',
    commandDeprecations: 'xtrm.command-deprecations.v1',
    commandOutcome: 'xtrm.command-outcome.v1',
    runtimeMatrix: 'xtrm.runtime-matrix.v1',
    runtimeOrigin: 'xtrm.runtime-origin.v1',
    branchIntegration: 'xtrm.branch.integration.v1',
    beadsLifecycleEvent: 'xtrm.beads.lifecycle-event.v1',
    xtmuxTopology: 'xtrm.xtmux.topology.v1',
    xtmuxMessage: 'xtrm.xtmux.message.v1',
    xtmuxObligation: 'xtrm.xtmux.obligation.v1',
    xtmuxMonitor: 'xtrm.xtmux.monitor.v1',
    xtmuxWait: 'xtrm.xtmux.wait.v1',
    xtmuxBridge: 'xtrm.xtmux.bridge.v1',
    agentRoleLaunched: 'xtrm.agent-role-launched.v1',
    specialistRoleEnvelope: 'xtrm.specialist-role-envelope.v1',
    topologyProjection: 'xtrm.topology.projection.v1',
    agentEvent: 'xtrm.agent-event.v1',
    agentCommand: 'xtrm.agent-command.v1',
    agentHostApi: 'xtrm.agent-host-api.v1',
} as const;

export type SchemaId = (typeof SCHEMA_ID)[keyof typeof SCHEMA_ID];

// --- xtrm.runtime-compatibility.v1 ---
export interface RuntimeCompatibilityV1 {
    schema_version: 'xtrm.runtime-compatibility.v1';
    notes?: string[];
    core: {
        package: string;
        requires: { specialists: string; xtmux: string; node: string; [dep: string]: string };
    };
    contracts: Record<string, string>;
}

// --- xtrm.interactive-role-envelope.v1 ---
export interface InteractiveRoleEnvelopeV1 {
    role: string;
    systemPrompt: string;
    skillPaths: string[];
    model?: string;
    thinkingLevel?: string;
}

// --- xtrm.pi-extension-manifest.v1 ---
export interface PiExtensionManifestV1 {
    schema_version: 'xtrm.pi-extension-manifest.v1';
    active: Array<{ id: string; displayName: string; required: boolean; ownership?: string }>;
    disabled: Record<string, string>;
}

// --- xtrm.command-deprecations.v1 ---
export interface CommandDeprecationEntry {
    command: string;
    deprecated_since: string;
    remove_in: string;
    replacement: string;
    behavior: 'execute-with-warning' | 'fail-with-redirect';
    code_ref: string;
    notes?: string;
}
export interface CommandDeprecationsV1 {
    schema_version: 'xtrm.command-deprecations.v1';
    notes?: string[];
    entries: CommandDeprecationEntry[];
}

// --- xtrm.command-outcome.v1 ---
export type CommandOutcomeStatus = 'ok' | 'degraded' | 'noop' | 'rejected' | 'failed';
export interface CommandOutcomeAction {
    kind: 'attach' | 'resume' | 'repair' | 'end' | 'wait' | 'inspect';
    required: boolean;
    argv: string[];
    display: string;
    cwd?: string;
    why: string;
}
export interface CommandOutcomeV1 {
    schema_version: 'xtrm.command-outcome.v1';
    status: CommandOutcomeStatus;
    reason_code: string;
    summary: string;
    runtime?: { name: 'pi' | 'claude' | 'codex'; version: string | null };
    identity?: {
        thread_id: string | null;
        session_name: string | null;
        tmux_session_id: string | null;
        pane_id: string | null;
    };
    worktree?: { path: string; branch: string; owner: 'core' };
    readiness?: { status: 'ready' | 'unverified' | 'not_ready'; source: 'agent.ready' | 'tmux-pane' | 'none' };
    safety_profile?: { name: string; sandbox: string; approvals: string; hook_trust: 'preserved' };
    persistence?: { completed: boolean; kind: string };
    authoritative_mutation: { completed: boolean; kind: string };
    side_effects: Array<{ kind: string; status: 'ok' | 'degraded' | 'failed' | 'skipped'; id?: string | null }>;
    next_actions: CommandOutcomeAction[];
}

// --- xtrm.runtime-matrix.v1 ---
export interface RuntimeMatrixRepoBlock {
    primary_runtime: 'node' | 'bun';
    minimum?: string;
    bun_minimum?: string;
    node_minimum?: string | null;
    node_usage?: string[];
    bun_usage?: string[];
    notes?: string;
}
export interface RuntimeMatrixV1 {
    schema_version: 'xtrm.runtime-matrix.v1';
    core: RuntimeMatrixRepoBlock;
    xtmux: RuntimeMatrixRepoBlock;
    specialists: RuntimeMatrixRepoBlock;
    consumers: Array<{ workflow: string; repo: string; runtime: string }>;
}

// --- xtrm.runtime-origin.v1 ---
export interface RuntimeOriginV1 {
    schema_version: 'xtrm.runtime-origin.v1';
    kind: 'xtmux.agent_instance';
    host_id: string;
    tmux_server_id?: string;
    tmux_session_id: string;
    tmux_window_id: string;
    tmux_pane_id: string;
    agent_instance_id?: string;
    bead_id?: string;
    parent_session_id?: string;
    captured_at_ms: number;
    capture_source: 'xtmux-context' | 'propagated';
    verified: boolean;
}

// --- xtrm.branch.integration.v1 ---
export interface BranchIntegrationV1 {
    schema_version: 'xtrm.branch.integration.v1';
    timestamp: string;
    t_unix_ms: number;
    source: { job_id: string; branch: string; worktree: string };
    target: { branch: string; worktree: string; role?: string };
    status: 'merged';
    commit: string;
}

// --- xtrm.beads.lifecycle-event.v1 ---
export type BeadsLifecycleEventType = 'created' | 'claimed' | 'updated' | 'closed' | 'reopened' | 'status_changed';
export interface BeadsLifecycleEventV1 {
    schema_version: 'xtrm.beads.lifecycle-event.v1';
    source: 'beads.events';
    id: string;
    issue_id: string;
    event_type: BeadsLifecycleEventType;
    actor: string;
    old_value: unknown;
    new_value: unknown;
    comment: string | null;
    created_at: string;
    occurred_at_ms: number;
    timestamp_source: 'uuidv7';
}

// --- xtrm.xtmux.topology.v1 ---
export interface XtmuxTopologyAgent {
    instance_id?: string;
    state?: string;
    bead_id?: string;
    task?: string;
    prompt_file?: string;
    parent_session_id?: string;
    last_transition?: string;
}
export interface XtmuxTopologyPane {
    pane_id: string;
    pane_index: number;
    active: boolean;
    width: number;
    height: number;
    left: number;
    top: number;
    pid: number;
    current_command: string;
    current_path: string;
    agent?: XtmuxTopologyAgent;
}
export interface XtmuxTopologyWindow {
    window_id: string;
    window_index: number;
    name: string;
    active: boolean;
    panes: XtmuxTopologyPane[];
}
export interface XtmuxTopologySession {
    session_id: string;
    name: string;
    created_at_ms: number;
    activity_at_ms: number;
    attached: boolean;
    active: boolean;
    windows: XtmuxTopologyWindow[];
}
export interface XtmuxTopologyV1 {
    schema_version: 'xtrm.xtmux.topology.v1';
    generated_at_ms: number;
    host: { host_id: string; tmux_server_id: string };
    sessions: XtmuxTopologySession[];
}

// --- xtrm.xtmux.message.v1 ---
export type XtmuxReplyStatus = 'pending' | 'fulfilled' | 'cancelled' | null;
export interface XtmuxCorrelatedReply {
    messageKey: string;
    senderId: string;
    senderPaneId?: string | null;
    recipientId: string;
    targetPaneId?: string | null;
    summary: string;
    createdAtMs: number;
}
export interface XtmuxMessageV1 {
    messageKey: string;
    senderId: string;
    recipientId: string;
    messageId?: number;
    duplicate?: boolean;
    senderPaneId?: string | null;
    senderKind?: string;
    targetPaneId?: string | null;
    recipientKind?: string;
    beadId?: string | null;
    summary?: string;
    createdAtMs?: number | null;
    expectsReply?: boolean;
    acked?: boolean;
    ackedAtMs?: number | null;
    ackedBy?: string | null;
    replyStatus?: XtmuxReplyStatus;
    fulfilledAtMs?: number | null;
    fulfilledByMessageKey?: string | null;
    replyToMessageKey?: string;
    fulfilledMessageKey?: string;
    fulfilled?: boolean;
    correlatedReply?: XtmuxCorrelatedReply | null;
}

// --- xtrm.xtmux.obligation.v1 ---
export interface XtmuxObligationV1 {
    messageKey: string;
    messageId: number;
    senderId: string;
    senderPaneId: string | null;
    recipientId: string;
    targetPaneId: string | null;
    summary: string;
    createdAtMs: number;
    acked: boolean;
    ackedAtMs: number | null;
    replyStatus: 'pending';
}

// --- xtrm.xtmux.monitor.v1 ---
export interface XtmuxMonitorV1 {
    monitorId: string;
    target: string;
    sessionId: string;
    paneId: string;
    state: string;
    startedAtMs: number;
    updatedAtMs: number;
    timeoutMs: number;
    intervalMs: number;
    wakeDelivered: boolean;
    wakeConsumed: boolean;
    orphan: boolean;
    waitId?: string;
    requesterSessionId?: string | null;
    requesterPaneId?: string | null;
    terminalStatus?: string | null;
    terminalAtMs?: number | null;
}

// --- xtrm.xtmux.wait.v1 ---
export interface XtmuxWaitV1 {
    waitId: string;
    target: string;
    requesterSessionId: string;
    requesterPaneId: string;
    targetSessionId: string;
    targetPaneId: string;
    state: string;
    wakeDelivered: boolean;
    wakeConsumed: boolean;
    replayed: boolean;
    startedAtMs: number;
    monitorId?: string | null;
    terminalStatus?: string | null;
    completedAtMs?: number | null;
    timeoutMs?: number | null;
    intervalMs?: null;
}

// --- xtrm.xtmux.bridge.v1 ---
export interface XtmuxBridgeRequest {
    id: string | number;
    method:
        | 'bridge.hello'
        | 'bridge.cancel'
        | 'topology.snapshot'
        | 'journal.query'
        | 'journal.follow'
        | 'pane.capture'
        | 'health.get';
    params?: Record<string, unknown>;
}
export interface XtmuxBridgeSuccess {
    id: string | number | null;
    result: Record<string, unknown>;
}
export interface XtmuxBridgeError {
    id: string | number | null;
    error: { code: string; message: string; detail?: Record<string, unknown> };
}
export type XtmuxBridgeV1 = XtmuxBridgeRequest | XtmuxBridgeSuccess | XtmuxBridgeError;

// --- xtrm.agent-role-launched.v1 (loose k=v field bag) ---
export interface AgentRoleLaunchedV1 {
    instance_id?: string;
    instance?: string;
    session?: string;
    session_id?: string;
    session_name?: string;
    pane?: string;
    pane_id?: string;
    runtime?: string;
    role?: string;
    bead?: string;
    bead_id?: string;
    task?: string;
    prompt_file?: string;
    parent?: string;
    parent_session?: string;
    [key: string]: string | undefined;
}

// --- xtrm.specialist-role-envelope.v1 (legacy "1", passthrough/open) ---
export interface SpecialistRoleEnvelopeV1 {
    specialist: {
        metadata: {
            name: string;
            version: string;
            description: string;
            category: string;
            [key: string]: unknown;
        };
        execution: { model: string | null; [key: string]: unknown };
        prompt: { task_template: string; [key: string]: unknown };
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

/** Map from schema id to its TypeScript payload type. */
// --- xtrm.topology.projection.v1 ---
/**
 * Owning system behind one projection source. Each maps to one published
 * read-only CLI surface; Core never reads another repo's database directly.
 */
export type TopologySourceName = 'xtmux' | 'tmux' | 'specialists' | 'beads' | 'git' | 'github';
/**
 * `unavailable` (binary absent) vs `error` (present but failed) is a load-bearing
 * distinction: only the latter is a bug signal.
 */
export type TopologySourceStatus = 'ok' | 'unavailable' | 'error';
export interface TopologySource {
    name: TopologySourceName;
    status: TopologySourceStatus;
    reason: string | null;
    duration_ms: number;
}
/** Lineage published by Core's launcher as `@agent_*` pane options (PR #465). */
export interface TopologyPaneAgent {
    /** Runtime lifecycle signal — never a completion signal. */
    state: string | null;
    /** `@agent_role` (audit P2-03); `task` keeps the legacy `role:<name>` encoding. */
    role: string | null;
    task: string | null;
    bead_id: string | null;
    worktree: string | null;
    /** For a coordinator pane, also the integration target its chains derive from. */
    branch: string | null;
    parent_session_id: string | null;
    parent_pane_id?: string | null;
    instance_id?: string | null;
}
export interface TopologyJob {
    job_id: string;
    specialist: string;
    /** Specialists-owned vocabulary, passed through unreinterpreted. */
    status: string;
    bead_id: string | null;
    epic_id?: string | null;
    chain_id?: string | null;
    chain_root_job_id?: string | null;
    is_chain_root: boolean;
    branch: string | null;
    worktree_path: string | null;
    pull_request?: TopologyPullRequest | null;
    integration_target_branch?: string | null;
    started_at_ms?: number | null;
    owning_pane_id?: string | null;
}
export interface TopologyBead {
    id: string;
    /** One of the two authoritative completion signals (with `merged_at`). */
    status: string;
    title?: string | null;
    issue_type?: string | null;
    priority?: number | null;
    parent_id?: string | null;
}
export interface TopologyWorktree {
    path: string;
    branch: string | null;
    head_sha: string | null;
    detached: boolean;
    /** Length > 1 is a worktree collision. */
    shared_by_pane_ids?: string[];
}
export interface TopologyPullRequest {
    number: number;
    state: string;
    url?: string | null;
    title?: string | null;
    head_branch: string;
    base_branch?: string | null;
    is_draft?: boolean | null;
    /** Authoritative completion signal. */
    merged_at?: string | null;
    checks_state?: string | null;
}
export interface TopologyPane {
    pane_id: string;
    session_id: string;
    session_name: string;
    window_id?: string | null;
    current_command: string;
    current_path: string;
    /** Null for a pane that is not an xtrm-launched agent. */
    agent: TopologyPaneAgent | null;
    jobs: TopologyJob[];
    bead: TopologyBead | null;
    worktree: TopologyWorktree | null;
    pull_request: TopologyPullRequest | null;
}
/**
 * A read-only snapshot, recomputed per invocation from live sources. Nothing here
 * is cached, materialized or written back, and no field is authoritative over its
 * source. There is deliberately no pane-capture/preview/output field at any level.
 */
export interface TopologyProjectionV1 {
    schema_version: 'xtrm.topology.projection.v1';
    generated_at_ms: number;
    host: { host_id: string; tmux_server_id?: string | null };
    sources: TopologySource[];
    panes: TopologyPane[];
    /** Facts belonging to no live pane — the leak an operator needs to see. */
    orphans: { jobs: TopologyJob[]; worktrees: TopologyWorktree[] };
}

// --- agent host protocol: xtrm.agent-event.v1 / xtrm.agent-command.v1 / xtrm.agent-host-api.v1 ---
// PRD xtrm-app §35.3, §35.8 item 1, §36.7. Event payloads mirror the Pi 1.0.0 extension
// lifecycle events; Pi-native objects (messages, tool args/results) stay opaque.

/** Every NDJSON frame on the extension <-> agent host socket. */
export interface AgentProtocolFrame<S extends string, P> {
    schema: S;
    /** Per-connection monotonically increasing frame number, starting at 0. */
    seq: number;
    sessionId: string;
    /** UTC epoch milliseconds. */
    at: number;
    payload: P;
}

/** Pi AgentMessage, passed through unchanged. */
export interface AgentMessagePassthrough {
    role: string;
    [key: string]: unknown;
}
export interface AgentImageContent {
    type: 'image';
    data: string;
    mimeType: string;
}
export interface AgentWorkItem {
    ref: string;
    project?: string;
    system?: 'substrate' | 'beads';
}
export interface AgentTmuxTarget {
    session: string;
    paneId: string;
}
export type AgentCapability = 'presence' | 'stream' | 'prompt' | 'steer' | 'follow_up' | 'abort' | 'extension_ui';

/** Raw tool registration source from pi.getAllTools() (ToolInfo.sourceInfo / namespace). */
export interface AgentToolSource {
    sourceInfo: {
        path: string;
        source: string;
        scope: 'user' | 'project' | 'temporary';
        origin: 'package' | 'top-level';
        baseDir?: string;
    };
    namespace?: { name: string; description?: string };
}
/** PRD §36.7 tool origin; filled once the classification rule lands (XTRM-559 / XTRM-571). */
export interface AgentToolOrigin {
    class: 'native' | 'mcp' | 'extension' | 'coordination';
    server?: string;
    transport?: string;
    extension?: string;
    version?: string;
}
interface AgentToolExecutionBase {
    toolCallId: string;
    toolName: string;
    parentToolCallId?: string;
    tool?: AgentToolSource;
    origin?: AgentToolOrigin;
}
export type CompactionReason = 'manual' | 'threshold' | 'overflow';

export interface AgentSessionIdentity {
    type: 'session_identity';
    runtime: { name: 'pi' | 'claude' | 'codex'; version: string | null };
    producer?: { name: string; version: string };
    sessionFile?: string;
    sessionName?: string;
    cwd: string;
    worktree?: string;
    branch?: string;
    role?: string;
    workItem?: AgentWorkItem;
    parentSessionId?: string;
    tmux?: AgentTmuxTarget;
    launch?: 'gui' | 'terminal';
    capabilities: AgentCapability[];
}

export type AgentEventPayload =
    | AgentSessionIdentity
    | { type: 'session_start'; reason: 'startup' | 'reload' | 'new' | 'resume' | 'fork'; previousSessionFile?: string }
    | {
          type: 'before_agent_start';
          prompt: string;
          images?: AgentImageContent[];
          ingress: { origin: 'gui' | 'terminal'; commandId?: string };
      }
    | { type: 'agent_start' }
    | { type: 'turn_start'; turnIndex: number; timestamp: number }
    | {
          type: 'turn_end';
          turnIndex: number;
          message: AgentMessagePassthrough;
          toolResults: AgentMessagePassthrough[];
          messageEntryId?: string;
          toolResultEntryIds?: string[];
      }
    | { type: 'message_start'; message: AgentMessagePassthrough }
    | {
          type: 'message_update';
          message: AgentMessagePassthrough;
          assistantMessageEvent: { type: string; [key: string]: unknown };
      }
    | { type: 'message_end'; message: AgentMessagePassthrough }
    | (AgentToolExecutionBase & { type: 'tool_execution_start'; args: unknown })
    | (AgentToolExecutionBase & { type: 'tool_execution_update'; args: unknown; partialResult: unknown })
    | (AgentToolExecutionBase & { type: 'tool_execution_end'; result: unknown; isError: boolean })
    /** willRetry is filled only by RPC / in-process producers; Pi extensions cannot see it. */
    | { type: 'agent_end'; messages: AgentMessagePassthrough[]; willRetry?: boolean }
    /** Authoritative Frame-close signal. */
    | { type: 'agent_settled' }
    | {
          type: 'session_compact';
          reason: CompactionReason;
          willRetry: boolean;
          fromExtension: boolean;
          compactionEntryId?: string;
      }
    | {
          type: 'session_compact_failed';
          reason: CompactionReason;
          willRetry: boolean;
          aborted: boolean;
          fromExtension: boolean;
          errorMessage?: string;
      }
    | {
          type: 'extension_ui_request';
          id: string;
          method: 'select' | 'confirm' | 'input' | 'editor';
          title: string;
          message?: string;
          options?: string[];
          placeholder?: string;
          prefill?: string;
          timeout?: number;
      }
    | { type: 'extension_ui_resolved'; id: string; resolvedBy: 'local' | 'host'; outcome: 'answered' | 'cancelled' }
    | {
          type: 'command_result';
          commandId: string;
          status: 'accepted' | 'rejected' | 'failed';
          reason?: string;
          message?: string;
      }
    | { type: 'session_shutdown'; reason: 'quit' | 'reload' | 'new' | 'resume' | 'fork'; targetSessionFile?: string };

export type AgentEventType = AgentEventPayload['type'];
export type AgentEventV1 = AgentProtocolFrame<'xtrm.agent-event.v1', AgentEventPayload>;

export type AgentCommandPayload =
    | { type: 'prompt'; commandId: string; message: string; images?: AgentImageContent[] }
    | { type: 'steer'; commandId: string; message: string; images?: AgentImageContent[] }
    | { type: 'follow_up'; commandId: string; message: string; images?: AgentImageContent[] }
    | { type: 'abort'; commandId: string }
    /** Exactly one of value / confirmed / cancelled (Pi RpcExtensionUIResponse); id = request id. */
    | { type: 'extension_ui_response'; commandId: string; id: string; value: string }
    | { type: 'extension_ui_response'; commandId: string; id: string; confirmed: boolean }
    | { type: 'extension_ui_response'; commandId: string; id: string; cancelled: true };

export type AgentCommandType = AgentCommandPayload['type'];
export type AgentCommandV1 = AgentProtocolFrame<'xtrm.agent-command.v1', AgentCommandPayload>;

export interface AgentSessionSummary {
    sessionId: string;
    provider: 'pi' | 'claude' | 'codex';
    state: 'working' | 'waiting_for_input' | 'settled' | 'failed' | 'history_only';
    name?: string;
    cwd: string;
    repository?: string;
    worktree?: string;
    branch?: string;
    role?: string;
    workItem?: AgentWorkItem;
    parentSessionId?: string;
    childCount?: number;
    tmux?: AgentTmuxTarget;
    launch?: 'gui' | 'terminal';
    extensionConnected: boolean;
    capabilities: AgentCapability[];
    model?: string;
    thinkingLevel?: string;
    contextUsage?: { tokens: number; contextWindow: number };
    frameCount?: number;
    startedAt?: number;
    lastActivityAt?: number;
    sessionFile?: string;
}
export type ContextReferenceKind =
    | 'issue'
    | 'epic'
    | 'gh-issue'
    | 'pr'
    | 'commit'
    | 'file'
    | 'session'
    | 'agent'
    | 'frame'
    | 'artifact'
    | 'program'
    | 'chain';
export interface ContextReference {
    kind: ContextReferenceKind;
    raw: string;
    status: 'resolved' | 'unresolved';
    title?: string;
    revision?: string;
    content?: string;
    truncated?: boolean;
    pointer?: string;
    bytes?: number;
    budgetBytes?: number;
    error?: string;
}

type HostApi<K extends string, B> = { schema: 'xtrm.agent-host-api.v1'; kind: K } & B;
export type AgentHostApiV1 =
    | HostApi<'session_list', { sessions: AgentSessionSummary[]; nextCursor?: string }>
    | HostApi<'session_detail', { session: AgentSessionSummary; identity?: AgentSessionIdentity; lastSeq?: number }>
    | HostApi<'event', { cursor: string; frame: AgentEventV1 }>
    | HostApi<'submit_request', { sessionId: string; command: AgentCommandPayload; references?: ContextReference[] }>
    | HostApi<
          'submit_result',
          {
              commandId: string;
              status: 'accepted' | 'busy' | 'rejected' | 'not_found' | 'unsupported' | 'failed';
              reason?: string;
              message?: string;
          }
      >
    | HostApi<
          'launch_request',
          {
              cwd: string;
              command: 'pi' | 'xt pi';
              options?: {
                  name?: string;
                  role?: string;
                  bead?: string;
                  model?: string;
                  thinking?: string;
                  skills?: string[];
                  prompt?: string;
                  parent?: string;
                  child?: boolean;
              };
          }
      >
    | HostApi<'launch_result', { outcome: CommandOutcomeV1; tmux?: AgentTmuxTarget }>
    | HostApi<'reference_resolve_request', { sessionId?: string; references: string[] }>
    | HostApi<'reference_resolve_result', { references: ContextReference[]; totalBytes: number; overBudget?: boolean }>
    | HostApi<'error', { code: string; message: string }>;

export type AgentHostApiKind = AgentHostApiV1['kind'];

export interface ContractTypeMap {
    'xtrm.runtime-compatibility.v1': RuntimeCompatibilityV1;
    'xtrm.interactive-role-envelope.v1': InteractiveRoleEnvelopeV1;
    'xtrm.pi-extension-manifest.v1': PiExtensionManifestV1;
    'xtrm.command-deprecations.v1': CommandDeprecationsV1;
    'xtrm.command-outcome.v1': CommandOutcomeV1;
    'xtrm.runtime-matrix.v1': RuntimeMatrixV1;
    'xtrm.runtime-origin.v1': RuntimeOriginV1;
    'xtrm.branch.integration.v1': BranchIntegrationV1;
    'xtrm.beads.lifecycle-event.v1': BeadsLifecycleEventV1;
    'xtrm.xtmux.topology.v1': XtmuxTopologyV1;
    'xtrm.xtmux.message.v1': XtmuxMessageV1;
    'xtrm.xtmux.obligation.v1': XtmuxObligationV1;
    'xtrm.xtmux.monitor.v1': XtmuxMonitorV1;
    'xtrm.xtmux.wait.v1': XtmuxWaitV1;
    'xtrm.xtmux.bridge.v1': XtmuxBridgeV1;
    'xtrm.agent-role-launched.v1': AgentRoleLaunchedV1;
    'xtrm.specialist-role-envelope.v1': SpecialistRoleEnvelopeV1;
    'xtrm.topology.projection.v1': TopologyProjectionV1;
    'xtrm.agent-event.v1': AgentEventV1;
    'xtrm.agent-command.v1': AgentCommandV1;
    'xtrm.agent-host-api.v1': AgentHostApiV1;
}

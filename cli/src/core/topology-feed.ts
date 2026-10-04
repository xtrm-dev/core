/**
 * Live topology feed for the agent host (XTRM-629).
 *
 * One feed per host serves every client: a refresh runs one `tmux list-panes -a`
 * pass, joins it with cached enrichment (topology-projection.ts), and broadcasts
 * the resulting message as one serialized string. Clients receive a
 * `topology_snapshot` first, then `topology_update` diffs, or a snapshot when a
 * diff would exceed the size cap. Identical projections are never resent.
 *
 * Events come from one tmux control-mode observer client: read-only (`-r`, it
 * cannot send input), `ignore-size` (it never resizes a window) and `no-output`
 * (no pane bytes cross the pipe). Its only command is one `refresh-client -B`
 * subscription, which reports @agent_state, the running command and the cwd of
 * every pane. Without it (no session yet, old tmux, crash) the feed polls every
 * 2 s; with it, a 10 s poll is the safety net. The feed is idle with no subscriber.
 *
 * Nothing here changes tmux, the registry or any source; the projection stays
 * read-only by construction.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { diffTopology, TOPOLOGY_FEED_VERSION } from '@xtrm/contracts';
import type { AgentHostApiV1, TopologyAgentSession, TopologyProjectionV1 } from '@xtrm/contracts';
import {
    collectEnrichment,
    defaultRunner,
    enrichmentKeys,
    joinProjection,
    readPanes,
    type CommandRunner,
    type RawPane,
    type TopologyEnrichment,
} from './topology-projection.js';

export type TopologySnapshotMessage = Extract<AgentHostApiV1, { kind: 'topology_snapshot' }>;
export type TopologyUpdateMessage = Extract<AgentHostApiV1, { kind: 'topology_update' }>;
export type TopologyFeedMessage = TopologySnapshotMessage | TopologyUpdateMessage;

/** An update over this many bytes is replaced by a full snapshot. */
export const TOPOLOGY_UPDATE_MAX_BYTES = 64 * 1024;
/** A snapshot over this many bytes drops its orphans and is marked truncated. */
export const TOPOLOGY_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

const SUBSCRIPTION = 'xtrm-topology';
/**
 * The control client's argv (after the server selector) and its one stdin
 * command. Declared here, and asserted by the test suite, for the same reason as
 * READ_ONLY_COMMANDS: the observer's read-only shape is a property of the code.
 */
export const TMUX_CONTROL = {
    attach: ['-C', 'attach-session', '-r', '-f', 'ignore-size,no-output,no-detach-on-destroy', '-t'],
    subscribe: `refresh-client -B '${SUBSCRIPTION}:%*:#{@agent_state}|#{pane_current_command}|#{pane_current_path}'`,
} as const;

/** Control-mode notifications that can change the projection. */
const TRIGGERS = /^%(?:window-|session|sessions-changed|layout-change|unlinked-window-|subscription-changed|pane-mode-changed)/;

export interface TopologyFeedOptions {
    runner?: CommandRunner;
    /** Server selector prepended to every tmux argv, e.g. ['-L', name]. Default: the inherited server. */
    tmuxArgs?: string[];
    /** Live agent host sessions by pane id. */
    agentSessions?: () => ReadonlyMap<string, TopologyAgentSession>;
    includeGithub?: boolean;
    cwd?: string;
    /** Enrichment older than this is refreshed in the background. */
    enrichmentTtlMs?: number;
    /** Poll interval while the control client is unavailable. Never below 2 s. */
    fallbackPollMs?: number;
    /** Poll interval while the control client is up. */
    safetyPollMs?: number;
    /** Minimum gap between two refreshes; bursts collapse into one trailing refresh. */
    minRefreshIntervalMs?: number;
    /** Use the tmux control client. Default true. */
    controlClient?: boolean;
    log?: (message: string) => void;
    now?: () => number;
}

interface FeedState {
    projection: TopologyProjectionV1;
    revision: string;
    seq: number;
    snapshotText: string;
    at: number;
}

type Listener = (message: TopologyFeedMessage, text: string) => void;

/** Content hash without generated_at_ms and sources[].duration_ms, which change every pass. */
export function topologyRevision(projection: TopologyProjectionV1): string {
    const stable = {
        ...projection,
        generated_at_ms: 0,
        sources: projection.sources.map((source) => ({ ...source, duration_ms: 0 })),
    };
    return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

/** Serialize a snapshot, dropping orphans when the snapshot exceeds the cap. */
export function buildSnapshot(projection: TopologyProjectionV1, seq: number, revision: string): { message: TopologySnapshotMessage; text: string } {
    let message: TopologySnapshotMessage = {
        schema: 'xtrm.agent-host-api.v1', kind: 'topology_snapshot', topology: TOPOLOGY_FEED_VERSION, seq, revision, projection,
    };
    let text = JSON.stringify(message);
    if (Buffer.byteLength(text) > TOPOLOGY_SNAPSHOT_MAX_BYTES) {
        message = { ...message, truncated: true, projection: { ...projection, orphans: { jobs: [], worktrees: [] } } };
        text = JSON.stringify(message);
    }
    return { message, text };
}

/** The tmux server a process inside tmux talks to: the socket path in $TMUX. */
export function inheritedTmuxArgs(env: NodeJS.ProcessEnv = process.env): string[] {
    const socket = env.TMUX?.split(',')[0];
    return socket ? ['-S', socket] : [];
}

export class TopologyFeed {
    private readonly runner: CommandRunner;
    private readonly tmuxArgs: string[];
    private readonly now: () => number;
    private readonly log: (message: string) => void;
    private readonly enrichmentTtlMs: number;
    private readonly fallbackPollMs: number;
    private readonly safetyPollMs: number;
    private readonly minRefreshIntervalMs: number;

    private readonly listeners = new Set<Listener>();
    private latest: FeedState | null = null;
    private seq = -1;
    private enrichment: TopologyEnrichment | null = null;
    private enrichmentKey = '';
    private enrichedAt = 0;
    private enriching: Promise<void> | null = null;
    private refreshing: Promise<void> | null = null;
    private dirty = false;
    private lastRefreshAt = 0;
    private lastPanes: RawPane[] = [];
    private agentSignature = '';
    private agentCheck: NodeJS.Timeout | null = null;
    private pollTimer: NodeJS.Timeout | null = null;
    private control: ChildProcess | null = null;
    private controlUp = false;
    private restartTimer: NodeJS.Timeout | null = null;
    private restartDelayMs = 2_000;
    private closed = false;

    constructor(private readonly options: TopologyFeedOptions = {}) {
        this.tmuxArgs = options.tmuxArgs ?? inheritedTmuxArgs();
        const base = options.runner ?? defaultRunner;
        // Every tmux read goes to the same server as the control client.
        this.runner = this.tmuxArgs.length === 0
            ? base
            : (bin, args, opts) => base(bin, bin === 'tmux' ? [...this.tmuxArgs, ...args] : args, opts);
        this.now = options.now ?? (() => Date.now());
        this.log = options.log ?? (() => {});
        this.enrichmentTtlMs = options.enrichmentTtlMs ?? 10_000;
        this.fallbackPollMs = Math.max(2_000, options.fallbackPollMs ?? 2_000);
        this.safetyPollMs = Math.max(this.fallbackPollMs, options.safetyPollMs ?? 10_000);
        this.minRefreshIntervalMs = options.minRefreshIntervalMs ?? 100;
    }

    get subscriberCount(): number {
        return this.listeners.size;
    }

    get controlClientUp(): boolean {
        return this.controlUp;
    }

    /**
     * Add a subscriber. It receives the current snapshot synchronously when one
     * exists, otherwise the first snapshot as soon as it is computed, and every
     * later message in order. Returns the unsubscribe function.
     */
    subscribe(listener: Listener): () => void {
        if (this.closed) return () => {};
        this.listeners.add(listener);
        if (this.latest) {
            const { message, text } = this.snapshotOf(this.latest);
            listener(message, text);
        }
        if (this.listeners.size === 1) this.activate();
        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0) this.deactivate();
        };
    }

    /** The current snapshot for a pull client; reuses a result younger than 1 s. */
    async snapshot(): Promise<TopologySnapshotMessage> {
        if (!this.latest || this.now() - this.latest.at > 1_000) await this.refresh();
        return this.snapshotOf(this.latest!).message;
    }

    /**
     * Ask for a refresh. Leading edge: an idle feed refreshes at once (or after
     * the minimum gap); triggers during a refresh collapse into one trailing pass.
     */
    refresh(): Promise<void> {
        if (this.closed) return Promise.resolve();
        if (this.refreshing) {
            this.dirty = true;
            return this.refreshing;
        }
        this.refreshing = (async () => {
            const wait = this.lastRefreshAt + this.minRefreshIntervalMs - this.now();
            if (wait > 0) await sleep(wait);
            do {
                this.dirty = false;
                this.lastRefreshAt = this.now();
                await this.runOnce();
            } while (this.dirty && !this.closed);
        })()
            .catch((error: Error) => this.log(`topology refresh failed: ${error.message}`))
            .finally(() => {
                this.refreshing = null;
            });
        return this.refreshing;
    }

    /**
     * The registry saw a frame. Refresh only when a pane's session id or state
     * changed, checked at most every 100 ms, so streaming deltas cost nothing.
     */
    noteAgentActivity(): void {
        if (this.closed || this.listeners.size === 0 || this.agentCheck) return;
        this.agentCheck = setTimeout(() => {
            this.agentCheck = null;
            const signature = this.currentAgentSignature();
            if (signature !== this.agentSignature) void this.refresh();
        }, 100);
        this.agentCheck.unref();
    }

    close(): void {
        this.closed = true;
        this.listeners.clear();
        this.deactivate();
    }

    // ── internals ────────────────────────────────────────────────────────────

    private snapshotOf(state: FeedState): { message: TopologySnapshotMessage; text: string } {
        return { message: JSON.parse(state.snapshotText) as TopologySnapshotMessage, text: state.snapshotText };
    }

    private currentAgentSignature(): string {
        const sessions = this.options.agentSessions?.();
        if (!sessions) return '';
        return JSON.stringify([...sessions.entries()].sort(([a], [b]) => a.localeCompare(b)));
    }

    private async runOnce(): Promise<void> {
        const paneRead = await readPanes({ runner: this.runner, now: this.now });
        const panes = paneRead.data ?? [];
        this.lastPanes = panes;
        const key = JSON.stringify(enrichmentKeys(panes));
        if (!this.enrichment) {
            await this.enrich(panes, key);
        } else if (key !== this.enrichmentKey || this.now() - this.enrichedAt > this.enrichmentTtlMs) {
            // The pane join must not wait for sp/sb/git: refresh in the background
            // and join again when the new enrichment lands.
            if (!this.enriching) {
                this.enriching = this.enrich(panes, key).finally(() => {
                    this.enriching = null;
                    void this.refresh();
                });
            }
        }
        this.agentSignature = this.currentAgentSignature();
        const projection = joinProjection(paneRead, this.enrichment!, {
            now: this.now,
            agentSessions: this.options.agentSessions?.(),
        });
        this.publish(projection);
        if (this.listeners.size > 0 && !this.control && !this.restartTimer) this.startControl();
    }

    private async enrich(panes: RawPane[], key: string): Promise<void> {
        this.enrichment = await collectEnrichment(panes, {
            runner: this.runner,
            now: this.now,
            cwd: this.options.cwd,
            includeGithub: this.options.includeGithub ?? false,
            githubSkipReason: 'github enrichment is off (xt host start --topology-github)',
        });
        this.enrichmentKey = key;
        this.enrichedAt = this.now();
    }

    private publish(projection: TopologyProjectionV1): void {
        const revision = topologyRevision(projection);
        const previous = this.latest;
        if (previous && previous.revision === revision) {
            // Nothing to send; keep the fresher generated_at_ms for pull clients and late subscribers.
            this.latest = { ...previous, projection, snapshotText: buildSnapshot(projection, previous.seq, revision).text, at: this.now() };
            return;
        }
        this.seq += 1;
        const snapshot = buildSnapshot(projection, this.seq, revision);
        let message: TopologyFeedMessage = snapshot.message;
        let text = snapshot.text;
        if (previous) {
            const update: TopologyUpdateMessage = {
                schema: 'xtrm.agent-host-api.v1',
                kind: 'topology_update',
                topology: TOPOLOGY_FEED_VERSION,
                seq: this.seq,
                base_revision: previous.revision,
                revision,
                ...diffTopology(previous.projection, projection),
            };
            const updateText = JSON.stringify(update);
            const bytes = Buffer.byteLength(updateText);
            if (bytes <= TOPOLOGY_UPDATE_MAX_BYTES && bytes <= Buffer.byteLength(snapshot.text) / 2) {
                message = update;
                text = updateText;
            }
        }
        this.latest = { projection, revision, seq: this.seq, snapshotText: snapshot.text, at: this.now() };
        for (const listener of this.listeners) listener(message, text);
    }

    private activate(): void {
        this.schedulePoll();
        void this.refresh();
    }

    private deactivate(): void {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        if (this.restartTimer) clearTimeout(this.restartTimer);
        if (this.agentCheck) clearTimeout(this.agentCheck);
        this.pollTimer = this.restartTimer = this.agentCheck = null;
        this.stopControl();
    }

    private schedulePoll(): void {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        if (this.closed || this.listeners.size === 0) return;
        const delay = this.controlUp ? this.safetyPollMs : this.fallbackPollMs;
        this.pollTimer = setTimeout(() => {
            void this.refresh();
            this.schedulePoll();
        }, delay);
        this.pollTimer.unref();
    }

    private startControl(): void {
        if (this.options.controlClient === false || this.closed) return;
        const target = this.lastPanes[0]?.session_id;
        if (!target) return; // no session to attach to; the fallback poll keeps going
        const env = { ...process.env };
        // tmux refuses a nested attach while $TMUX names the same server; the
        // server is selected explicitly by tmuxArgs instead.
        delete env.TMUX;
        const child = spawn('tmux', [...this.tmuxArgs, ...TMUX_CONTROL.attach, target], {
            stdio: ['pipe', 'pipe', 'ignore'],
            env,
        });
        this.control = child;
        child.on('error', (error) => this.log(`tmux control client failed: ${error.message}`));
        child.stdin?.on('error', () => {});
        child.stdin?.write(`${TMUX_CONTROL.subscribe}\n`);
        const lines = createInterface({ input: child.stdout! });
        lines.on('line', (line) => {
            if (!this.controlUp && line.startsWith('%')) {
                this.controlUp = true;
                this.restartDelayMs = 2_000;
                this.schedulePoll();
                this.log('tmux control client attached');
            }
            if (line.startsWith('%exit')) return;
            if (TRIGGERS.test(line)) void this.refresh();
        });
        child.on('close', () => {
            if (this.control !== child) return;
            this.control = null;
            this.controlUp = false;
            if (this.closed || this.listeners.size === 0) return;
            this.log(`tmux control client exited; polling every ${this.fallbackPollMs} ms, retry in ${this.restartDelayMs} ms`);
            this.schedulePoll();
            this.restartTimer = setTimeout(() => {
                this.restartTimer = null;
                void this.refresh(); // reattaches from the fresh pane list
            }, this.restartDelayMs);
            this.restartTimer.unref();
            this.restartDelayMs = Math.min(this.restartDelayMs * 2, 30_000);
            void this.refresh();
        });
    }

    private stopControl(): void {
        const child = this.control;
        this.control = null;
        this.controlUp = false;
        if (!child) return;
        // Closing stdin detaches the control client; the signal covers a client
        // that does not exit. Both reach only this child, never the tmux server.
        child.stdin?.end();
        const kill = setTimeout(() => child.kill('SIGTERM'), 500);
        kill.unref();
        child.once('close', () => clearTimeout(kill));
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

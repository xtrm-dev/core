// XTRM-629: the agent host topology feed — coalescing, no-resend, diff/size cap, session join.
// No tmux here: a fake runner answers list-panes. The live tmux path is agent-host-topology.test.ts.
import { describe, expect, it } from 'vitest';
import { applyTopologyUpdate, validate, type TopologyAgentSession } from '@xtrm/contracts';
import {
    buildSnapshot,
    inheritedTmuxArgs,
    TMUX_CONTROL,
    TOPOLOGY_SNAPSHOT_MAX_BYTES,
    TOPOLOGY_UPDATE_MAX_BYTES,
    topologyRevision,
    TopologyFeed,
    type TopologyFeedMessage,
} from '../core/topology-feed.js';
import type { CommandRunner } from '../core/topology-projection.js';
import { agentSessionsByPane } from '../core/agent-host.js';

const SEP = '\t';
const line = (pane: string, session: string, window = 'zsh', state = '', command = 'zsh') =>
    [pane, '$1', session, '@1', command, '/home/op', state, '', '', '', '', '', '', '', '', '0', '0', '1', '1', window].join(SEP);

class FakeTmux {
    /** Six panes: a diff of one pane is then well under half of a snapshot, as in a real fleet. */
    lines: string[] = Array.from({ length: 6 }, (_, i) => line(`%${i + 1}`, i < 3 ? 'main' : 'work'));
    listCalls = 0;
    otherCalls: string[] = [];
    delayMs = 0;
    readonly runner: CommandRunner = async (bin, args) => {
        if (bin === 'tmux') {
            this.listCalls += 1;
            if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
            if (args[0] !== 'list-panes') throw new Error(`unexpected tmux ${args.join(' ')}`);
            return { kind: 'ok', stdout: `${this.lines.join('\n')}\n` };
        }
        this.otherCalls.push(`${bin} ${args.join(' ')}`);
        return { kind: 'missing' };
    };
}

function collect(feed: TopologyFeed) {
    const messages: TopologyFeedMessage[] = [];
    const texts: string[] = [];
    const unsubscribe = feed.subscribe((message, text) => {
        messages.push(message);
        texts.push(text);
    });
    return { messages, texts, unsubscribe };
}

async function until<T>(probe: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = probe();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, 5));
    }
}

const newFeed = (tmux: FakeTmux, extra: Partial<ConstructorParameters<typeof TopologyFeed>[0]> = {}) =>
    new TopologyFeed({ runner: tmux.runner, tmuxArgs: [], controlClient: false, minRefreshIntervalMs: 0, ...extra });

describe('topology feed (XTRM-629)', () => {
    it('sends a snapshot first, then a diff update that applies to the next projection', async () => {
        const tmux = new FakeTmux();
        const feed = newFeed(tmux);
        const sub = collect(feed);
        await until(() => sub.messages.length === 1);
        const first = sub.messages[0];
        expect(first.kind).toBe('topology_snapshot');
        expect(validate('xtrm.agent-host-api.v1', first).errors).toEqual([]);

        tmux.lines.push(line('%20', 'second', 'build'));
        await feed.refresh();
        const update = sub.messages[1];
        expect(update.kind).toBe('topology_update');
        expect(validate('xtrm.agent-host-api.v1', update).errors).toEqual([]);
        if (update.kind !== 'topology_update' || first.kind !== 'topology_snapshot') throw new Error('unexpected kinds');
        expect(update.base_revision).toBe(first.revision);
        expect(update.panes.upsert.map((p) => p.pane_id)).toEqual(['%20']);
        const applied = applyTopologyUpdate(first.projection, update);
        expect(topologyRevision(applied)).toBe(update.revision);
        expect(update.seq).toBe(first.seq + 1);
        feed.close();
    });

    it('never resends an identical projection', async () => {
        const tmux = new FakeTmux();
        const feed = newFeed(tmux);
        const sub = collect(feed);
        await until(() => sub.messages.length === 1);
        await feed.refresh();
        await feed.refresh();
        expect(tmux.listCalls).toBeGreaterThanOrEqual(3);
        expect(sub.messages).toHaveLength(1);
        feed.close();
    });

    it('coalesces a burst of triggers into one in-flight and one trailing pass, shared by every client', async () => {
        const tmux = new FakeTmux();
        tmux.delayMs = 30;
        const feed = newFeed(tmux);
        const clients = [collect(feed), collect(feed), collect(feed)];
        await until(() => clients.every((c) => c.messages.length === 1));
        const before = tmux.listCalls;
        tmux.lines.push(line('%20', 'second'));
        await Promise.all(Array.from({ length: 20 }, () => feed.refresh()));
        expect(tmux.listCalls - before).toBeLessThanOrEqual(2);
        // Every client got the same bytes for the same message.
        expect(new Set(clients.map((c) => c.texts.at(-1))).size).toBe(1);
        expect(clients[0].messages.at(-1)!.kind).toBe('topology_update');
        feed.close();
    });

    it('hands a late subscriber the current snapshot synchronously', async () => {
        const tmux = new FakeTmux();
        const feed = newFeed(tmux);
        const early = collect(feed);
        await until(() => early.messages.length === 1);
        tmux.lines.push(line('%20', 'second'));
        await feed.refresh();
        const late: TopologyFeedMessage[] = [];
        feed.subscribe((message) => late.push(message));
        expect(late).toHaveLength(1);
        expect(late[0]).toMatchObject({ kind: 'topology_snapshot', seq: 1 });
        if (late[0].kind === 'topology_snapshot') expect(late[0].projection.panes.map((p) => p.pane_id)).toEqual(['%1', '%2', '%3', '%4', '%5', '%6', '%20']);
        feed.close();
    });

    it('sends a snapshot instead of an update when the diff exceeds the size cap', async () => {
        const tmux = new FakeTmux();
        const feed = newFeed(tmux);
        const sub = collect(feed);
        await until(() => sub.messages.length === 1);
        const big = 'w'.repeat(1024);
        tmux.lines = Array.from({ length: 100 }, (_, i) => line(`%${i + 10}`, `s${i}`, big));
        await feed.refresh();
        expect(Buffer.byteLength(JSON.stringify(sub.messages[1]))).toBeGreaterThan(TOPOLOGY_UPDATE_MAX_BYTES);
        expect(sub.messages[1].kind).toBe('topology_snapshot');
        feed.close();
    });

    it('truncates orphans, never panes, when a snapshot exceeds its cap', () => {
        const projection = {
            schema_version: 'xtrm.topology.projection.v1' as const,
            generated_at_ms: 1,
            host: { host_id: 'h' },
            sources: [],
            panes: [],
            orphans: {
                jobs: [],
                worktrees: Array.from({ length: 5000 }, (_, i) => ({ path: `/${'p'.repeat(1000)}/${i}`, branch: null, head_sha: null, detached: false })),
            },
        };
        const { message, text } = buildSnapshot(projection, 0, '0123456789abcdef');
        expect(Buffer.byteLength(JSON.stringify(projection))).toBeGreaterThan(TOPOLOGY_SNAPSHOT_MAX_BYTES);
        expect(message.truncated).toBe(true);
        expect(message.projection.orphans.worktrees).toEqual([]);
        expect(Buffer.byteLength(text)).toBeLessThan(TOPOLOGY_SNAPSHOT_MAX_BYTES);
    });

    it('ignores volatile fields in the revision', async () => {
        const tmux = new FakeTmux();
        let clock = 1;
        const feed = newFeed(tmux, { now: () => clock++ });
        const a = await feed.snapshot();
        clock += 5_000;
        const b = await feed.snapshot();
        expect(b.projection.generated_at_ms).not.toBe(a.projection.generated_at_ms);
        expect(b.revision).toBe(a.revision);
        feed.close();
    });

    it('carries the registered agent session per pane and refreshes when a session state changes', async () => {
        const tmux = new FakeTmux();
        let sessions = new Map<string, TopologyAgentSession>([['%1', { session_id: 's-1', provider: 'pi', state: 'settled' }]]);
        const feed = newFeed(tmux, { agentSessions: () => sessions });
        const sub = collect(feed);
        await until(() => sub.messages.length === 1);
        const snap = sub.messages[0];
        if (snap.kind !== 'topology_snapshot') throw new Error('expected snapshot');
        expect(snap.projection.panes.find((p) => p.pane_id === '%1')!.agent_session).toEqual({ session_id: 's-1', provider: 'pi', state: 'settled' });
        expect(snap.projection.panes.find((p) => p.pane_id === '%2')!.agent_session).toBeNull();

        sessions = new Map([['%1', { session_id: 's-1', provider: 'pi', state: 'working' }]]);
        feed.noteAgentActivity();
        const update = await until(() => sub.messages[1]);
        expect(update).toMatchObject({ kind: 'topology_update', panes: { upsert: [{ pane_id: '%1', agent_session: { state: 'working' } }] } });
        feed.close();
    });

    it('does not read any source while nobody is subscribed', async () => {
        const tmux = new FakeTmux();
        const feed = newFeed(tmux);
        const sub = collect(feed);
        await until(() => sub.messages.length === 1);
        sub.unsubscribe();
        const calls = tmux.listCalls;
        feed.noteAgentActivity();
        await new Promise((r) => setTimeout(r, 150));
        expect(tmux.listCalls).toBe(calls);
        feed.close();
    });

    it('keeps GitHub off by default and reports why', async () => {
        const tmux = new FakeTmux();
        const feed = newFeed(tmux);
        const snap = await feed.snapshot();
        expect(tmux.otherCalls.some((c) => c.startsWith('gh '))).toBe(false);
        expect(snap.projection.sources.find((s) => s.name === 'github')).toMatchObject({ status: 'unavailable' });
        feed.close();
    });
});

describe('tmux control observer (XTRM-629)', () => {
    it('attaches read-only, never resizes, carries no pane output, and only subscribes', () => {
        expect(TMUX_CONTROL.attach.slice(0, 2)).toEqual(['-C', 'attach-session']);
        expect(TMUX_CONTROL.attach).toContain('-r');
        const flags = TMUX_CONTROL.attach[TMUX_CONTROL.attach.indexOf('-f') + 1].split(',');
        expect(flags).toEqual(expect.arrayContaining(['ignore-size', 'no-output', 'no-detach-on-destroy']));
        expect(TMUX_CONTROL.subscribe.startsWith('refresh-client -B ')).toBe(true);
        expect(TMUX_CONTROL.subscribe).not.toMatch(/[;\n]/);
    });

    it('selects the inherited server from $TMUX', () => {
        expect(inheritedTmuxArgs({ TMUX: '/tmp/tmux-1000/default,123,0' })).toEqual(['-S', '/tmp/tmux-1000/default']);
        expect(inheritedTmuxArgs({})).toEqual([]);
    });
});

describe('agentSessionsByPane', () => {
    const summary = (sessionId: string, paneId: string | undefined, extra: Record<string, unknown> = {}) => ({
        sessionId, provider: 'pi' as const, state: 'settled' as const, cwd: '/', extensionConnected: true, capabilities: [],
        ...(paneId ? { tmux: { session: 's', paneId } } : {}), ...extra,
    });

    it('joins live sessions by pane id, prefers a connected one, then the latest activity', () => {
        const map = agentSessionsByPane([
            summary('old', '%1', { extensionConnected: false, lastActivityAt: 99 }),
            summary('new', '%1', { lastActivityAt: 5 }),
            summary('later', '%2', { lastActivityAt: 10 }),
            summary('earlier', '%2', { lastActivityAt: 1 }),
            summary('no-pane', undefined),
            summary('history', '%3', { state: 'history_only' }),
        ]);
        expect(map.get('%1')?.session_id).toBe('new');
        expect(map.get('%2')?.session_id).toBe('later');
        expect(map.has('%3')).toBe(false);
        expect(map.size).toBe(2);
    });
});

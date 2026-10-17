// CORE-2432 I1 wake contract: one test per requirement R1-R9, named after it.
// Registry-level tests with stub producer connections (no sockets).

import { describe, expect, it, vi } from 'vitest';
import { AgentHostRegistry, type ProducerConnection } from '../core/agent-host-registry.js';
import type { AgentCommandPayload, AgentEventV1 } from '@xtrm/contracts';

function stubConnection() {
    const sent: { sessionId: string; payload: AgentCommandPayload }[] = [];
    const connection: ProducerConnection = {
        sendCommand: (sessionId, payload) => {
            sent.push({ sessionId, payload });
        },
    };
    return { connection, sent };
}

let seq = 0;

function identity(
    sessionId: string,
    extra: Record<string, unknown> = {},
): AgentEventV1 {
    return {
        schema: 'xtrm.agent-event.v1',
        seq: seq++,
        sessionId,
        at: Date.now(),
        payload: {
            type: 'session_identity',
            runtime: { name: 'pi', version: '1.0.0' },
            cwd: '/w',
            capabilities: ['prompt'],
            ...extra,
        } as never,
    };
}

function commandResult(
    sessionId: string,
    commandId: string,
    status: 'accepted' | 'rejected' | 'failed',
    reason?: string,
): AgentEventV1 {
    return {
        schema: 'xtrm.agent-event.v1',
        seq: seq++,
        sessionId,
        at: Date.now(),
        payload: { type: 'command_result', commandId, status, ...(reason ? { reason } : {}) } as never,
    };
}

function registryWithLog(opts: ConstructorParameters<typeof AgentHostRegistry>[0] = {}) {
    const lines: string[] = [];
    const registry = new AgentHostRegistry({ ...opts, log: (m) => lines.push(m) });
    return { registry, lines };
}

describe('CORE-2432 wake contract', () => {
    it('R1 listener identity is pid + sessionId + generation', () => {
        const { registry } = registryWithLog();
        const { connection } = stubConnection();
        expect(registry.ingest(connection, identity('s-1', { pid: 4242, generation: 1, sessionName: 'worker' }))).toBe(true);
        expect(registry.detail('s-1')?.identity).toMatchObject({ pid: 4242, generation: 1 });
        expect(registry.resolveParticipant('s-1')).toBe('s-1');
        expect(registry.resolveParticipant('worker')).toBe('s-1');
    });

    it('R2 a second listener for one identity is refused loudly, or drains explicitly on handover', () => {
        const { registry, lines } = registryWithLog();
        const a = stubConnection();
        const b = stubConnection();
        expect(registry.ingest(a.connection, identity('s-1', { pid: 100, generation: 1, sessionName: 'one' }))).toBe(true);
        // Same pid + sessionId + generation on a second connection: refused loudly.
        expect(registry.ingest(b.connection, identity('s-1', { pid: 100, generation: 1, sessionName: 'two' }))).toBe(false);
        expect(lines.join('\n')).toMatch(/refused second listener for session s-1/);
        // The first binding is intact.
        expect(registry.detail('s-1')?.identity).toMatchObject({ sessionName: 'one' });

        // Explicit drain-and-handover under the handover policy.
        const handover = new AgentHostRegistry({ duplicateListener: 'handover', log: () => {} });
        const c = stubConnection();
        const d = stubConnection();
        expect(handover.ingest(c.connection, identity('s-1', { pid: 100, generation: 1 }))).toBe(true);
        const submitted = handover.submit({
            schema: 'xtrm.agent-host-api.v1',
            kind: 'submit_request',
            sessionId: 's-1',
            command: { type: 'prompt', commandId: 'cmd-1', message: 'hi' },
        });
        expect(handover.ingest(d.connection, identity('s-1', { pid: 100, generation: 1 }))).toBe(true);
        expect(c.sent.map((s) => s.payload.type)).toContain('listener_replaced');
        // The in-flight command drained to the new listener: dropping the old
        // socket must not fail it, and the answer on the new one settles it.
        handover.disconnect(c.connection);
        handover.ingest(d.connection, commandResult('s-1', 'cmd-1', 'accepted'));
        return expect(submitted).resolves.toMatchObject({ status: 'accepted' });
    });

    it('R3 delivered only after the receiver accepted', () => {
        const { registry } = registryWithLog();
        const { connection, sent } = stubConnection();
        registry.ingest(connection, identity('s-1', { pid: 100, generation: 1, sessionName: 'worker' }));
        const first = registry.wake('worker', 'CORE-2432');
        expect(first.messageId).toMatch(/^[0-9a-f]{32}$/);
        expect(first.state).toBe('queued');
        expect(sent.map((s) => s.payload.type)).toEqual(['wake']);
        // Sent but unanswered: still queued, never delivered.
        expect(registry.wakeStatus(first.messageId)?.state).toBe('queued');
        registry.ingest(connection, commandResult('s-1', first.messageId, 'accepted'));
        expect(registry.wakeStatus(first.messageId)?.state).toBe('delivered');
    });

    it('R4 only a host shutdown reports pending wakes as undelivered', () => {
        const { registry } = registryWithLog();
        const { connection } = stubConnection();
        registry.ingest(connection, identity('s-1', { pid: 100, generation: 1, sessionName: 'a' }));
        const queued = registry.wake('a', 'ref-1');
        expect(queued.state).toBe('queued');
        const held = registry.wake('nobody-yet', 'ref-2');
        expect(held.state).toBe('held');
        // Graceful end parks the session's wakes for a receiver restart
        // (CORE-2437 F2), exactly like a transport loss.
        registry.ingest(connection, {
            schema: 'xtrm.agent-event.v1',
            seq: seq++,
            sessionId: 's-1',
            at: Date.now(),
            payload: { type: 'session_shutdown' } as never,
        });
        expect(registry.wakeStatus(queued.messageId)?.state).toBe('held');
        // Transport loss parks the wakes too: the session is gone but the
        // messages survive for a receiver restart.
        const other = stubConnection();
        registry.ingest(other.connection, identity('s-2', { pid: 200, generation: 1, sessionName: 'b' }));
        const parked = registry.wake('b', 'ref-3');
        expect(parked.state).toBe('queued');
        registry.disconnect(other.connection);
        expect(registry.wakeStatus(parked.messageId)?.state).toBe('held');
        // Host shutdown revokes everything left, including parked and held wakes.
        registry.close();
        expect(registry.wakeStatus(held.messageId)?.state).toBe('undelivered');
        expect(registry.wakeStatus(parked.messageId)?.state).toBe('undelivered');
        expect(registry.wakeStatus(queued.messageId)?.state).toBe('undelivered');
    });

    it('R5 the registry tells a replaced listener so it can re-assert', () => {
        const { registry } = registryWithLog();
        const oldConn = stubConnection();
        const newConn = stubConnection();
        registry.ingest(oldConn.connection, identity('s-1', { pid: 100, generation: 1 }));
        expect(registry.ingest(newConn.connection, identity('s-1', { pid: 100, generation: 2 }))).toBe(true);
        const notice = oldConn.sent.find((s) => s.payload.type === 'listener_replaced');
        expect(notice?.payload).toMatchObject({ generation: 2, reason: 'replaced_by_newer_generation' });
        expect(registry.detail('s-1')?.identity).toMatchObject({ generation: 2 });
    });

    it('R6 registry writes are compare-and-swap on generation', () => {
        const { registry, lines } = registryWithLog();
        const a = stubConnection();
        const b = stubConnection();
        const c = stubConnection();
        registry.ingest(a.connection, identity('s-1', { pid: 100, generation: 2 }));
        // Older but otherwise valid generation: refused, binding untouched.
        expect(registry.ingest(b.connection, identity('s-1', { pid: 100, generation: 1 }))).toBe(false);
        expect(lines.join('\n')).toMatch(/refused stale session_identity for session s-1/);
        expect(registry.detail('s-1')?.identity).toMatchObject({ generation: 2 });
        // Newer generation: adopted.
        expect(registry.ingest(c.connection, identity('s-1', { pid: 200, generation: 3 }))).toBe(true);
        expect(registry.detail('s-1')?.identity).toMatchObject({ pid: 200, generation: 3 });
    });

    it('R7 exact-name resolution; ambiguity is an error naming the candidates', () => {
        const { registry } = registryWithLog();
        const a = stubConnection();
        const b = stubConnection();
        registry.ingest(a.connection, identity('s-1', { pid: 1, generation: 1, sessionName: 'dup' }));
        registry.ingest(b.connection, identity('s-2', { pid: 2, generation: 1, sessionName: 'dup' }));
        // Exact single names still resolve.
        expect(registry.resolveParticipant('s-1')).toBe('s-1');
        let error: Error | null = null;
        try {
            registry.wake('dup', 'ref-1');
        } catch (e) {
            error = e as Error;
        }
        expect(error?.message).toContain('ambiguous participant "dup"');
        expect(error?.message).toContain('s-1');
        expect(error?.message).toContain('s-2');
    });

    it('R9 stable message ids deduplicate redelivery', () => {
        const { registry } = registryWithLog();
        const { connection, sent } = stubConnection();
        registry.ingest(connection, identity('s-1', { pid: 100, generation: 1, sessionName: 'worker' }));
        const wakes = () => sent.filter((s) => s.payload.type === 'wake');
        const first = registry.wake('worker', 'CORE-2432');
        // F5: dedupe only while queued or held: the same pair sends once.
        expect(registry.wake('worker', 'CORE-2432')).toEqual({ messageId: first.messageId, state: 'queued' });
        expect(wakes()).toHaveLength(1);
        registry.ingest(connection, commandResult('s-1', first.messageId, 'accepted'));
        // F5: a new wake after the terminal state sends again under the same stable id.
        const third = registry.wake('worker', 'CORE-2432');
        expect(third).toEqual({ messageId: first.messageId, state: 'queued' });
        expect(wakes()).toHaveLength(2);
        registry.ingest(connection, commandResult('s-1', first.messageId, 'accepted'));
        expect(registry.wakeStatus(first.messageId)?.state).toBe('delivered');
    });

    it('F1 a replaced listener does not win the binding back: replacements stop', () => {
        const { registry, lines } = registryWithLog();
        const a = stubConnection();
        const b = stubConnection();
        // A binds; B with a newer generation replaces it and A is told once.
        expect(registry.ingest(a.connection, identity('s-1', { pid: 1, generation: 1 }))).toBe(true);
        expect(registry.ingest(b.connection, identity('s-1', { pid: 2, generation: 2 }))).toBe(true);
        expect(a.sent.filter((s) => s.payload.type === 'listener_replaced')).toHaveLength(1);
        // A bumps and tries to win it back: refused, loudly, told by frame,
        // with no new notice to B and no further replacements.
        expect(registry.ingest(a.connection, identity('s-1', { pid: 1, generation: 3 }))).toBe(false);
        expect(lines.join('\n')).toMatch(/refused win-back session_identity for session s-1/);
        const notices = a.sent.filter((s) => s.payload.type === 'listener_replaced');
        expect(notices).toHaveLength(2);
        expect(notices[1].payload).toMatchObject({ reason: 'winback_refused', generation: 2 });
        expect(b.sent.filter((s) => s.payload.type === 'listener_replaced')).toHaveLength(0);
        expect(registry.detail('s-1')?.identity).toMatchObject({ pid: 2, generation: 2 });
        // The refused loser cannot hijack the binding with later frames either.
        expect(
            registry.ingest(a.connection, {
                schema: 'xtrm.agent-event.v1',
                seq: seq++,
                sessionId: 's-1',
                at: Date.now(),
                payload: { type: 'agent_start' } as never,
            }),
        ).toBe(false);
        // The owner re-asserting over its own socket still adopts.
        expect(registry.ingest(b.connection, identity('s-1', { pid: 2, generation: 2 }))).toBe(true);
        expect(registry.detail('s-1')?.identity).toMatchObject({ pid: 2, generation: 2 });
    });

    it('F3 a legacy frame never displaces a pid+generation binding', () => {
        const { registry, lines } = registryWithLog();
        const scoped = stubConnection();
        const legacy = stubConnection();
        registry.ingest(scoped.connection, identity('s-1', { pid: 7, generation: 1, sessionName: 'one' }));
        // Legacy identity for the same session: refused loudly, producer told, binding kept.
        const legacyIdentity: AgentEventV1 = {
            schema: 'xtrm.agent-event.v1',
            seq: seq++,
            sessionId: 's-1',
            at: Date.now(),
            payload: {
                type: 'session_identity',
                runtime: { name: 'pi', version: '1.0.0' },
                cwd: '/w',
                capabilities: ['prompt'],
                sessionName: 'two',
            } as never,
        };
        expect(registry.ingest(legacy.connection, legacyIdentity)).toBe(false);
        expect(lines.join('\n')).toMatch(/refused legacy session_identity for session s-1/);
        expect(legacy.sent.find((s) => s.payload.type === 'listener_replaced')?.payload).toMatchObject({
            reason: 'legacy_identity_refused',
        });
        expect(registry.detail('s-1')?.identity).toMatchObject({ sessionName: 'one' });
        // Later frames from the refused connection are dropped.
        expect(
            registry.ingest(legacy.connection, {
                schema: 'xtrm.agent-event.v1',
                seq: seq++,
                sessionId: 's-1',
                at: Date.now(),
                payload: { type: 'agent_start' } as never,
            }),
        ).toBe(false);
        // Legacy-over-legacy keeps the old overwrite behaviour.
        const l1 = stubConnection();
        const l2 = stubConnection();
        const legacyFor = (sid: string, name: string): AgentEventV1 => ({
            schema: 'xtrm.agent-event.v1',
            seq: seq++,
            sessionId: sid,
            at: Date.now(),
            payload: {
                type: 'session_identity',
                runtime: { name: 'pi', version: '1.0.0' },
                cwd: '/w',
                capabilities: ['prompt'],
                sessionName: name,
            } as never,
        });
        expect(registry.ingest(l1.connection, legacyFor('s-2', 'old'))).toBe(true);
        expect(registry.ingest(l2.connection, legacyFor('s-2', 'new'))).toBe(true);
        expect(registry.detail('s-2')?.identity).toMatchObject({ sessionName: 'new' });
    });

    it('F7 a wake held while starting completes only on accepted', () => {
        const { registry } = registryWithLog();
        const { connection } = stubConnection();
        registry.ingest(connection, identity('s-1', { pid: 100, generation: 1, sessionName: 'worker' }));
        const w = registry.wake('worker', 'ref-1');
        expect(w.state).toBe('queued');
        // Deferred while starting: the extension answers held, the wake stays held.
        registry.ingest(connection, commandResult('s-1', w.messageId, 'rejected', 'held'));
        expect(registry.wakeStatus(w.messageId)?.state).toBe('held');
        // A late acceptance once it is actually delivered completes it.
        registry.ingest(connection, commandResult('s-1', w.messageId, 'accepted'));
        expect(registry.wakeStatus(w.messageId)?.state).toBe('delivered');
    });

    it('CORE-2436 (b) a caller-supplied id is an idempotency key across terminal states', () => {
        const { registry } = registryWithLog();
        const { connection, sent } = stubConnection();
        registry.ingest(connection, identity('s-1', { pid: 100, generation: 1, sessionName: 'worker' }));
        const wakes = () => sent.filter((s) => s.payload.type === 'wake');
        expect(registry.wake('worker', 'CORE-1', { messageId: 'ask-1' })).toEqual({
            messageId: 'ask-1',
            state: 'queued',
        });
        expect(wakes()).toHaveLength(1);
        // Delivered: a retry with the same id returns the recorded state and does not resend.
        registry.ingest(connection, commandResult('s-1', 'ask-1', 'accepted'));
        expect(registry.wake('worker', 'CORE-1', { messageId: 'ask-1' })).toEqual({
            messageId: 'ask-1',
            state: 'delivered',
        });
        expect(wakes()).toHaveLength(1);
        // Refused: same rule.
        expect(registry.wake('worker', 'CORE-2', { messageId: 'ask-2' }).state).toBe('queued');
        registry.ingest(connection, commandResult('s-1', 'ask-2', 'rejected', 'nope'));
        expect(registry.wake('worker', 'CORE-2', { messageId: 'ask-2' })).toEqual({
            messageId: 'ask-2',
            state: 'refused',
        });
        expect(wakes()).toHaveLength(2);
        // Expired: same rule (unknown participant, ttlMs 0: held-then-expired, never sent).
        expect(registry.wake('nobody-here', 'CORE-3', { messageId: 'ask-3', ttlMs: 0 }).state).toBe('expired');
        expect(registry.wake('nobody-here', 'CORE-3', { messageId: 'ask-3' })).toEqual({
            messageId: 'ask-3',
            state: 'expired',
        });
        expect(wakes()).toHaveLength(2);
        // Undelivered: same rule.
        expect(registry.wake('worker', 'CORE-4', { messageId: 'ask-4' }).state).toBe('queued');
        registry.close();
        expect(registry.wake('worker', 'CORE-4', { messageId: 'ask-4' })).toEqual({
            messageId: 'ask-4',
            state: 'undelivered',
        });
        // A new id still resends (the stub connection is still bound after close).
        const sentBefore = wakes().length;
        const fresh = registry.wake('worker', 'CORE-1', { messageId: 'ask-5' });
        expect(fresh.messageId).toBe('ask-5');
        expect(wakes().length).toBe(sentBefore + 1);
    });

    it('CORE-2436 (b) stable ids keep the F5 resend-after-terminal behaviour', () => {
        const { registry } = registryWithLog();
        const { connection, sent } = stubConnection();
        registry.ingest(connection, identity('s-1', { pid: 100, generation: 1, sessionName: 'worker' }));
        const wakes = () => sent.filter((s) => s.payload.type === 'wake');
        const first = registry.wake('worker', 'CORE-9');
        registry.ingest(connection, commandResult('s-1', first.messageId, 'accepted'));
        const second = registry.wake('worker', 'CORE-9');
        expect(second).toEqual({ messageId: first.messageId, state: 'queued' });
        expect(wakes()).toHaveLength(2);
    });

    it('CORE-2436 (c) after A→B→C replacements neither A nor B wins the binding back', () => {
        const { registry, lines } = registryWithLog();
        const a = stubConnection();
        const b = stubConnection();
        const c = stubConnection();
        expect(registry.ingest(a.connection, identity('s-1', { pid: 1, generation: 1 }))).toBe(true);
        expect(registry.ingest(b.connection, identity('s-1', { pid: 2, generation: 2 }))).toBe(true);
        expect(registry.ingest(c.connection, identity('s-1', { pid: 3, generation: 3 }))).toBe(true);
        // A tries with a bumped generation: refused.
        expect(registry.ingest(a.connection, identity('s-1', { pid: 1, generation: 4 }))).toBe(false);
        // B tries with a bumped generation: refused too (single-slot code would let B back in).
        expect(registry.ingest(b.connection, identity('s-1', { pid: 2, generation: 4 }))).toBe(false);
        expect(lines.join('\n')).toMatch(/refused win-back session_identity for session s-1/);
        expect(registry.detail('s-1')?.identity).toMatchObject({ pid: 3, generation: 3 });
        // The owner re-asserting over its own socket still adopts.
        expect(registry.ingest(c.connection, identity('s-1', { pid: 3, generation: 3 }))).toBe(true);
    });

    it('CORE-2436 a flush-time failure after held settles the wake as undelivered', () => {
        const { registry } = registryWithLog();
        const { connection } = stubConnection();
        registry.ingest(connection, identity('s-1', { pid: 100, generation: 1, sessionName: 'worker' }));
        const w = registry.wake('worker', 'ref-1');
        expect(w.state).toBe('queued');
        // The bridge defers and answers held: the pending settles, the record stays held.
        registry.ingest(connection, commandResult('s-1', w.messageId, 'rejected', 'held'));
        expect(registry.wakeStatus(w.messageId)?.state).toBe('held');
        // The flush-time injection fails after the pending is gone: the
        // orphan failure must report undelivered, never strand the wake.
        registry.ingest(connection, commandResult('s-1', w.messageId, 'failed', 'injection_failed'));
        expect(registry.wakeStatus(w.messageId)?.state).toBe('undelivered');
        // Terminal records never move on orphan answers.
        registry.ingest(connection, commandResult('s-1', w.messageId, 'accepted'));
        expect(registry.wakeStatus(w.messageId)?.state).toBe('undelivered');
    });

    it('CORE-2437 a receiver restart parks three queued wakes and redelivers each exactly once', () => {
        const { registry } = registryWithLog();
        const receiver = stubConnection();
        registry.ingest(receiver.connection, identity('s-1', { pid: 100, generation: 1, sessionName: 'worker' }));
        const ids = ['m-1', 'm-2', 'm-3'];
        for (const [index, id] of ids.entries()) {
            expect(registry.wake('worker', `ref-${index + 1}`, { messageId: id }).state).toBe('queued');
        }
        expect(receiver.sent.filter((s) => s.payload.type === 'wake')).toHaveLength(3);
        // The receiver restarts: its connection drops with no shutdown frame.
        registry.disconnect(receiver.connection);
        for (const id of ids) expect(registry.wakeStatus(id)?.state).toBe('held');
        // ... and registers again on a new connection with a bumped generation.
        const restarted = stubConnection();
        expect(
            registry.ingest(restarted.connection, identity('s-1', { pid: 200, generation: 2, sessionName: 'worker' })),
        ).toBe(true);
        const resent = restarted.sent.filter((s) => s.payload.type === 'wake');
        expect(resent.map((s) => (s.payload as { messageId: string }).messageId).sort()).toEqual(ids);
        // Each arrives once: the redelivery is accepted, never duplicated.
        for (const id of ids) {
            registry.ingest(restarted.connection, commandResult('s-1', id, 'accepted'));
            expect(registry.wakeStatus(id)?.state).toBe('delivered');
        }
        expect(restarted.sent.filter((s) => s.payload.type === 'wake')).toHaveLength(3);
    });

    it('CORE-2437 N1 a full live mailbox evicts without recursing', () => {
        const { registry } = registryWithLog();
        const sender = stubConnection();
        registry.ingest(sender.connection, identity('s-snd', { pid: 50, generation: 1, sessionName: 'sender' }));
        // 17 receivers of 64 live wakes each: past the 1024 global cap with
        // no settled record to evict. On the pre-N1 code this threw
        // RangeError (the notice re-selected its own victim, forever).
        for (let r = 0; r < 17; r += 1) {
            for (let i = 0; i < 64; i += 1) {
                registry.wake(`crowded-${r}`, `fill-${r}-${i}`, { messageId: `n1-${r}-${i}`, fromSessionId: 's-snd' });
            }
        }
        const notices = sender.sent.filter((s) => s.payload.type === 'wake');
        expect(notices.length).toBeGreaterThan(0);
        expect((notices[0].payload as { payloadRef: string }).payloadRef).toMatch(/mailbox is full/);
    });

    it('CORE-2437 F5 a full per-receiver mailbox evicts the oldest with an undelivered notice', () => {
        const { registry } = registryWithLog();
        const sender = stubConnection();
        registry.ingest(sender.connection, identity('s-snd', { pid: 50, generation: 1, sessionName: 'sender' }));
        for (let i = 0; i < 64; i += 1) {
            expect(registry.wake('crowded', `fill-${i}`, { messageId: `fill-${i}`, fromSessionId: 's-snd' }).state).toBe('held');
        }
        // The 65th arrival evicts the oldest live wake for this receiver.
        expect(registry.wake('crowded', 'fill-64', { messageId: 'fill-64', fromSessionId: 's-snd' }).state).toBe('held');
        expect(registry.wakeStatus('fill-0')).toBeNull();
        expect(registry.wakeStatus('fill-64')?.state).toBe('held');
        const notices = sender.sent.filter((s) => s.payload.type === 'wake');
        expect(notices).toHaveLength(1);
        const notice = notices[0].payload as { messageId: string; payloadRef: string };
        expect(notice.payloadRef).toContain('fill-0');
        expect(notice.payloadRef).toMatch(/mailbox is full/);
    });

    it('CORE-2437 F3 the idle sweep expires wakes and notifies without any send or poll', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(2_000_000);
            const { registry } = registryWithLog({ sweepIntervalMs: 30_000 });
            const sender = stubConnection();
            registry.ingest(sender.connection, identity('s-snd', { pid: 50, generation: 1, sessionName: 'sender' }));
            registry.wake('ghost-nobody', 'idle-ref', { messageId: 'm-idle', fromSessionId: 's-snd', ttlMs: 10_000 });
            expect(registry.wakeStatus('m-idle')?.state).toBe('held');
            // Nobody sends or polls; the unref'd sweep still fires on schedule.
            vi.setSystemTime(2_000_000 + 31_000);
            vi.advanceTimersByTime(31_000);
            expect(sender.sent.filter((s) => s.payload.type === 'wake')).toHaveLength(1);
            const notice = sender.sent[0].payload as { payloadRef: string };
            expect(notice.payloadRef).toContain('m-idle');
            expect(notice.payloadRef).toMatch(/expired before delivery/);
        } finally {
            vi.useRealTimers();
        }
    });

    it('CORE-2437 a graceful shutdown parks three queued wakes and redelivers each exactly once', () => {
        const { registry } = registryWithLog();
        const receiver = stubConnection();
        registry.ingest(receiver.connection, identity('s-1', { pid: 100, generation: 1, sessionName: 'worker' }));
        const ids = ['g-1', 'g-2', 'g-3'];
        for (const [index, id] of ids.entries()) {
            expect(registry.wake('worker', `gref-${index + 1}`, { messageId: id }).state).toBe('queued');
        }
        expect(receiver.sent.filter((s) => s.payload.type === 'wake')).toHaveLength(3);
        // The receiver quits gracefully: a session_shutdown frame, no crash.
        registry.ingest(receiver.connection, {
            schema: 'xtrm.agent-event.v1',
            seq: seq++,
            sessionId: 's-1',
            at: Date.now(),
            payload: { type: 'session_shutdown' } as never,
        });
        for (const id of ids) expect(registry.wakeStatus(id)?.state).toBe('held');
        // ... and registers again on a new connection with a bumped generation.
        const restarted = stubConnection();
        expect(
            registry.ingest(restarted.connection, identity('s-1', { pid: 200, generation: 2, sessionName: 'worker' })),
        ).toBe(true);
        const resent = restarted.sent.filter((s) => s.payload.type === 'wake');
        expect(resent.map((s) => (s.payload as { messageId: string }).messageId).sort()).toEqual(ids);
        for (const id of ids) {
            registry.ingest(restarted.connection, commandResult('s-1', id, 'accepted'));
            expect(registry.wakeStatus(id)?.state).toBe('delivered');
        }
        expect(restarted.sent.filter((s) => s.payload.type === 'wake')).toHaveLength(3);
    });

    it('CORE-2437 an expired wake posts one expired notice to the sender, then stays silent', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1_000_000);
            const { registry } = registryWithLog();
            const sender = stubConnection();
            registry.ingest(sender.connection, identity('s-snd', { pid: 50, generation: 1, sessionName: 'sender' }));
            registry.wake('ghost-nobody', 'doomed-ref', {
                messageId: 'm-doom',
                fromSessionId: 's-snd',
                fromName: 'sender',
                ttlMs: 1000,
            });
            expect(registry.wakeStatus('m-doom')?.state).toBe('held');
            // Past the TTL the wake reads expired and the sender is told, once.
            vi.setSystemTime(1_000_000 + 2000);
            expect(registry.wakeStatus('m-doom')?.state).toBe('expired');
            const notices = sender.sent.filter((s) => s.payload.type === 'wake');
            expect(notices).toHaveLength(1);
            const notice = notices[0].payload as { messageId: string; payloadRef: string };
            expect(notice.messageId).not.toBe('m-doom');
            expect(notice.payloadRef).toContain('m-doom');
            expect(notice.payloadRef).toMatch(/expired before delivery/);
            // The notice itself expires without a cascading notice.
            vi.setSystemTime(1_000_000 + 2000 + 6 * 60_000);
            expect(registry.wakeStatus(notice.messageId)?.state).toBe('expired');
            expect(sender.sent.filter((s) => s.payload.type === 'wake')).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('F5 a caller-supplied message id keys dedupe', () => {
        const { registry } = registryWithLog();
        const { connection, sent } = stubConnection();
        registry.ingest(connection, identity('s-1', { pid: 100, generation: 1, sessionName: 'worker' }));
        const wakes = () => sent.filter((s) => s.payload.type === 'wake');
        expect(registry.wake('worker', 'CORE-1', { messageId: 'custom-1' })).toEqual({
            messageId: 'custom-1',
            state: 'queued',
        });
        expect(registry.wake('worker', 'CORE-2', { messageId: 'custom-1' })).toEqual({
            messageId: 'custom-1',
            state: 'queued',
        });
        expect(wakes()).toHaveLength(1);
        expect(() => registry.wake('worker', 'CORE-1', { messageId: '' })).toThrow();
    });
});

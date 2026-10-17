// CORE-2432 I1 wake contract: one test per requirement R1-R9, named after it.
// Registry-level tests with stub producer connections (no sockets).

import { describe, expect, it } from 'vitest';
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

function commandResult(sessionId: string, commandId: string, status: 'accepted' | 'rejected' | 'failed'): AgentEventV1 {
    return {
        schema: 'xtrm.agent-event.v1',
        seq: seq++,
        sessionId,
        at: Date.now(),
        payload: { type: 'command_result', commandId, status } as never,
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

    it('R4 teardown, including dispose without shutdown, revokes and reports pending as undelivered', () => {
        const { registry } = registryWithLog();
        const { connection } = stubConnection();
        registry.ingest(connection, identity('s-1', { pid: 100, generation: 1, sessionName: 'a' }));
        const queued = registry.wake('a', 'ref-1');
        expect(queued.state).toBe('queued');
        const held = registry.wake('nobody-yet', 'ref-2');
        expect(held.state).toBe('held');
        // Dispose without shutdown: the socket just goes away.
        registry.disconnect(connection);
        expect(registry.wakeStatus(queued.messageId)?.state).toBe('undelivered');
        // Host shutdown revokes everything left, including held wakes.
        registry.close();
        expect(registry.wakeStatus(held.messageId)?.state).toBe('undelivered');
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
        registry.ingest(a.connection, identity('s-1', { pid: 100, generation: 1 }));
        // Older generation: refused, binding untouched.
        expect(registry.ingest(b.connection, identity('s-1', { pid: 100, generation: 0 }))).toBe(false);
        expect(lines.join('\n')).toMatch(/refused stale session_identity for session s-1/);
        expect(registry.detail('s-1')?.identity).toMatchObject({ generation: 1 });
        // Newer generation: adopted.
        expect(registry.ingest(c.connection, identity('s-1', { pid: 200, generation: 2 }))).toBe(true);
        expect(registry.detail('s-1')?.identity).toMatchObject({ pid: 200, generation: 2 });
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
        const first = registry.wake('worker', 'CORE-2432');
        const second = registry.wake('worker', 'CORE-2432');
        expect(second.messageId).toBe(first.messageId);
        expect(sent.filter((s) => s.payload.type === 'wake')).toHaveLength(1);
        registry.ingest(connection, commandResult('s-1', first.messageId, 'accepted'));
        // After delivery a redelivery still returns the same id and state, with no resend.
        const third = registry.wake('worker', 'CORE-2432');
        expect(third).toEqual({ messageId: first.messageId, state: 'delivered' });
        expect(sent.filter((s) => s.payload.type === 'wake')).toHaveLength(1);
    });
});

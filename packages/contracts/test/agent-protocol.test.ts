import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
    SCHEMA_ID,
    validate,
    getSchema,
    checkSchemaVersion,
    decodeFrame,
    encodeFrame,
    parseSchemaId,
    type AgentProtocolSchemaId,
    type AgentEventV1,
    type AgentCommandV1,
    type AgentHostApiV1,
    type AgentHostAuthV1,
} from '../src/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const fixtures = JSON.parse(readFileSync(path.join(fixturesDir, 'agent-protocol.json'), 'utf8')) as {
    events: AgentEventV1[];
    commands: AgentCommandV1[];
    hostApi: AgentHostApiV1[];
    hostAuth: AgentHostAuthV1[];
};

/** Discriminator values a schema's union accepts, read from the schema itself. */
function unionTags(id: string, unionDef: string, tagField: string): string[] {
    const schema = getSchema(id) as unknown as { definitions: Record<string, any>; oneOf?: any[] };
    const branches = unionDef === '' ? schema.oneOf! : schema.definitions[unionDef].oneOf;
    return branches.map((branch: { $ref: string }) => {
        const name = branch.$ref.replace('#/definitions/', '');
        return schema.definitions[name].properties[tagField].const as string;
    });
}

const sets: Array<{ id: AgentProtocolSchemaId; items: unknown[]; tags: string[]; tagOf: (m: any) => string }> = [
    {
        id: SCHEMA_ID.agentEvent,
        items: fixtures.events,
        tags: unionTags(SCHEMA_ID.agentEvent, 'event', 'type'),
        tagOf: (m) => m.payload.type,
    },
    {
        id: SCHEMA_ID.agentCommand,
        items: fixtures.commands,
        tags: unionTags(SCHEMA_ID.agentCommand, 'command', 'type'),
        tagOf: (m) => m.payload.type,
    },
    {
        id: SCHEMA_ID.agentHostApi,
        items: fixtures.hostApi,
        tags: unionTags(SCHEMA_ID.agentHostApi, '', 'kind'),
        tagOf: (m) => m.kind,
    },
    {
        id: SCHEMA_ID.agentHostAuth,
        items: fixtures.hostAuth,
        tags: unionTags(SCHEMA_ID.agentHostAuth, '', 'kind'),
        tagOf: (m) => m.kind,
    },
];

describe.each(sets)('$id round-trip fixtures', ({ id, items, tags, tagOf }) => {
    it('cover every message type the schema declares', () => {
        expect(new Set(items.map(tagOf))).toEqual(new Set(tags));
    });

    it.each(items.map((item) => [tagOf(item), item]))('%s validates and survives NDJSON round-trip', (_tag, item) => {
        const direct = validate(id, item);
        expect(direct.errors, JSON.stringify(direct.errors)).toEqual([]);

        const line = encodeFrame(item as never);
        expect(line.endsWith('\n')).toBe(true);
        expect(line.slice(0, -1)).not.toContain('\n');

        const decoded = decodeFrame(id, line.trimEnd());
        expect(decoded).toEqual({ ok: true, value: item });
    });

    it('rejects an unknown major version before payload validation', () => {
        const v2 = { ...(items[0] as object), schema: id.replace(/\.v1$/, '.v2') };
        expect(validate(id, v2).valid).toBe(false);
        expect(checkSchemaVersion(id, v2)).toMatchObject({ ok: false, reason: 'unsupported_major' });
        expect(decodeFrame(id, JSON.stringify(v2))).toMatchObject({ ok: false, reason: 'unsupported_major' });
    });

    it('rejects a message from another contract family or without a schema', () => {
        const other = { ...(items[0] as object), schema: 'xtrm.command-outcome.v1' };
        expect(checkSchemaVersion(id, other)).toMatchObject({ ok: false, reason: 'unknown_family' });
        const { schema: _drop, ...bare } = items[0] as Record<string, unknown>;
        expect(checkSchemaVersion(id, bare)).toMatchObject({ ok: false, reason: 'missing_schema' });
        expect(decodeFrame(id, '{not json')).toMatchObject({ ok: false, reason: 'invalid_json' });
    });
});

describe('agent-event.v1 semantics', () => {
    const id = SCHEMA_ID.agentEvent;
    const frame = (payload: Record<string, unknown>) => ({ ...fixtures.events[0], payload });

    it('accepts agent_end without willRetry (Pi extension API) and with it (RPC / in-process producers)', () => {
        expect(validate(id, frame({ type: 'agent_end', messages: [] })).valid).toBe(true);
        expect(validate(id, frame({ type: 'agent_end', messages: [], willRetry: true })).valid).toBe(true);
    });

    it('carries parentToolCallId separately from the §36.7 origin', () => {
        const start = structuredClone(fixtures.events.find((e) => e.payload.type === 'tool_execution_start')!);
        (start.payload as any).parentToolCallId = 'call_0';
        (start.payload as any).origin = { class: 'mcp', server: 'github', transport: 'stdio' };
        expect(validate(id, start).valid).toBe(true);
        (start.payload as any).origin = { class: 'builtin' };
        expect(validate(id, start).valid).toBe(false);
    });

    it('requires a Frame ingress origin of gui or terminal (§35.8 item 5)', () => {
        expect(validate(id, frame({ type: 'before_agent_start', prompt: 'x', ingress: { origin: 'terminal' } })).valid).toBe(true);
        expect(validate(id, frame({ type: 'before_agent_start', prompt: 'x' })).valid).toBe(false);
        expect(validate(id, frame({ type: 'before_agent_start', prompt: 'x', ingress: { origin: 'web' } })).valid).toBe(false);
    });

    it('rejects an unknown event type and a missing frame field', () => {
        expect(validate(id, frame({ type: 'auto_retry_start', attempt: 1 })).valid).toBe(false);
        const { seq: _seq, ...noSeq } = fixtures.events[0];
        expect(validate(id, noSeq).valid).toBe(false);
    });

    it('requires options for a select UI request', () => {
        expect(validate(id, frame({ type: 'extension_ui_request', id: 'u', method: 'select', title: 't' })).valid).toBe(false);
    });

    it('closes a UI request with extension_ui_resolved carrying who resolved it and how', () => {
        const resolved = { type: 'extension_ui_resolved', id: 'u', resolvedBy: 'local', outcome: 'cancelled' };
        expect(validate(id, frame(resolved)).valid).toBe(true);
        expect(validate(id, frame({ ...resolved, resolvedBy: 'host', outcome: 'answered' })).valid).toBe(true);
        expect(validate(id, frame({ ...resolved, resolvedBy: 'terminal' })).valid).toBe(false);
        expect(validate(id, frame({ ...resolved, value: 'secret' })).valid).toBe(false);
        const { outcome: _outcome, ...noOutcome } = resolved;
        expect(validate(id, frame(noOutcome)).valid).toBe(false);
    });
});

describe('agent-event.v1 Claude hook events', () => {
    const id = SCHEMA_ID.agentEvent;
    const frame = (payload: Record<string, unknown>) => ({ ...fixtures.events[0], payload });

    it('accepts a notification with a snake_case kind and rejects free text kinds', () => {
        expect(validate(id, frame({ type: 'notification', kind: 'idle_prompt' })).valid).toBe(true);
        expect(validate(id, frame({ type: 'notification', kind: 'Permission prompt' })).valid).toBe(false);
        expect(validate(id, frame({ type: 'notification' })).valid).toBe(false);
    });

    it('accepts subagent_end with optional identifiers only', () => {
        expect(validate(id, frame({ type: 'subagent_end' })).valid).toBe(true);
        expect(validate(id, frame({ type: 'subagent_end', agentId: 'a', transcript: 'x' })).valid).toBe(false);
    });
});

describe('agent-command.v1 semantics', () => {
    const id = SCHEMA_ID.agentCommand;
    const frame = (payload: Record<string, unknown>) => ({ ...fixtures.commands[0], payload });

    it('requires exactly one answer field on extension_ui_response', () => {
        const base = { type: 'extension_ui_response', commandId: 'c', id: 'ui-1' };
        expect(validate(id, frame(base)).valid).toBe(false);
        expect(validate(id, frame({ ...base, value: 'a', confirmed: true })).valid).toBe(false);
        expect(validate(id, frame({ ...base, cancelled: false })).valid).toBe(false);
    });

    it('rejects an empty prompt and a command without commandId', () => {
        expect(validate(id, frame({ type: 'prompt', commandId: 'c', message: '' })).valid).toBe(false);
        expect(validate(id, frame({ type: 'abort' })).valid).toBe(false);
    });
});

describe('agent-host-api.v1 semantics', () => {
    const id = SCHEMA_ID.agentHostApi;

    it('embeds a full xtrm.agent-event.v1 frame in each SSE event and rejects an invalid one', () => {
        const event = structuredClone(fixtures.hostApi.find((m) => m.kind === 'event')!) as any;
        expect(validate(id, event).valid).toBe(true);
        event.frame.payload = { type: 'not_an_event' };
        expect(validate(id, event).valid).toBe(false);
    });

    it('routes submit commands through the xtrm.agent-command.v1 command union', () => {
        const submit = structuredClone(fixtures.hostApi.find((m) => m.kind === 'submit_request')!) as any;
        submit.command = { type: 'abort', commandId: 'c' };
        expect(validate(id, submit).valid).toBe(true);
        submit.command = { type: 'shell', commandId: 'c' };
        expect(validate(id, submit).valid).toBe(false);
    });

    it('rejects an unknown kind', () => {
        expect(validate(id, { schema: id, kind: 'session_delete', sessionId: 's' }).valid).toBe(false);
    });
});

describe('agent-host-ensure.v1 semantics', () => {
    const id = SCHEMA_ID.agentHostEnsure;
    const ok = { schema: id, version: '0.13.0', protocol: { major: 1 }, port: 43817, pid: 48211 };

    it('accepts the result and the error form', () => {
        expect(validate(id, ok).valid).toBe(true);
        expect(validate(id, { schema: id, error: { code: 'host_start_failed', message: 'exited with code 1' } }).valid).toBe(true);
    });

    it('rejects a missing protocol major, port 0, extra fields and a mixed result/error object', () => {
        const { protocol: _protocol, ...noProtocol } = ok;
        expect(validate(id, noProtocol).valid).toBe(false);
        expect(validate(id, { ...ok, port: 0 }).valid).toBe(false);
        expect(validate(id, { ...ok, address: '0.0.0.0' }).valid).toBe(false);
        expect(validate(id, { ...ok, error: { code: 'x', message: 'y' } }).valid).toBe(false);
    });
});

describe('agent-host-auth.v1 semantics', () => {
    const id = SCHEMA_ID.agentHostAuth;
    const session = () => structuredClone(fixtures.hostAuth.find((m) => m.kind === 'device_session')!) as any;

    it('accepts a pair_request without a device name', () => {
        expect(validate(id, { schema: id, kind: 'pair_request', pairingToken: 'xtp_x' }).valid).toBe(true);
    });

    it('never carries a token hash and keeps token prefixes per kind', () => {
        expect(validate(id, { ...session(), tokenHash: 'a'.repeat(64) }).valid).toBe(false);
        expect(validate(id, { ...session(), token: 'xtp_wrongKind' }).valid).toBe(false);
        expect(validate(id, { schema: id, kind: 'pairing_token', token: 'xtd_wrongKind', expiresAt: 1 }).valid).toBe(false);
        const list = { schema: id, kind: 'device_list', devices: [{ ...session().device, tokenHash: 'a'.repeat(64) }] };
        expect(validate(id, list).valid).toBe(false);
    });

    it('rejects a control character in a device name and a host API error kind', () => {
        const bad = session();
        bad.device.name = 'pho\u0007ne';
        expect(validate(id, bad).valid).toBe(false);
        expect(validate(id, { schema: id, kind: 'error', code: 'unauthorized', message: 'x' }).valid).toBe(false);
    });
});

describe('parseSchemaId', () => {
    it('splits family and major', () => {
        expect(parseSchemaId('xtrm.agent-event.v12')).toEqual({ family: 'xtrm.agent-event', major: 12 });
        expect(parseSchemaId('xtrm.agent-event')).toBeNull();
        expect(parseSchemaId('xtrm.agent-event.v0')).toBeNull();
    });
});

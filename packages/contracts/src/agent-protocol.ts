// Agent host protocol helpers (PRD xtrm-app §35.8 item 1): schema-version check and
// NDJSON framing for xtrm.agent-event.v1 / xtrm.agent-command.v1 / xtrm.agent-host-api.v1 /
// xtrm.agent-host-auth.v1.
// The JSON Schemas stay the source of truth; these helpers only add the version
// negotiation a peer needs before it validates a frame.

import { validate } from './validate.js';
import type { ContractTypeMap } from './types.js';

export type AgentProtocolSchemaId =
    | 'xtrm.agent-event.v1'
    | 'xtrm.agent-command.v1'
    | 'xtrm.agent-host-api.v1'
    | 'xtrm.agent-host-auth.v1';

const VERSIONED_ID = /^(xtrm\.[a-z0-9.-]+)\.v([1-9][0-9]*)$/;

export type SchemaVersionCheck =
    | { ok: true; family: string; major: number }
    | {
          ok: false;
          /** missing_schema: no string `schema` field; unknown_family: a different contract; unsupported_major: same contract, other major. */
          reason: 'missing_schema' | 'unknown_family' | 'unsupported_major';
          received: unknown;
          expected: string;
      };

/** Split a versioned contract id ("xtrm.agent-event.v1") into family and major. */
export function parseSchemaId(id: string): { family: string; major: number } | null {
    const match = VERSIONED_ID.exec(id);
    return match ? { family: match[1], major: Number(match[2]) } : null;
}

/**
 * Check a message's `schema` field against the expected contract id before validating it.
 * A different major of the same contract is rejected as `unsupported_major`, so a peer can
 * tell the operator to update instead of reporting a generic validation failure.
 */
export function checkSchemaVersion(expected: AgentProtocolSchemaId, message: unknown): SchemaVersionCheck {
    const want = parseSchemaId(expected)!;
    const received = (message as { schema?: unknown } | null)?.schema;
    if (typeof received !== 'string') return { ok: false, reason: 'missing_schema', received, expected };
    const got = parseSchemaId(received);
    if (!got || got.family !== want.family) return { ok: false, reason: 'unknown_family', received, expected };
    if (got.major !== want.major) return { ok: false, reason: 'unsupported_major', received, expected };
    return { ok: true, family: got.family, major: got.major };
}

export type DecodeResult<K extends AgentProtocolSchemaId> =
    | { ok: true; value: ContractTypeMap[K] }
    | {
          ok: false;
          reason: 'invalid_json' | 'missing_schema' | 'unknown_family' | 'unsupported_major' | 'invalid_payload';
          detail: string;
      };

/** Serialize one frame as an NDJSON line (JSON.stringify never emits a raw newline). */
export function encodeFrame(frame: ContractTypeMap[AgentProtocolSchemaId]): string {
    return `${JSON.stringify(frame)}\n`;
}

/** Parse, version-check and validate one NDJSON line. Never throws. */
export function decodeFrame<K extends AgentProtocolSchemaId>(expected: K, line: string): DecodeResult<K> {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch (error) {
        return { ok: false, reason: 'invalid_json', detail: (error as Error).message };
    }
    const version = checkSchemaVersion(expected, value);
    if (!version.ok) {
        return { ok: false, reason: version.reason, detail: `expected ${expected}, received ${String(version.received)}` };
    }
    const { valid, errors } = validate(expected, value);
    if (!valid) {
        const detail = errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
        return { ok: false, reason: 'invalid_payload', detail };
    }
    return { ok: true, value: value as ContractTypeMap[K] };
}

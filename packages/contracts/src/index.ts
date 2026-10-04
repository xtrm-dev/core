// @xtrm/contracts — shared cross-runtime contracts for the xtrm ecosystem.
// Ships JSON Schemas (../schemas), TypeScript types and ajv-backed runtime
// validators. The JSON Schema files are the single source of truth.

export * from './types.js';
export {
    SCHEMA_IDS,
    getSchema,
    getValidator,
    validate,
    assertValid,
    uuidV7TimestampMs,
    type JsonSchema,
    type ValidationResult,
} from './validate.js';
export {
    parseSchemaId,
    checkSchemaVersion,
    encodeFrame,
    decodeFrame,
    type AgentProtocolSchemaId,
    type SchemaVersionCheck,
    type DecodeResult,
} from './agent-protocol.js';
export { diffTopology, applyTopologyUpdate, type TopologyDiff } from './topology-feed.js';

import { validate } from './validate.js';
import type { ContractTypeMap } from './types.js';

/**
 * Typed validation guard: narrows `data` to the payload type for a known
 * schema id when it validates. `validate()` is the untyped, error-returning
 * form; this is the ergonomic guard for TypeScript consumers.
 */
export function isValid<K extends keyof ContractTypeMap>(
    id: K,
    data: unknown,
): data is ContractTypeMap[K] {
    return validate(id, data).valid;
}

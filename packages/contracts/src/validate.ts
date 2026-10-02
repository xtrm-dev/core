import { Ajv, type ValidateFunction, type ErrorObject } from 'ajv';
import { BUNDLED_SCHEMAS } from './schemas.js';

export type JsonSchema = Record<string, unknown> & { $id: string };

// strict:false — contract ids (e.g. "xtrm.runtime-origin.v1") are intentionally
// not URIs, and we lean on draft-07 `const`; neither should be a strict-mode error.
// validateFormats:false — `format` (e.g. date-time) is kept as documentation only;
// enforcing it would need ajv-formats. Keeps output clean and dependency-light.
// allErrors defaults to false (fail-fast): a validator that may see cross-repo
// payloads shouldn't let a crafted input balloon the error array (DoS).
const ajv = new Ajv({ strict: false, validateFormats: false });
// Schemas also ship as static JSON under schemas/ (the ./schemas/* export).
const schemas = BUNDLED_SCHEMAS as JsonSchema[];
for (const schema of schemas) ajv.addSchema(schema);

/** All contract schema ids shipped by this package, sorted. */
export const SCHEMA_IDS: readonly string[] = schemas.map((s) => s.$id).sort();

/** Return the raw JSON Schema object for a contract id, or undefined. */
export function getSchema(id: string): JsonSchema | undefined {
    return schemas.find((s) => s.$id === id);
}

/** Compiled ajv validator for a contract id. Throws on unknown id. */
export function getValidator(id: string): ValidateFunction {
    const validator = ajv.getSchema(id);
    if (!validator) {
        throw new Error(`Unknown contract schema id: ${id}. Known ids: ${SCHEMA_IDS.join(', ')}`);
    }
    return validator as ValidateFunction;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Decode the authoritative UTC millisecond timestamp embedded in a UUIDv7 event id. */
export function uuidV7TimestampMs(id: string): number {
    if (!UUID_V7.test(id)) throw new Error(`Expected UUIDv7 event id, got: ${id}`);
    return Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
}

export interface ValidationResult {
    valid: boolean;
    errors: ErrorObject[];
}

/** Validate data against a contract schema. Never throws on invalid data. */
export function validate(id: string, data: unknown): ValidationResult {
    const validator = getValidator(id);
    const valid = validator(data) as boolean;
    return { valid, errors: valid ? [] : validator.errors ?? [] };
}

/** Validate and throw a readable error if invalid. */
export function assertValid(id: string, data: unknown): void {
    const { valid, errors } = validate(id, data);
    if (!valid) {
        const detail = errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
        throw new Error(`Contract ${id} validation failed: ${detail}`);
    }
}

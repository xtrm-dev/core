import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import AjvImport from 'ajv';
import { SpecV1Schema, toJSONSchemaV1, CURRENT_SCHEMA_VERSION } from '../spec/schema.js';

// ajv ships as CJS; under NodeNext the default export is the constructor at runtime
// but TS resolves it as a namespace. Cast through unknown to recover the constructor.
type AjvValidate = ((data: unknown) => boolean) & { errors?: unknown };
type AjvCtor = new (opts?: Record<string, unknown>) => {
    compile: (schema: unknown) => AjvValidate;
};
const Ajv = AjvImport as unknown as AjvCtor;

const repo = resolve(import.meta.dirname, '../..');
const committedSchemaPath = resolve(repo, 'src/spec/schema.json');
const examplePath = resolve(repo, '../docs/specs/EXAMPLE.yaml');

describe('spec v1 schema', () => {
    it('CURRENT_SCHEMA_VERSION is 1', () => {
        expect(CURRENT_SCHEMA_VERSION).toBe(1);
    });

    it('committed schema.json is byte-identical to generated (drift check)', () => {
        const committed = readFileSync(committedSchemaPath, 'utf8');
        const generated = JSON.stringify(toJSONSchemaV1(), null, 2) + '\n';
        expect(committed).toBe(generated);
    });

    it('JSON Schema compiles under ajv strict mode', () => {
        const ajv = new Ajv({ strict: true, allErrors: true });
        const compiled = ajv.compile(toJSONSchemaV1());
        expect(typeof compiled).toBe('function');
    });

    it('EXAMPLE.yaml parses and validates against zod schema', () => {
        const raw = readFileSync(examplePath, 'utf8');
        const parsed = parseYaml(raw);
        const result = SpecV1Schema.safeParse(parsed);
        if (!result.success) {
            throw new Error('zod validation failed: ' + JSON.stringify(result.error.issues, null, 2));
        }
        expect(result.data.schema_version).toBe(1);
        expect(result.data.id).toBe('auth-refresh-hardening');
    });

    it('EXAMPLE.yaml also validates against generated JSON Schema (ajv)', () => {
        const ajv = new Ajv({ strict: true, allErrors: true });
        const validate = ajv.compile(toJSONSchemaV1());
        const parsed = parseYaml(readFileSync(examplePath, 'utf8'));
        const ok = validate(parsed);
        if (!ok) {
            throw new Error('ajv validation failed: ' + JSON.stringify(validate.errors, null, 2));
        }
        expect(ok).toBe(true);
    });

    it('rejects a spec missing required fields', () => {
        const result = SpecV1Schema.safeParse({ schema_version: 1, id: 'x', title: 't' });
        expect(result.success).toBe(false);
    });

    it('rejects a non-kebab id', () => {
        const result = SpecV1Schema.safeParse({
            schema_version: 1,
            id: 'NotKebab',
            title: 't',
            status: 'draft',
            scrutiny: 'low',
            problem: 'p',
            success: ['s'],
            scope: { include: ['x'] },
            requirements: [{ id: 'R1', story: 's', behavior: 'b', acceptance: ['a'] }],
        });
        expect(result.success).toBe(false);
    });
});

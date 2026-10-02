import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SCHEMA_IDS, SCHEMA_ID, validate, getSchema, isValid, uuidV7TimestampMs } from '../src/index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const golden = JSON.parse(readFileSync(path.join(fixturesDir, 'golden.json'), 'utf8')) as Record<string, unknown>;
const invalid = JSON.parse(readFileSync(path.join(fixturesDir, 'invalid.json'), 'utf8')) as Record<string, unknown>;

describe('@xtrm/contracts registry', () => {
    it('exposes every declared SCHEMA_ID as a loadable schema', () => {
        for (const id of Object.values(SCHEMA_ID)) {
            expect(SCHEMA_IDS, `SCHEMA_ID.${id} missing from loaded schemas`).toContain(id);
            expect(getSchema(id), `schema ${id} not loadable`).toBeTruthy();
        }
    });

    it('bundled schema set exactly matches schemas/*.json (src/schemas.ts has no drift)', () => {
        const schemasDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
        const onDisk = readdirSync(schemasDir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => (JSON.parse(readFileSync(path.join(schemasDir, f), 'utf8')) as { $id: string }).$id)
            .sort();
        expect([...SCHEMA_IDS].sort()).toEqual(onDisk);
    });

    it('loaded schema set exactly matches the SCHEMA_ID constants (no orphans, no gaps)', () => {
        expect([...SCHEMA_IDS].sort()).toEqual([...Object.values(SCHEMA_ID)].sort());
    });

    it('every schema ships a golden + invalid fixture', () => {
        for (const id of SCHEMA_IDS) {
            expect(golden, `golden fixture missing for ${id}`).toHaveProperty(id);
            expect(invalid, `invalid fixture missing for ${id}`).toHaveProperty(id);
        }
    });
});

describe('golden fixtures validate', () => {
    for (const id of SCHEMA_IDS) {
        it(`accepts the golden payload for ${id}`, () => {
            const result = validate(id, golden[id]);
            expect(result.errors, `${id}: ${JSON.stringify(result.errors)}`).toEqual([]);
            expect(result.valid).toBe(true);
        });
    }
});

describe('invalid fixtures are rejected', () => {
    for (const id of SCHEMA_IDS) {
        it(`rejects the fabricated invalid payload for ${id}`, () => {
            expect(validate(id, invalid[id]).valid).toBe(false);
        });
    }
});

describe('Beads lifecycle event contract', () => {
    const id = 'xtrm.beads.lifecycle-event.v1';
    const base = {
        schema_version: id,
        source: 'beads.events',
        id: '019f847d-530b-77a1-9603-25eeeae6ea27',
        issue_id: 'xtrm-etmv4.2',
        actor: 'jaggerxtrm',
        old_value: { status: 'open' },
        new_value: { status: 'in_progress' },
        comment: null,
        created_at: '2026-07-21T13:43:53Z',
        occurred_at_ms: 1784634233611,
        timestamp_source: 'uuidv7',
    };

    it.each(['created', 'claimed', 'updated', 'closed', 'reopened', 'status_changed'])('accepts %s', (event_type) => {
        expect(validate(id, { ...base, event_type }).valid).toBe(true);
    });

    it('rejects legacy imperative aliases and hook sources', () => {
        expect(validate(id, { ...base, event_type: 'claim' }).valid).toBe(false);
        expect(validate(id, { ...base, event_type: 'claimed', source: 'xtrm-hook' }).valid).toBe(false);
    });

    it('derives UTC milliseconds from the UUIDv7 identity', () => {
        expect(uuidV7TimestampMs(base.id)).toBe(base.occurred_at_ms);
        expect(() => uuidV7TimestampMs('not-a-uuidv7')).toThrow(/UUIDv7/);
    });
});

describe('aggregated topology projection contract', () => {
    const id = SCHEMA_ID.topologyProjection;
    const base = () => structuredClone(golden[id]) as Record<string, any>;

    it('rejects an unknown top-level property', () => {
        expect(validate(id, { ...base(), cached_at_ms: 1 }).valid).toBe(false);
    });

    it.each(['schema_version', 'generated_at_ms', 'host', 'sources', 'panes', 'orphans'])(
        'rejects a payload missing %s',
        (key) => {
            const payload = base();
            delete payload[key];
            expect(validate(id, payload).valid).toBe(false);
        },
    );

    // The audit's hardest P2-06 rule: pane capture is diagnostic, and must never be
    // journalled or persisted. Enforcing it by `additionalProperties: false` means a
    // producer CANNOT smuggle terminal text through this contract even by accident —
    // the guarantee survives a careless future edit, which a code comment would not.
    it.each(['content', 'capture', 'preview', 'output', 'terminal_text'])(
        'refuses to carry pane content in a %s field',
        (field) => {
            const payload = base();
            payload.panes[0][field] = 'some captured terminal text';
            expect(validate(id, payload).valid).toBe(false);
        },
    );

    it('refuses pane content nested under the agent block', () => {
        const payload = base();
        payload.panes[0].agent.capture = 'terminal text';
        expect(validate(id, payload).valid).toBe(false);
    });

    it('accepts a fully degraded projection (every source down, no panes)', () => {
        const names = ['xtmux', 'tmux', 'specialists', 'beads', 'git', 'github'];
        expect(
            validate(id, {
                schema_version: id,
                generated_at_ms: 1,
                host: { host_id: 'h' },
                sources: names.map((name) => ({
                    name,
                    status: 'unavailable',
                    reason: `${name} not found on PATH`,
                    duration_ms: 0,
                })),
                panes: [],
                orphans: { jobs: [], worktrees: [] },
            }).valid,
        ).toBe(true);
    });

    it('requires a reason slot on every source entry so ok/unavailable stay distinguishable', () => {
        const payload = base();
        delete payload.sources[0].reason;
        expect(validate(id, payload).valid).toBe(false);
    });

    it('rejects an unknown source name rather than silently accepting a typo', () => {
        const payload = base();
        payload.sources[0].name = 'xtmuxx';
        expect(validate(id, payload).valid).toBe(false);
    });

    it('accepts a pane with no agent lineage (a plain shell)', () => {
        const payload = base();
        expect(validate(id, payload).valid).toBe(true);
        expect(payload.panes[1].agent).toBeNull();
    });
});

describe('validator behavior', () => {
    it('bounds command outcomes and rejects fields that could smuggle raw runtime content', () => {
        const id = 'xtrm.command-outcome.v1';
        const payload = structuredClone(golden[id]) as Record<string, any>;

        expect(validate(id, payload).valid).toBe(true);
        expect(validate(id, { ...payload, prompt: 'untrusted turn body' }).valid).toBe(false);
        expect(validate(id, { ...payload, summary: 'x'.repeat(241) }).valid).toBe(false);

        payload.next_actions[0].argv[1] = 'attach\n--unexpected';
        expect(validate(id, payload).valid).toBe(false);
    });

    it('rejects a fabricated invalid pi-extension manifest (audit acceptance criterion)', () => {
        const fabricated = {
            schema_version: 'xtrm.pi-extension-manifest.v1',
            active: [{ id: 'evil', displayName: 'evil', required: 'not-a-boolean' }],
            disabled: { foo: '' },
        };
        const { valid, errors } = validate(SCHEMA_ID.piExtensionManifest, fabricated);
        expect(valid).toBe(false);
        expect(errors.length).toBeGreaterThan(0);
    });

    it('isValid narrows a valid runtime-origin payload', () => {
        expect(isValid(SCHEMA_ID.runtimeOrigin, golden[SCHEMA_ID.runtimeOrigin])).toBe(true);
        expect(isValid(SCHEMA_ID.runtimeOrigin, { nope: true })).toBe(false);
    });

    it('throws on an unknown schema id', () => {
        expect(() => validate('xtrm.not-a-real-schema.v1', {})).toThrow(/Unknown contract schema id/);
    });
});

import { describe, it, expect } from 'vitest';
import { validate, type ErrorCode } from '../spec/validate.js';
import { inferScrutiny, raiseScrutiny } from '../spec/scrutiny.js';
import type { SpecV1 } from '../spec/schema.js';

function goodSpec(overrides: Partial<SpecV1> = {}): SpecV1 {
    return {
        schema_version: 1,
        id: 'good-spec',
        title: 'Good spec',
        status: 'draft',
        scrutiny: 'medium',
        problem: 'A real problem worth solving',
        success: ['Observable end state holds'],
        scope: { include: ['cli/src/foo/bar.ts'], exclude: [] },
        non_goals: [],
        constraints: [],
        requirements: [
            {
                id: 'R1',
                story: 'User does X',
                behavior: 'CLI command exits with code 0 on success',
                acceptance: ['Exit code is 0 when input is valid'],
                layer_hint: 'shell',
            },
        ],
        validation: [],
        dependencies: [],
        open_questions: [],
        links: { children: [], test_issues: [] },
        ...overrides,
    } as SpecV1;
}

function codes(result: { errors: { code: ErrorCode }[]; warnings: { code: ErrorCode }[] }): Set<ErrorCode> {
    return new Set([...result.errors, ...result.warnings].map((i) => i.code));
}

describe('validate — happy path', () => {
    it('accepts a well-formed spec', () => {
        const r = validate(goodSpec());
        expect(r.ok).toBe(true);
        expect(r.errors).toHaveLength(0);
    });
});

describe('validate — schema gate', () => {
    it('rejects garbage input with schema_invalid', () => {
        const r = validate({ not: 'a spec' });
        expect(r.ok).toBe(false);
        expect(codes(r).has('schema_invalid')).toBe(true);
    });
});

describe('validate — scope vagueness', () => {
    it.each([
        ['src/'],
        ['all'],
        ['everything'],
        ['**/*'],
        ['foo'],
    ])('rejects vague scope entry %s', (entry) => {
        const r = validate(goodSpec({ scope: { include: [entry], exclude: [] } }));
        expect(codes(r).has('scope_too_vague')).toBe(true);
    });

    it('accepts a specific path', () => {
        const r = validate(goodSpec({ scope: { include: ['cli/src/spec/validate.ts'], exclude: [] } }));
        expect(codes(r).has('scope_too_vague')).toBe(false);
    });
});

describe('validate — requirement testability', () => {
    it('rejects vague acceptance words', () => {
        const r = validate(
            goodSpec({
                requirements: [
                    {
                        id: 'R1',
                        story: 's',
                        behavior: 'b',
                        acceptance: ['It looks good and is appropriate'],
                        layer_hint: 'core',
                    },
                ],
            }),
        );
        expect(codes(r).has('requirement_untestable')).toBe(true);
    });

    it('accepts concrete acceptance', () => {
        const r = validate(
            goodSpec({
                requirements: [
                    {
                        id: 'R1',
                        story: 's',
                        behavior: 'b',
                        acceptance: ['Exit code is 0 after one retry'],
                        layer_hint: 'shell',
                    },
                ],
            }),
        );
        expect(codes(r).has('requirement_untestable')).toBe(false);
    });
});

describe('validate — layer hints', () => {
    it('warns when layer_hint missing but inferable', () => {
        const r = validate(
            goodSpec({
                requirements: [
                    {
                        id: 'R1',
                        story: 'CLI command runs',
                        behavior: 'Subcommand emits exit code 0 to stdout',
                        acceptance: ['Exit code 0 confirmed'],
                    },
                ],
            }),
        );
        expect(codes(r).has('layer_missing')).toBe(true);
        expect(r.inferred.layer_hints?.R1).toBe('shell');
    });

    it('errors when layer_hint missing and not inferable', () => {
        const r = validate(
            goodSpec({
                requirements: [
                    {
                        id: 'R1',
                        story: 'Something happens',
                        behavior: 'Something else',
                        acceptance: ['Observable thing X'],
                    },
                ],
            }),
        );
        expect(r.ok).toBe(false);
        expect(codes(r).has('layer_missing')).toBe(true);
    });
});

describe('validate — dependency cycles', () => {
    it('detects A→B→A cycle', () => {
        const r = validate(
            goodSpec({
                requirements: [
                    { id: 'R1', story: 's', behavior: 'CLI behavior', acceptance: ['Exit 0'], layer_hint: 'shell' },
                    { id: 'R2', story: 's', behavior: 'CLI behavior', acceptance: ['Exit 0'], layer_hint: 'shell' },
                ],
                dependencies: [
                    { from: 'R1', requires: 'R2' },
                    { from: 'R2', requires: 'R1' },
                ],
            }),
        );
        expect(codes(r).has('cycle_detected')).toBe(true);
    });

    it('detects A→B→C→A cycle', () => {
        const reqs: SpecV1['requirements'] = ['R1', 'R2', 'R3'].map((id) => ({
            id,
            story: 's',
            behavior: 'CLI behavior',
            acceptance: ['Exit 0'],
            layer_hint: 'shell' as const,
        }));
        const r = validate(
            goodSpec({
                requirements: reqs,
                dependencies: [
                    { from: 'R1', requires: 'R2' },
                    { from: 'R2', requires: 'R3' },
                    { from: 'R3', requires: 'R1' },
                ],
            }),
        );
        expect(codes(r).has('cycle_detected')).toBe(true);
    });

    it('accepts acyclic chain', () => {
        const reqs: SpecV1['requirements'] = ['R1', 'R2', 'R3'].map((id) => ({
            id,
            story: 's',
            behavior: 'CLI behavior',
            acceptance: ['Exit 0'],
            layer_hint: 'shell' as const,
        }));
        const r = validate(
            goodSpec({
                requirements: reqs,
                dependencies: [
                    { from: 'R2', requires: 'R1' },
                    { from: 'R3', requires: 'R2' },
                ],
            }),
        );
        expect(codes(r).has('cycle_detected')).toBe(false);
    });
});

describe('validate — SCRUTINY inference', () => {
    it('raises low → high on auth scope keyword', () => {
        const r = validate(goodSpec({
            scrutiny: 'low',
            scope: { include: ['cli/src/auth/refresh.ts'], exclude: [] },
        }));
        expect(r.inferred.scrutiny?.inferred).toBe('high');
        expect(r.inferred.scrutiny?.effective).toBe('high');
    });

    it('does not lower an explicit high', () => {
        const r = validate(goodSpec({ scrutiny: 'high' }));
        expect(r.inferred.scrutiny?.effective).toBe('high');
    });

    it('raises low → medium on >10 requirements', () => {
        const many: SpecV1['requirements'] = Array.from({ length: 11 }, (_, i) => ({
            id: `R${i + 1}`,
            story: 's',
            behavior: 'CLI behavior',
            acceptance: ['Exit 0'],
            layer_hint: 'shell' as const,
        }));
        const r = validate(goodSpec({ scrutiny: 'low', requirements: many }));
        expect(r.inferred.scrutiny?.inferred).toBe('medium');
    });

    it('emits warning when inferred raises explicit', () => {
        const r = validate(goodSpec({
            scrutiny: 'low',
            scope: { include: ['cli/src/auth/login.ts'], exclude: [] },
        }));
        expect(codes(r).has('scrutiny_lower_than_inferred')).toBe(true);
    });

    it('floor function is monotonic', () => {
        expect(raiseScrutiny('low', 'high')).toBe('high');
        expect(raiseScrutiny('high', 'low')).toBe('high');
        expect(raiseScrutiny('medium', 'critical')).toBe('critical');
        expect(raiseScrutiny('critical', 'high')).toBe('critical');
    });

    it('inferScrutiny is a pure function (no side effects on input)', () => {
        const s = goodSpec();
        const snapshot = JSON.stringify(s);
        inferScrutiny(s);
        expect(JSON.stringify(s)).toBe(snapshot);
    });
});

describe('validate — open questions for high/critical', () => {
    it('rejects unresolved open questions when effective scrutiny is high', () => {
        const r = validate(goodSpec({
            scrutiny: 'high',
            open_questions: ['Is the auth backend rotating tokens?'],
        }));
        expect(codes(r).has('open_question_unresolved')).toBe(true);
        expect(r.ok).toBe(false);
    });

    it('allows open questions at medium scrutiny', () => {
        const r = validate(goodSpec({ scrutiny: 'medium', open_questions: ['minor q'] }));
        expect(codes(r).has('open_question_unresolved')).toBe(false);
    });
});

describe('validate — purity', () => {
    it('module has no fs/http/spawn references', async () => {
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const root = resolve(import.meta.dirname, '../spec');
        for (const file of ['validate.ts', 'scrutiny.ts', 'checks.ts']) {
            const src = readFileSync(resolve(root, file), 'utf8');
            expect(src).not.toMatch(/from ['"]node:fs['"]/);
            expect(src).not.toMatch(/from ['"]node:http/);
            expect(src).not.toMatch(/from ['"]node:child_process['"]/);
        }
    });
});

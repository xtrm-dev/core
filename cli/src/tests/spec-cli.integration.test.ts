import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SpecV1Schema } from '../spec/schema.js';

const cliRoot = resolve(import.meta.dirname, '../..');
const dist = resolve(cliRoot, 'dist/index.cjs');

function ensureBuilt() {
    if (!existsSync(dist)) {
        execSync('npm run build', { cwd: cliRoot, stdio: 'inherit' });
    }
}

function withTmp<T>(fn: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'xt-spec-'));
    try {
        return fn(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

function runCli(args: string[], cwd: string) {
    return spawnSync('node', [dist, ...args], { cwd, encoding: 'utf8' });
}

function parseStderrLogs(stderr: string): Array<Record<string, unknown>> {
    return stderr
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .map((l) => JSON.parse(l));
}

describe('xt spec draft + validate (integration)', () => {
    beforeAll(() => ensureBuilt());

    it('draft writes a spec.yaml that parses + zod-validates', () => {
        withTmp((dir) => {
            const r = runCli(['spec', 'draft', 'Auth refresh hardening', '--template', 'minimal'], dir);
            expect(r.status).toBe(0);
            const out = resolve(dir, 'docs/specs/auth-refresh-hardening/spec.yaml');
            expect(existsSync(out)).toBe(true);
            const parsed = parseYaml(readFileSync(out, 'utf8'));
            const shape = SpecV1Schema.safeParse(parsed);
            expect(shape.success).toBe(true);

            const logs = parseStderrLogs(r.stderr);
            const draftEvt = logs.find((e) => e.event === 'spec_drafted');
            expect(draftEvt).toBeDefined();
            expect(draftEvt!.spec_id).toBe('auth-refresh-hardening');
        });
    });

    it('draft refuses without --force when file exists', () => {
        withTmp((dir) => {
            runCli(['spec', 'draft', 'Sample feature', '--template', 'minimal'], dir);
            const r = runCli(['spec', 'draft', 'Sample feature', '--template', 'minimal'], dir);
            expect(r.status).toBe(1);
            expect(r.stderr).toMatch(/already exists/);
        });
    });

    it('draft overwrites with --force', () => {
        withTmp((dir) => {
            const first = runCli(['spec', 'draft', 'Sample feature', '--template', 'minimal'], dir);
            expect(first.status).toBe(0);
            const r = runCli(['spec', 'draft', 'Sample feature', '--template', 'full', '--force'], dir);
            expect(r.status).toBe(0);
        });
    });

    it('validate (good spec) exits 0 with json schema xt.spec.validate.v1', () => {
        withTmp((dir) => {
            const goodPath = resolve(import.meta.dirname, '../../../docs/specs/EXAMPLE.yaml');
            const r = runCli(['spec', 'validate', goodPath, '--json'], dir);
            expect(r.status).toBe(0);
            const report = JSON.parse(r.stdout);
            expect(report.schema).toBe('xt.spec.validate.v1');
            expect(report.ok).toBe(true);
            expect(report.errors).toEqual([]);
        });
    });

    it('validate (bad spec — cycle) exits 1 with cycle_detected error code', () => {
        withTmp((dir) => {
            const bad = `schema_version: 1
id: bad-cycle
title: Bad cycle
status: draft
scrutiny: medium
problem: P
success:
  - End-state
scope:
  include:
    - cli/src/foo/bar.ts
non_goals: []
constraints: []
requirements:
  - id: R1
    story: s
    behavior: CLI exits 0
    acceptance: ["Exit 0"]
    layer_hint: shell
  - id: R2
    story: s
    behavior: CLI exits 0
    acceptance: ["Exit 0"]
    layer_hint: shell
dependencies:
  - {from: R1, requires: R2}
  - {from: R2, requires: R1}
open_questions: []
validation: []
links: {parent_epic: null, planner_bead: null, epic: null, children: [], test_issues: []}
`;
            const p = resolve(dir, 'bad.yaml');
            writeFileSync(p, bad);
            const r = runCli(['spec', 'validate', p, '--json'], dir);
            expect(r.status).toBe(1);
            const report = JSON.parse(r.stdout);
            expect(report.ok).toBe(false);
            const hasCycle = report.errors.some((e: { code: string }) => e.code === 'cycle_detected');
            expect(hasCycle).toBe(true);
        });
    });

    it('validate (good with warnings) exits 2 if --strict not set and warnings present', () => {
        withTmp((dir) => {
            const warn = `schema_version: 1
id: warn-spec
title: Warning case
status: draft
scrutiny: low
problem: P
success:
  - End-state
scope:
  include:
    - cli/src/auth/login.ts
non_goals: []
constraints: []
requirements:
  - id: R1
    story: s
    behavior: CLI exits 0
    acceptance: ["Exit 0"]
    layer_hint: shell
dependencies: []
open_questions: []
validation: []
links: {parent_epic: null, planner_bead: null, epic: null, children: [], test_issues: []}
`;
            const p = resolve(dir, 'warn.yaml');
            writeFileSync(p, warn);
            const r = runCli(['spec', 'validate', p, '--json'], dir);
            // scrutiny raised low → high; that's a warning. No errors expected.
            const report = JSON.parse(r.stdout);
            const warnHit = report.warnings.some((w: { code: string }) => w.code === 'scrutiny_lower_than_inferred');
            expect(warnHit).toBe(true);
            expect(r.status).toBe(2);
        });
    });

    it('validate emits spec_validated log line with required fields', () => {
        withTmp((dir) => {
            const goodPath = resolve(import.meta.dirname, '../../../docs/specs/EXAMPLE.yaml');
            const r = runCli(['spec', 'validate', goodPath], dir);
            const logs = parseStderrLogs(r.stderr);
            const evt = logs.find((e) => e.event === 'spec_validated');
            expect(evt).toBeDefined();
            for (const key of ['ok', 'error_count', 'warning_count', 'duration_ms']) {
                expect(evt).toHaveProperty(key);
            }
        });
    });

    it('validate refuses missing file with exit 64', () => {
        withTmp((dir) => {
            const r = runCli(['spec', 'validate', resolve(dir, 'nonexistent.yaml')], dir);
            expect(r.status).toBe(64);
        });
    });
});

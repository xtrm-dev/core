import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const cliRoot = resolve(import.meta.dirname, '../..');
const dist = resolve(cliRoot, 'dist/index.cjs');

interface MockBdConfig {
    /** key = bd id, value = status reported by bd show */
    statuses: Record<string, string>;
    /** key = kv key, value = kv value */
    kv?: Record<string, string>;
    /** epic id → children list returned by `bd children <id>` */
    children?: Record<string, string[]>;
}

function withRepo<T>(cfg: MockBdConfig, fn: (dir: string, env: NodeJS.ProcessEnv) => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'xt-spec-archive-'));
    try {
        const bdPath = join(dir, 'mock-bd.sh');
        writeFileSync(bdPath, `#!/usr/bin/env bash
case "$1" in
  show)
    case "$2" in
${Object.entries(cfg.statuses).map(([id, status]) => `      ${id}) echo '{"id":"${id}","status":"${status}"}'; exit 0 ;;`).join('\n')}
    esac
    exit 1
    ;;
  kv)
    case "$2" in
      get)
        case "$3" in
${Object.entries(cfg.kv ?? {}).map(([k, v]) => `          ${k}) echo '${v}'; exit 0 ;;`).join('\n')}
        esac
        exit 1
        ;;
    esac
    ;;
  children)
    case "$2" in
${Object.entries(cfg.children ?? {}).map(([id, kids]) => `      ${id}) echo '${JSON.stringify(kids.map((k) => ({ id: k })))}'; exit 0 ;;`).join('\n')}
    esac
    echo '[]'
    exit 0
    ;;
  dep)
    echo '[]'
    exit 0
    ;;
esac
exit 0
`);
        chmodSync(bdPath, 0o755);
        return fn(dir, { ...process.env, XT_SPEC_BD_BINARY: bdPath });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

function writeSpec(dir: string, overrides: { status?: string; scrutiny?: string; links?: Record<string, unknown> }): string {
    const yaml = `schema_version: 1
id: archive-test
title: Archive test spec
status: ${overrides.status ?? 'planned'}
scrutiny: ${overrides.scrutiny ?? 'medium'}
problem: Some problem
success:
  - End-state holds
scope:
  include:
    - cli/src/foo/bar.ts
  exclude: []
non_goals: []
constraints: []
requirements:
  - id: R1
    story: s
    behavior: CLI exits 0
    acceptance: ["Exit 0"]
    layer_hint: shell
validation: []
dependencies: []
open_questions: []
links:
  parent_epic: null
  planner_bead: ${(overrides.links?.planner_bead as string) ?? 'null'}
  epic: ${(overrides.links?.epic as string) ?? 'null'}
  children: ${JSON.stringify((overrides.links?.children as unknown[]) ?? [])}
  test_issues: ${JSON.stringify((overrides.links?.test_issues as unknown[]) ?? [])}
`;
    const p = join(dir, 'spec.yaml');
    writeFileSync(p, yaml);
    return p;
}

function runArchive(p: string, env: NodeJS.ProcessEnv) {
    return spawnSync('node', [dist, 'spec', 'archive', p, '--json'], { encoding: 'utf8', env });
}

describe('xt spec archive gate', () => {
    it('refuses if epic is open', () => {
        withRepo({
            statuses: { 'epic-1': 'open', 'epic-1.1': 'closed' },
        }, (dir, env) => {
            const p = writeSpec(dir, { links: { epic: 'epic-1', planner_bead: 'plan-1', children: ['epic-1.1'], test_issues: [] } });
            const r = runArchive(p, env);
            expect(r.status).toBe(1);
            const report = JSON.parse(r.stdout);
            expect(report.failures.some((f: { code: string }) => f.code === 'epic_open')).toBe(true);
        });
    });

    it('refuses if any child is open', () => {
        withRepo({
            statuses: { 'epic-1': 'closed', 'epic-1.1': 'open' },
        }, (dir, env) => {
            const p = writeSpec(dir, { links: { epic: 'epic-1', planner_bead: 'plan-1', children: ['epic-1.1'], test_issues: [] } });
            const r = runArchive(p, env);
            const report = JSON.parse(r.stdout);
            expect(report.failures.some((f: { code: string }) => f.code === 'child_open')).toBe(true);
        });
    });

    it('refuses high-scrutiny without review evidence', () => {
        withRepo({
            statuses: { 'epic-1': 'closed', 'epic-1.1': 'closed', 'plan-1': 'closed' },
        }, (dir, env) => {
            const p = writeSpec(dir, {
                scrutiny: 'high',
                links: { epic: 'epic-1', planner_bead: 'plan-1', children: ['epic-1.1'], test_issues: [] },
            });
            const r = runArchive(p, env);
            const report = JSON.parse(r.stdout);
            expect(report.failures.some((f: { code: string }) => f.code === 'review_missing')).toBe(true);
        });
    });

    it('passes high-scrutiny when review evidence is present', () => {
        withRepo({
            statuses: { 'epic-1': 'closed', 'epic-1.1': 'closed', 'plan-1': 'closed' },
            kv: { 'reviewed:epic-1': 'reviewer-job-xyz PASS' },
            children: { 'epic-1': ['epic-1.1'] },
        }, (dir, env) => {
            const p = writeSpec(dir, {
                scrutiny: 'high',
                links: { epic: 'epic-1', planner_bead: 'plan-1', children: ['epic-1.1'], test_issues: [] },
            });
            const r = runArchive(p, env);
            expect(r.status).toBe(0);
            const updated = parseYaml(readFileSync(p, 'utf8'));
            expect(updated.status).toBe('archived');
            const snap = join(dir, 'archive/archive-test.yaml');
            expect(existsSync(snap)).toBe(true);
        });
    });

    it('refuses already-archived spec', () => {
        withRepo({
            statuses: { 'epic-1': 'closed' },
        }, (dir, env) => {
            const p = writeSpec(dir, {
                status: 'archived',
                links: { epic: 'epic-1', planner_bead: 'plan-1', children: [], test_issues: [] },
            });
            const r = runArchive(p, env);
            const report = JSON.parse(r.stdout);
            expect(report.failures.some((f: { code: string }) => f.code === 'already_archived')).toBe(true);
        });
    });

    it('refuses if epic link is missing', () => {
        withRepo({ statuses: {} }, (dir, env) => {
            const p = writeSpec(dir, { links: { epic: 'null', planner_bead: 'null', children: [], test_issues: [] } });
            const r = runArchive(p, env);
            const report = JSON.parse(r.stdout);
            expect(report.failures.some((f: { code: string }) => f.code === 'epic_missing')).toBe(true);
        });
    });
});

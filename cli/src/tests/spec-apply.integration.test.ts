import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const cliRoot = resolve(import.meta.dirname, '../..');
const dist = resolve(cliRoot, 'dist/index.cjs');

function ensureBuilt() {
    if (!existsSync(dist)) {
        execSync('npm run build', { cwd: cliRoot, stdio: 'inherit' });
    }
}

interface MockEnv {
    bdLog: string;     // path where mock-bd appends its argv
    spLog: string;     // path where mock-sp appends its argv
}

function withMockRepo<T>(fn: (dir: string, env: NodeJS.ProcessEnv & MockEnv) => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'xt-spec-apply-'));
    try {
        // Make the dir look like a git repo so findRepoRoot returns it.
        mkdirSync(join(dir, '.git'), { recursive: true });

        // Skill files containing every capability matrix marker so probe passes.
        mkdirSync(join(dir, '.xtrm/skills/default/planning'), { recursive: true });
        mkdirSync(join(dir, '.xtrm/skills/default/test-planning'), { recursive: true });
        writeFileSync(join(dir, '.xtrm/skills/default/planning/SKILL.md'), `
# planning
bd swarm validate
bd mol pour <formula>
<change-contract>...</change-contract>
recommended_template: code-standard
bd dep add a b --type validates
SCRUTINY: high
`);
        writeFileSync(join(dir, '.xtrm/skills/default/test-planning/SKILL.md'), `
# test-planning
bd gate create
core layer / boundary layer / shell layer
`);

        // mock bd: handles `create --json` and `show <id> --json`.
        const bdPath = join(dir, 'mock-bd.sh');
        const bdLog = join(dir, 'bd-calls.log');
        writeFileSync(bdPath, `#!/usr/bin/env bash
echo "$@" >> "${bdLog}"
case "$1" in
  create)
    echo '{"id":"unitTEST-plan-001","title":"Plan: mock","type":"task"}'
    exit 0
    ;;
  show)
    echo '{"id":"'$2'","status":"open"}'
    exit 0
    ;;
esac
exit 0
`);
        chmodSync(bdPath, 0o755);

        // mock sp: handles `run planner --bead X --background --json` and `result <job> --json`.
        const spPath = join(dir, 'mock-sp.sh');
        const spLog = join(dir, 'sp-calls.log');
        writeFileSync(spPath, `#!/usr/bin/env bash
echo "$@" >> "${spLog}"
case "$1" in
  run)
    echo '{"job_id":"job-abc123","status":"dispatched"}'
    exit 0
    ;;
  result)
    echo '{"epic_id":"unitTEST-epic-9","children":["unitTEST-epic-9.1","unitTEST-epic-9.2"],"test_issues":["unitTEST-epic-9.3"],"first_task":"unitTEST-epic-9.1"}'
    exit 0
    ;;
esac
exit 0
`);
        chmodSync(spPath, 0o755);

        // Copy a golden spec into the repo
        const specSrc = resolve(cliRoot, '../docs/specs/EXAMPLE.yaml');
        const specDir = join(dir, 'docs/specs/example');
        mkdirSync(specDir, { recursive: true });
        const specDest = join(specDir, 'spec.yaml');
        copyFileSync(specSrc, specDest);

        const env: NodeJS.ProcessEnv & MockEnv = {
            ...process.env,
            XT_SPEC_BD_BINARY: bdPath,
            XT_SPEC_SP_BINARY: spPath,
            XT_SPEC_REPO_ROOT: dir,
            bdLog,
            spLog,
        };
        return fn(dir, env);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    return spawnSync('node', [dist, ...args], { cwd, encoding: 'utf8', env });
}

describe('xt spec apply (integration, mocked sp + bd)', () => {
    beforeAll(() => ensureBuilt());

    it('end-to-end: bd create → sp dispatch → sidecar → reconcile → handoff (no auto-claim, no chain approve)', () => {
        withMockRepo((dir, env) => {
            const specPath = join(dir, 'docs/specs/example/spec.yaml');

            // Phase 1: apply
            const apply = run(['spec', 'apply', specPath], dir, env);
            expect(apply.status).toBe(0);
            expect(apply.stdout).toMatch(/planner bead created: unitTEST-plan-001/);
            expect(apply.stdout).toMatch(/planner dispatched: job-abc123/);

            // sidecar written
            const sidecar = join(dir, 'docs/specs/example/.apply-state.json');
            expect(existsSync(sidecar)).toBe(true);
            const state = JSON.parse(readFileSync(sidecar, 'utf8'));
            expect(state.schema).toBe('xt.spec.apply-state.v1');
            expect(state.planner_bead_id).toBe('unitTEST-plan-001');
            expect(state.planner_job_id).toBe('job-abc123');

            // bd was called with create then NOT with update --claim
            const bdCalls = readFileSync(env.bdLog, 'utf8');
            expect(bdCalls).toMatch(/^create /m);
            expect(bdCalls).not.toMatch(/update.*--claim/);

            // sp was called with `run planner` and NOT `chain approve`
            const spCalls = readFileSync(env.spLog, 'utf8');
            expect(spCalls).toMatch(/^run planner --bead unitTEST-plan-001 --background --json/m);
            expect(spCalls).not.toMatch(/chain approve/);

            // Phase 2: reconcile
            const recon = run(['spec', 'apply', specPath, '--reconcile'], dir, env);
            expect(recon.status).toBe(0);
            expect(recon.stdout).toMatch(/reconciled: epic unitTEST-epic-9/);
            expect(recon.stdout).toMatch(/sp chain review unitTEST-epic-9/);
            expect(recon.stdout).not.toMatch(/sp chain approve/);

            // spec.yaml links populated, status flipped
            const updated = parseYaml(readFileSync(specPath, 'utf8'));
            expect(updated.status).toBe('planned');
            expect(updated.links.planner_bead).toBe('unitTEST-plan-001');
            expect(updated.links.epic).toBe('unitTEST-epic-9');
            expect(updated.links.children).toEqual(['unitTEST-epic-9.1', 'unitTEST-epic-9.2']);
            expect(updated.links.test_issues).toEqual(['unitTEST-epic-9.3']);

            // Reconcile is idempotent (byte-identical second run)
            const firstBytes = readFileSync(specPath);
            const second = run(['spec', 'apply', specPath, '--reconcile'], dir, env);
            expect(second.status).toBe(0);
            const secondBytes = readFileSync(specPath);
            expect(secondBytes.equals(firstBytes)).toBe(true);

            // Final guard: confirm no `sp chain approve` was ever invoked across phases
            const finalSpCalls = readFileSync(env.spLog, 'utf8');
            expect(finalSpCalls).not.toMatch(/chain approve/);
        });
    });

    it('refuses with exit 65 if any readiness capability missing', () => {
        withMockRepo((dir, env) => {
            // Wipe the markers so probe fails
            writeFileSync(join(dir, '.xtrm/skills/default/planning/SKILL.md'), '# empty\n');
            const specPath = join(dir, 'docs/specs/example/spec.yaml');
            const r = run(['spec', 'apply', specPath], dir, env);
            expect(r.status).toBe(65);
            expect(r.stderr).toMatch(/readiness probe failed/);
        });
    });
});

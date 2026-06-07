import { Command } from 'commander';
import kleur from 'kleur';
import fs from 'fs-extra';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { findRepoRoot } from '../../utils/repo-root.js';
import { probe } from '../../spec/readiness/probe.js';
import { validate } from '../../spec/validate.js';
import { toChangeContractXml } from '../../spec/transform/to-change-contract.js';
import { dispatchPlanner } from '../../spec/dispatch.js';
import { writeApplyState, sidecarPath } from '../../spec/apply-state.js';
import { logEvent } from '../../spec/log.js';

interface ApplyOptions {
    checkOnly?: boolean;
    json?: boolean;
    /** Print the planner-bead XML to stdout; skip readiness + bd writes. */
    dryRun?: boolean;
    /** Reconcile mode: read sp result for the persisted sidecar and write links back to spec.yaml. */
    reconcile?: boolean;
}

const BD_DESCRIPTION_LIMIT_BYTES = 60_000;

export function createSpecApplyCommand(): Command {
    return new Command('apply')
        .description('Transform a validated spec.yaml into a planner bead and dispatch the planner specialist')
        .argument('<path>', 'Path to spec.yaml')
        .option('--check-only', 'Run readiness probe + validate, do not create any bead', false)
        .option('--json', 'Emit structured JSON output', false)
        .option('--dry-run', 'Print the planner-bead XML to stdout; do not create the bead', false)
        .option('--reconcile', 'Read sp result for the persisted planner job and write links back to spec.yaml', false)
        .action(async (specPath: string, opts: ApplyOptions) => {
            const absPath = path.resolve(specPath);
            if (!(await fs.pathExists(absPath))) {
                console.error(kleur.red(`error: ${absPath} not found`));
                process.exit(64);
            }

            // --reconcile is a separate phase that runs after the planner completes;
            // it does not re-run the readiness probe or re-validate the spec.
            if (opts.reconcile) {
                const { readApplyState } = await import('../../spec/apply-state.js');
                const { reconcile } = await import('../../spec/reconcile.js');
                const state = await readApplyState(absPath);
                if (!state) {
                    console.error(kleur.red('error: no .apply-state.json sidecar found next to ') + absPath);
                    console.error(kleur.dim('  run `xt spec apply <path>` first to create the planner bead and dispatch.'));
                    process.exit(1);
                }
                const result = await reconcile(absPath, state);
                if (!result.ok) {
                    console.error(kleur.red('✗ reconcile failed: ') + result.error);
                    logEvent({ event: 'apply_reconcile_failed', error: result.error, orphan_ids: result.orphan_ids });
                    process.exit(1);
                }
                logEvent({
                    event: 'apply_reconciled',
                    planner_bead_id: state.planner_bead_id,
                    epic_id: result.planner_result!.epic_id,
                    children_count: result.planner_result!.children.length,
                    test_issues_count: result.planner_result!.test_issues.length,
                });
                const { renderReconcileHandoff } = await import('../../spec/handoff.js');
                console.log(renderReconcileHandoff({
                    plannerBeadId: state.planner_bead_id,
                    plannerJobId: state.planner_job_id,
                    epicId: result.planner_result!.epic_id,
                    childrenCount: result.planner_result!.children.length,
                    testIssuesCount: result.planner_result!.test_issues.length,
                }));
                logEvent({
                    event: 'apply_handoff_emitted',
                    epic_id: result.planner_result!.epic_id,
                    next_command: `sp chain review ${result.planner_result!.epic_id}`,
                });
                process.exit(0);
            }

            const repoRoot = process.env.XT_SPEC_REPO_ROOT
                ?? (await findRepoRoot().catch(() => null))
                ?? process.cwd();

            // --dry-run prints XML for inspection; no bd writes; no dispatch.
            // Readiness probe only gates real dispatch (the planner specialist won't
            // produce correct output if the deployed skills don't speak bd-native primitives).
            const probeReport = opts.dryRun ? { ready: true, results: [] as Array<{ present: boolean; capability: { key: string } }> } : await probe(repoRoot);
            if (!probeReport.ready) {
                const missing = probeReport.results.filter((r) => !r.present).map((r) => r.capability.key);
                if (opts.json) {
                    process.stdout.write(JSON.stringify({
                        schema: 'xt.spec.apply.v1',
                        ok: false,
                        phase: 'readiness',
                        missing_capabilities: missing,
                    }, null, 2) + '\n');
                } else {
                    console.error(kleur.red('✗ readiness probe failed — xt spec apply refuses to dispatch.'));
                    console.error(kleur.dim('  Run `xt spec doctor` for the full capability report.'));
                    for (const m of missing) console.error(kleur.dim('   - missing: ' + m));
                }
                logEvent({ event: 'apply_refused', reason: 'readiness', missing_capabilities: missing });
                process.exit(65);
            }

            const raw = await fs.readFile(absPath, 'utf8');
            const parsed = parseYaml(raw);
            const vr = validate(parsed);
            if (!vr.ok) {
                if (opts.json) {
                    process.stdout.write(JSON.stringify({
                        schema: 'xt.spec.apply.v1',
                        ok: false,
                        phase: 'validate',
                        errors: vr.errors,
                    }, null, 2) + '\n');
                } else {
                    console.error(kleur.red('✗ validate failed — apply refuses to dispatch.'));
                    for (const e of vr.errors) console.error(kleur.dim(`   ${e.code} at ${e.field_path}: ${e.message}`));
                }
                logEvent({ event: 'apply_refused', reason: 'validate', error_count: vr.errors.length });
                process.exit(1);
            }

            if (opts.checkOnly) {
                if (opts.json) {
                    process.stdout.write(JSON.stringify({ schema: 'xt.spec.apply.v1', ok: true, phase: 'check-only' }, null, 2) + '\n');
                } else {
                    console.log(kleur.green('✓ readiness + validate passed — xt spec apply is unblocked'));
                }
                process.exit(0);
            }

            const spec = vr.errors.length === 0 && vr.warnings.length >= 0 ? (parsed as ReturnType<typeof Object>) : null;
            // re-parse cleanly via validator return inferred fields
            const effectiveScrutiny = vr.inferred.scrutiny?.effective ?? (parsed as { scrutiny: 'low' | 'medium' | 'high' | 'critical' }).scrutiny;

            const xml = toChangeContractXml({
                spec: parsed as Parameters<typeof toChangeContractXml>[0]['spec'],
                effectiveScrutiny,
                sourcePath: absPath,
            });
            const bytes = Buffer.byteLength(xml, 'utf8');
            if (bytes > BD_DESCRIPTION_LIMIT_BYTES) {
                console.error(kleur.red(`✗ spec_too_large: planner-bead description would be ${bytes} bytes (limit ${BD_DESCRIPTION_LIMIT_BYTES}).`));
                console.error(kleur.dim('  Split the spec into smaller scopes and run xt spec apply on each.'));
                logEvent({ event: 'apply_refused', reason: 'spec_too_large', bytes });
                process.exit(1);
            }

            if (opts.dryRun) {
                process.stdout.write(xml);
                logEvent({ event: 'apply_dry_run', spec_id: (parsed as { id: string }).id, xml_byte_size: bytes });
                process.exit(0);
            }

            const title = `Plan: ${(parsed as { title: string }).title}`;
            const created = bdCreatePlannerBead({ title, description: xml });
            if (!created.ok) {
                console.error(kleur.red('✗ bd create failed:'));
                console.error(created.stderr);
                logEvent({ event: 'apply_planner_bead_create_failed', stderr: created.stderr });
                process.exit(created.exitCode ?? 1);
            }
            logEvent({
                event: 'apply_planner_bead_created',
                spec_id: (parsed as { id: string }).id,
                planner_bead_id: created.id,
                xml_byte_size: bytes,
            });
            console.log(kleur.green('✓ planner bead created: ') + created.id);

            // Phase 2 (xtrm-ai9xl.11) — dispatch planner specialist, persist sidecar.
            const dispatched = dispatchPlanner(created.id!);
            if (!dispatched.ok) {
                console.error(kleur.red('✗ sp dispatch failed:'));
                console.error(dispatched.stderr);
                logEvent({
                    event: 'apply_dispatch_failed',
                    planner_bead_id: created.id,
                    stderr: dispatched.stderr,
                });
                process.exit(dispatched.exit_code ?? 1);
            }
            const state = {
                schema: 'xt.spec.apply-state.v1' as const,
                spec_id: (parsed as { id: string }).id,
                spec_path: absPath,
                planner_bead_id: created.id!,
                planner_job_id: dispatched.job_id!,
                dispatched_at: new Date().toISOString(),
            };
            await writeApplyState(absPath, state);
            logEvent({
                event: 'apply_planner_dispatched',
                planner_bead_id: created.id,
                planner_job_id: dispatched.job_id,
                sidecar_path: sidecarPath(absPath),
            });
            console.log(kleur.green('✓ planner dispatched: ') + dispatched.job_id);
            console.log(kleur.dim('  follow: ') + `sp feed ${dispatched.job_id}`);
            console.log(kleur.dim('  reconcile once planner completes: ') + `xt spec apply ${path.relative(process.cwd(), absPath)} --reconcile`);
            console.log(kleur.dim('  (reconcile + composition handoff land in xtrm-ai9xl.12–.13)'));

            // Suppress unused
            void spec;
        });
}

interface BdCreateResult {
    ok: boolean;
    id?: string;
    stderr?: string;
    exitCode?: number;
}

function bdCreatePlannerBead(args: { title: string; description: string }): BdCreateResult {
    const bd = process.env.XT_SPEC_BD_BINARY ?? 'bd';
    const r = spawnSync(
        bd,
        ['create', '--type', 'task', '--priority', '1', '--title', args.title, '--description', args.description, '--json'],
        { encoding: 'utf8' },
    );
    if (r.status !== 0) {
        return { ok: false, stderr: r.stderr || r.stdout, exitCode: r.status ?? 1 };
    }
    try {
        const parsed = JSON.parse(r.stdout);
        return { ok: true, id: parsed.id };
    } catch {
        return { ok: false, stderr: 'failed to parse bd create JSON output: ' + r.stdout };
    }
}

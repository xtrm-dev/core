import { Command } from 'commander';
import kleur from 'kleur';
import { findRepoRoot } from '../../utils/repo-root.js';
import { probe } from '../../spec/readiness/probe.js';
import { logEvent } from '../../spec/log.js';

interface DoctorOptions {
    json?: boolean;
}

export function createSpecDoctorCommand(): Command {
    return new Command('doctor')
        .description('Check planning + test-planning skill readiness for `xt spec apply`')
        .option('--json', 'Emit a structured JSON report', false)
        .action(async (opts: DoctorOptions) => {
            const repoRoot = process.env.XT_SPEC_REPO_ROOT
                ?? (await findRepoRoot().catch(() => null))
                ?? process.cwd();
            const report = await probe(repoRoot);

            for (const r of report.results) {
                logEvent({
                    event: 'readiness_probe',
                    capability: r.capability.key,
                    present: r.present,
                    required_for: r.capability.required_for,
                    source_file: r.capability.source,
                });
            }

            if (opts.json) {
                process.stdout.write(JSON.stringify(report, null, 2) + '\n');
            } else {
                renderHuman(report);
            }

            process.exit(report.ready ? 0 : 1);
        });
}

function renderHuman(report: { results: { capability: { key: string; title: string; upstream_ref: string }; present: boolean; detail: string }[]; ready: boolean }): void {
    console.log(kleur.bold(`xt spec doctor — planner/test-planning readiness for xt spec apply`));
    for (const r of report.results) {
        const mark = r.present ? kleur.green('✓') : kleur.red('✗');
        console.log(`  ${mark} ${r.capability.title}`);
        if (!r.present) {
            console.log(`     ${kleur.dim('upstream: ' + r.capability.upstream_ref)}`);
            console.log(`     ${kleur.dim(r.detail)}`);
        }
    }
    if (report.ready) {
        console.log(kleur.green('\n✓ all capabilities present — xt spec apply is unblocked'));
    } else {
        const missing = report.results.filter((r) => !r.present).length;
        console.log(kleur.red(`\n✗ ${missing} capability(s) missing — xt spec apply will refuse with exit 65`));
        console.log(kleur.dim('   See docs/specs/UPSTREAM-DEPENDENCIES.md for the alignment plan.'));
    }
}

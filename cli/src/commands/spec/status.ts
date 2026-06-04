import { Command } from 'commander';
import kleur from 'kleur';
import fs from 'fs-extra';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SpecV1Schema } from '../../spec/schema.js';
import { computeStatus, type StatusReport } from '../../spec/drift.js';
import { logEvent } from '../../spec/log.js';

interface StatusOpts {
    json?: boolean;
}

export function createSpecStatusCommand(): Command {
    return new Command('status')
        .description('Compare spec.yaml.links against current bd state and report drift')
        .argument('<path>', 'Path to spec.yaml')
        .option('--json', 'Emit a structured JSON report', false)
        .action(async (specPath: string, opts: StatusOpts) => {
            const absPath = path.resolve(specPath);
            if (!(await fs.pathExists(absPath))) {
                console.error(kleur.red(`error: ${absPath} not found`));
                process.exit(64);
            }
            const parsed = parseYaml(await fs.readFile(absPath, 'utf8'));
            const shape = SpecV1Schema.safeParse(parsed);
            if (!shape.success) {
                console.error(kleur.red('error: spec.yaml does not match schema; run `xt spec validate ' + absPath + '`'));
                process.exit(1);
            }
            const report = await computeStatus(shape.data);
            if (opts.json) {
                process.stdout.write(JSON.stringify(report, null, 2) + '\n');
            } else {
                renderHuman(report);
            }
            logEvent({
                event: 'spec_status',
                spec_id: shape.data.id,
                open_count: report.open_count,
                closed_count: report.closed_count,
                drift_kind: report.drift.map((d) => d.kind),
            });
            if (!report.ok) process.exit(1);
            if (report.warning_only) process.exit(2);
            process.exit(0);
        });
}

function renderHuman(report: StatusReport): void {
    console.log(kleur.bold(`xt spec status: ${report.spec_id}`));
    console.log(kleur.dim(`  spec.status = ${report.spec_status}`));
    console.log(kleur.dim(`  linked: epic=${report.links.epic ?? 'null'}, planner=${report.links.planner_bead ?? 'null'}, children=${report.links.children.length}, tests=${report.links.test_issues.length}`));
    console.log(kleur.dim(`  bd state: ${report.open_count} open, ${report.closed_count} closed`));

    if (report.drift.length === 0) {
        console.log(kleur.green('  ✓ in sync'));
        return;
    }
    for (const d of report.drift) {
        const tag = d.severity === 'error' ? kleur.red('  ✗') : kleur.yellow('  ⚠');
        console.log(`${tag} ${kleur.bold(d.kind)} ${kleur.cyan(d.id)} ${d.detail ?? ''}`);
    }
}

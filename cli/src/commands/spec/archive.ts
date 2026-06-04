import { Command } from 'commander';
import kleur from 'kleur';
import fs from 'fs-extra';
import path from 'node:path';
import { parse as parseYaml, parseDocument } from 'yaml';
import { SpecV1Schema } from '../../spec/schema.js';
import { checkArchiveGate } from '../../spec/archive-gate.js';
import { logEvent } from '../../spec/log.js';

interface ArchiveOpts {
    json?: boolean;
}

export function createSpecArchiveCommand(): Command {
    return new Command('archive')
        .description('Archive a completed spec; refuses unless epic + children are closed (and review evidence for high/critical)')
        .argument('<path>', 'Path to spec.yaml')
        .option('--json', 'Emit a structured JSON report', false)
        .action(async (specPath: string, opts: ArchiveOpts) => {
            const absPath = path.resolve(specPath);
            if (!(await fs.pathExists(absPath))) {
                console.error(kleur.red(`error: ${absPath} not found`));
                process.exit(64);
            }
            const raw = await fs.readFile(absPath, 'utf8');
            const parsed = parseYaml(raw);
            const shape = SpecV1Schema.safeParse(parsed);
            if (!shape.success) {
                console.error(kleur.red('error: spec.yaml does not match schema; run `xt spec validate ' + absPath + '`'));
                process.exit(1);
            }
            const gate = await checkArchiveGate(shape.data);
            if (!gate.ok) {
                if (opts.json) {
                    process.stdout.write(JSON.stringify({ schema: 'xt.spec.archive.v1', ok: false, failures: gate.failures }, null, 2) + '\n');
                } else {
                    console.error(kleur.red('✗ archive refused — gate failures:'));
                    for (const f of gate.failures) {
                        console.error(kleur.red(`  ${f.code}: `) + f.detail);
                    }
                }
                logEvent({ event: 'spec_archive_refused', spec_id: shape.data.id, gates: gate.failures.map((f) => f.code) });
                process.exit(1);
            }

            // Snapshot under <spec-dir>/archive/<slug>.yaml; never overwrites.
            const archiveDir = path.join(path.dirname(absPath), 'archive');
            const snapshot = path.join(archiveDir, `${shape.data.id}.yaml`);
            await fs.ensureDir(archiveDir);
            if (await fs.pathExists(snapshot)) {
                console.error(kleur.red(`error: archive snapshot already exists at ${snapshot}`));
                process.exit(1);
            }
            await fs.writeFile(snapshot, raw, 'utf8');

            // Mutate spec.status = archived in place (preserving comments).
            const doc = parseDocument(raw);
            doc.set('status', 'archived');
            const out = String(doc);
            const tmp = `${absPath}.tmp`;
            await fs.writeFile(tmp, out.endsWith('\n') ? out : out + '\n', 'utf8');
            await fs.rename(tmp, absPath);

            logEvent({ event: 'spec_archived', spec_id: shape.data.id, snapshot });
            console.log(kleur.green('✓ archived: ') + path.relative(process.cwd(), absPath));
            console.log(kleur.dim('  snapshot: ') + path.relative(process.cwd(), snapshot));
            process.exit(0);
        });
}

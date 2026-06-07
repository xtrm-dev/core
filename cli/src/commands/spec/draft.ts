import { Command } from 'commander';
import kleur from 'kleur';
import fs from 'fs-extra';
import path from 'node:path';
import { renderTemplate, type TemplateName } from '../../spec/templates.js';
import { slugify } from '../../spec/slug.js';
import { logEvent } from '../../spec/log.js';
import { SpecV1Schema } from '../../spec/schema.js';
import { parse as parseYaml } from 'yaml';

interface DraftOptions {
    template: TemplateName;
    out?: string;
    force?: boolean;
}

export function createSpecDraftCommand(): Command {
    return new Command('draft')
        .description('Scaffold a spec.yaml from a free-text feature description')
        .argument('<description>', 'Short feature description (becomes title + slug)')
        .option('--template <name>', 'Template variant (minimal|full)', 'full')
        .option('--out <path>', 'Output path; defaults to docs/specs/<slug>/spec.yaml')
        .option('--force', 'Overwrite if the output already exists', false)
        .action(async (description: string, opts: DraftOptions) => {
            const title = description.trim();
            if (!title) {
                console.error(kleur.red('error: description must not be empty'));
                process.exit(64);
            }
            if (opts.template !== 'minimal' && opts.template !== 'full') {
                console.error(kleur.red(`error: --template must be "minimal" or "full" (got "${opts.template}")`));
                process.exit(64);
            }

            const slug = slugify(title);
            const outPath = path.resolve(opts.out ?? path.join('docs/specs', slug, 'spec.yaml'));
            const outDir = path.dirname(outPath);

            if (await fs.pathExists(outPath) && !opts.force) {
                console.error(kleur.red(`error: ${outPath} already exists. Use --force to overwrite.`));
                process.exit(1);
            }

            await fs.ensureDir(outDir);
            // schema URL is the stable $id from cli/src/spec/schema.ts; editors
            // with yaml-language-server resolve it via the schema-store cache.
            const schemaPath = 'https://xtrm.dev/schemas/spec-v1.json';
            const content = renderTemplate(opts.template, { slug, title, schemaPath });

            // Round-trip self-check: drafted yaml must parse and satisfy schema shape
            // (template placeholders are intentional TODO strings — we only verify shape).
            const parsed = parseYaml(content);
            const shapeCheck = SpecV1Schema.safeParse(parsed);
            if (!shapeCheck.success) {
                console.error(kleur.red('internal error: template failed schema shape check'));
                console.error(JSON.stringify(shapeCheck.error.issues, null, 2));
                process.exit(70);
            }

            await fs.writeFile(outPath, content, 'utf8');
            logEvent({ event: 'spec_drafted', spec_id: slug, path: outPath, template: opts.template });

            console.log(kleur.green('✓ drafted ') + outPath);
            console.log(kleur.dim('  next: edit the TODO blocks, then `xt spec validate ' + path.relative(process.cwd(), outPath) + '`'));
        });
}

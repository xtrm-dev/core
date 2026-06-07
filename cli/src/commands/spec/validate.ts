import { Command } from 'commander';
import kleur from 'kleur';
import fs from 'fs-extra';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validate } from '../../spec/validate.js';
import { renderHuman, renderJson } from '../../spec/report.js';
import { logEvent } from '../../spec/log.js';

interface ValidateCmdOptions {
    json?: boolean;
    strict?: boolean;
}

export function createSpecValidateCommand(): Command {
    return new Command('validate')
        .description('Run all gates against a spec.yaml; report errors and warnings')
        .argument('<path>', 'Path to spec.yaml')
        .option('--json', 'Emit a structured JSON report instead of human text', false)
        .option('--strict', 'Treat warnings as errors', false)
        .action(async (specPath: string, opts: ValidateCmdOptions) => {
            const absPath = path.resolve(specPath);
            if (!(await fs.pathExists(absPath))) {
                console.error(kleur.red(`error: ${absPath} not found`));
                process.exit(64);
            }

            const started = Date.now();
            const raw = await fs.readFile(absPath, 'utf8');
            let parsed: unknown;
            try {
                parsed = parseYaml(raw);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (opts.json) {
                    process.stdout.write(JSON.stringify({
                        schema: 'xt.spec.validate.v1',
                        ok: false,
                        source: absPath,
                        errors: [{ code: 'yaml_parse_error', field_path: '(root)', severity: 'error', message: msg }],
                        warnings: [],
                        inferred: {},
                    }, null, 2) + '\n');
                } else {
                    console.error(kleur.red(`yaml parse error: ${msg}`));
                }
                logEvent({ event: 'spec_validated', spec_id: null, ok: false, error_count: 1, warning_count: 0, duration_ms: Date.now() - started, parse_error: true });
                process.exit(1);
            }

            const result = validate(parsed, { strict: opts.strict });

            if (opts.json) {
                process.stdout.write(JSON.stringify(renderJson(result, absPath), null, 2) + '\n');
            } else {
                process.stdout.write(renderHuman(result, absPath) + '\n');
            }

            const specId = (parsed && typeof parsed === 'object' && 'id' in parsed) ? (parsed as { id?: unknown }).id ?? null : null;
            logEvent({
                event: 'spec_validated',
                spec_id: specId,
                ok: result.ok,
                error_count: result.errors.length,
                warning_count: result.warnings.length,
                duration_ms: Date.now() - started,
            });

            if (!result.ok) process.exit(1);
            if (result.warnings.length > 0) process.exit(2);
            process.exit(0);
        });
}

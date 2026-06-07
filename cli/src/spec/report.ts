import kleur from 'kleur';
import type { ValidationResult, ValidationIssue } from './validate.js';

export function renderHuman(result: ValidationResult, sourcePath: string): string {
    const lines: string[] = [];
    lines.push(kleur.bold(`xt spec validate: ${sourcePath}`));

    if (result.inferred.scrutiny) {
        const s = result.inferred.scrutiny;
        const arrow = s.effective === s.explicit ? '' : kleur.yellow(` → raised to ${s.effective}`);
        lines.push(kleur.dim(`  scrutiny: ${s.explicit} (inferred ${s.inferred})${arrow}`));
    }

    if (result.errors.length === 0 && result.warnings.length === 0) {
        lines.push(kleur.green('  ✓ no issues'));
        return lines.join('\n');
    }

    if (result.errors.length > 0) {
        lines.push('');
        lines.push(kleur.red(`  ${result.errors.length} error${result.errors.length === 1 ? '' : 's'}`));
        for (const e of result.errors) lines.push(...formatIssue(e, 'error'));
    }
    if (result.warnings.length > 0) {
        lines.push('');
        lines.push(kleur.yellow(`  ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}`));
        for (const w of result.warnings) lines.push(...formatIssue(w, 'warning'));
    }
    return lines.join('\n');
}

function formatIssue(issue: ValidationIssue, kind: 'error' | 'warning'): string[] {
    const tag = kind === 'error' ? kleur.red('  ✗') : kleur.yellow('  ⚠');
    const out: string[] = [];
    out.push(`${tag} ${kleur.bold(issue.code)} at ${kleur.cyan(issue.field_path)}`);
    out.push(`     ${issue.message}`);
    if (issue.fix) out.push(`     ${kleur.dim('fix: ' + issue.fix)}`);
    return out;
}

export interface JsonReport {
    schema: 'xt.spec.validate.v1';
    ok: boolean;
    source: string;
    errors: ValidationIssue[];
    warnings: ValidationIssue[];
    inferred: ValidationResult['inferred'];
}

export function renderJson(result: ValidationResult, sourcePath: string): JsonReport {
    return {
        schema: 'xt.spec.validate.v1',
        ok: result.ok,
        source: sourcePath,
        errors: result.errors,
        warnings: result.warnings,
        inferred: result.inferred,
    };
}

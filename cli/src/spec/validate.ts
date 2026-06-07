import type { SpecV1, Scrutiny, Layer } from './schema.js';
export type { Scrutiny, Layer } from './schema.js';
import { inferScrutiny, raiseScrutiny } from './scrutiny.js';
import {
    checkSchema,
    checkScopeNotVague,
    checkRequirementsTestable,
    checkLayerHints,
    checkDependencyCycles,
    checkOpenQuestionsForHighScrutiny,
} from './checks.js';

export type ErrorCode =
    | 'schema_invalid'
    | 'scope_too_vague'
    | 'requirement_untestable'
    | 'layer_missing'
    | 'cycle_detected'
    | 'scrutiny_lower_than_inferred'
    | 'open_question_unresolved';

export type Severity = 'error' | 'warning';

export interface ValidationIssue {
    code: ErrorCode;
    field_path: string;
    message: string;
    severity: Severity;
    fix?: string;
}

export interface InferredFields {
    scrutiny?: { explicit: Scrutiny; inferred: Scrutiny; effective: Scrutiny };
    layer_hints?: Record<string, Layer>;
}

export interface ValidationResult {
    ok: boolean;
    errors: ValidationIssue[];
    warnings: ValidationIssue[];
    inferred: InferredFields;
}

export interface ValidateOptions {
    /** Treat warnings as errors. Default false. */
    strict?: boolean;
}

/**
 * Pure validator: input is an arbitrary parsed object (likely from yaml).
 * No I/O. No console output. Caller is responsible for rendering.
 */
export function validate(input: unknown, opts: ValidateOptions = {}): ValidationResult {
    const issues: ValidationIssue[] = [];
    const inferred: InferredFields = {};

    const schemaResult = checkSchema(input);
    if (!schemaResult.ok) {
        return {
            ok: false,
            errors: schemaResult.errors,
            warnings: [],
            inferred,
        };
    }
    const spec: SpecV1 = schemaResult.spec;

    issues.push(...checkScopeNotVague(spec));
    issues.push(...checkRequirementsTestable(spec));

    const layerCheck = checkLayerHints(spec);
    issues.push(...layerCheck.issues);
    if (Object.keys(layerCheck.inferredLayers).length > 0) {
        inferred.layer_hints = layerCheck.inferredLayers;
    }

    issues.push(...checkDependencyCycles(spec));

    const inferredScrutiny = inferScrutiny(spec);
    const effectiveScrutiny = raiseScrutiny(spec.scrutiny, inferredScrutiny);
    inferred.scrutiny = {
        explicit: spec.scrutiny,
        inferred: inferredScrutiny,
        effective: effectiveScrutiny,
    };
    if (effectiveScrutiny !== spec.scrutiny) {
        issues.push({
            code: 'scrutiny_lower_than_inferred',
            field_path: 'scrutiny',
            severity: 'warning',
            message: `Explicit scrutiny "${spec.scrutiny}" raised to "${effectiveScrutiny}" by inference signals.`,
            fix: `Set scrutiny: ${effectiveScrutiny} to acknowledge the inferred floor.`,
        });
    }

    issues.push(...checkOpenQuestionsForHighScrutiny(spec, effectiveScrutiny));

    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warning');
    const ok = errors.length === 0 && (!opts.strict || warnings.length === 0);

    return { ok, errors, warnings, inferred };
}

import { SpecV1Schema, type SpecV1, type Layer, type Scrutiny } from './schema.js';
import type { ValidationIssue } from './validate.js';

/* ───────────────── schema ───────────────── */

export type SchemaCheckResult =
    | { ok: true; spec: SpecV1 }
    | { ok: false; errors: ValidationIssue[] };

export function checkSchema(input: unknown): SchemaCheckResult {
    const parsed = SpecV1Schema.safeParse(input);
    if (parsed.success) return { ok: true, spec: parsed.data };
    const errors: ValidationIssue[] = parsed.error.issues.map((issue) => ({
        code: 'schema_invalid',
        field_path: issue.path.length ? issue.path.join('.') : '(root)',
        severity: 'error',
        message: issue.message,
        fix: 'Run `xt spec validate` and follow the field-by-field hints.',
    }));
    return { ok: false, errors };
}

/* ───────────────── scope vagueness ───────────────── */

const VAGUE_SCOPE_PATTERNS: RegExp[] = [
    /^src\/?$/i,
    /^lib\/?$/i,
    /^all\b/i,
    /^everything$/i,
    /^\*+$/,
    /^\*\*\/\*$/,
    /^the whole/i,
];

export function checkScopeNotVague(spec: SpecV1): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    spec.scope.include.forEach((entry, idx) => {
        const trimmed = entry.trim();
        const isVague =
            trimmed.length < 4 ||
            VAGUE_SCOPE_PATTERNS.some((p) => p.test(trimmed)) ||
            (!trimmed.includes('/') && !trimmed.includes('.') && trimmed.split(/\s+/).length <= 2);
        if (isVague) {
            issues.push({
                code: 'scope_too_vague',
                field_path: `scope.include[${idx}]`,
                severity: 'error',
                message: `Scope entry "${entry}" is too vague to act on.`,
                fix: 'Name specific files, modules, or symbol surfaces (e.g., cli/src/foo/bar.ts).',
            });
        }
    });
    return issues;
}

/* ───────────────── testability ───────────────── */

const UNTESTABLE_WORDS = [
    'good', 'nice', 'better', 'cleaner', 'appropriate', 'as needed',
    'etc', 'and so on', 'reasonable', 'sensible', 'sufficient',
];

export function checkRequirementsTestable(spec: SpecV1): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    spec.requirements.forEach((req, rIdx) => {
        req.acceptance.forEach((line, aIdx) => {
            const lower = line.toLowerCase();
            const hit = UNTESTABLE_WORDS.find((w) => lower.includes(w));
            if (hit) {
                issues.push({
                    code: 'requirement_untestable',
                    field_path: `requirements[${rIdx}].acceptance[${aIdx}]`,
                    severity: 'error',
                    message: `Acceptance criterion uses vague word "${hit}" — not falsifiable.`,
                    fix: 'Rewrite as an observable assertion (numbers, exit codes, output strings, log events).',
                });
            }
        });
    });
    return issues;
}

/* ───────────────── layer hints ───────────────── */

interface LayerCheckOutput {
    issues: ValidationIssue[];
    inferredLayers: Record<string, Layer>;
}

const LAYER_KEYWORDS: Array<{ layer: Layer; pattern: RegExp }> = [
    { layer: 'shell', pattern: /\b(cli|command|subcommand|argv|exit code|stdout|stderr)\b/i },
    { layer: 'boundary', pattern: /\b(api|endpoint|client|http|fetch|url|port|grpc|webhook)\b/i },
    { layer: 'operational', pattern: /\b(deploy|hook|telemetry|metric|log event|runbook|health check)\b/i },
    { layer: 'core', pattern: /\b(transform|compute|parse|validate|serialize|deserialize|state machine)\b/i },
];

function inferLayer(req: SpecV1['requirements'][number]): Layer | null {
    const text = `${req.story} ${req.behavior} ${req.acceptance.join(' ')}`;
    for (const { layer, pattern } of LAYER_KEYWORDS) {
        if (pattern.test(text)) return layer;
    }
    return null;
}

export function checkLayerHints(spec: SpecV1): LayerCheckOutput {
    const issues: ValidationIssue[] = [];
    const inferredLayers: Record<string, Layer> = {};
    spec.requirements.forEach((req, idx) => {
        if (req.layer_hint) return;
        const inferred = inferLayer(req);
        if (inferred) {
            inferredLayers[req.id] = inferred;
            issues.push({
                code: 'layer_missing',
                field_path: `requirements[${idx}].layer_hint`,
                severity: 'warning',
                message: `Missing layer_hint for ${req.id}; inferred "${inferred}" from content.`,
                fix: `Set layer_hint: ${inferred} explicitly.`,
            });
        } else {
            issues.push({
                code: 'layer_missing',
                field_path: `requirements[${idx}].layer_hint`,
                severity: 'error',
                message: `Missing layer_hint for ${req.id} and cannot infer from content.`,
                fix: 'Set layer_hint to one of: core | boundary | shell | operational.',
            });
        }
    });
    return { issues, inferredLayers };
}

/* ───────────────── dependency cycles (Kahn) ───────────────── */

export function checkDependencyCycles(spec: SpecV1): ValidationIssue[] {
    const reqIds = new Set(spec.requirements.map((r) => r.id));
    const edges = spec.dependencies.filter((d) => reqIds.has(d.from) && reqIds.has(d.requires));

    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const id of reqIds) {
        inDegree.set(id, 0);
        adj.set(id, []);
    }
    for (const e of edges) {
        // `from` depends on `requires` → edge from requires → from
        adj.get(e.requires)!.push(e.from);
        inDegree.set(e.from, (inDegree.get(e.from) ?? 0) + 1);
    }

    const queue = [...reqIds].filter((id) => (inDegree.get(id) ?? 0) === 0);
    let visited = 0;
    while (queue.length) {
        const node = queue.shift()!;
        visited++;
        for (const next of adj.get(node) ?? []) {
            inDegree.set(next, (inDegree.get(next) ?? 0) - 1);
            if (inDegree.get(next) === 0) queue.push(next);
        }
    }

    if (visited === reqIds.size) return [];

    const stuck = [...reqIds].filter((id) => (inDegree.get(id) ?? 0) > 0);
    return [
        {
            code: 'cycle_detected',
            field_path: 'dependencies',
            severity: 'error',
            message: `Dependency cycle detected involving: ${stuck.join(', ')}.`,
            fix: 'Break the cycle by removing one dependency edge or splitting a requirement.',
        },
    ];
}

/* ───────────────── open questions for high/critical scrutiny ───────────────── */

export function checkOpenQuestionsForHighScrutiny(
    spec: SpecV1,
    effective: Scrutiny,
): ValidationIssue[] {
    if (effective !== 'high' && effective !== 'critical') return [];
    if (spec.open_questions.length === 0) return [];
    return [
        {
            code: 'open_question_unresolved',
            field_path: 'open_questions',
            severity: 'error',
            message: `Effective scrutiny is "${effective}" but ${spec.open_questions.length} open question(s) remain.`,
            fix: 'Resolve open questions before xt spec apply, or accept downgrade in a separate review pass.',
        },
    ];
}

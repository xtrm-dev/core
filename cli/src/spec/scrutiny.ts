import type { SpecV1, Scrutiny } from './schema.js';

const SCRUTINY_ORDER: Scrutiny[] = ['low', 'medium', 'high', 'critical'];

export function rank(s: Scrutiny): number {
    return SCRUTINY_ORDER.indexOf(s);
}

export function raiseScrutiny(explicit: Scrutiny, inferred: Scrutiny): Scrutiny {
    return rank(inferred) > rank(explicit) ? inferred : explicit;
}

interface InferenceSignal {
    test: (spec: SpecV1) => boolean;
    floor: Scrutiny;
    label: string;
}

const SIGNALS: InferenceSignal[] = [
    {
        label: 'security-sensitive scope keyword',
        floor: 'high',
        test: (s) => matchesAny(allText(s), /\b(auth|crypto|secret|token|password|credential|tls|signing|cert)/i),
    },
    {
        label: 'migration or schema-change keyword',
        floor: 'high',
        test: (s) => matchesAny(allText(s), /\b(migration|migrate|schema-change|breaking-change|backfill)/i),
    },
    {
        label: 'release / publish / dispatch surface',
        floor: 'high',
        test: (s) => matchesAny(allText(s), /\b(release|publish|deploy|dispatch|merge-queue)/i),
    },
    {
        label: 'more than 10 requirements',
        floor: 'medium',
        test: (s) => s.requirements.length > 10,
    },
    {
        label: 'open questions present',
        floor: 'medium',
        test: (s) => s.open_questions.length > 0,
    },
    {
        label: 'requirements declare risks',
        floor: 'medium',
        test: (s) => s.requirements.some((r) => (r.risks ?? []).length > 0),
    },
];

/**
 * Compute the inferred SCRUTINY floor from spec content.
 * Returns the highest floor among matched signals, or 'low' if none match.
 */
export function inferScrutiny(spec: SpecV1): Scrutiny {
    let floor: Scrutiny = 'low';
    for (const sig of SIGNALS) {
        if (sig.test(spec) && rank(sig.floor) > rank(floor)) {
            floor = sig.floor;
        }
    }
    return floor;
}

export function explainInference(spec: SpecV1): string[] {
    return SIGNALS.filter((s) => s.test(spec)).map((s) => `${s.label} → floor ${s.floor}`);
}

function allText(spec: SpecV1): string {
    return [
        spec.title,
        spec.problem,
        ...spec.success,
        ...spec.scope.include,
        ...(spec.scope.exclude ?? []),
        ...(spec.non_goals ?? []),
        ...(spec.constraints ?? []),
        ...spec.requirements.flatMap((r) => [r.story, r.behavior, ...r.acceptance, ...(r.risks ?? [])]),
        ...spec.open_questions,
    ].join(' \n ');
}

function matchesAny(haystack: string, re: RegExp): boolean {
    return re.test(haystack);
}

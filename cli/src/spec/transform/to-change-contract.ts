import type { SpecV1 } from '../schema.js';
import { elem, bullets, render, type XmlNode } from '../xml.js';

/**
 * Transform spec.yaml → planner-bead `<change-contract>` XML per D30.
 *
 * Field mapping (also in docs/specs/CHANGE-CONTRACT-SHAPE.md):
 *   spec.problem                    → <problem>
 *   spec.success                    → <success><item>…</item>…</success>
 *   spec.scrutiny (effective)       → <scrutiny>
 *   spec.scope.include              → <scope><item>…</item>…</scope>
 *   spec.scope.exclude + non_goals  → <non-goals><item>…</item>…</non-goals>
 *   spec.constraints                → <constraints><item>…</item>…</constraints>
 *   requirements + validation       → <validation><item>…</item>…</validation>
 *   (reserved for planner)          → <output/>
 */
export interface ChangeContractInputs {
    spec: SpecV1;
    /**
     * Effective SCRUTINY chosen by the validator (>= spec.scrutiny).
     * Required because the apply pipeline runs `validate` first and we want
     * the planner bead to carry the inferred floor, not the operator's
     * possibly-stale explicit value.
     */
    effectiveScrutiny: SpecV1['scrutiny'];
    /** Optional: the spec.yaml source path (recorded as a comment hint). */
    sourcePath?: string;
}

export function toChangeContractXml(inputs: ChangeContractInputs): string {
    const root = toChangeContractNode(inputs);
    return render(root) + '\n';
}

export function toChangeContractNode({ spec, effectiveScrutiny }: ChangeContractInputs): XmlNode {
    const nonGoals = [
        ...spec.scope.exclude,
        ...spec.non_goals,
    ];

    const validationItems = [
        ...spec.requirements.flatMap((r) =>
            r.acceptance.map((a) => `${r.id}: ${a}`),
        ),
        ...spec.validation.map((v) => `${v.kind}: ${v.target}`),
    ];

    return elem('change-contract', [
        elem('problem', [spec.problem]),
        elem('success', bullets(spec.success)),
        elem('scrutiny', [effectiveScrutiny]),
        elem('scope', bullets(spec.scope.include)),
        elem('non-goals', bullets(nonGoals)),
        elem('constraints', bullets(spec.constraints)),
        elem('validation', bullets(validationItems)),
        elem('output'),
    ]);
}

/** Field count exposed for transform-table parity tests. */
export function changeContractFieldCount(): number {
    return 8; // problem, success, scrutiny, scope, non-goals, constraints, validation, output
}

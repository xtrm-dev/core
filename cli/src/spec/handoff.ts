import kleur from 'kleur';

export interface HandoffInputs {
    plannerBeadId?: string;
    plannerJobId?: string;
    epicId?: string;
    childrenCount?: number;
    testIssuesCount?: number;
}

/**
 * Render the post-reconcile operator handoff.
 *
 * Deliberate non-feature: the composition gate (specialists-roadmap Opp 4)
 * is the operator's decision. xt spec emits a printed `sp chain review`
 * command and stops. Auto-approving or auto-claiming the first task is
 * out-of-band and blocked by the guard test under cli/src/tests/.
 */
export function renderReconcileHandoff(inputs: HandoffInputs): string {
    const lines: string[] = [];
    lines.push(kleur.green(`✓ reconciled: epic ${inputs.epicId} (${inputs.childrenCount} children, ${inputs.testIssuesCount} test issues)`));
    lines.push(kleur.dim('  spec.yaml status → planned; links populated'));
    lines.push('');
    lines.push(kleur.bold('  next: ') + kleur.cyan(`sp chain review ${inputs.epicId}`));
    lines.push(kleur.dim('    Composition gate: review the resolved chain shape and approve before any dispatch.'));
    lines.push(kleur.dim('    xt spec apply does not auto-approve, auto-claim, or auto-dispatch step beads.'));
    return lines.join('\n');
}

/**
 * Capability matrix for the planner + test-planning skills.
 * Probed by `xt spec doctor` and `xt spec apply --check-only`.
 *
 * Each capability has:
 *   - key: stable id (used by status output + apply gate)
 *   - title: human-readable label
 *   - required_for: which xt spec feature depends on it
 *   - upstream_ref: which specialists-roadmap bead/decision ships it
 *   - source: path (relative to repo root) to grep
 *   - marker: regex that proves presence
 */

export interface Capability {
    key: string;
    title: string;
    required_for: string;
    upstream_ref: string;
    source: string;
    marker: RegExp;
}

export const CAPABILITY_MATRIX: Capability[] = [
    {
        key: 'planning_uses_bd_swarm',
        title: 'Planning skill teaches `bd swarm` (epic + DAG validation)',
        required_for: 'xt spec apply (planner produces bd swarm rather than raw bd create loops)',
        upstream_ref: 'specialists-roadmap §0 (bd surface inventory) + D26',
        source: '.xtrm/skills/default/planning/SKILL.md',
        marker: /\bbd\s+swarm\b/i,
    },
    {
        key: 'planning_uses_bd_mol_pour',
        title: 'Planning skill teaches `bd mol pour` (chain-molecule pour)',
        required_for: 'xt spec apply (planner pours chain-molecules per child chain)',
        upstream_ref: 'specialists-roadmap §0 absorbed molecule model + §13',
        source: '.xtrm/skills/default/planning/SKILL.md',
        marker: /\bbd\s+mol\s+pour\b/i,
    },
    {
        key: 'planning_emits_xml_contracts',
        title: 'Planning skill emits XML `<change-contract>` / `<step-contract>` per D30',
        required_for: 'xt spec apply XML-contract transform',
        upstream_ref: 'specialists-roadmap Opp 12 / D30',
        source: '.xtrm/skills/default/planning/SKILL.md',
        marker: /<change-contract>|<step-contract>/,
    },
    {
        key: 'planning_recommends_template',
        title: 'Planning Pass-2 annotates `recommended_template` per child root',
        required_for: 'xt spec apply preview + sp chain review handoff',
        upstream_ref: 'specialists-roadmap D23 / D26',
        source: '.xtrm/skills/default/planning/SKILL.md',
        marker: /recommended_template/,
    },
    {
        key: 'planning_typed_edge_fluency',
        title: 'Planning skill uses typed `bd dep` edges (validates/discovered-from/etc)',
        required_for: 'apply produces dep graph with correct typed edges, not flattened blocks',
        upstream_ref: 'specialists-roadmap D28 / using-specialists-v4',
        source: '.xtrm/skills/default/planning/SKILL.md',
        marker: /--type\s+(validates|discovered-from|tracks|supersedes)/,
    },
    {
        key: 'planning_scrutiny_enforcement',
        title: 'Planning skill enforces SCRUTINY in 7-section contracts',
        required_for: 'xt spec apply SCRUTINY propagation',
        upstream_ref: 'specialists-roadmap Opp 16',
        source: '.xtrm/skills/default/planning/SKILL.md',
        marker: /\bSCRUTINY\b/,
    },
    {
        key: 'testplanning_uses_bd_gate',
        title: 'test-planning skill picks `bd gate` types by SCRUTINY',
        required_for: 'xt spec apply produces typed bd gates instead of bare validates edges',
        upstream_ref: 'specialists-roadmap §0 (bd gate primitive) + Opp 16',
        source: '.xtrm/skills/default/test-planning/SKILL.md',
        marker: /\bbd\s+gate\b/i,
    },
    {
        key: 'testplanning_layer_classification',
        title: 'test-planning skill classifies by core/boundary/shell layer',
        required_for: 'xt spec apply test-issue batching',
        upstream_ref: 'specialists-roadmap §13 chain templates layer model',
        source: '.xtrm/skills/default/test-planning/SKILL.md',
        marker: /\b(core|boundary|shell)\s+layer\b/i,
    },
];

export interface CapabilityProbeResult {
    capability: Capability;
    present: boolean;
    detail: string;
}

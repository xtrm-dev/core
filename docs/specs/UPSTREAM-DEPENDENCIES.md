# `xt spec` Upstream Dependencies

> **Why this doc:** `xt spec apply` (MVP2) depends on capabilities owned by
> `~/dev/specialists` (the specialists-runtime project). Those capabilities
> ship as updates to the planner specialist config + planning + test-planning
> skill packages, which arrive in xtrm-tools via `xt update`.
>
> This index pins each capability to its upstream decision so the readiness
> probe (`xt spec doctor`) can name a concrete migration target when a check
> fails.

## Edge type

We do **not** use `bd dep add --type blocks` to wire this dependency.
A blocks edge would freeze the entire `xtrm-ai9xl` board behind cross-repo
work we don't control. Instead we use prose pointers here, plus the readiness
probe (`cli/src/spec/readiness/matrix.ts`) as the *runtime* gate that refuses
`xt spec apply` until the deployed skills meet contract.

If a future bd federation pass arrives between xtrm-tools and specialists,
each row below should be re-expressed as `bd dep add <local> <upstream>
--type tracks` (non-blocking cross-workspace pointer). That's a follow-up,
not a precondition.

## Capability ↔ upstream

| Capability key (matrix) | Upstream decision | Notes |
|---|---|---|
| `planning_uses_bd_swarm` | specialists-roadmap §0 *Existing bd surface inventory* (2026-06-02) + D26 | Planning skill must teach `bd swarm validate` + `bd swarm create` instead of raw `bd create` loops. Land in `~/dev/specialists/config/skills/planning/SKILL.md`. |
| `planning_uses_bd_mol_pour` | specialists-roadmap §0 absorbed molecule model + §13 chain templates | Each child chain = `bd mol pour <formula>` rather than hand-rolled children. Replaces sibling enumeration with formula-driven pour. |
| `planning_emits_xml_contracts` | specialists-roadmap Opp 12 / D30 | Root beads carry `<change-contract>` XML; step beads carry `<step-contract>`. Replaces the markdown 7-section convention. |
| `planning_recommends_template` | specialists-roadmap D23 / D26 | Pass-2 of the planner annotates each child root with `recommended_template: <one of 13 formulas | on-the-run>` validated against live `bd formula list`. |
| `planning_typed_edge_fluency` | specialists-roadmap D28 (using-specialists-v4 navigation) | Use `bd dep add … --type validates/discovered-from/parent-child/related/supersedes/tracks` rather than flattening to `blocks`. |
| `planning_scrutiny_enforcement` | specialists-roadmap Opp 16 (`unitAI-3l0ac`) | Every substantive bead carries SCRUTINY explicit; reviewer floor-can-only-raise. |
| `testplanning_uses_bd_gate` | specialists-roadmap §0 (bd gate primitive) + Opp 16 | test-planning selects `bd gate` types (human/timer/gh:run/gh:pr/bead) per SCRUTINY. |
| `testplanning_layer_classification` | specialists-roadmap §13 chain templates layer model | Already partially present (core/boundary/shell language); needs explicit gate selection per layer + SCRUTINY. |

## Locating current upstream bead IDs

The roadmap document is the canonical reference for *decisions* (`Dxx`,
`Opp Y`); the implementation beads live in the specialists workspace.

```bash
cd ~/dev/specialists
bd search "D26"                     # planning skill alignment work
bd search "D28"                     # using-specialists-v4
bd search "D30"                     # XML contracts
bd search "Opp 16"                  # SCRUTINY enforcement
bd search "Opp 12"                  # XML-structured contracts
```

When a specific bead ID is confirmed, append it parenthetically to its row
above. Do not add cross-workspace `blocks` edges.

## Refresh discipline

This index is reviewed:
- on every `xt spec` release (added to `xt spec archive` gate doc)
- whenever the readiness probe's capability matrix changes
- whenever a roadmap decision (Dxx / Opp Y) cited above is amended

If a capability is added to `cli/src/spec/readiness/matrix.ts`, a matching
row MUST land here in the same PR.

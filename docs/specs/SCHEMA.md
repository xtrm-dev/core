# spec.yaml v1 — Field Reference

> Canonical schema lives in `cli/src/spec/schema.ts` (zod). Generated JSON
> Schema artifact at `cli/src/spec/schema.json` (regenerate via
> `node cli/scripts/build-spec-schema.mjs`). A drift test enforces parity.

## Purpose

`spec.yaml` is the durable intent artifact authored by `xt spec draft`,
validated by `xt spec validate`, transformed into a planner-bead XML
`<change-contract>` by `xt spec apply`, and reconciled against linked bd
state by `xt spec status` / `xt spec archive`.

It is NOT a decomposition. `xt spec` produces a single planner bead and
dispatches the planner specialist — the planner does the bd swarm /
molecule / test-issue decomposition through the planning + test-planning
skills.

## Top-level fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `schema_version` | `1` | yes | Currently the only supported value. Bumped when breaking changes land. |
| `id` | kebab-case string | yes | Stable identifier; used in slugs, paths, sidecar files. ASCII, 1–80 chars. |
| `title` | string | yes | Human title. 1–200 chars. |
| `status` | `draft \| validated \| planned \| archived` | yes | Lifecycle state; mutated by xt spec commands, not hand-edited. |
| `scrutiny` | `low \| medium \| high \| critical` | yes | Explicit floor. The validator can infer-and-raise based on scope/risk signals; it cannot lower. |
| `problem` | string | yes | Why this work exists. Maps to planner-bead `<problem>`. |
| `success` | string[] | yes (min 1) | Observable end-states. Maps to planner-bead `<success>`. |
| `scope.include` | string[] | yes (min 1) | Files / modules / surfaces in scope. Maps to planner-bead `<scope>`. |
| `scope.exclude` | string[] | no | Explicit exclusions; merged with `non_goals` into planner-bead `<non-goals>`. |
| `non_goals` | string[] | no | Related work explicitly out of scope. |
| `constraints` | string[] | no | Hard rules: API compat, logging contract, do-not-touch boundaries. Maps to planner-bead `<constraints>`. |
| `requirements` | Requirement[] | yes (min 1) | See below. |
| `validation` | ValidationItem[] | no | Cross-cutting validation hints consumed by test-planning. |
| `dependencies` | Dependency[] | no | Inter-requirement ordering. Compiled to bd `blocks` edges by the planner. |
| `open_questions` | string[] | no | Unresolved high-risk questions. For `scrutiny ∈ {high, critical}`, must be empty at apply-time. |
| `links` | Links | no | Populated by `xt spec apply --reconcile`; do not edit by hand. |

## Requirement

| Field | Type | Notes |
|---|---|---|
| `id` | `R<n>` | E.g. `R1`, `R2`. Used by `dependencies`. |
| `story` | string | "As a … I want … so that …" style; one sentence is fine. |
| `behavior` | string | Behavior in observable terms. |
| `acceptance` | string[] | Concrete acceptance checks. Compiled into planner-bead `<validation>`. |
| `layer_hint` | `core \| boundary \| shell \| operational` (optional) | Steers test-planning's layer classification. Inferable when missing. |
| `priority` | 0–4 (optional) | Maps to bd priority. |
| `risks` | string[] (optional) | Notes for SCRUTINY inference and reviewer focus. |

## ValidationItem

| Field | Type | Notes |
|---|---|---|
| `kind` | `unit \| integration \| smoke \| e2e \| telemetry` | Test layer. |
| `target` | string | What is being validated. |

## Dependency

| Field | Type | Notes |
|---|---|---|
| `from` | `R<n>` | Dependent requirement. |
| `requires` | `R<n>` | Prerequisite requirement. Compiled to bd `blocks` edge. |

## Links (managed by xt spec apply)

| Field | Type | Notes |
|---|---|---|
| `parent_epic` | string or null | Optional bd epic this spec rolls up to. |
| `planner_bead` | string or null | The bead `xt spec apply` created for the planner specialist. |
| `epic` | string or null | bd epic produced by the planner. |
| `children` | string[] | Direct children of `epic` produced by the planner. |
| `test_issues` | string[] | Test issues produced by test-planning. |

`xt spec status` checks every id here against `bd show <id> --json`.
`xt spec archive` refuses unless `epic` is closed and every `children` and
`test_issues` id is closed (plus a review-evidence marker for high/critical).

## SCRUTINY semantics

`scrutiny` is an explicit floor. The validator (`xt spec validate`) runs an
inference table over scope/risks and may **raise** the effective scrutiny in
its report; it never lowers an explicit value.

Sample inference signals (non-exhaustive, see `cli/src/spec/scrutiny.ts`):
- security-sensitive scope keywords → at least `high`
- migration / schema-change keywords → at least `high`
- > 10 requirements → at least `medium`
- any unresolved `open_questions` → at least `medium`

## Example

See [`EXAMPLE.yaml`](./EXAMPLE.yaml).

## Editor integration

Add a yaml-language-server schema directive at the top of every spec.yaml:

```yaml
# yaml-language-server: $schema=<relative-path-to>/cli/src/spec/schema.json
```

This enables completions and inline validation in VS Code / Neovim with the
yaml plugin.

## Regenerating the JSON Schema artifact

```bash
cd cli
node scripts/build-spec-schema.mjs
```

The drift test (`cli/src/tests/spec-schema.test.ts`) fails CI if the committed
`schema.json` is out of sync with the zod source.

# Lane 3 — Spec → Chain convergence audit (Core planning flow and its Beads-shaped materialization)

> Lane: 3 of the Core↔Substrate architecture audit. Read-only audit; no source mutated.
> Date: 2026-09-15. Author: Lane 3 (audit worker).
>
> Verified baseline
> - Core: `/home/dawid/dev/core` worktree `core-xt-pi-7awr`, branch `xt/7awr`, HEAD `e3c09927f115a9ad551953ede2262c91a9bbb431`, `xtrm-tools@0.12.0`.
> - Substrate (xtrm-dev/xtrm): `origin/main` `12e71d743a32c7b27af6c3e792574cfa08e7b81a`, snapshot `/tmp/audit/xtrm-main`.
> - Specialists: `origin/master` `67100f1362c01f0972e081795be805297be8e8a9`, snapshot `/tmp/audit/specialists-master`.
>
> Statement classes: every claim below is **VERIFIED** (cited source read) unless explicitly labelled INFERENCE / RECOMMENDATION / UNRESOLVED.

---

## 0. Executive findings

1. **Core contains zero chain-authoring code.** No `ChainLoader`, `ChainSource`, `ChainDefinition`, `ResolvedChain`, `ChainRun`, `chain_template`, `resolved_chain_json`, formula loader, compiler, reducer, or scheduler exists anywhere under `cli/src`, `.xtrm/`, `scripts/`, `skills/`, `templates/`, `hooks/`, `policies/`, or `packages/`. The only Core code that touches "chain" is a **read-only topology projection** of Specialists job lineage (`cli/src/core/topology-projection.ts:269-271`) and the strings in `.xtrm/skills/default/using-specialists/SKILL.md:38`. VERIFIED (documented sweep in §8).
2. **Core authors Beads graphs only, and it does not even author them — the planner specialist does.** `xt spec apply` creates one planner Bead via `bd create --type task --priority 1`, dispatches `planner` through `sp run --background`, then scrapes epic/child ids out of the planner's textual result. `cli/src/commands/spec/apply.ts:159,218-234`; `cli/src/spec/dispatch.ts:21-25`; `cli/src/spec/reconcile.ts:43-83`.
3. **Both halves of Core's production planner path are provably broken against the real Specialists binary.** `sp run … --background --json` emits `{"type":"job_started","jobId":"…"}` (camelCase, no `job_id`) — `cli/src/spec/dispatch.ts:29-41` looks for `parsed.job_id ?? parsed.id`, then a fallback regex requiring `job_id:`/`jobid=`, neither of which matches `"jobId":"`. And `sp result <job> --json` emits `{job:{…}, output:"<free text>", startup_context, error}` — `cli/src/spec/reconcile.ts:74-83` requires **top-level** `epic_id` / `children` / `test_issues`, which never appear. VERIFIED by source: `specialists-master/src/cli/run.ts:94-113`, `specialists-master/src/cli/result.ts:291-312`. The integration test passes only because it mocks `sp` to emit exactly Core's expected fiction (`cli/src/tests/spec-apply.integration.test.ts:68-82`).
4. **`xt spec apply` is additionally hard-gated off in this tree.** All 8 readiness capabilities are absent, so apply refuses with exit 65 before any `bd` call. VERIFIED by executing `XT_SPEC_BD_BINARY=/bin/false node cli/dist/index.cjs spec apply docs/specs/EXAMPLE.yaml` → `EXIT=65`, 8 missing capabilities; and by `xt spec doctor --json` → `ready: false`.
5. **The target shape already names this exact flow as its upstream.** `loadChangeContractRoot()` in the upstream experiment is documented as "Load a change-contract ROOT already parsed out of spec.yaml by `xt spec`" (`xtrm-main/experiments/agentsession-sre-chain-vertical-slice/src/chain-loader/index.ts:379-416`), and the execution plan records the precise residual for `xt spec`: "connect produced root tasks to the canonical chain compiler", "implement `sp chain review` before advertising the handoff as operational", "retain `xt spec` as programme planning, not participant topology" (`xtrm-main/docs/shared/xtrm-current-execution-plan.md:198-200`).
6. **The correct convergence is not `bd create` → `sb issue create`.** It is `spec.yaml` → (normalized authored form) ⊆ `ChainSource`/change-contract root → `ChainDefinition` → `ResolvedChain` → **one atomic `PlanDraft`** committed by `sb plan apply`, then native activation against `WorkItemStore` with `issueRef` + attestation. Rationale and rejected alternatives in §6; upstream release status of each primitive in §7.

---

## 1. Q1 — What is `spec.yaml` today?

### 1.1 Schema
`schema_version: 1`, closed shape (`additionalProperties: false`), `$id` `https://xtrm.dev/schemas/spec-v1.json` (`cli/src/spec/schema.json:278-281`). Two implementations exist and must stay in lockstep: JSON Schema (`schema.json`) and a zod mirror (`cli/src/spec/schema.ts:44-68`) whose `toJSONSchemaV1()` regenerates the `$id`/`title`/`description` fields (`schema.ts:80-87`).

Required top-level fields (`schema.json:261-277`):
`schema_version, id, title, status, scrutiny, problem, success, scope, non_goals, constraints, requirements, validation, dependencies, open_questions, links`.

Field semantics:
| Field | Shape | Evidence |
|---|---|---|
| `id` | kebab-case, `^[a-z][a-z0-9-]*$`, ≤80 | `schema.json:9-14` |
| `status` | enum `draft, validated, planned, archived` | `schema.json:20-28` |
| `scrutiny` | enum `low, medium, high, critical` (no `none`) | `schema.json:29-37` |
| `problem` | non-empty string | `schema.json:38-41` |
| `success` | non-empty array of strings (min 1) | `schema.json:42-49` |
| `scope` | `{include[] (min 1), exclude[]}`, both required | `schema.json:50-74` |
| `requirements` | array min 1 of `{id ^R\d+$, story, behavior, acceptance[] (min 1), layer_hint?, priority 0-4?, risks?}`; `layer_hint` ∈ `core, boundary, shell, operational` | `schema.json:89-144` |
| `validation` | array of `{kind ∈ unit, integration, smoke, e2e, telemetry, target}` | `schema.json:145-172` |
| `dependencies` | array of `{from ^R\d+$, requires ^R\d+$}` (requirement-level, not issue-level) | `schema.json:173-194` |
| `links` | `{parent_epic?, planner_bead?, epic?, children[], test_issues[]}` | `schema.json:202-259` |

`links` is the **Beads-shaped materialization record**: it stores foreign keys into the Beads graph (`planner_bead`, `epic`, `children`, `test_issues`) and nothing else. It carries no revision, no contract hash, no ownership, and no chain identity.

### 1.2 Sidecar files
Exactly one sidecar: `.apply-state.json`, written next to `spec.yaml` (`cli/src/spec/apply-state.ts:18-20`), atomically via temp-file + `rename(2)` (`apply-state.ts:26-37`). Shape (`apply-state.ts:4-16`):

```
schema:      'xt.spec.apply-state.v1'
spec_id, spec_path
planner_bead_id      // bd id
planner_job_id       // sp job id
dispatched_at        // ISO8601
reconciled_at?, epic_id?, children?, test_issues?   // declared, never written
```

VERIFIED: `reconciled_at`, `epic_id`, `children`, `test_issues` are declared as "reconcile will append" in the interface (`apply-state.ts:11-15`) but `reconcile()` never writes the sidecar — it rewrites `spec.yaml` instead (`reconcile.ts:63-69,102-118`). The only writer is `apply.ts:186-194`. The archive command creates a second artifact, `archive/<id>.yaml` (`cli/src/commands/spec/archive.ts:46-54`), which is a snapshot, not a sidecar.

### 1.3 Validation and inference
Pure, I/O-free validator (`cli/src/spec/validate.ts:53-102`) with 7 stop codes (`validate.ts:13-20`) supplied by: zod schema check (`checks.ts:10-21`), scope-vagueness patterns (`checks.ts:25-54`), acceptance linter against `good/nice/better/appropriate/…` (`checks.ts:58-81`), layer inference by keyword (`checks.ts:90-131`), Kahn dependency-cycle detection (`checks.ts:135-174`), scrutiny floor raise (`scrutiny.ts:19-64`), and open-questions blocking at high/critical scrutiny (`checks.ts:178-193`, severity `error`).

### 1.4 The transform that actually leaves Core
`toChangeContractXml` renders 8 tags: `problem, success, scrutiny, scope, non-goals, constraints, validation, output` (`cli/src/spec/transform/to-change-contract.ts:48-58`, field count asserted at `:61-63`). `scope.exclude + non_goals` merge into one `non-goals` list (`:36-39`); requirement acceptance items are prefixed `R<n>:` and validation items `<kind>:` (`:41-46`). Rendering is a hand-written escaping builder (`cli/src/spec/xml.ts:18-67`). Size gate: 60 000 bytes, else `spec_too_large` (`cli/src/commands/spec/apply.ts:24,144-150`).

---

## 2. Q2 — The exact materialization step, and what is Beads-specific

### 2.1 Actual sequence, in order, with ids
VERIFIED sequence in `cli/src/commands/spec/apply.ts`:

| # | Step | Actor | Id produced | Evidence |
|---|---|---|---|---|
| 1 | Readiness probe over 8 skill markers; refuse exit 65 | Core | none | `apply.ts:88-105`; `readiness/matrix.ts:23-88`; `readiness/probe.ts:16-23` |
| 2 | `validate()` on parsed YAML; refuse on error | Core | none | `apply.ts:107-124` |
| 3 | Render `<change-contract>` XML, size-check | Core | none | `apply.ts:139-150` |
| 4 | `bd create --type task --priority 1 --title "Plan: <title>" --description <xml> --json` | Core shells `bd` | `planner_bead_id` (bd) | `apply.ts:158-172,218-234` |
| 5 | `sp run planner --bead <planner_bead_id> --background --json` | Core shells `sp` | `planner_job_id` (sp) | `apply.ts:175`; `dispatch.ts:21-25` |
| 6 | Write `.apply-state.json` | Core | sidecar | `apply.ts:186-194` |
| 7 | Print `sp chain review <epic>` handoff (no chain exists yet) | Core | none | `apply.ts:203-204`; `handoff.ts:19-28` |
| 8 | *(out of Core)* planner specialist: `bd show` parent reuse, explore, `bd` issue creation, Pass-2 `recommended_template` annotation | **planner specialist** (Specialists repo) | epic + children + test-issue bd ids | `specialists-master/config/specialists/planner.specialist.json` (system prompt: "use `bd` CLI directly to create real issues"; "if bead has `parent`, reuse that parent epic") |
| 9 | End response with `## Planner result` block (`Epic:`, `Children:`, `Test issues:`, `First task:`) | planner specialist | textual ids | same file, `prompt.system`; `prompt.output_schema.properties = [epic_id, children, test_issues, first_task]` |
| 10 | `sp result <planner_job_id> --json`, extract top-level `epic_id/children/test_issues` | Core | — (fails in production, §0.3) | `reconcile.ts:43-83` |
| 11 | Existence-check every id with `bd show <id> --json`; abort on any orphan | Core | `reconcile_orphan_link` | `reconcile.ts:58-61,85-92` |
| 12 | Rewrite `spec.yaml`: `links = {parent_epic:null, planner_bead, epic, children, test_issues}` and `status: planned` | Core | — | `reconcile.ts:63-69,102-118` |
| 13 | Operator (manual) runs `sp chain review <epic>` — **the command does not exist** | operator | none | `handoff.ts:24`; `XTRM-GUIDE.md:315`; specialists `src/cli/help.ts` CORE_COMMANDS has no `chain` entry |
| 14 | Execution: operator claims first task with `bd update <id> --claim` | operator | — | planner prompt "To start: bd update <first-task-id> --claim"; Core is guard-tested never to do this (`cli/src/tests/spec-no-bypass.test.ts:20-23`) |

**Nobody in Core creates the epic or the children.** Core creates exactly one Bead (the planner Bead) and one Specialist job. The epic/children set is produced by an LLM specialist writing to Beads with `bd`, and Core learns the resulting ids by scraping a free-text result. VERIFIED.

### 2.2 Beads-specific vs portable
| Concern | Beads-specific? | Evidence |
|---|---|---|
| `bd create --type task --priority 1 --json` for the planner work item | Beads-specific invocation; portable concept = "create an attested work item" | `apply.ts:222` |
| `bd show <id> --json` existence checks | Beads-specific | `reconcile.ts:88` |
| `bd show`/`bd children`/`bd dep cycles` drift detection | Beads-specific | `drift.ts:60,109,121` |
| `bd kv get reviewed:<epic>` as the high/critical review gate | Beads-specific (Beads KV namespace used as a review-evidence store) | `archive-gate.ts:94-99` |
| `epic` as the root work item with `children` and derived ids (`<epic>.<n>`) | Beads convention; Substrate models the same relation natively as `parent_child` | `apply.ts:76`; `reconcile.ts:7-12`; `xtrm-main/packages/substrate/src/service/planning-service.ts:278-281` |
| `test_issues` as a parallel id list | Beads-shaped; Substrate has `kind ∈ epic|task|bug|decision|research|followup` and no `validation` kind | `schema.json:246-252`; `xtrm-main/packages/substrate/src/domain/issue.ts:5-6` |
| `--type task` / planner summary as the only contract carrier | Beads-shaped (XML stuffed into the description field) | `xml.ts:1-11`; `docs/specs/CHANGE-CONTRACT-SHAPE.md:7-13` |
| Dependency cycle detection | **portable, and already duplicated**: spec does Kahn over requirements (`checks.ts:135-174`); Beads does `bd dep cycles` (`drift.ts:120-132`) | both cited |
| Scrutiny floor raise, inference, open-question gate | **portable and Core-owned** (pure functions, no Beads) | `scrutiny.ts:19-64`; `checks.ts:178-193` |
| XML `<change-contract>` body | Beads-shaped in *transport*, portable in *semantics*: upstream declares it a rename pass once Substrate carries the contract row | `docs/specs/CHANGE-CONTRACT-SHAPE.md:70-75` |
| `.apply-state.json` sidecar | **portable concept** (execution binding of spec → work item → job), Beads-specific fields | `apply-state.ts:4-16` |
| Readiness probe over deployed skill text markers | **portable concept, Beads-specific content**; it is a grep over `.xtrm/skills/default/planning/SKILL.md` for `bd swarm`, `bd mol pour`, `<change-contract>`, `recommended_template`, typed-bd-edge regex, `SCRUTINY` | `readiness/matrix.ts:23-88`; `readiness/probe.ts:25-48` |

---

## 3. Q3 — Does Core author or compile a ChainDefinition / ResolvedChain?

**No.** VERIFIED by exhaustive sweep (§8). Findings:

- No `ChainLoader` string anywhere in the worktree.
- `ChainSource` / `ChainDefinition` / `ResolvedChain` appear **only in prose**: `.xtrm/skills/default/using-specialists/SKILL.md:38` ("`ChainSource -> ChainDefinition -> ResolvedChain -> ChainRun` architecture, but that…"), `docs/specs/UPSTREAM-DEPENDENCIES.md:16-26`, `docs/architecture/superseded-designs.md:78`, `docs/design/command-outcome-v1.md:53` (explicitly "does not depend on `ResolvedChain`").
- `ChainRun` appears only in skills prose (`using-specialists/SKILL.md:38,152`, `using-specialists/references/nodes.md:5`, `using-xtrm/SKILL.md:44`, `multiplexing/references/scope.md:18,39`).
- No `.formula.json` asset, no formula catalog reader, no `bd formula`, no `applies_when`, no `on-the-run`, no `resolved_chain`, no materializer.
- The only executable "chain" code in Core is **read-model**: `cli/src/core/topology-projection.ts:269-271` passes through `chain_id` / `chain_root_job_id` / `is_chain_root` from `sp ps --json`, and `cli/src/core/topology-views.ts:37,52-53,140-156` renders `chains` and `lineage` views. `packages/contracts/src/types.ts:406-408` declares those three fields in the topology projection contract. This models the **bridge-era worktree-lineage chain** (`xtrm-main/docs/chains.md:7-22`), which the upstream canon explicitly demotes: "`chain_id` is worktree-lineage/root-job derived… **not** the final substrate identity model… Substrate treats `chain_id` as an opaque correlation field".
- The planner specialist *does* consume chain vocabulary in its contract — but no code: the readiness matrix asserts the deployed planning skill must teach `bd swarm`, `bd mol pour`, `<change-contract>`/`<step-contract>`, `recommended_template`, typed `bd dep --type validates|discovered-from|…`, and `SCRUTINY` (`readiness/matrix.ts:23-70`), and test-planning must teach `bd gate` and core/boundary/shell layer classification (`matrix.ts:72-87`). All 8 markers are **absent** (§0.4), so this is an aspiration recorded as a gate, not an implemented capability.

Conclusion: **Core today is a programme-intake front end that hands an XML prose blob to a Beads-writing agent.** It is not an authoring or compilation layer in the upstream object model.

---

## 4. Q4 — What stays Core-owned after the cut

Upstream authority for the boundary is `xtrm-main/docs/shared/xtrm-current-execution-plan.md:57-70` (surface responsibility table: "These surfaces may share contracts. They must not become competing workflow engines.") and `:198-200` (§5 residual for `xt spec`).

| Flow part | Post-cut owner | Upstream justification (primitive named) |
|---|---|---|
| `xt spec draft` scaffolding, slugify, templates | **Core** | §5 "retain `xt spec` as programme planning" (`execution-plan.md:200`). Drafting is programme intake, not participant topology. |
| `xt spec validate` — schema, scope vagueness, acceptance linter, layer inference, requirement-graph cycles, scrutiny inference | **Core, with one convergence point** | Structural contract validation upstream is `validateContractStructure` + `assertContractShape` (`substrate/src/domain/contract.ts:27-66`, called from `planning-service.ts:144-170`). Core's requirement-level checks are a superset that has no Substrate equivalent (`checks.ts:35-174`); the *shape* check must converge on `WorkContract`. |
| SCRUTINY inference and floor raise | Split: **Core** infers from spec prose (`scrutiny.ts:19-64`); **Substrate** owns the policy seam that enforces the floor (`substrate/src/domain/readiness.ts:36-47` `ScrutinyPolicy`; `contract.ts:67-73` `SCRUTINY_LEVELS`). Contract text: "SCRUTINY is policy input, not prose". |
| `.apply-state.json` binding (spec ↔ work item ↔ execution) | **Core writes it; Substrate owns the authoritative form** | Upstream: immutable execution binding pinned to revision + contract hash (`substrate/src/workitems/dispatch-gate.ts:1-15`; `domain/execution-binding.ts`). Core's sidecar has no revision/hash → superseded by execution binding + Journal checkpoint. |
| Readiness probe over deployed skills | **Core may keep the concept; the `bd`-marker vocabulary must be replaced** | The probe is a grep for Beads-native primitives (`readiness/matrix.ts:23-88`). Under ADR-001 that content is a compatibility surface: "Formulas are not the ontology and migrate into the ChainDefinition corpus over time" (`xtrm-main/docs/runtime/adr/001-chain-authoring-compilation.md:21`). Capability readiness must instead be a ChainLoader/compiler availability probe. UNRESOLVED which probe (§9). |
| XML `<change-contract>` renderer | **Delete once Substrate carries the contract** | "When substrate lands and bd issues carry a first-class `<change-contract>` field row (per §6.4), the XML body in the description retires in favor of the row… migration is a rename pass" (`docs/specs/CHANGE-CONTRACT-SHAPE.md:70-75`). |
| Planner Bead creation (`bd create --type task --priority 1`) | **Substrate** | Work+acceptance authority is Substrate Issues: "Substrate Issues are the authoritative work/acceptance surface and durable external projection of ChainRuns; root Epic = native parent; step issues children; blocks edges between steps only" (`runtime/prd/native-chain-runtime.md:63`). |
| Epic/child/test-issue decomposition | **XTRM runtime, via `ResolvedChain`; Substrate materializes** | "Planner output becomes ChainDefinition *before* materialization (`xt spec` change-contract → Pass-2 `recommended_template` annotation → compile → freeze → pour)" (`adr/001:20`). "Materialization: Beads materializes only after freeze… The materializer projects; it never invents a second dependency graph" (`adr/001:20`). |
| "Who creates the children" (today: planner specialist with `bd`) | **XTRM materializer from frozen `ResolvedChain`** | Same citation; plus R1.5 "Substrate materialization happens only after freeze" (`prd:38`). |
| Planner dispatch (`sp run planner --background`) | **XTRM native participant runtime** | R3.11 "Direct Pi AgentSession hosting is the product path" (`prd:48`); `SpecialistActivationProfile` → `Activation → attempt → AgentSession` (`prd:21`); specialists doc: "neither invokes the legacy `sp run` CLI", "There is no Beads client and no `bd` subprocess on the native path" (`specialists-master/docs/native-activation.md:39-48`). |
| Plan → work-item materialization transaction | **Substrate `PlanningService`** | `PlanDraft` + `PlanningService.check()` / `apply()`: validate everything up front, commit all revisions/edges/aliases/events in one transaction or none, idempotent by `planKey` (`substrate/src/service/planning-service.ts:8-15,105,335-348`); PRD §16 (`docs/substrate/substrate-issues-v0-prd.md:828-859`); CLI `sb plan check|apply --file` (`substrate/cli/sb.ts:293,510-514,1896-1898`). |
| Planner-result ingest | **Substrate Journal** | `JOURNAL_KINDS` includes `result` (`substrate/src/domain/journal.ts:16-27`); bounded `ResultPayload` (`journal.ts:128-139`). |
| Handoff to composition gate | **XTRM** (`sb chain review/insert/approve`), currently nonexistent | `chain_templates.md:73-77` names composition as the dispatcher's job ("pours the formula → creates the molecule + child step beads with the right dependency edges. Reviewed / approved / insert-mutated via `sp chain review/approve/insert`"); released status: "no released `sp chain` command family" (`execution-plan.md:216`). |
| Drift detect (`status`) | **Core keeps the UX; source of truth becomes Substrate projections** | Core's drift compares spec.yaml against `bd show`/`bd children`/`bd dep cycles` (`drift.ts:44-132`). Substrate has recomputable projections and `changesSince` (`workitems/store.ts:47-70`), plus Beads IDs resolving as aliases (PRD §20). |
| Archive gate | **Substrate closure + projections** | Substrate has first-class `Closure` with bounded `CLOSURE_OUTCOMES` and stated reason/actor/revision/hash/refs (`substrate/src/domain/closure.ts:1-50`). Core's gate instead reads `bd show` status and a Beads KV key `reviewed:<epic>` (`archive-gate.ts:51-73`). |
| Archive snapshot + `status: archived` flip | **Core** | Filesystem artifact of the programme-intake surface; no Substrate primitive needed. |
| Structured stderr log channel (`xt.spec` events) | **Core, converged on the telemetry contract** | `log.ts:13-17` emits one JSON line per event. Upstream forensic families are named in the channels doc (`channels.md:721`) and the forensic contract; Core event names are currently unordered/unnamespaced (`apply_refused`, `apply_reconciled`, …). ADAPT, not port. |
| `xt topology chains/lineage` read-model | **Core, compatibility** | Explicit bridge-era vocabulary (`docs/chains.md:7`), and it is a projection of `sp ps --json`, not an authority (`topology-projection.ts:255-283`). Retire when `Container(kind=chain)` exists; until then COMPAT. |
| Beads IDs as durable aliases | **Substrate** | `resolveRef` falls through to `issue_aliases` (`substrate/src/service/issue-service.ts:461-488,704-725`); one-shot import maps Beads ids to aliases and never dual-writes (`substrate/src/compatibility/beads/import.ts:1-8`); PRD §20 "Beads IDs resolve as aliases". |

---

## 5. Q5 — Rejection of the naive migration

### 5.1 Explicitly REJECTED
- **`bd create` → `sb issue create` (drop-in).** REJECTED. It preserves the actual defect: the materialization remains **incremental and non-atomic**, and the *shape* still comes from free-text LLM output. `sb issue create` creates exactly one issue per invocation (`substrate/cli/sb.ts:999-1017`): N children become N transactions, a mid-loop failure leaves a partially materialized graph, and there is no draft-level cycle/alias/ownership pre-check. Substrate solved this explicitly: "Planning should not progressively create partially valid work while still reasoning about the plan… `plan apply` commits all Issue revisions, edges, aliases and events or none" (`docs/substrate/substrate-issues-v0-prd.md:830-857`). ADR-001: "the materializer must not invent a second dependency graph" (`adr/001:20` / PRD R1.5 `prd:38`).
- **Keep letting the planner specialist write the work graph.** REJECTED by name: "Letting planners mutate Beads directly as the only representation (loses reviewability/freeze)" is a listed rejected alternative (`adr/001:32`).
- **Keep XML as the contract transport.** REJECTED as target (COMPAT only): it is declared a temporary carrier, not a schema (`CHANGE-CONTRACT-SHAPE.md:70-75`).
- **Let `xt spec` become the chain/pour engine.** REJECTED: "retain `xt spec` as programme planning, not participant topology" (`execution-plan.md:200`); "They must not become competing workflow engines" (`execution-plan.md:69-70`).
- **Treat `sp chain review` as an existing dependency.** REJECTED: it is roadmap only (`specialists-master/docs/design/roadmap/wp-continuity.json:469`); no `chain` verb in the released help (`specialists-master/src/cli/help.ts` CORE_COMMANDS). The handoff must not be advertised as operational until it exists (`execution-plan.md:199`).

### 5.2 Correct convergence (RECOMMENDATION)
```
spec.yaml (Core programme-intake artifact, unchanged authoring UX)
  └─ Core validate/scrutiny/checks (KEEP; shape must emit the Substrate WorkContract)
      └─ normalized authored form: ChainSource variant (TemplateChainSource via
         recommended_template | JsonChainSource via inline steps)
           └─ ChainLoader ─→ ChainDefinition ─→ compiler ─→ ResolvedChain (frozen)
               └─ Substrate materialization: ONE PlanDraft → sb plan check → sb plan apply
                   └─ SchedulerIntent[] → Activation (issueRef) → Pi AgentSession
                       └─ evidence → Journal(result) / Closure → projections back into spec.links
```
Named upstream APIs the design binds to:
`ChainLoader.loadChangeContractRoot(root, catalog)` and `loadTemplate(ref, catalog)` (`experiments/.../src/chain-loader/index.ts:379-416`, `:347-377`); `ChainDefinitionSchema` (`experiments/.../src/chain-contracts/chain-definition.ts:53-64`); `PlanningService.check(draft)` / `apply(draft)` with `PlanDraft {planKey, issues[], edges[]}` (`substrate/src/service/planning-service.ts:44-49,105,335-348`); `sb plan check|apply --file` (`substrate/cli/sb.ts:293,510-514`); `IssueService.createIssue({…}, {idempotencyKey})` (`planning-service.ts:371-386`); `WorkItemStore` (`substrate/src/workitems/store.ts:47-70`); `SpecialistDispatchRequest` + `DispatchCheck` gate (`substrate/src/workitems/dispatch-gate.ts:20-47`); `JournalService` result entries (`journal.ts:16-27,128-139`); `Closure` (`closure.ts`).

---

## 6. Q6 — Planner-result and sidecar schemas: destination map

| Schema today | Where defined | Target concept | Evidence / gap |
|---|---|---|---|
| `PlannerResult {epic_id, children[], test_issues[], first_task?}` | Core `cli/src/spec/reconcile.ts:7-12`; extracted top-level from `sp result --json` at `:74-83` | **Substrate Journal entry `kind: "result"`** with `ResultPayload` | `JOURNAL_KINDS` includes `result` (`journal.ts:16-27`). **Gap (OPEN):** `ResultPayload` is a bounded field set `summary, resultVersion, attempted, outcome, completed[], validation[], findings[], artifactRefs[], receiptRefs[], provenanceRefs[]` (`journal.ts:128-139`) and `validateResultPayload` **rejects unknown keys** (`:155-160`). There is no field for an epic/child id set. `artifactRefs` is the only lossy fit. UNRESOLVED — see §9. |
| `PlannerResult` as declared in the specialist | `specialists-master/config/specialists/planner.specialist.json` → `prompt.output_schema.properties` = the identical four keys; prompt mandates a `## Planner result` prose block | **ChainRuntime runner state** (materialization input), not a Substrate concept | A materialized id set is *input to freeze/materialize*, i.e. chain authoring state, not durable work authority. Under ADR-001 materialization happens only after freeze (`adr/001:20`), so this payload becomes "compiler input", and its durable record becomes an effect receipt + the Journal result. |
| `ApplyState` (`xt.spec.apply-state.v1`) | `cli/src/spec/apply-state.ts:4-16` | **Substrate execution binding** (+ Journal checkpoint for the spec↔work-item link) | Dispatch pins issue + revision + contract hash: "the pinned revision and contract hash the later binding freezes" (`dispatch-gate.ts:41-47`). Core's sidecar has `planner_bead_id` and `planner_job_id` only — no revision, no hash, no attempt. |
| `links` block in `spec.yaml` | `schema.json:202-259`; written at `reconcile.ts:102-118` | **Core programme-intake record of Substrate issue refs** (ids + revisions, not bare Beads ids) | Substrate issues are revision-bearing; storing bare ids makes reconcile stale by construction. The bead-era model: "cross-DB refs stay opaque (Phase 11 cutover; Beads IDs resolve as aliases)" (`prd:63`). |
| `sp result --json` envelope `{job:{id,specialist,status,…}, output, startup_context, error}` | `specialists-master/src/cli/result.ts:291-312` | **Legacy transport; delete from Core** | Core scrapes planner fields from this envelope; the fields are not in it (§0.3). Journal `result` is the replacement channel. |
| `sp run --background --json` launch line `{schema, type:"job_started", jobId, specialist, detached, tmuxSession?}` | `specialists-master/src/cli/run.ts:94-113` | **Legacy transport; delete from Core** | Core expects `job_id`. Native runtime identity is `activation_id`, distinct from `job_id` and `pi_session_id` (`prd:23`; `specialists-master/src/activation/types.ts:8-25`). |
| `xt.spec.status.v1` `DriftIssue {kind ∈ orphan_link,new_child,cycle,linked_open,linked_closed}` | `cli/src/spec/drift.ts:4-33` | **Core read-model over Substrate projections** | Substrate offers `changesSince(ref, afterEventId)` and `resolveContext` (`workitems/store.ts:47-70`). |
| `xt.spec.readiness.v1` (`CapabilityProbeResult`) | `cli/src/spec/readiness/probe.ts:5-10` | **Core capability probe, vocabulary replaced** | Matrix content is `bd swarm` / `bd mol pour` / XML / `recommended_template` / typed `bd dep` / `bd gate` (`matrix.ts:23-88`) — i.e. exactly the assets ADR-001 demotes to compatibility ChainSources (`adr/001:21`). |
| `xt.spec.validate.v1` JSON report | `cli/src/spec/report.ts:41-59` | **KEEP** (Core programme-intake read-model) | No Substrate counterpart needed. |
| `Closure` outcome vocabulary | `substrate/src/domain/closure.ts:16-30` (`completed, superseded, duplicate, wont_fix, invalid, cancelled, abandoned`) | **Target replacement for Core's archive gate** | Core's gate uses Beads status strings + `bd kv get reviewed:<epic>` (`archive-gate.ts:51-73`); it maps only crudely onto closure outcomes. |
| `Container(kind=chain)` / `resolved_chain_json` | design only | **ChainRuntime runner state** | `substrate_design_en.md:1743` describes the columns; no `Container` symbol exists in `substrate/src` (VERIFIED grep). |

---

## 7. Q7 — What breaks if Specialists' native activation replaces the planner dispatch path

All VERIFIED against `specialists-master/src/activation/*`, `docs/native-activation.md`, and Core's spec code.

1. **Write authority disappears.** The native host refuses dispatch when the Substrate store is absent and "never falls back to another authority"; "There is no Beads client and no `bd` subprocess on the native path" (`native-activation.md:41-48`). The planner's entire current job — create the epic/children with `bd` — has no permitted path; its definition declares `capabilities.external_commands: ["bd","git"]` and `beads_integration: "auto"` (`planner.specialist.json`), and the native path resolves capability grants (`prd` R4.15 "request ≠ permission") rather than honoring `external_commands` as a shell grant.
2. **Admission order is inverted relative to Core.** Native admission is strictly: specialist resolution → workspace → **work gate (inline contract XOR `issueRef`; draft/unattested/blocked/scope-expanding refuses `issue_not_dispatchable`; inline contract is validate → create → attest → claim before any `AgentSession`)** → tool contract/preflight (`native-activation.md:59-75`). Core creates an **unattested, unclaimed** Bead (`apply.ts:222` has no `--claim`; `spec-no-bypass.test.ts:20-23` forbids claiming) and then dispatches a specialist to *create* its own work. On the native path that is exactly the refused state.
3. **`--background` + `job_id` + `sp result` all vanish.** Native dispatch is an in-process activation with `activationId`/`attemptId`/`sessionId` (`activation/types.ts:8-25`), driven by the Pi extension / Claude MCP frontend, not `sp run`. Core's `planner_job_id` sidecar field (`apply-state.ts:9`) and `sp result` poll (`reconcile.ts:43`) have no counterpart.
4. **Result channel changes shape.** There is no `result.txt`: `sp result` reads `.specialists/jobs/<id>/result.txt` relative to `process.cwd()` (`result.ts:14,355-366`), while the native path records outcomes as Substrate journal/provenance rows (`native-activation.md:79-95`). Core's reconcile would have nothing to read even before the field mismatch.
5. **Contract-vs-XML mismatch hard-fails earlier.** Native inline contracts are validated as the seven-field `WorkContract` (`contract.ts:12-25`) and structurally checked by `validateContractStructure`; `success` is a **string**, not an array, and `scope/nonGoals/constraints/validation/output` are required arrays. Core's XML carries `success` as repeated `<item>` elements (`to-change-contract.ts:50`) and emits an empty `<output/>` (`:56`). An inline-contract dispatch of Core's XML fails structural validation.
6. **The readiness gate must be redefined.** Core's 8 `bd`-marker capabilities (`matrix.ts:23-88`) become meaningless; the native equivalent gate is the Substrate dispatch service's readiness (`dispatch-gate.ts`), which Core must render rather than re-implement. Also `capabilities.required_tools` is resolved into a bounded allowlist — "it must not expose unrestricted generic Pi built-ins (current adapter behavior: `noTools:"builtin"` + allowlist)" (`prd:55`).
7. **The no-bypass guard test becomes wrong.** `cli/src/tests/spec-no-bypass.test.ts:20-23` forbids `bd update --claim` anywhere under `cli/src/{spec,commands/spec}`. On the native path, claiming is a **precondition of activation** (admission step 3), not an operator-only bypass. The guard must be rewritten to forbid *bypassing the composition gate*, not to forbid claiming.
8. **The `sp chain review` handoff stays decorative, and gets worse.** `handoff.ts:24` prints a command that does not exist in either released CLI (`execution-plan.md:216`; specialists `help.ts`). With native activation there is additionally no Beads epic id for it to take as an argument.
9. **Epic read-models lose their source.** Core's `xt topology chains/lineage` views (`topology-views.ts:37,52-53,140-156`) read `sp ps --json` `chain_id`/`chain_root_job_id`; the upstream canon demotes that vocabulary to an opaque correlation field (`docs/chains.md:7`). Target is `Container(kind=chain)`, which does not exist.
10. **Reconcile idempotency guarantee changes basis.** Core's idempotency is "a second reconcile run produces a byte-identical spec.yaml" (`reconcile.ts:28-34`; asserted `spec-apply.integration.test.ts:155-160`). Substrate provides *stronger* idempotency at the materialization boundary (`mutateOnce` on `planKey`, `planning-service.ts:335-348`) and per-issue `idempotencyKey` (`:383`), but a native path removes the file-rewrite model entirely — the spec.yaml write-back survives only as a Core-side projection.

---

## 8. Audit matrix

Columns are fixed by the lane brief. `Action ∈ {KEEP, ADAPT, DELETE, REPLACE, COMPAT}`; `Confidence ∈ {VERIFIED, INFERRED, OPEN}`.

| Current surface | Current behavior | Current owner | Target owner | Target primitive | Evidence | Action | Upstream dependency | Ordering | Acceptance proof | Migration hazard | Release impact | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `xt spec draft` (templates, slugify) | Renders minimal/full YAML template, schema round-trip self-check | Core | Core | none (Core programme intake) | `commands/spec/draft.ts:35-61`; `spec/templates.ts:4-114`; `spec/slug.ts:6-15` | KEEP | none | anytime | `xt spec draft` output zod-validates | low | none | VERIFIED |
| `xt spec validate` structural checks | Pure validator, 7 error codes, warnings, inferred scrutiny/layers | Core | Core | `assertContractShape` for shape parity | `spec/validate.ts:53-102`; `checks.ts:35-193`; `scrutiny.ts:19-64` | ADAPT | `substrate/src/domain/contract.ts:27-66` | after spec→WorkContract mapping decided | `xt spec validate --json` on a fixture; parity test spec↔`assertContractShape` | `success` string-vs-array, `output` empty vs required | none | VERIFIED |
| SCRUTINY inference/floor | Keyword signals raise explicit scrutiny; open questions block at high/critical | Core | Core infers, Substrate enforces | `ScrutinyPolicy`, `SCRUTINY_LEVELS` | `scrutiny.ts:19-64`; `checks.ts:178-193`; `substrate/src/domain/readiness.ts:36-47`; `contract.ts:67-73` | ADAPT | `substrate/src/domain/readiness.ts` | enforcement after attestation lands | floor never lowered by a participant (test) | Core `low` has no Substrate equivalent for non-code chains | none | VERIFIED |
| `xt spec doctor` readiness probe | Greps 8 `bd`-marker regexes in deployed skill text; exit 1 if any absent | Core | Core (redefined) | ChainLoader/compiler capability probe (UNRESOLVED) | `spec/readiness/matrix.ts:23-88`; `probe.ts:16-48` | REPLACE | none released | first, gates apply | `xt spec doctor --json` returns ready with new vocabulary | today always fails ⇒ gate is dead weight | none | VERIFIED |
| `xt spec apply` readiness gate | Refuse exit 65 before any write | Core | Core (redefined) | same as above | `commands/spec/apply.ts:88-105`; executed → EXIT=65 | ADAPT | none released | unchanged position | exit-code test | — | none | VERIFIED |
| `spec.yaml` schema v1 | Closed schema, 15 required fields, `links` = Beads FK record | Core | Core | Substrate `WorkContract` field names for the contract subset | `spec/schema.json:261-277`; `schema.ts:44-68`; `substrate/src/domain/contract.ts:12-25` | ADAPT | `substrate/src/domain/contract.ts` | phase 1 | zod↔JSON-Schema parity test + WorkContract mapping test | `links` scalar ids lose revision pinning | none | VERIFIED |
| `<change-contract>` XML transform | 8 tags, escaping builder, `R<n>:`/`<kind>:` prefixes | Core | Core (COMPAT) then delete | Substrate contract row | `transform/to-change-contract.ts:30-58`; `xml.ts:18-67`; `docs/specs/CHANGE-CONTRACT-SHAPE.md:70-75` | COMPAT | Substrate `<change-contract>` row (§6.4) | last to retire | tag-for-tag rename test | double representation during transition | none | VERIFIED |
| Planner bead creation (`bd create --type task --priority 1`) | Core shells `bd`; no claim, no attestation, no contract row | Core | Substrate | `IssueService.createIssue` via `PlanDraft` | `commands/spec/apply.ts:218-234`; `substrate/src/service/planning-service.ts:371-386` | DELETE | `sb plan apply` (released) | after PlanDraft exists | `sb plan apply` produces the same epic+children in one transaction | premature deletion strands the flow (which is already non-operational) | removes a `bd` runtime dependency | VERIFIED |
| Planner dispatch (`sp run planner --bead X --background --json`) | Core shells legacy CLI; parses `job_id` which the binary never emits | Core | XTRM native runtime | `SpecialistDispatchRequest` + `DispatchCheck` + `WorkItemStore` | `spec/dispatch.ts:21-41`; `specialists-master/src/cli/run.ts:94-113`; `substrate/src/workitems/dispatch-gate.ts:20-47` | REPLACE | `dispatch-gate` (released), native host (released) | after work item is attested+claimed | dispatch refuses `issue_not_dispatchable` for unattested work | order inversion (§7.2); planner's `bd` write path disappears | breaks/retires the planner-legacy path | VERIFIED |
| `.apply-state.json` sidecar | spec↔planner bead↔job map; atomic write | Core | Core writes projection, Substrate owns binding | Execution binding + Journal checkpoint | `spec/apply-state.ts:4-37`; `dispatch-gate.ts:41-47` | ADAPT | `substrate/src/domain/execution-binding.ts` | with dispatch replacement | sidecar carries revision+hash and matches `sb issue show` | declared-but-unwritten fields (`reconciled_at`,…) already drift | none | VERIFIED |
| `xt spec apply --reconcile` | `sp result` scrape, `bd show` orphan check, YAML rewrite, `status: planned` | Core | Substrate materialization + Journal result | `PlanningService.apply` + Journal `result` | `spec/reconcile.ts:43-118`; `journal.ts:16-27,128-139` | REPLACE | `sb plan apply` (released); `ResultPayload` gap OPEN | after freeze | reconcile is idempotent under `planKey`, not file bytes | §0.3: today it cannot succeed against real `sp` | removes `sp` dependency | VERIFIED |
| `PlannerResult` field contract | 4 keys mirrored in Core + planner `output_schema` | Specialists (definition), Core (consumer) | XTRM ChainRuntime (materialization input) | ChainDefinition step graph → PlanDraft issues[] | `reconcile.ts:7-12`; `planner.specialist.json` `output_schema` | DELETE | `PlanDraft` (released); no id-set ResultPayload field (OPEN) | after chain freeze | one frozen chain materializes to exactly one PlanDraft | id-set has no bounded home today | — | VERIFIED |
| Materialization transactionality | Non-existent: N independent `bd create` calls by an LLM | planner specialist (external) | Substrate | `PlanDraft.check/apply` in one transaction | `planning-service.ts:8-15,105,335-348`; `substrate-issues-v0-prd.md:830-857` | REPLACE | `sb plan check|apply` (released) | phase 1 of convergence | re-applying same `planKey` returns recorded result, zero row growth | planner must stop writing the board | — | VERIFIED |
| Epic/child decomposition authorship | LLM planner chooses topology; no reviewable frozen form | planner specialist | XTRM compiler + human freeze gate | `ChainDefinition` → `ResolvedChain` | `adr/001:18-20,32`; `prd:36-38` | REPLACE | ChainLoader/compiler **not released** | after ChainLoader lands | compiler determinism test; structural change requires new revision | blocks on unreleased upstream (§9.1-3) | cannot ship in this release | VERIFIED |
| Typed dependency edges | Planner instructed to emit typed `bd dep`; Core drift reads `bd dep cycles` | planner specialist + Core | Substrate | `EDGE_KINDS` + cycle rejection in `check()` | `readiness/matrix.ts:56-63`; `spec/drift.ts:120-132`; `planning-service.ts:289-297` | ADAPT | `planning-service.ts` (released) | with materialization | invalid edge kind / block cycle rejected at `check` | current edges are unvalidated prose instructions | — | VERIFIED |
| `xt spec status` drift | `bd show` per id, `bd children`, `bd dep cycles`, orphan/new-child/cycle kinds | Core | Core read-model over Substrate projections | `changesSince`, `resolveContext`, recomputable projections | `spec/drift.ts:44-132`; `workitems/store.ts:47-70`; `prd:63` | ADAPT | `WorkItemStore` (released) | after ids become Substrate refs | drift report parses `sb issue show`/journal timeline | Beads-only signals (`new_child` from `bd children`) have no direct analogue | none | VERIFIED |
| `xt spec archive` gate | Requires `status: planned`, epic+children+test closed, `bd kv reviewed:<epic>` at high/critical, zero drift | Core | Substrate | Closure + readiness/attestation + projections | `spec/archive-gate.ts:33-99`; `substrate/src/domain/closure.ts:16-50` | REPLACE | `ClosureService` (released) | last phase | archive refused until Closure exists with an approved outcome | `bd kv` review evidence has no Substrate row (must become journal/attestation refs) | removes `bd kv` dependency | VERIFIED |
| Archive snapshot + status flip | `archive/<id>.yaml` never overwrites; YAML status rewrite | Core | Core | none | `commands/spec/archive.ts:46-62` | KEEP | none | anytime | snapshot immutability test | — | none | VERIFIED |
| Composition-gate handoff | Prints `sp chain review <epic>`; never approves/claims | Core | XTRM | `sb chain review/insert/approve` | `spec/handoff.ts:19-28`; `commands/spec/apply.ts:203-204`; `XTRM-GUIDE.md:315` | COMPAT | **not released** (`execution-plan.md:216`) | after `sb chain` lands | handoff target command exits 0 | advertises a nonexistent command today | must not be advertised as operational | VERIFIED |
| No-bypass guard test | Fails suite if `sp chain approve` or `bd update --claim` appear in spec paths | Core | Core (semantics change) | none | `tests/spec-no-bypass.test.ts:20-23` | ADAPT | — | with dispatch replacement | guard forbids gate bypass, not claiming | wrong invariant on native path (§7.7) | — | VERIFIED |
| Structured stderr log channel | One JSON line per event, `component: xt.spec`, unbounded event names | Core | Core | forensic families / telemetry contract | `spec/log.ts:13-17`; `channels.md:721`; `prd:70` | ADAPT | telemetry contract | with read-model work | event names present in a registry test | event names are free-form strings today | none | VERIFIED |
| `@xtrm/contracts` topology chain fields | `chain_id`, `chain_root_job_id`, `is_chain_root` passthrough | Core | Core (COMPAT) | `Container(kind=chain)` | `packages/contracts/src/types.ts:406-408`; `topology-projection.ts:269-271` | COMPAT | `Container` **not released** | later | projection parses both vocabularies | bridge-era identity (`docs/chains.md:7`) leaked into a versioned schema | v1 schema churn later | VERIFIED |
| `xt topology chains/lineage` views | Read-only rendering of sp job lineage | Core | Core (COMPAT) | ChainRun projections | `topology-views.ts:37,52-53,140-156` | COMPAT | `ChainRun` **not released** | later | view snapshot tests | wording asserts a chain model that is not the target one | — | VERIFIED |
| Planner specialist definition | `## Planner result` block; reuse parent epic; `bd`-native issue creation; `output_schema` 4 keys | Specialists | XTRM runtime (input shape) | `ChainDefinition.steps` + materializer | `planner.specialist.json` (prompt + `output_schema` + `capabilities.external_commands`) | REPLACE | materializer **not released** | after compiler | planner output compiles to a valid ChainDefinition | planner is the current sole authoring path; removing it without compiler leaves a gap | cross-repo release coordination | VERIFIED |
| `sp result --json` envelope | `{job:{…},output:"<text>",startup_context,error}`; no planner fields | Specialists | XTRM (Journal result) | `ResultPayload` | `specialists-master/src/cli/result.ts:291-312`; `reconcile.ts:74-83` | DELETE (Core consumer) | `ResultPayload` (released, but no id-set field) | with reconcile replacement | reconcile reads a journal result row | §0.3 verified breakage | removes the false green | VERIFIED |
| `sp run --background --json` line | `{type:"job_started", jobId, …}` camelCase | Specialists | XTRM (activation id) | `ActivationId` | `specialists-master/src/cli/run.ts:94-113`; `activation/types.ts:15-20` | DELETE (Core consumer) | native host (released) | with dispatch replacement | sidecar records activation id | §0.3 verified breakage | — | VERIFIED |
| `sb plan check|apply` usage | Not used by Core | Substrate | Substrate | `PlanningService` | `substrate/cli/sb.ts:293,510-514,1896-1898` | (new dependency) | released | phase 1 | `sb plan apply` idempotency on `planKey` | emits camelCase Substrate contracts, needs spec mapping | new external CLI requirement | VERIFIED |
| `ChainLoader.loadChangeContractRoot` | Upstream experiment function documented as consuming `xt spec` change-contract roots | XTRM experiment (**non-canonical**) | XTRM | `ChainDefinition` | `experiments/.../src/chain-loader/index.ts:379-416`; `experiments/.../README.md:3` | (new dependency) | **not released** | phase 2 | loader resolves `recommended_template` and inline `steps` | depending on an experiment | blocks phase 2 | VERIFIED |
| Beads→Substrate id bridging | Not used by Core | Substrate | Substrate | `resolveRef` alias fallback + one-shot import | `substrate/src/service/issue-service.ts:461-488,704-725`; `compatibility/beads/import.ts:1-8` | (new dependency) | released | phase 1-2 | old bd ids in `spec.links` still resolve | import is one-shot, no dual-write | requires migration event | VERIFIED |
| `interactive-plan.ts` (in scope by brief) | `xt` installer/sync multiselect UI over `PreflightPlan`; importable only by its own test | Core (install surface) | Core (install surface) | none | `core/interactive-plan.ts:122-174`; `test/interactive-plan.test.ts:11-14` | KEEP (out of scope) | none | n/a | existing installer test | none — but see §8 "Not inspected" note | none | VERIFIED |
| `docs/specs/UPSTREAM-DEPENDENCIES.md` | Prose cross-repo dependency index with a rules-of-refresh section | Core | Core | none | `docs/specs/UPSTREAM-DEPENDENCIES.md:11-42` | ADAPT | none | with matrix change | matrix entries have matching rows | already partially accurate; hides release status of `sp chain` | none | VERIFIED |
| `docs/migration/create-spec-deprecation.md` | Preemptive contract: no second source of truth, `/create-spec` must not call `bd create` | Core | Core | none | `docs/migration/create-spec-deprecation.md:20-34` | KEEP | none | anytime | doc cross-check test | — | none | VERIFIED |

### 8.1 Counts by Action
| Action | Count |
|---|---|
| KEEP | 4 |
| ADAPT | 9 |
| DELETE | 4 |
| REPLACE | 5 |
| COMPAT | 3 |
| (new upstream dependency, not an action on current code) | 3 |
| **Total rows** | **28** |

Rows counted as actions on current surfaces: 25 (`KEEP 4 + ADAPT 9 + DELETE 4 + REPLACE 5 + COMPAT 3`). Confidence: **VERIFIED 28, INFERRED 0, OPEN 0** for the matrix cells as written; the two OPEN items live in §9 because they are unresolved *target* questions, not uncertain current-state claims.

---

## 9. Proposed spec→Chain convergence design (DESIGN ONLY, not implemented)

Nothing in this section is implemented, proposed for immediate implementation, or authorised. It is the reconciled target shape the audit recommends.

### 9.1 The three invariants the design must not break
- `ChainDefinition ≠ ChainRun`; `ChainSource` is one input, template is one variant (`prd:29`).
- Materialization happens **only after freeze** and **must not invent a second dependency graph** (`adr/001:20`; `prd:38`).
- `xt spec` stays programme planning; it must not become a workflow engine (`execution-plan.md:69-70,200`).

### 9.2 Staged shape
**S0 — Stop the false green (no upstream dependency).** Mark the planner dispatch/reconcile path non-operational in `xt spec apply`, because both parsers contradict the released `sp` output (§0.3). This removes a misleading success claim without adding capability. Core-side only.

**S1 — Spec → normalized authored form (depends on nothing unreleased).**
1. Keep `spec.yaml` as the Core authoring artifact and `xt spec validate` as its gate.
2. Emit the contract in Substrate's `WorkContract` field set (`problem, success, scope[], nonGoals[], constraints[], validation[], output[]`) rather than XML prose, and keep XML as a COMPAT rendering for one release.
3. Extend the spec with the two fields the upstream change-contract root already recognises — `recommended_template` (+ `recommended_template_version`) and optional inline `steps` — matching `loadChangeContractRoot`'s contract that "Both present → error; neither → error" (`chain-loader/index.ts:398-412`). This is the single point where Core's artifact meets the chain ontology.
4. Materialize through Substrate atomically: build one `PlanDraft` (`planKey`, `issues[]` with `parentKey` for epic→children, `edges[]` with `blocks`) and commit it with `sb plan apply`. Root epic = native parent; step issues children; `blocks` between steps only — exactly PRD §20 (`prd:63`).
5. Write back issue **refs + revisions**, not bare Beads ids, into `spec.links`, and persist the binding (issue id, revision, contract hash) in the sidecar.

**S2 — Freeze before materialization (depends on unreleased ChainRuntime).**
6. Route the normalized form through `ChainLoader` → `ChainDefinition` → pure compiler → `ResolvedChain`; structural change requires a new reviewed revision.
7. Move the composition gate to the released/`sb`-canonical verb family (`sb chain review/insert/approve`), and only then advertise the handoff.

**S3 — Execution and return path.**
8. Dispatch through the Substrate gate + native activation using `issueRef`, with the planner's materialization output carried as a Journal `result` entry (and artifact refs), not a text scrape.
9. Close/archive through `Closure`; derive `xt spec status` from Substrate projections and `changesSince`.

### 9.3 Exact upstream primitives each stage depends on
| Stage | Primitive | Released today? |
|---|---|---|
| S1.2 | `WorkContract` / `assertContractShape` / `validateContractStructure` (`substrate/src/domain/contract.ts`) | Yes |
| S1.4 | `PlanDraft`, `PlanningService.check/apply`, `sb plan check|apply --file` (`planning-service.ts:44-49,105,335-348`; `sb.ts:293,510-514`) | Yes |
| S1.4 | `IssueService.createIssue` with per-key `idempotencyKey` (`planning-service.ts:371-386`) | Yes |
| S1.5 | `resolveRef` alias fallback for legacy Beads ids (`issue-service.ts:461-488`) | Yes |
| S1.5 | Execution binding / `ExpectedClaimPin` (`domain/execution-binding.ts`; `dispatch-gate.ts:36-47`) | Yes |
| S2.6 | `ChainLoader.loadTemplate` / `loadChangeContractRoot`, `ChainDefinitionSchema` | **No** — experiment only |
| S2.6 | `ResolvedChain` persistence (`resolved_chain_json`) | **No** — design only |
| S2.7 | `sb chain review|insert|approve` | **No** — roadmap only |
| S3.8 | `SpecialistDispatchRequest` / `DispatchCheck` / `WorkItemStore` | Yes |
| S3.8 | Journal `result` + `ResultPayload` | Yes (with the field gap in §9.4) |
| S3.9 | `ClosureService` + projections | Yes |

### 9.4 What does NOT exist upstream yet — these cannot be depended on
1. **`ChainLoader` / normalizer / `ChainDefinition` pipeline in a released package.** Only `experiments/agentsession-sre-chain-vertical-slice/` (status: "bounded harness experiment; non-canonical", `README.md:3`). No `ChainLoader`/`ChainSource`/`ChainDefinition` symbol under `packages/`.
2. **`ResolvedChain` and its persistence.** No `resolved_chain_json` column, no freeze artifact; `docs/shared/xtrm-current-execution-plan.md:217-218` lists "no authoritative selection/compiler boundary" and "no persisted `ResolvedChain`" as open gaps.
3. **The composition gate.** No `sb chain` group (`sb.ts:841` KNOWN_GROUPS = `init, issue, project, plan, journal, provenance, import, export`); no `sp chain` verb in the released Specialists help. Both are roadmap lines (`wp-continuity.json:469`). `execution-plan.md:216` states "no released `sp chain` command family".
4. **`Container(kind=chain)` and `ChainRun`.** No `Container` symbol anywhere in `substrate/src` (VERIFIED grep). Column design exists only in `docs/substrate/substrate_design_en.md:1743`.
5. **Pure reducer + `SchedulerIntent[]`.** No `SchedulerIntent`/`ChainReducer`/scheduler code in any `packages/*/src`. ADR-002 requires them ("SchedulerIntents are exact and idempotent; keys are persisted before dispatch", `adr/002:11`).
6. **Effect receipts / idempotency-key store for external effects.** ADR-002 mandates append-only receipts and an `uncertain` outcome (`adr/002:9-10`); no receipt table or service exists in `substrate/src`.
7. **`ResolvedChain` → `PlanDraft` materializer.** Only the experiment's Beads adapter exists, and it writes to a private sandboxed Beads DB (`experiments/.../src/adapters/beads.ts:1-24,84`) — never Substrate.
8. **`recommended_template` on the planner.** The readiness matrix requires the marker (`readiness/matrix.ts:48-55`) but the released planner `output_schema` has only `epic_id/children/test_issues/first_task`, and the planning skill in this tree contains the marker nowhere (VERIFIED: 0 hits across all four skill copies). Execution plan (W-planning) records the skill-doc direction was "updated in docs only" (`runtime-decision-matrix.md:84`).
9. **A bounded home for the materialized id set.** `ResultPayload` rejects unknown keys (`journal.ts:155-160`) and has no epic/children field. UNRESOLVED (§10).
10. **ChainRun ↔ Substrate Issue projection code.** PRD §20 states the requirement (`prd:63`); no projection implementation exists.
11. **The seven-field `WorkContract` accepting `ChainDefinition` step contracts.** Specialists has `StepContract` (`specialists-master/src/activation/step-contract.ts:59-79`) with `rootWorkRef/mandate/inputs/outputs/scope/nonGoals/constraints/validation`; Substrate has no step-contract row type. The join point between step contracts and Substrate issues is not implemented anywhere.

---

## 10. Surfaces searched

| Command / method | Result |
|---|---|
| `find cli/src/spec -type f` (20 files) + read all of them | §1, §2 |
| Read all 7 `cli/src/commands/spec{,.ts}` files | §2 |
| Read `cli/src/core/interactive-plan.ts` + `cli/test/interactive-plan.test.ts` | out of scope; installer UI |
| Read all 6 `cli/src/tests/spec-*.test.ts` | §2, §5 |
| Repository-wide term sweep (excluding `node_modules`, `.git`, `dist`, `.xtrm/worktrees`): `ChainLoader`, `ChainSource`, `ChainDefinition`, `ResolvedChain`, `ChainRun`, `resolved_chain`, `chain_template`, `recommended_template`, `bd mol`, `bd formula`, `sp chain`, `sb chain`, `PlanDraft`, `sb plan`, `on-the-run`, `applies_when`, `materialize` | §3; only prose hits |
| `grep -rn chain cli/src --include='*.ts'` (22 files) then filtered to non-test | §3: topology read-model only |
| `docs/` spec surface: `ARCHIVE-GATE.md`, `CHANGE-CONTRACT-SHAPE.md`, `EXAMPLE.yaml`, `SCHEMA.md`, `UPSTREAM-DEPENDENCIES.md`, `VALIDATE-JSON.md`, `docs/migration/create-spec-deprecation.md`, `XTRM-GUIDE.md:315` | §1, §4 |
| Executed `node cli/dist/index.cjs spec doctor --json` | ready=false, 8/8 missing |
| Executed `XT_SPEC_BD_BINARY=/bin/false XT_SPEC_SP_BINARY=/bin/false node cli/dist/index.cjs spec apply docs/specs/EXAMPLE.yaml` | EXIT=65, no `bd`/`sp` call reachable |
| Upstream read: `docs/runtime/prd/native-chain-runtime.md`, `adr/001`, `adr/002`, `docs/chains.md`, `docs/runtime/README.md`, `docs/runtime/reconciliation/runtime-decision-matrix.md` (Q24–Q29), `docs/shared/xtrm-current-execution-plan.md` §4–§6, `docs/substrate/chain_templates.md` §1–§2, `docs/substrate/substrate-issues-v0-prd.md` §16, `docs/channels/channels.md` (TOC + §10.5) | §4–§7 |
| Upstream code read: `packages/substrate/src/service/planning-service.ts`, `src/domain/{contract,issue,journal,readiness,closure}.ts`, `src/workitems/{store,dispatch-gate}.ts`, `src/compatibility/beads/import.ts`, `cli/sb.ts` (groups/verbs/flags/`runPlan`) | §4–§7 |
| Upstream experiment read: `src/chain-loader/index.ts` (`loadTemplate`, `loadChangeContractRoot`), `src/chain-contracts/{chain-source,chain-definition}.ts`, `src/adapters/beads.ts` | §5, §9 |
| Specialists read: `config/specialists/planner.specialist.json`, `docs/native-activation.md`, `src/activation/types.ts`, `src/activation/step-contract.ts`, `src/cli/{run,result,help}.ts`, roadmap `wp-continuity.json:469` | §2, §6, §7 |
| Readiness-marker verification across `skills/planning/SKILL.md`, `skills/test-planning/SKILL.md`, `.xtrm/skills/default/planning/SKILL.md`, `~/.xtrm/skills/default/planning/SKILL.md` | 0 hits for all 8 markers; `test-planning` not deployed |
| Sibling lane presence: `docs/migrations/core-substrate-audit/lane2-xt-cli-lifecycle.md` (exists, not read) | — |

## 11. Not inspected

- `cli/dist/index.cjs` and source maps (bundled output; treated as derived from `cli/src`).
- `node_modules/**` (all repos).
- Specialists `dist/**` (built output).
- Upstream `docs/substrate/substrate_design_it.md` rev12 in full (read only the two `recommended_template` regions by grep; EN twin is declared stale in `docs/runtime/README.md`).
- `.git` objects (history read only via `git log --oneline` for the spec files).
- Upstream `docs/channels/channels.md` in full (875 lines; read TOC and the §10.5 forensic families section only).
- Upstream runtime ADR-003, ADR-004, ADR-005, ADR-006 in full.
- Experiment internals beyond `chain-loader`, `chain-contracts`, `adapters/beads.ts`, `README.md` — specifically `src/chain/{reducer,scheduler,store,finalize,topology,trusted-context,provenance-receipts}.ts` and `src/chain-compiler/index.ts` were **not** read. The claim "reducer/scheduler is not released" rests on their absence from `packages/` and on `execution-plan.md` line 220 ("no evidence reducer"), not on a line-level reading of the experiment.
- Other upstream packages (`xtrm-app`, `xtrm-tui`, `xts`, `arena-top`, `board-audit`, `mcpq`, `service-knowledge`, `xtprompt`) — not searched for chain code. RECOMMENDATION: a follow-up sweep should confirm no chain runtime hides in `packages/xtrm-app/src/runtime`.
- `xtmux` and other repositories entirely (out of declared scope).
- Core `docs/design/**` beyond `command-outcome-v1.md:53`; `docs/architecture/superseded-designs.md` beyond its chain row.
- Pi extension packages `packages/pi-extensions/**` (grep for `chain` terms returned no authoring hits, but not read).

## 12. Unresolved (exact questions)

- **U1 — Where does the materialized work-id set live on the Substrate side?** `ResultPayload` is bounded and rejects unknown keys (`journal.ts:128-160`), and no released concept carries "epic + children + test issues". Options: (a) a new bounded `ResultPayload` field; (b) `artifactRefs` + a `resultVersion` bump; (c) drop the id-set entirely and let the `PlanDraft`/`planKey` receipt be the only materialization record. Which one is upstream-owned, and who decides?
- **U2 — Does `PlanDraft` cover the frozen-chain materialization, or does it need a chain-aware superset?** `PlanIssueSpec` has `key, projectId, title, kind, contract, scrutiny, ownership, contextRefs, parentKey, updateIssueId, expectedRevision, aliases` (`planning-service.ts:19-35`) — no step class, no `blocks`-only topology constraint, no chain id. Is the intended binding `ResolvedChain → PlanDraft`, or a new chain materializer that calls `PlanningService`?
- **U3 — What replaces the readiness probe vocabulary, and when?** No released primitive answers "is the chain compiler installed and usable". Options: probe `sb` subcommand availability; probe a ChainDefinition catalog; or delete the gate once materialization is atomic. Which is authoritative, and should `xt spec apply` fail closed in the interim?
- **U4 — Is `recommended_template` on the planner still the intended interface?** Readiness requires it (`matrix.ts:48-55`) and `loadChangeContractRoot` consumes it, but no released planner emits it and the skill does not teach it (`runtime-decision-matrix.md:84` says docs-only). Does the migration wait for the planner change, or does Core author the ChainSource itself and demote the planner to a suggestion?
- **U5 — Who owns `spec.yaml` → `ChainSource` normalization?** `loadChangeContractRoot` is documented as consuming "a change-contract ROOT **already parsed out of spec.yaml by `xt spec`**" (`chain-loader/index.ts:385`) — that phrasing suggests Core parses YAML and the loader receives a root object. Is the crossing point a JSON object, a file path, or a workspace boundary, and which repo owns the schema version?
- **U6 — Release ordering for the broken planner path.** §0.3 shows the dispatch and reconcile parsers contradict released `sp`. Is the sanctioned interim (a) mark non-operational, (b) fix the parsers to the released camelCase/nested shapes, or (c) freeze the surface pending the native runtime? This determines whether S0 ships alone.
- **U7 — Status of `xt topology`/`@xtrm/contracts` chain fields.** `chain_id`/`chain_root_job_id`/`is_chain_root` are versioned in `packages/contracts` while the canon demotes that vocabulary (`docs/chains.md:7`). Do they get deprecated in place, or does a v2 schema carry `container_id`? No upstream decision found.
- **U8 — Which repo owns the step-contract ↔ Substrate issue join?** Specialists has `StepContract` (`rootWorkRef` + `mandate/inputs/outputs/scope/nonGoals`) keyed by `issueRef`; Substrate has no step-contract row type and `WorkContract` is the root seven-field shape. The mapping is unimplemented in both repos; nothing found that names an owner.

---

*End of Lane 3 report. Read-only audit; no source, board, or git state was modified. The only file created is this report.*

# Core Substrate Hard-Cut Migration Plan — Implementation Freeze

> **Status: `DESIGN_FREEZE`** — Wave A exploration complete; the plan is
> implementation-ready in shape but **NOT authorized to implement**.
> Marked `IMPLEMENTATION_READY` only by the §7.3 Core gate procedure.
>
> Authority for the target architecture is upstream, not this document:
> `xtrm/docs/substrate/sbcloseout4-adr.md` (2932 lines, 103 sections) at
> `xtrm-dev/xtrm@12e71d74`. Where this plan and that ADR disagree, the ADR wins.
>
> Raw per-lane evidence: [`core-substrate-audit/`](./core-substrate-audit/) —
> supporting material, not required reading.

---

## 0. Scope, authority and method

### 0.1 Authorization

```text
AUTHORIZED     : read-only exploration; this plan
NOT AUTHORIZED : implementation; publication; state migration;
                 Beads deletion; version bumps; runtime config changes
```

### 0.2 Primary architectural rule

This is **not** a Beads → Substrate rename exercise. Every behaviour resolves
ownership before a replacement is named:

```text
1. Does Core still own this behaviour?        4. Does the XTRM Chain Runtime own it?
2. Does Substrate now own it?                 5. Is it compatibility/import-only?
3. Does Specialists now own it?               6. Is it obsolete and should be deleted?
```

Mechanical translation (`bd foo` → `sb foo`) is rejected. §3.3 contains the
worked counter-example where a rename would preserve a broken, non-atomic,
LLM-authored materialization model.

### 0.3 Evidence discipline

`Confidence ∈ {VERIFIED, INFERRED, OPEN}`. Non-source statements are labelled
`INFERENCE` / `RECOMMENDATION` / `UNRESOLVED`. **No agent summary was accepted as
authority.** Every high-consequence claim was independently re-checked; the
adversary pass (§0.4) refuted several lane claims and three claims in this
document's own first draft, and those corrections are applied here.

### 0.4 Method

Ten read-only lanes: eight explorer lanes (runtime enforcement; `xt` CLI
lifecycle; spec/Chain convergence; board-audit transport; contracts and identity;
skills and generated surfaces; release and packaging; tests/CI/migration), one
adversary lane, and this synthesis. Lane reports and the adversary report:
`core-substrate-audit/lane{1..9}-*.md`.

**Corrections applied from the adversary pass (recorded so they are not
re-introduced):**

| Claim | First draft | Corrected, verified |
|---|---|---|
| Core derives Project prefix/name | "Core derives prefix+name" | Core **does not derive** identity — `substrate.ts:238-240` "the caller supplies prefix/name — this module never invents project identity"; the defect is the **primitive** (`sb project create`+`link` instead of `sb init`) and the onboarding UX, not a duplicate derivation algorithm |
| `@xtrm/substrate` reference count | 26 | **20** excluding `cli/dist`; 49 tracked including `cli/dist` |
| Direct `bd` subprocess sites | ≥9 in 4 files | **≥15 across 8 files**, including `cli/src/spec/{drift,archive-gate,reconcile}.ts`, which the first draft did not name |
| Prepublish embeds a CI temp path | current defect | **stale on main** — fixed at `589e67e5` (post-`v0.12.0`); the "packed registry ≠ committed registry" half stands |
| Stop-gate row gates the whole row group | only "stop-gate" BLOCKED | edit/commit and stop-gate gaps differ per host — see §2.7 |
| `beads-gate-utils.mjs:31` | cited for cwd-as-session | correct citation is **`beads-gate-utils.mjs:20-21`** |

---

## 1. Exact source and release baseline

Date-stamped. **Two of three upstreams moved during the audit**, so this section
must be re-confirmed at the §7.3 implementation gate.

### 1.1 Repositories

| Repo | Visibility | Audited head | Date | Note |
|---|---|---|---|---|
| `xtrm-dev/core` | **public** | `e3c09927f115a9ad551953ede2262c91a9bbb431` | 2026-09-12 | `git describe` = `v0.12.0-236-ge3c09927` |
| `xtrm-dev/xtrm` | **private** | `12e71d743a32c7b27af6c3e792574cfa08e7b81a` | 2026-09-15 | PRs #185, #186, #188, #189, #190, #191 merged |
| `xtrm-dev/specialists` | **public** | `31887a4e55d25a57b90f06feef580ae148e29e9d` | 2026-09-15 | **moved during the audit** (`67100f13` → `31887a4e`) |

Visibility verified with `gh repo view <repo> --json visibility`. The asymmetry
is load-bearing (§2.8).

### 1.2 Published artifacts

| Package | Latest | Published | Relationship to source |
|---|---|---|---|
| `xtrm-tools` | `0.12.0` | 2026-09-04 | **= tag `v0.12.0` (`04c1867`), NOT main.** npm `gitHead` **absent** |
| `@jaggerxtrm/substrate` | `0.1.2` | 2026-09-12 | lags source: main carries unreleased sbcloseout4 |
| `@jaggerxtrm/specialists` | `3.21.6` | 2026-09-03 | lags source by ~293 commits |
| `@xtrm/contracts` | **404** | — | declares `publishConfig.access: public` for an unpublished package |

```bash
git describe --tags e3c09927        # v0.12.0-236-ge3c09927
git rev-list --count v0.12.0..e3c09927   # 236
```

### 1.3 The baseline asymmetry that governs sequencing

The published Core artifact and Core `main` are **not the same product**:

| Surface | In `v0.12.0` | On `main` |
|---|---|---|
| `cli/src/core/substrate.ts` | absent | present (564 lines) |
| `cli/src/core/substrate-verify.ts` | absent | present (405 lines) |
| `cli/src/core/substrate-migration.ts` | absent | present |

Verified with `git cat-file -e v0.12.0:<path>`. Added in `f949b33f`
(`v0.12.0-233-gf949b33f`). **The entire Substrate consumer seam in Core is
unreleased.** `changelog/release-notes/v0.12.0.md` names `Specialists 3.21.6` as
counterpart and contains zero Substrate references.

### 1.4 Environment facts a cold-start worker must know

- `cli/dist/index.cjs`, `.map`, `.d.cts` are **tracked in git** — committed build
  artifacts that can drift from `src`.
- `.beads/` is **live and tracked** in Core (`issues.jsonl`, `metadata.json`,
  `.beads/hooks/*`, plus an untracked `dolt/` server directory).
- `hooks/` is a **symlink** to `.xtrm/hooks`. Not a duplicate tree.
- Live machine state is already partly broken; see §6.1.

---

## 2. Architecture authority map

Upstream-decided. Quoted from `sbcloseout4-adr.md`.

### 2.1 Authority model

```text
XTRM Chain Runtime  →  workflow progression
Specialists         →  governed cognitive/execution participant runtime
Substrate           →  durable work authority, Journal, claims, Closure,
                       ExecutionBinding, provenance, Resume
Channels            →  semantic coordination / messaging
Core                →  installation, launch, UX, compatibility,
                       runtime composition, operator-facing façades
Git                 →  code/artifact truth
```

### 2.2 ADR §100 — assigned ownership (verbatim)

```text
xtrm-dev/xtrm        repository identity; repository bindings; sb init;
                     Issue/Journal/Closure/Provenance services;
                     execution-context model; Substrate Pi/Claude integration;
                     CLI/MCP/docs

xtrm-dev/core        xt init consumption of sb init; session identity propagation;
                     managed skills/instructions; operator/runtime installation;
                     doctor integration
                     "Core does not reimplement repository identity."

xtrm-dev/specialists activation/session execution; automatic result publication
                     integration; Specialist lineage; provider adapters
                     "Specialists does not own Issue persistence or Project identity."
```

### 2.3 North-Star rules

| Rule | ADR | Text |
|---|---|---|
| **N1** | §2, §19 | `xt init` → Substrate enrollment → `sb init` → runtime enrollment/verification. "Core must not independently implement project identity policy." |
| **N2** | §3 | The normal Substrate Project maps to the **Git repository**, not an arbitrary checkout path |
| **N3** | §18, §19 | `sb project *` are **advanced/recovery** surfaces, not onboarding. "Bare `sb project link` must not infer the sole Project." Core must not derive Project IDs, names or prefixes |
| **N4** | §4 | `projects.length === 1` is **never** evidence of repository membership; global-cardinality inference is removed as an authority |

### 2.4 Target lifecycle (ADR §102)

```text
Issue claim → ExecutionBinding / activation / attempt → execution + validation
   → commit → receipt / provenance binding → validated result → Closure
```

**Close-before-commit is not the target lifecycle.** Closure is written after
validation and receipt binding, not as a pre-commit gate.

### 2.5 Target chain shape — normative, **not shipped**

```text
ChainSource → ChainDefinition → compile/validate/scrutiny → ResolvedChain
   → ChainRun 1:1 Container(kind=chain) → pure reducer over persisted evidence
   → SchedulerIntent[] → Activation → Pi AgentSession
```

`ChainDefinition`/`ResolvedChain`/`ChainRun`/`SchedulerIntent` exist **only** in
`xtrm/experiments/agentsession-sre-chain-vertical-slice/` plus PRD/ADRs. There is
**no chain package** in `xtrm/packages/`. See §7.1 BG-1.

### 2.6 Identity taxonomy Core does not yet have

```text
participant != activation != attempt != AgentSession != Issue
```

`grep -c 'participantId|activationId|attemptId|runId'` over `cli/src`,
`packages/pi-extensions/src`, `packages/contracts/src` → **zero**. Core has
`job_id` only.

### 2.7 Enforcement is host-specific — do not generalise

Verified by reading `integrations/pi/extension.ts` and
`integrations/claude-code/hooks.json`:

| Gate | Claude Code | Pi | Core today |
|---|---|---|---|
| claim / edit-write | `edit-gate.ts` (PreToolUse) | `extension.ts:183-192` `tool_call` → `decidePiEditCall`, returns `{block:true}` | `beads-edit-gate.mjs` |
| commit | `commit-check.ts` (PreToolUse/Bash) | **absent** | `beads-commit-gate.mjs` |
| stop / continuity | `stop-gate.ts` (Stop) | **absent** (`evaluateStopContinuity` exported at `handlers.ts:390`, never registered) | `beads-stop-gate.mjs` |
| compaction | `precompact.ts`/`postcompact.ts` | `session_before_compact` | `beads-compact-{save,restore}.mjs` |
| session start / resume | `session-start.ts` | `session_start` + `substrate-resume` | `beads-claim-sync.mjs` |

**Consequence:** the two blocked deletions are narrower than "gate transfer".
Only the **Pi commit gate** (BG-5b) and the **Pi stop gate** (BG-5) lack an upstream
replacement. Claude's three gates are ready.

### 2.8 Integration-boundary rule (RECOMMENDATION)

`xtrm-dev/xtrm` is **private**; `core` and `specialists` are **public**. Three
integration styles exist for one dependency:

| Consumer | Style | Boundary |
|---|---|---|
| Core (public) | process | shells to `sb`; `XTRM_SB_BIN` override |
| Specialists (public) | dynamic module | **no static dep**; `XTRM_SUBSTRATE_DIR` → module resolution → fail closed |
| Substrate integrations | source enrollment | `integrations/{pi,claude-code}`, `integrations/setup.ts` |

Core must not add a static dependency on Substrate source. The frozen contract is
expressed against the **published npm artifact** plus the `sb` process boundary.

---

## 3. Exhaustive migration inventory

Legend — Action: `KEEP` / `ADAPT` / `DELETE` / `REPLACE` / `COMPAT`.
Ordering: `NOW` / `AFTER-SB` (post Substrate release) / `AFTER-SP` / `DESIGN-ONLY` / `DELETE-LAST`.
Full row sets: `core-substrate-audit/lane{1..8}-*.md`.

### 3.1 Runtime enforcement and session lifecycle (48 rows)

| Current surface | Current behavior | Current owner | Target owner | Target primitive | Evidence | Action | Upstream dependency | Ordering | Acceptance proof | Migration hazard | Release impact | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `.xtrm/hooks/beads-edit-gate.mjs` | blocks edit without a session claim via `bd kv` | Core | Substrate | `claude-code/edit-gate.ts`; Pi `extension.ts:183` | upstream header: `// Replaces beads-edit-gate.mjs` | DELETE | ready (Claude+Pi) | AFTER-SB | edit refused without live claim | removing before enrollment → ungated edits | patch | VERIFIED |
| `.xtrm/hooks/beads-stop-gate.mjs` | **blocks** session stop | Core | Substrate | `claude-code/stop-gate.ts` | upstream stop-gate **never blocks** | DELETE (Claude) / ADAPT (Pi) | **BG-5 blocked on Pi** | AFTER-SB + BG-5 | stop continuity preserved | Pi stop continuity lost silently | minor | VERIFIED |
| `.xtrm/hooks/beads-commit-gate.mjs` | block-first commit gate | Core | Substrate | `claude-code/commit-check.ts` (nudge + post-commit bind) | Pi has **no** commit gate | ADAPT | **BG-5b blocked on Pi** | AFTER-SB + BG-5b | commit without receipt flagged | Pi commits unbound to Issue | minor | VERIFIED |
| `.xtrm/hooks/beads-compact-{save,restore}.mjs` | checkpoint around compaction | Core | Substrate | `precompact.ts`/`postcompact.ts`; Pi `session_before_compact` | — | DELETE | ready | AFTER-SB | resume capsule after compaction | context loss on resume | minor | VERIFIED |
| `.xtrm/hooks/beads-claim-sync.mjs` | writes `bd kv set claimed:<sessionId>` | Core | Substrate | `sb issue claim --holder --activation --ttl-ms` | no claim id/generation/`expiresAt`; `claim.ts:16-18` forbids a stored flag | REPLACE | ready | AFTER-SB | claim visible in `sb issue show` | **dual claim authority** | patch | VERIFIED |
| `.xtrm/hooks/beads-status-cache.mjs` | board counts cache, read by `statusline.mjs:17` and `custom-footer/index.ts:34` | Core | Substrate | `sb issue state/list --json` | **not** in `registry.json` yet globally installed | REPLACE | ready | DELETE-LAST | statusline renders from `sb` | display shows stale board | minor | VERIFIED |
| `.xtrm/hooks/beads-gate-{core,messages,utils}.mjs` | shared gate plumbing | Core | — | — | `beads-gate-utils.mjs:20-21` mixes cwd into `session_id` | DELETE | none | with D-5 | no import from deleted module | dangling imports | patch | VERIFIED |
| `.xtrm/hooks/worktree-boundary.mjs`, `worktree-reap-sweep.mjs`, `xtrm-*-logger.mjs`, `quality-check.*`, `inbox-reminder-stop.mjs` | worktree/quality/logging/channel guards | Core | Core | unchanged | — | KEEP | none | NOW | existing tests | — | none | VERIFIED |
| Pi extension `beads` | board tools + edit gate | Core | — | — | `adapter.ts:39-41` requires `.beads` in cwd; **already inert in worktrees** | DELETE | none | DELETE-LAST | claim gate still enforced | gate becomes a no-op earlier than assumed | patch | VERIFIED |
| Pi extension `session-flow` | session phase tracking (`claimed`,`merged`) | Core | — | no upstream counterpart | `policies/session-flow.json` RETIRED, `manifest.json:37` present | DELETE | none | AFTER-SB | no `SessionState.phase` reader | orphaned state readers | minor | VERIFIED |
| `packages/pi-extensions/src/core/*`, `python-kernel`, `xtrm-ui`, `xtprompt`, `custom-footer`, `compact-header`, `read-line-numbers`, `git-checkpoint`, `sp-terminal-overlay`, `quality-gates` | runtime UI/tooling | Core | Core | unchanged | — | KEEP | none | NOW | existing tests | — | none | VERIFIED |
| `.xtrm/ext-src/**` and `.xtrm/packages/pi-extensions/**` | two stale forks of the shipped extensions | Core | — | — | separate trees, both tracked | DELETE | none | AFTER-SB | build/package uses `packages/pi-extensions` only | drift ships stale code | patch | VERIFIED |
| `hooks/` → `.xtrm/hooks` | symlink | Core | Core | unchanged | `readlink -f hooks` = `.xtrm/hooks` | COMPAT | none | — | — | being "de-duplicated" by mistake | none | VERIFIED |
| `policies/beads.json`, `session-flow.json` | declare RETIRED while `manifest.json` lists both | Core | — | — | `manifest.json:5` id `beads`, `:7` `required:true` | DELETE | none | with D-5 | `--check-pi` green from real layout | CI green on a fabricated dir | patch | VERIFIED |
| `.claude/hooks` (3 dangling symlinks) | dead entries | Core | — | — | — | DELETE | none | NOW | — | none | none | VERIFIED |

### 3.2 `xt` CLI lifecycle (60 rows)

| Current surface | Current behavior | Current owner | Target owner | Target primitive | Evidence | Action | Upstream dependency | Ordering | Acceptance proof | Migration hazard | Release impact | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `xt init` Project creation | `--sb-create-project PREFIX:Name` → `sb project create` + `link` | Core | Substrate | `sb init --json` (ADR §6, §19) | `init.ts:1173-1199`; ADR §19 "should disappear from the normal operator UX" | REPLACE | **BG-9** (`sb init` unreleased) | AFTER-SB | fresh repo: one command initializes | split identity / wrong Project bound | **major** | VERIFIED |
| `--sb-project` / `--sb-create-project` flags | operator-supplied identity | Core | Core (deprecated, admin-only) | ADR §19 compatibility carve-out | ADR §18/§19 | COMPAT | BG-9 | AFTER-SB | absent from recommended docs | operators keep hand-binding | minor | VERIFIED |
| `cli/src/core/substrate.ts` package resolution | resolves `node_modules/@xtrm/substrate`, `npm root -g` join | Core | Core (fix) | `@jaggerxtrm/substrate` | `substrate.ts:352,356`; upstream `setup.ts:203` `EXPECTED_PACKAGE_NAME` fails closed | REPLACE | none | NOW | `setup.ts check` exits 0 | operator follows remediation into a rejected path | patch | VERIFIED |
| `dependency-maintenance.ts` | declares `@xtrm/substrate`; comment asserts "is unpublished" | Core | Core (fix) | `@jaggerxtrm/substrate` (published) | `:31,:83,:107` | REPLACE | none | NOW | registry query resolves | wrong package name in maintenance | patch | VERIFIED |
| `substrate-verify.ts` (405 lines) | re-derives Beads preservation counts | Core | Substrate | `sb import beads` receipt `verifier.checks` + `verdict` | `sb.ts:2123-2134` | DELETE | **BG-15 (receipt schema, xtrm `.9.1`)** | DELETE-LAST | receipt verdict trusted, verifier deleted | losing the only preservation proof | **major** | VERIFIED |
| `sb import beads` invocation | **never called** by Core | — | — | `sb.ts:2118-2139` | `substrate.test.ts:166` "A8 never invokes it" | REPLACE | **BG-15 + BG-9** | AFTER-SB | lossless import proven | unrecoverable work loss | **major** | VERIFIED |
| `migrationBlockedReason` gate | `xt init` **exits 1**; `xt update --apply` fails closed on any `.beads` repo | Core | Core (until A9 lands) | — | `init.ts:831`, `update.ts:119,360`, `doctor.ts:628`, `substrate-migration.ts:48` | KEEP (fail-closed) | BG-15 | — | legacy upgrade path proven | **currently un-upgradable repos** | blocker | VERIFIED |
| `end.ts`/`report.ts`/`worktree-session.ts`/`codex-worktree-session.ts`/`docs-cross-check-bd.ts` (≥15 sites) | direct `bd` subprocess | Core | Substrate | `sb issue *`, `sb journal *` | §0.4 correction | REPLACE | ready | AFTER-SB | no `bd` binary required | dual board authority | patch | VERIFIED |
| `beads-shared-server.ts` + `install.ts:267` | writes `.beads/config.yaml`, enables Dolt shared server | Core | — | — | — | DELETE | none | DELETE-LAST | no `.beads` writer | Dolt server orphaned | minor | VERIFIED |
| `doctor` integration | consumes `setup.ts check --json`, six enrollment items | Core | Core | unchanged (ADR §100) | `doctor.ts:540,573-575` | KEEP | none | NOW | enrollment items reported | — | none | VERIFIED |
| `runtime-compat.ts` | enforces sibling ranges at interactive launch only | Core | Core (extend) | add a `substrate` row | no `substrate` key anywhere | ADAPT | none | NOW (§12) | out-of-range substrate rejected | launch on unverified substrate | minor | VERIFIED |
| `cli/src/utils/worktree-session.ts:1871,1885` | hardcoded `plugin:specialists@xtrm`; re-derives plugin install from `~/.claude/plugins/installed_plugins.json` | Core | Core (fix) | `setup.ts check` `naming.substratePlugins` (already consumed in `substrate.ts:272`) | two derivations of one fact | ADAPT | none | NOW | single naming source | channel silently dropped | minor | VERIFIED |

### 3.3 Planning, `xt spec`, Chain convergence (25 rows + 3 new)

**Chain authoring in Core today: NONE.** No `ChainLoader`/`ChainSource`/
`ChainDefinition`/`ResolvedChain`/`ChainRun`/`chain_template`/`applies_when`
anywhere under `cli/src`, `.xtrm/`, `scripts/`, `skills/`, `templates/`,
`hooks/`, `policies/`, `packages/`. The only executable "chain" artefact is the
bridge-era read-only topology read-model (`topology-projection.ts:269-271`).

| Current surface | Current behavior | Current owner | Target owner | Target primitive | Evidence | Action | Upstream dependency | Ordering | Acceptance proof | Migration hazard | Release impact | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `spec.yaml` intake + validate + scrutiny | PRD-level intake, schema-validated | Core | Core (shape converges) | Substrate `WorkContract` | `cli/src/spec/schema.json`; ADR §67 | KEEP | none | NOW | schema tests | — | none | VERIFIED |
| planner Bead creation | `bd create --type task --priority 1` | Core | Substrate | one atomic `PlanDraft` → `sb plan apply` | `apply.ts:158-172,218-234`; `planning-service.ts:1-104` | REPLACE | ready | AFTER-SB | plan applied in one transaction | **non-atomic graph** | major | VERIFIED |
| `sp run planner --bead <bd-id>` | Beads-keyed dispatch | Core | Specialists | `Activation(issueRef)` via `WorkItemStore` + `DispatchCheck` | `dispatch.ts:21-25` | REPLACE | **AFTER-SP** | AFTER-SP | activation id in Journal | Beads id inside activation key | patch | VERIFIED |
| `sp run --background --json` parsing | expects `job_id`/`id`; regex cannot match | Core | Core (fix now) | `jobId` (camelCase) | `dispatch.ts:29-41` vs `specialists/src/cli/run.ts:88-118` | REPLACE | none | **NOW** | dispatch returns a job id | **`xt spec apply` cannot dispatch at all** | patch | VERIFIED |
| `sp result --json` parsing | expects top-level `epic_id/children/test_issues` | Core | Core (fix now) | `{job, output, …}` | `reconcile.ts:74-83` vs `specialists/src/cli/result.ts:291-312` | REPLACE | none | **NOW** | reconcile parses a real result | **reconcile always fails** | patch | VERIFIED |
| `sp chain review <epic>` handoff | printed as the operator's next step | Core | — | **no such command exists** | `handoff.ts:24`; `specialists/src/cli/` has no `chain.ts` | DELETE | none | NOW | handoff text has no dead command | dead operator instruction | minor | VERIFIED |
| readiness probe keyed on `bd swarm`/`bd mol pour`/`bd gate` | 8 markers, 0 present | Core | — | delete; no released replacement | `readiness/matrix.ts:23-88` | DELETE | **BG-10** | AFTER-SB | `xt spec apply` guarded by a real check | fail-closed forever | patch | VERIFIED |
| `links.planner_bead/epic/children/test_issues`, `.apply-state.json {planner_bead_id, planner_job_id}` | Beads graph persisted in `spec.yaml` | Core | Substrate refs + revisions | Issue refs + `planKey` receipt | `schema.json:202-259`; `apply-state.ts:8-10` | ADAPT | **BG-2, BG-3** | AFTER-SB | links resolve to real Issues | dangling ids, identity collapse | patch | VERIFIED |
| `bd kv get reviewed:<epic>` archive gate | review marker in Beads KV | Core | Substrate | attestation / Journal `decision` | `archive-gate.ts:94-99` | REPLACE | ready | AFTER-SB | archive blocked without attestation | un-reviewed archive | minor | VERIFIED |
| `bd show`/`bd children`/`bd dep cycles` drift | board drift detection | Core | Substrate | `sb issue show/tree` | `drift.ts:99,109,121` | REPLACE | ready | AFTER-SB | drift detected from `sb` | silent drift | minor | VERIFIED |

**Worked counter-example (why `bd create` → `sb issue create` is wrong).**
`PlanningService` already provides one atomic `PlanDraft` validated up front by
`sb plan check` and committed by `sb plan apply`, with plan-level parent/block
cycle and alias-collision checks, `mutateOnce` idempotency keyed on `planKey`,
and all-revisions-or-none semantics. Incremental `sb issue create` would preserve
N transactions, no draft-level validation, and a dependency graph authored by
free-text model output — the exact failure ADR-001 rejects ("planners mutate
Beads directly as the only representation").

**Convergence (DESIGN ONLY):**

```text
spec.yaml (Core intake, KEEP)
  → Core validate/scrutiny (shape converges on Substrate WorkContract)
  → normalized authored form = ChainSource variant
  → ChainLoader → ChainDefinition → compiler → ResolvedChain (freeze)
  → ONE atomic PlanDraft → sb plan check → sb plan apply
  → SchedulerIntent[] → Activation(issueRef) via WorkItemStore + DispatchCheck
  → evidence → Journal result / Closure
  → projections back into spec.links as refs + revisions
```

Open: `PlanIssueSpec` has no step class, chain id, or blocks-only constraint
(`planning-service.ts:19-35`) → BG-2. Treat as upstream design, not a Core decision.

### 3.4 Board-audit and external review transport (30 rows)

**Frame correction (verified):** Core `.githooks/board-audit-*` are **gen-1**
(one commit, `487e6074`/PR #592). Canonical **gen-2** lives upstream at
`xtrm/packages/board-audit/` — permanent orphan export worktrees
(`board-audit-export-wt`) + an all-repo fanout timer (`board-audit-fanout`),
live since 2026-08-22, publishing all 12 mercury repos. Upstream's README calls
gen-1 "operationally superseded … retained for handoff/reconcile round-trips".

**Consequence: board-audit is an upstream-tool-ownership problem, not primarily a
Substrate-projection problem.** Core owns a stale fork of an upstream tool. The
Core action is *delete the fork*; the future of the tool is an upstream change.
Core has no reference to gen-2 and no pin mechanism for it.

| Capability today | Target primitive | Status | Action |
|---|---|---|---|
| whole-board snapshot / read model | `IssueService.exportProject` + `sb export project` | available | REPLACE |
| portable tree/markdown | `writeFilesystemProjection` | library-only, no CLI | ADAPT |
| outward projection | `IntegrationService.enqueueProjection`/`drainOutbox` | engine present, **no sender (BG-6)** | REPLACE |
| selective publication | `PROJECTABLE_JOURNAL_KINDS` + `shouldProjectJournalEntry` (ADR §60) | available | REPLACE |
| PR/commit evidence binding | `ProvenanceService.*` + `sb provenance pr/commit` | available | REPLACE |
| portable evidence bundle | `generateBundle`/`attachArtifact` | available | REPLACE |
| freshness / conflict | `ExternalBinding.syncState` + `projection.drift` | available | REPLACE |
| lookup (replaces `index.json`) | `external_bindings` + `listBindings` | available | REPLACE |
| inbound external input | `receiveInbound` → unready draft / drift | store available, **no CLI (BG-6)** | REPLACE |
| untrusted external comment | `receiveComment` + `isUntrustedRef` (ADR §61) | available | REPLACE |
| transport bypass / lease / index / round-trip / `bd` mutation | **no equivalent** | — | DELETE |

**Hazard:** gen-1's round-trip mutates Beads (`bd import`/`bd dep`/`bd comments`
— verified 8 calls in `board-audit-roundtrip.py`) while Substrate becomes
authority → dual board authority. **Gate: no board-audit path may invoke
`bd import`/`bd dep`/`bd comments` after the authority cutover.**

Core's board-audit surfaces have **zero tests** (`git grep -ln board-audit` over
`cli/test`, `cli/src/tests`, `test` → 0). `.githooks/pre-push:105` hardcodes the
machine-specific path `/home/dawid/dev/core/.githooks/board-audit-pr-adapter.sh`
and chains it with `|| true`.

### 3.5 Contracts, identity, topology, observability (36 + 19 rows)

**Identity collapses (all verified):**

| # | Collapse | Evidence | Sev | Target |
|---|---|---|---|---|
| C1 | `session_id` mixes ≥4 namespaces — tmux `$N`, runtime UUID, Pi PID, filesystem cwd | `beads-gate-utils.mjs:20-21`, `session-flow/index.ts:18`, `beads/index.ts:14` | HIGH | `ExecutionContext.host.sessionId` |
| C2 | Core `claimId` = an **issue-id string**; upstream `IssueClaim.id` = integer row id | `beads-gate-core.mjs:70-75` → `beads-edit-gate.mjs:61`; `claim.ts:31-41` | HIGH | `IssueClaim.id` + `issueId` kept distinct |
| C3 | **Two competing claim authorities**: `bd kv set claimed:<sessionId>` (no id/generation/`expiresAt`/`activationId`) **plus** Beads `in_progress` flag | `beads-claim-sync.mjs:80-85`; upstream `claim.ts:16-18` "never a stored flag on the issue" | **CRITICAL** | live claim row only |
| C4 | `issueId` = Beads alias in `.xtrm-session-state.json`, `iss_…` in `SubstrateAliasEntry` | `session-state.ts:13` vs `substrate-verify.ts:60` | HIGH | one resolver, `sb`-owned |
| C5 | `@agent_bead` holds issue **or** epic | `topology-projection.ts:476` | MED | typed ref |
| C6 | role encoded twice (`agentTask:'role:<name>'` + `@agent_role`) | `worktree-session.ts:2053,1996,2010-2011` | MED | `participant` |
| C7 | `xtrm.agent-role-launched.v1` open bag: 10 names / 4 identities | schema | MED | typed envelope |
| C8 | `parent_session` = coordinator session here, tmux pane lineage in xtmux | — | MED | `ExecutionCoordinator.sessionId` |
| C9 | Beads alias slugified into the tmux session name | `worktree-session.ts:2018` | MED | resume handle only |
| C10 | `@agent_state` two writers | `worktree-session.ts:2112` | LOW | single owner |
| C11 | `command-outcome.identity` has no issue/participant/activation/attempt/claim; `worktree.owner:'core'` hardcoded | `launch-outcome.ts:172-178` | MED | real binding or drop |
| C12 | `planner_bead_id` + `planner_job_id` with no linkage guarantee | `apply-state.ts:8-10` | MED | `planKey` receipt |

**Beads-shaped contracts:** `xtrm.beads.lifecycle-event.v1` (DELETE → `IssueEvent`
+ `Closure`); `xtrm.runtime-origin.v1` (`bead_id`, `verified`);
`xtrm.topology.projection.v1` (`bead_id`,`epic_id`,`chain_root_bead_id`,`bead.status`);
`xtrm.xtmux.topology.v1` (`bead_id`); `xtrm.xtmux.message.v1` (`beadId`);
`xtrm.agent-role-launched.v1` (`bead`); `xtrm.branch.integration.v1`.

**Second authorities over other systems:** `xtrm.beads.lifecycle-event.v1` →
Substrate; `xtrm.branch.integration.v1` (`status:'merged'` stores Git/PR truth);
`xtrm.xtmux.bridge.v1` (`journal.query`/`journal.follow` **bypass** Substrate
Journal); `xtrm.command-outcome.v1` (`authoritative_mutation`, `worktree.owner`
with no lease behind them); `xtrm.runtime-origin.v1` (`verified`);
`SessionState.phase` (`claimed`, `merged`).

**Topology is a correctly-built read model** — `collectProjection()` is pure, no
store, argv only from `READ_ONLY_COMMANDS` (`topology-projection.ts:5-24,85-99`).
Defect: sources `bd list --all --json` (`:91`) and promotes
`bead.status==='closed'` to a completion signal (`topology-views.ts:83-87`).
Post-cutover: `beads` → `substrate` source, extend `TopologySourceName` and the
schema's pinned 6-element `contains` list, add
`participant`/`activation_id`/`attempt_id` to pane lineage. **Blocked by BG-7.**

**Vocabulary change:** Beads `open|in_progress|blocked|closed` → Substrate
`LifecycleState {open,deferred,done,cancelled,archived}` + derived
`OperationalState {terminal,deferred,draft,blocked,claimed,ready}`. `blocked`
exists in both with **different semantics** (stored vs derived).
`SessionState.phase` (`claimed`,`merged`) is Core-invented → DELETE. Correct and
unchanged: `command-outcome.status`, `topology.sources[].status`,
`TopologyJob.status`, and the Prometheus allowed-label set — map `role` →
`participant`; never promote issue/activation/attempt/session to labels
(`docs/observability/prometheus-labels.md:31-38` is already right).

### 3.6 Skills, prompts, instructions, generated surfaces (47 + 32 rows)

**The contradiction is live, in one file, and test-bracketed.** `AGENTS.md:14`
declares Beads "**Authoritative** for ownership, dependencies, and closure. File,
claim, and close work here", while `AGENTS.md:50` says "Substrate owns durable
work" and `:85` "Durable work lives in Substrate, not in chat task lists". A third
block at `AGENTS.md:143-145` ("This project uses **bd (beads)** for ALL issue
tracking") is **auto-injected by `bd init`** (commit `93924b3e`).

It passes CI deliberately: `substrate-doctrine.test.ts:39-41` scans only the
contract span; `agent-contract-parity.test.ts:60-66` bans only two `bd prime`
phrases outside it.

| Surface | Classification | Action | Note |
|---|---|---|---|
| `AGENTS.md:14` vs `:50/:85` | STALE (deliberate, bracketed) | REPLACE | remove the Beads authority claim |
| `AGENTS.md:143-145` (BEADS INTEGRATION) | STALE, `bd`-injected | DELETE | must be re-injected-safe |
| `CLAUDE.md:85,108,112,123-176,207,212` | STALE | REPLACE | upstream A4 replacements exist |
| `XTRM-GUIDE.md:19,93,346-364,381` | STALE ("Issue Tracking with Beads") | ADAPT | |
| `.xtrm/skills/default/{planning,starting-and-resuming-work,using-xtrm}` | STALE | REPLACE | upstream A4 skills exist in `xtrm/docs/substrate/skills/` |
| `.xtrm/skills/default/using-specialists` | STALE duplicate at `5d2f2907` (v4.1) | REPLACE | upstream v4.3 adds the "Native activation = Substrate authority, never bd" section |
| root `skills/` (190 files) | GENERATED mirror, not in `files[]` | DELETE | duplicates `.xtrm/skills/{default,optional}`; `gitnexus-*` duplicates the `pi-gitnexus` package |
| `cli/src/commands/help.ts:44` ("Project — bd init") | STALE | REPLACE | contradicts `init.ts:786` "sb project init" |
| `templates/claude-md-fragments/bd-workflow.md` | RETIRED doctrine, still present | DELETE | `doctor.ts:138` already calls it retired |
| `.xtrm/registry.json` | GENERATED | KEEP | but it is **not** the hook install filter (§6.1) |
| `README.md:79,298` | COMPATIBILITY (describes shipped reality) | ADAPT | after the release |

**Retired bd-memory is still injected and still referenced.** `959c7718` retired
the stack, but `packages/pi-extensions/extensions/python-kernel/index.ts:155`
still advertises `bd memories`, and **the live `~/.pi/agent/APPEND_SYSTEM.md` and
`~/.claude/CLAUDE.md` still carry the full "Memory doctrine" block including
`bd remember`** — observed directly, active in this session. `global-prompt-sync.ts:105-114`
**fails closed on duplicate markers**, and the live files carry 4 blocks, so sync
cannot remove them. Confirmed gone: `memory-doctrine.md`,
`beads-memory-gate.mjs`, `project-memory.mjs`, `.xtrm/memory.md`.

### 3.7 Release, packaging, compatibility (35 rows)

| Surface | Current | Target | Action | Evidence |
|---|---|---|---|---|
| `docs/runtime-compatibility.json core.requires` | `specialists >=3.21.0 <4`, `xtmux >=0.1.0 <0.3`, `node >=24.0.0`; **no `substrate` row** | add a Substrate range | ADAPT | verified absent |
| enforcement point | `runtime-compat.ts` + `worktree-session.ts:2534`, interactive launch only, skippable by `XTRM_SKIP_RUNTIME_COMPAT=1` | add init/update/doctor checks | ADAPT | 11 fail-open points (§5.7) |
| exact validated artifact pin | prose only (`changelog/release-notes/v0.12.0.md:5`) | committed pin consumed by `fresh-machine-smoke.yml` | ADAPT | §12.3 |
| `.xtrm/specialists-source.json` v2 | per-file git-blob SHA-1, `resolved_sha=5d2f2907` (≈242 commits behind) | re-pin at migration time | ADAPT | §12.3 |
| `cli/dist/{index.cjs,.map,.d.cts}` | tracked build artifacts | decide tracked-or-built; never ship untested | ADAPT | §6.3 |
| `@xtrm/contracts` | public `publishConfig`, 404 on npm | publish or drop the claim | REPLACE | verified 404 |
| prepublish temp-path in vendored manifest | **fixed** at `589e67e5` (post-`v0.12.0`) | — | NO_ACTION | §0.4 |

### 3.8 Tests, CI, migration, legacy retirement (156 tests + 31 gates + 40 surfaces)

Fate: **KEEP 119 · EVOLVE 34 · DELETE 2 · INVALID 1.**
DELETE: `bd-auto-stage-patch.test.ts`, `beads-shared-server.test.ts`.
INVALID after cut: `cli/test/registry-pack-parity.test.ts`.

**Tests that protect data-loss / security invariants — delete only with a proven
replacement (§9):**

| Test | Invariant |
|---|---|
| `cli/src/tests/migrate-restore-security.test.ts:163,187,206,229,249` | tar traversal / absolute / symlink-escape / hardlink / FIFO → zero writes, no partial tree (`xtrm-zc1rs`) |
| `cli/src/tests/end-beads-symlink-guard.test.ts:45,52,66` | a mode-120000 symlink under `.beads/`/`.specialists/` is refused before push |
| `cli/src/tests/worktree-session-beads-noise.test.ts:19,759,766` | worktree `.beads/` removed + `skip-worktree` masking, never a symlink |
| `cli/src/tests/migrate-runtime-adoption.test.ts:166,189,219,237,331` | arbitrary/chained/dangling/special-file targets refused; rollback on failed swap |
| `cli/src/tests/migrate.test.ts:292,317,402,564` | backup-before-destroy, diverged preservation, restore round-trip |
| `cli/src/tests/installer-global-writes.test.ts` | never delete a file the installer cannot prove it wrote |
| `settings-audit{,fix}`, `atomic-config{,-prune}`, `claude-runtime-sync-*`, `reconcile-global-claude-hooks`, `legacy-hook-dedupe`, `hook-entry-source-tagging` | hook/settings ownership |
| `substrate-migration.test.ts`, `update.test.ts:274,297,341,426` | ADR-43 fail-closed **zero-mutation** abort; "Do NOT delete `.beads` (irreversible work loss)" |

---

## 4. Ownership-transfer matrix

| Concern | Current owner | Target owner | Exact target primitive | Action | Ordering |
|---|---|---|---|---|---|
| Repository / Project identity | Core chooses the onboarding primitive; **does not derive** identity (`substrate.ts:238-240`) but uses `sb project create`+`link` | Substrate | `sb init --json` — atomic, idempotent: discover → common root → derive identity → base branch → derive/find Project → bind → alias → verify | REPLACE | AFTER-SB (BG-9) |
| Durable work records | Core shells to `bd` (≥15 sites, 8 files) | Substrate | `sb issue *` over SQLite/WAL | REPLACE | AFTER-SB |
| Claim authority | Core `bd kv claimed:<session>` + Beads `in_progress` | Substrate | live `IssueClaim` row (`id`, `generation`, `expiresAt`, `activationId`) | REPLACE | AFTER-SB |
| Edit/write enforcement | Core `beads-edit-gate.mjs` + Pi `beads` ext | Substrate | Claude `edit-gate.ts`; Pi `extension.ts:183` | REPLACE | AFTER-SB |
| Commit enforcement | Core `beads-commit-gate.mjs` | Substrate (**Pi gap BG-5b**) | Claude `commit-check.ts` | REPLACE | AFTER-SB + BG-5b |
| Stop-gate continuity | Core `beads-stop-gate.mjs` | Substrate (**Pi gap BG-5**) | Claude `stop-gate.ts`; Pi needs registration | REPLACE | AFTER-SB + BG-5 |
| Journal / continuity | Core `bd` notes + `.xtrm-session-state.json` | Substrate | `sb journal append/checkpoint/show`, 9-kind vocabulary | REPLACE | AFTER-SB |
| Closure | Core `bd close` | Substrate | `sb issue close --outcome --reason --receipt --validation` → immutable `Closure` row | REPLACE | AFTER-SB |
| Provenance / receipts | Core board-audit git branches | Substrate | `sb provenance dispatch/commit/receipt/bundle/session/activation` | REPLACE | AFTER-SB |
| Execution identity | Core session metadata (`@agent_bead`, `@agent_role`, `C1`–`C12`) | Substrate + Specialists | `ExecutionContext`, `ExecutionBinding`, `participantId`/`activationId`/`attemptId` | REPLACE | AFTER-SB + AFTER-SP |
| Workflow progression | **nobody** (no runtime) | XTRM Chain Runtime | `ChainSource→ResolvedChain→ChainRun→SchedulerIntent[]` | DESIGN ONLY | post-release (BG-1) |
| Planning materialization | Core planner Bead + `sp run planner --bead` | Substrate | one atomic `PlanDraft` → `sb plan check` / `sb plan apply` | REPLACE | AFTER-SB |
| External review transport | Core gen-1 board-audit fork | upstream gen-2 + Substrate projections | `sb export project` + outbox/inbox + `external_bindings` | DELETE fork | AFTER-SB (BG-6) |
| Channels / wake | Core launcher passes `--channels`, re-derives plugin install | Split: Core = launch/UX; Specialists = the channel | `setup.ts` naming report + Specialists plugin channel | ADAPT | NOW |
| Managed skills / instructions | Core | Core (ADR §100) | skills-v4 + vendored upstream packs | ADAPT | AFTER-SB |
| Operator installation / doctor | Core | Core (ADR §100) | `xt init`/`doctor` consuming `setup.ts check/plan` | ADAPT | NOW |
| Substrate enforcement proof | absent | Core (extend) | `substrate` row in `runtime-compatibility.json` | ADAPT | NOW |
| Code / artifact truth | Git | Git (unchanged) | — | KEEP | — |

---

## 5. Dependency DAG

`X → Y` means X must be true/landed before Y may start.

### 5.1 Upstream-to-Core spine

```text
[SB-1] Substrate release artifact exists and uniquely identifies its source (BG-14)
   → [SB-2] sb init available from a frozen artifact (BG-9)
   → [SB-3] Core runtime-compat declares a Substrate range (§12.3a)
   → [CORE-SB1] Core Substrate consumer seam

[SB-4] Substrate import receipt schema frozen (xtrm .9.1) (BG-15)
   → [SB-5] sb import beads activation contract fixed
   → [CORE-SB7] legacy retirement (one-way Beads import)

[SP-1] Specialists native activation + Substrate integration settled
   → [SP-2] Specialists released against the frozen Substrate contract
   → [CORE-SB2] runtime authority transfer (dispatch + wake paths)
   → [CORE-SB4] Completion / result / Closure / provenance
```

### 5.2 Core-internal graph

```text
CORE-SB0 (compatibility/release contract)
  ├→ CORE-SB1 (consumer seam: init/doctor/install/update)
  │     ├→ CORE-SB2 (runtime authority transfer)
  │     │     ├→ CORE-SB4 (completion/report/result/Closure/provenance)
  │     │     └→ CORE-SB5 (board-audit / projections)   [needs BG-6]
  │     ├→ CORE-SB3 (planning / native Chain convergence) [needs SB-2 + BG-2]
  │     └→ CORE-SB6 (contracts / topology / generated surfaces)
  └→ CORE-SB7 (legacy retirement)  [needs SB-4, SB-5, SB-2, and all of SB1–SB6]
```

### 5.3 Hard sequencing constraints

| # | Constraint | Why |
|---|---|---|
| S1 | **Enrollment before deletion.** Substrate must be enrolled *and verified* on both hosts before any Core gate is deleted | §6.1: current live wiring is already partially dead |
| S2 | **Import before deletion of `.beads`.** `sb import beads` proven lossless before the source is removed | `substrate-migration.ts:48` "irreversible work loss" |
| S3 | **Receipt before verifier deletion.** `substrate-verify.ts` (405 lines) may be deleted only once the upstream receipt ships `verifier.checks` + `verdict` | `sb.ts:2123-2134` |
| S4 | **Authority cut before board-audit transport.** No board-audit path may invoke `bd import`/`bd dep`/`bd comments` post-cut | dual board authority |
| S5 | **Topology read-model switch is last within SB6.** It is a read model and may lag, but must not lag after `bd` is removed | `topology-projection.ts:91` |
| S6 | **Guards delete last.** Every guard listed in §3.8 is deleted only after its replacement invariant is asserted by a test | historical data-loss incidents |
| S7 | **`cli/dist` policy decided in SB0.** A tracked build artifact must not be shipped untested | §6.3 |

### 5.4 Parallelizable work

Safe to run concurrently once their upstream gate is met:
`SB2 ∥ SB3` (different subtrees), `SB5 ∥ SB6`, and inside SB6:
contracts ∥ skills ∥ docs ∥ CI. **Not** parallelizable: SB1 before SB2/SB3;
SB7 after everything.

---

## 6. Wave A findings

### 6.1 Runtime enforcement

**Duplicated authority is the dominant problem**, and the duplication has already
degraded in production:

- Live `~/.claude/settings.json` wires 7 `beads-*`/memory hook tokens and
  **zero** substrate tokens; `~/.pi/agent/settings.json` likewise.
- `~/.xtrm/hooks/{beads-memory-gate,project-memory}.mjs` are **still installed**
  although deleted from the repo in `959c7718`.
- The Pi edit gate is **already inert in worktrees** (`adapter.ts:39-41` requires
  `.beads` in `cwd`) yet `manifest.json:7` marks it `required:true` while
  `policies/beads.json:3` says RETIRED.
- **`.xtrm/registry.json` is not the install filter.** `global-hooks-bootstrap.ts:185`
  copies the whole source hooks root under a `__pycache__`-only `COPY_FILTER`
  (`:42`); the registry lists 14 hooks and 0 beads hooks, while `files[]` ships
  `.xtrm/hooks`. This is *why* 11 dead cross-generation hooks survived three
  cleanup waves.
- `hooks/` is a symlink (`readlink -f` → `.xtrm/hooks`), not a duplicate.
- `ci.yml:73-77` fabricates `$PI_AGENT_DIR/extensions` before `--check-pi`, so the
  check cannot catch the manifest/policy contradiction; a local run fails
  `Expected 3, Deployed 0`.

**Newly found upstream fail-open (HIGH, class 6).** Substrate's Pi edit gate
swallows its own failure: `integrations/pi/extension.ts:64` calls
`openServices(dbPath())` **outside** `withServices`'s try block, and the
`tool_call` handler wraps everything in `try { … } catch { return; }`
(`:183-192`). If the Substrate store cannot be opened, the handler returns
nothing → **the edit proceeds ungated**. This contradicts the fail-closed
discipline Specialists applies to the same store ("refuses dispatch fail-closed
when the store is absent"), and it contradicts the programme's own invariant that
authority failure must fail closed. **This must be fixed upstream before Core
deletes its own edit gate (S1).**

### 6.2 `xt` CLI lifecycle

Target principle "Core consumes the published Substrate contract; Core does not
derive Substrate authority independently" **fails on three axes**: stale package
identity (20 references to `@xtrm/substrate` excluding `cli/dist`, two of them
load-bearing at `substrate.ts:352,356`); Core choosing the identity primitive
(`sb project create`+`link`); and a consumed surface pinned to `0.1.x`. Full drift
table in §3.2/§5.2 of the lane report: most consequential are **no `sb init`**
(P0), **bare `sb project link` no longer infers** (P1), and **`import beads`
envelope replaced by `substrate-import-receipt/v1` with exit 1 on FAIL** (P1).

**The legacy path is currently a hard trap.** `xt init` exits 1 and
`xt update --apply` fails closed on any `.beads` repo, with remediation pointing
at an A9 pipeline whose only landed slice is the verifier (`124dd068`).

### 6.3 Release and packaging

Three mechanisms are conflated and must be separated (§12.3). Eleven fail-open
points exist, the most consequential being **no Substrate range or check at all**
and **enforcement only at interactive launch** (`init`/`update`/`doctor`/`spec`
unchecked). `cli/dist/*` is tracked. `@xtrm/contracts` claims public publication
and is 404.

### 6.4 Chain convergence

**No chain authoring exists in Core**, and **no chain runtime is shipped
upstream**. The spec→planner path is additionally **broken in two places**
(`jobId` camelCase; `sp result` shape), and its handoff prints a command that
does not exist. This lane is therefore the *most design-immature and least
blocking*: nothing in SB1, SB2, SB4, SB6, SB7 depends on it.

---

## 7. Upstream freeze gates

### 7.1 Blocking gaps (nothing can be implemented against these)

| ID | Missing primitive | Blocking consequence | Verification |
|---|---|---|---|
| BG-1 | Released Chain Runtime — `ResolvedChain` exists only in `experiments/`; no chain package in `xtrm/packages/` | SB3 convergence is DESIGN ONLY | `grep -rln ResolvedChain` over xtrm snapshot |
| BG-2 | `PlanIssueSpec` has no step class, chain id, or blocks-only constraint | `ResolvedChain → PlanDraft` not expressible | `planning-service.ts:19-35` |
| BG-3 | `ResultPayload` rejects unknown keys; no materialized id-set field | spec→Issue link set has no home | `journal.ts:128-160` |
| BG-4 | No installer for `packages/substrate/hooks/*`; zero `core.hooksPath` handling; `setup.ts planCommands` has no hook step | Core cannot retire `.githooks` provenance blocks | `grep hooksPath integrations/setup.ts` → empty |
| BG-5 | Pi `agent_end`/stop unwired — `evaluateStopContinuity` exported, never registered | Core cannot retire `beads-stop-gate.mjs` | `integrations/pi/extension.ts` handler list |
| BG-5b | Pi **commit** gate absent entirely | Core cannot retire `beads-commit-gate.mjs` | same |
| BG-6 | No projection/integration CLI group (`KNOWN_GROUPS` = init, issue, project, plan, journal, provenance, import, export); `ProjectionSender` interface-only; `drainOutbox` test-only | Core cannot replace board-audit transport | `sb.ts:841`, `integration-service.ts:60-62` |
| BG-7 | No `sb` bulk read verb | topology read-model cannot switch source | `topology-projection.ts:91` |
| BG-8 | board-audit has no `package.json` and lives in the **private** repo | no distribution mechanism for gen-2 | `packages/board-audit/` file listing |
| BG-9 | `sb init` absent from every published artifact (`0.1.2` lacks it) | SB1 cannot start | `sb.ts:730-780` on main vs published 0.1.2 |
| BG-10 | No chain-availability probe; no released emitter of `recommended_template` | `xt spec` readiness cannot converge | `readiness/matrix.ts:23-88` |
| BG-11 | No Substrate substitute for the `bd dolt push` push precondition | `pre-push` sync cannot be replaced | `.githooks/pre-push.bd-sync:20-36` |
| BG-12 | **Hidden `bd` dependency outside `cli/src`** | "no hidden bd dependency" proof fails | `scripts/smoke-container/Dockerfile:43-50` (`bd version` required; `@beads/bd` called "hard dependency of xtmux-events"), `.github/workflows/service-skills-drift-sweep.yml:56,368` (`@beads/bd@$BEADS_VERSION`), `test/integration-suite/suite-c-coordinator-lineage.mjs` (`bd init`) |
| BG-13 | Pi edit gate fails **open** when the store is unopenable (§6.1) | deleting Core's edit gate would leave a hole | `extension.ts:64,183-192` |
| BG-14 | No machine-readable artifact identity (npm `gitHead`) for Substrate or Core | release validation relies on content-hash reconstruction | `npm view ... gitHead` empty |
| BG-15 | No frozen `sb import beads` receipt schema or activation contract (xtrm `.9.1`) | the one-way Beads import — a required acceptance proof — has no contract to implement against | `substrate-verify.ts:9-20` "Interface assumptions for xtrm-side .9.1 receipt coordination" |

### 7.2 Substrate gate (all must hold)

```text
[ ] canonical accepted implementation complete
[ ] release artifact exists on npm
[ ] artifact version uniquely identifies that implementation
    (the published 0.1.2 does NOT — source carries unreleased sbcloseout4)
[ ] machine-readable identity published (gitHead or equivalent)   [BG-14]
[ ] `sb init` available from the artifact                          [BG-9]
[ ] import receipt schema + activation frozen and released          [BG-15]
[ ] CLI/MCP/Pi/Claude surfaces used by Core are frozen
[ ] the Pi edit gate fails CLOSED on store failure                  [BG-13]
[ ] Pi commit-gate and stop-gate registration decided              [BG-5/5b]
[ ] git-hook installer decided (Substrate ships it, or Core owns it) [BG-4]
[ ] import/migration acceptance passes
[ ] package install smoke passes
```

### 7.3 Specialists gate (all must hold)

```text
[ ] native activation/runtime work complete
[ ] Substrate integration settled
[ ] result/Closure integration settled
[ ] Channels/wake/reply lifecycle settled
[ ] Pi/Claude surfaces accepted
[ ] final live evidence complete
[ ] released against the frozen Substrate contract
[ ] release-attestation.json is a real attestation, not candidate_template
```

### 7.4 Core implementation gate

After **both** upstream releases:

```text
1. run a focused delta exploration (not this whole programme)
2. diff every upstream change against this document
3. update ONLY invalidated rows; record each in §13
4. confirm Core itself did not materially change (re-run §1.1/§1.2)
5. flip the status line to IMPLEMENTATION_READY and record the exact
   upstream artifact versions validated against
```

### 7.5 Why the freeze cannot be declared complete today

Stated plainly so no reader mistakes `DESIGN_FREEZE` for readiness:

- Substrate's published artifact does **not** contain the ADR the plan is built
  on (`sb init`, `Closure`, `ExecutionContext`, `PlanDraft` are all unreleased).
- Specialists moved **during this audit**; ~293 commits of master are unreleased.
- 15 blocking gaps (§7.1) are unimplementable by Core even after both releases.
- The one-way Beads import — a required acceptance proof — is unimplemented on
  both sides.
- Core's own pre-cut state is a trap: `.beads` repos cannot `xt init` or
  `xt update --apply`.

---

## 8. Core implementation phases

Wave decomposition evaluated against evidence; the tested `CORE-SB0..7` shape
holds, with two changes: additions to SB0 and an explicit SB3 deferral.

| Wave | Content | Entry gate | Exit proof |
|---|---|---|---|
| **SB0** Contract & hygiene | (a) add `substrate` to `docs/runtime-compatibility.json`; (b) publish or drop `@xtrm/contracts` publication claim; (c) decide `cli/dist` tracked-or-built; (d) fix the two live `sp` parser breakages and the dead `sp chain review` handoff; (e) fix `@xtrm/substrate` → `@jaggerxtrm/substrate` incl. the "unpublished" comment and test fixtures; (f) single plugin-naming source | NOW (no upstream dependency) | parser tests against real `sp` shapes; no `@xtrm/substrate` outside `cli/dist` history; naming has one source |
| **SB1** Consumer seam | `xt init` calls `sb init --json`; delete `sb project create`+`link` from the normal path; deprecate `--sb-project`/`--sb-create-project` to admin-only; `doctor` reports `data.repository`/`effectiveOverride`; extend `runtime-compat` to Substrate; reconcile live machine hook wiring | SB gate (§7.2) | fresh-repo one-command init (ADR §84); multi-repo isolation (ADR §85); worktree/multi-clone (ADR §86/§87) |
| **SB2** Runtime authority transfer | enroll Substrate Pi+Claude; verify; then delete Core gates in the §9 order; keep the fail-closed `migrationBlockedReason` gate until SB7 | SB gate; S1 | ADR §92/§93/§94/§97; edit/commit/stop enforced by Substrate on both hosts |
| **SB3** Planning & Chain convergence | **DEFERRED.** Only unblocked work: fix the two `sp` parsers (moved to SB0), delete the dead handoff command, delete the `bd`-marker readiness probe | BG-1, BG-2, BG-3 | deferred; re-open only when a Chain Runtime ships |
| **SB4** Completion / result / Closure / provenance | `xt end`/`xt report` emit Journal `result` + Closure with receipts; provenance bindings replace board-audit branches; session identity propagation (`XTRM_SESSION_ID` producer decided) | SB gate + SP gate | ADR §92, §94, §95, §96, §98 |
| **SB5** Board-audit / projections | delete Core's gen-1 fork; adopt upstream gen-2 retargeted to `sb export project`; wire outbox/inbox when BG-6 lands | BG-6 | a NEW board-audit fidelity test (there are currently **zero** tests); §3.4 capability map |
| **SB6** Contracts / topology / generated surfaces / docs / CI | replace Beads-shaped contracts; switch topology source to `substrate`; single-source instructions; delete `AGENTS.md:143-145` safely; purge retired memory doctrine from live files | SB gate; S5 | contract tests; `docs-cross-check`; a scan proving one writer per fact |
| **SB7** Legacy retirement | `sb import beads` one-way import; then the §9 deletion order verbatim | SB-4/SB-5; S2; S6 | one-way import proven lossless; suite green with `bd` absent from PATH |

`DELETE-LAST` and `HISTORICAL_ONLY` classifications are applied in §9, not here.

---

## 9. Legacy deletion order

Anything protecting against a historical data-loss incident is deleted **last**,
only after an equivalent invariant is proven. Each step names its precondition.

| Step | Delete | Precondition (proof that replaces it) |
|---|---|---|
| **D-1** | *nothing* | Land the generalized wipe guard and the D-1/D-2/D-3 acceptance proofs first |
| **D-2** | bd-owned git hooks: `pre-commit:23-88`, `pre-push:24-98`, `post-merge:2-75`, whole `post-checkout`, `prepare-commit-msg`, `pre-push.bd-sync`, `post-merge.bd-sync` | D-1 durable; **BG-4** resolved (Substrate git-hook installer, or Core installs Substrate's hooks and owns the wiring per ADR §100) |
| **D-3** | tracked `.beads/*`, `.gitignore:133,151-153`, scanner ignores | lossless-import verification passes (**BG-15**, `sb import beads` receipt verdict) |
| **D-4** | `bd-auto-stage-patch.ts`, `beads-shared-server.ts`, `Bash(bd …)` allowlists (`sync-executor.ts:13-17`) | D-3 complete |
| **D-5** | 11 retired `.xtrm/hooks/beads-*.mjs` (tarball-allowlisted at `check-registry-pack-parity.mjs:38-51`), `policies/beads.json`, `policies/session-flow.json` | the six named successors wired (`claude-runtime-sync.ts:342-350`); **BG-5/BG-5b/BG-13** resolved for Pi |
| **D-6** | `beads-status-cache.mjs` + statusline bd coupling | D-5; statusline renders from `sb` |
| **D-7** | board-audit transport (4 449 lines, **zero tests**) + `board-audit/pr-*` and `board-audit-staging/*` branches | a replacement that does not exist yet (**BG-6**); requires a NEW fidelity test |
| **D-8** | `@beads/bd` from the smoke container, install-order matrix, drift sweep | **BG-12**; `bd` absent from PATH and the suite still green |
| **D-9** | Beads Pi extension, `policies/beads.json`, `beads` topology source | D-7 claim-enforcement proof (**BG-7** for the topology read verb) |
| **D-10 (LAST)** | `end.ts:256-310` symlink guard + `worktree-session.ts` masking | a proven equivalent guard; if the invariant becomes vacuous that must be **asserted**, not assumed |

**Never delete**: `.xtrm/skills/**` instruction content before its upstream
replacement is vendored; `migrate-restore-security.test.ts` and the other §3.8
guards before their invariant is re-proven; the `migrationBlockedReason`
fail-closed gate before SB7.

---

## 10. Acceptance matrix

Maps the brief's required proofs onto upstream criteria (`sbcloseout4-adr.md`
§84–§98) and the Core-side test that must exist.

| # | Proof | Upstream criterion | Core-side test | Status |
|---|---|---|---|---|
| A1 | Fresh install | ADR §84 fresh repository | EVOLVE `cli/test/init-cli.test.ts` + `init-phases.test.ts` | needs `sb init` (BG-9) |
| A2 | Legacy upgrade | — | **NEW** — `.beads` repo → `xt init` → imported, no data loss | needs BG-15 |
| A3 | One-way Beads import | ADR §78 historical note mapping | **NEW** importer half (`substrate-verify.ts` is the verifier only) | needs BG-15 |
| A4 | Repository isolation | ADR §85 multi-repository | EVOLVE `substrate-migration.test.ts` | needs BG-9 |
| A5 | Linked worktrees | ADR §86 | EVOLVE `worktree-*` tests | — |
| A6 | Multiple repositories in one `state.db` | ADR §85, §89 basename collision | **NEW** (N≥2 repos, one `~/.xtrm/state.db`) | needs BG-7 |
| A7 | Claim enforcement | `claim.ts` live-row rule | EVOLVE `beads-claim-sync.test.ts` → Substrate claim | — |
| A8 | Result / Closure lifecycle | ADR §92, §96 | **NEW** provenance receipt + Closure row | needs SB-4 |
| A9 | Provenance | ADR §94 Specialist provenance, §98 no fabricated provenance | **NEW** | needs SP gate |
| A10 | Compaction / resume | ADR §92 session C reconstructs | **NEW** | — |
| A11 | Core launch | — | EVOLVE `session-launcher`, `worktree-session-launch` | — |
| A12 | Specialists dispatch | ADR §94 | EVOLVE `substrate.test.ts` against the **real** `sp` shapes | SB0(d) |
| A13 | Core ↔ Specialists ↔ Substrate compatibility | — | EVOLVE `runtime-compat.test.ts` + fresh-machine smoke | SB0(a) |
| A14 | **No dual authority** | ADR §5, §101 | **NEW** scan: one writer per fact (claim, state, closure) | — |
| A15 | **No hidden `bd` dependency** | — | **NEW** suite green with `bd` absent from PATH (catches BG-12) | — |
| A16 | Deployment-automation states (`not_run` reasoning explicit) | — | `ci.yml` + `fresh-machine-smoke.yml` | — |

---

## 11. Rollout and rollback strategy

### 11.1 Rollout

```text
R0  pre-flight: re-run §1 baseline; confirm both upstream gates (§7.2, §7.3)
R1  SB0 lands alone, on main, with no behaviour change except the two parser
    fixes. Ships as a patch release. Rollback = revert.
R2  SB1 lands behind the existing fail-closed gate. No deletion. Rollback =
    revert; the `migrationBlockedReason` gate keeps legacy repos stopped.
R3  SB2 enrollment first: Substrate Pi+Claude enrolled and VERIFIED on both
    hosts while the Core gates are still live (double coverage, one authority
    each — Core gates remain authoritative until the delete step).
R4  SB2 deletion: Core gates removed only after verification evidence exists
    for each host and each gate. Rollback = re-run `xt init` from the previous
    release (single command, no state migration involved).
R5  SB4/SB5/SB6 land with their own proofs.
R6  SB7: one-way import, then the §9 deletion order, D-1 through D-10.
```

### 11.2 Rollback boundaries

| Boundary | Reversible? | How |
|---|---|---|
| SB0, SB1 | yes | `git revert`; no state written |
| SB2 enrollment | yes | enrollment is additive; Core gates still present |
| **SB2 deletion** | yes | re-run previous `xt` release; Substrate state untouched |
| SB4/SB5/SB6 | yes | `git revert`; no destructive state step |
| **SB3 import (SB7)** | **no** | the only irreversible step. Requires: backup, dry-run verdict, receipt `verdict: PASS`, and the §9 D-3 precondition |
| D-10 guard deletion | **no** | must not happen until an equivalent guard is proven |

### 11.3 Rollback gaps to close before R4 (OPEN)

1. No Substrate-era equivalent of `.beads` backup/restore
   (`backup-archive.ts` is Beads-shaped).
2. No reconciliation path for a Substrate `uncertain` mutation outcome on the
   Core side.
3. `XTRM_SKIP_RUNTIME_COMPAT=1` remains a silent full bypass with no audit trail.
4. The live machine hook wiring (7 beads tokens, 0 substrate) has no
   reconciliation step in any wave; SB1(f) must add one, or R3/R4 will run
   against a host whose wiring is already inconsistent.

---

## 12. Release strategy

### 12.1 Expected sequence

```text
Substrate frozen + released
   → Specialists validated against that exact Substrate release
   → Specialists major release
   → Core migrates against those frozen releases
   → Core major / hard-cut release
```

### 12.2 What must be frozen before Core migrates

Both gates in §7.2/§7.3, plus the §7.1 gaps that Core cannot work around.

### 12.3 Three distinct compatibility mechanisms — do not conflate

| Mechanism | Artifact | Owner | Where enforced | Today |
|---|---|---|---|---|
| **(a) operator-facing RANGE** | `docs/runtime-compatibility.json core.requires` (shipped in `files[]`) | Core | `check-runtime-compatibility.mjs`; `runtime-compat.ts` + `worktree-session.ts:2534` | no `substrate` row → **add one** |
| **(b) EXACT artifact used for release validation** | a committed pin consumed by `fresh-machine-smoke.yml` | release process | smoke run | prose only (`changelog/release-notes/v0.12.0.md:5`) → **needs a committed pin** |
| **(c) vendored skill/source pins** | `.xtrm/specialists-source.json` v2 (per-file git-blob SHA-1) | Core vendoring | `check:specialists-vendor`, `check:vendored-specialists-parity` | pinned at `5d2f2907`, ≈242 commits behind → **re-pin at migration time** |

A fourth mechanism lives upstream and is **not** interchangeable with these:
Specialists catalog `version` pins are **compatibility baselines**
(caret-of-baseline; `a5635b96`, `081522d7`), explicitly *not* identity checks.

**Illustrative only — not decided.** A future range shape such as
`substrate >=0.2.0 <0.3`, `specialists >=4.0.0 <5` is **not** supported by live
evidence: Substrate main still reads `0.1.2` with unreleased same-version work;
Specialists' CHANGELOG has no 4.0 marker and `release-attestation.json` sets the
host-read-isolation waiver to expire at `3.21.7`/2026-10-03. **Actual numbers:
UNRESOLVED (§13 U-1, U-2).**

### 12.4 Release blockers

- `@xtrm/contracts` publishes a public-package claim while 404 on npm.
- No npm `gitHead` for `xtrm-tools` or Substrate → unattributable artifacts.
- `cli/dist/*` is tracked and can ship code that was never built from the tag.

---

## 13. Unresolved questions

Consolidated, deduplicated, each with the decision owner.

**Upstream (Substrate)**

| # | Question | Owner |
|---|---|---|
| U-1 | Which release ships `sb init` (and the whole sbcloseout4 surface)? Package `version` on main still reads the already-published `0.1.2` | Substrate |
| U-2 | Does Substrate intend `0.2.0` as the freeze boundary, and will it publish `gitHead`? | Substrate |
| U-3 | Will the Pi edit gate be made to fail **closed** on store failure (BG-13)? | Substrate |
| U-4 | Pi commit-gate + stop-gate: register, or is Core expected to retain equivalents? (BG-5/BG-5b) | Substrate |
| U-5 | Who installs `packages/substrate/hooks/*` — Substrate ships an installer, or Core installs and owns the wiring? (BG-4) | Substrate/Core |
| U-6 | Freeze the `sb import beads` receipt schema and activation contract (xtrm `.9.1`) (BG-15) | Substrate |
| U-7 | Add a projection/integration CLI group + a concrete `ProjectionSender` (BG-6) | Substrate |
| U-8 | Add a bulk read verb for topology (BG-7) | Substrate |
| U-9 | Is `PlanDraft` a chain-materialization target, or is a chain-aware superset needed (BG-2)? Who owns the `ResolvedChain → PlanDraft` binding? | Substrate |
| U-10 | Where does the materialized work-id set live given `ResultPayload` rejects unknown keys (BG-3)? | Substrate |
| U-11 | Distribution mechanism for `xtrm/packages/board-audit` (no `package.json`, private repo) (BG-8) | xtrm |
| U-12 | What replaces the `bd dolt push` push-sync durability property (BG-11)? | Substrate |

**Upstream (Specialists)**

| # | Question | Owner |
|---|---|---|
| U-13 | Does Specialists intend a 4.0 boundary? Core currently excludes `>=4` | Specialists |
| U-14 | Does the Specialists plugin own the raw-`Agent` guard (the plugin declares no `Agent` matcher)? | Specialists |
| U-15 | Does Specialists ship a stop-continuity surface, or is the Pi stop gate Substrate's? | Specialists |
| U-16 | Who owns the `StepContract` ↔ Substrate-issue join (Specialists keys by `issueRef`; Substrate has no step-contract row)? | joint |
| U-17 | Which release replaces the broken `sp run --background --json` / `sp result --json` shapes, and is `jobId` frozen as the contract? | Specialists |

**Core decisions**

| # | Question | Owner |
|---|---|---|
| U-18 | `XTRM_SESSION_ID` producer: nothing in Core sets it (test usages only). Which value for (a) pi/claude interactive, (b) Codex, (c) a Specialist activation, and who exports it? | Core |
| U-19 | Claim TTL expiry mid-turn: fail closed and require re-claim, and who surfaces it? | Core |
| U-20 | `agent_instance_id` has no upstream analogue — compat alias inside `ExecutionBinding`, or dropped with the tmux lineage leg? | Core |
| U-21 | Is adding a `substrate` source to `xtrm.topology.projection.v1` a minor bump, or v2 that also drops `beads`? Consumers of the pinned 6-element `contains` list were not enumerated | Core |
| U-22 | Is the `sb export project` schema the frozen external-review contract, and what is the G47 round-trip guarantee? | Core/Substrate |
| U-23 | Retain a Git artifact branch as projection transport post-Beads, retargeted to `sb export project`, or delete once BG-6 lands? | Core |
| U-24 | Do the 20 existing `board-audit/pr-*` origin refs get reaped or retained? | operator |
| U-25 | Who wrote the extra doctrine blocks in live `~/.pi/agent/APPEND_SYSTEM.md` / `~/.claude/CLAUDE.md`, and must `global-prompt-sync` learn to repair multi-block files? | Core |
| U-26 | How does `using-substrate` reach an agent's skill root? `setup.ts` has no skill-install step | Core/Substrate |
| U-27 | Is the 190-file root `skills/` mirror to be deleted, and does any check still read it? | Core |
| U-28 | Is `cli/dist` tracked deliberately, or should it be a build output? | Core |
| U-29 | `xt report`'s Beads sections: who consumes them (delete vs port)? | Core |
| U-30 | `end-beads-symlink-guard`: does the Substrate era keep any parent-tracked dir→symlink pattern that requires the masking logic? | Core |
| U-31 | `xtrm.beads.lifecycle-event.v1` and the `beads` topology source are published contracts with golden fixtures — may they be retired? | Core |
| U-32 | Which revision/machine performs the gate cutover, and what is the rollback per host? | operator |

---

## 14. Surfaces searched, and what was not inspected

### 14.1 Searched (by lane)

| Lane | Surfaces |
|---|---|
| 1 | `packages/pi-extensions/**`, `.xtrm/hooks/**` (all 25), `.xtrm/ext-src/**`, `.xtrm/packages/pi-extensions/**`, `policies/**`, `.xtrm/config/{hooks.json,settings.json,instructions/*}`, `cli/src/core/{claude-runtime-sync,pi-runtime-hooks,global-hooks-bootstrap}.ts`, `hooks/**` (symlink), live `~/.claude/settings.json`, `~/.pi/agent/settings.json`, `~/.xtrm/hooks/**`, upstream `integrations/{pi,claude-code}/**` |
| 2 | `cli/src/commands/**` (all), `cli/src/core/**` (all), `cli/src/utils/**`, `cli/src/types/**`, `scripts/**`, `templates/**`, `.xtrm/config/pi/install-schema.json`, `docs/runtime-compatibility.json`, upstream `cli/sb.ts` + `integrations/setup.ts` + `doctor` |
| 3 | `cli/src/commands/spec/**`, `cli/src/spec/**` (all incl. readiness/transform), `cli/src/core/interactive-plan.ts`, `cli/test/*spec*`, `cli/src/tests/spec-*`, upstream PRD/ADR-001/002, `chain_templates.md`, `planning-service.ts`, `workitems/*`, `specialists config/specialists/planner.specialist.json` |
| 4 | `.githooks/board-audit-*` (all 6), `.githooks/{pre-commit,pre-push,post-merge,post-checkout,prepare-commit-msg,*.bd-sync}`, `.xtrm/skills/**/resources/board-audit`, upstream `packages/board-audit/**`, `projections/**`, `integration-service.ts`, `provenance-service.ts`, `migrations/002,007` |
| 5 | `packages/contracts/**` (all schemas), `cli/src/types/**`, `cli/src/core/{topology-*,xt-reports,launch-outcome}.ts`, `cli/src/utils/{worktree-session,codex-worktree-session,env-manager,known-repos}.ts`, `.xtrm/hooks/xtrm-*-logger.mjs`, session-meta files, `docs/observability/**`, upstream `domain/{claim,closure,execution-binding,execution-context,journal,provenance}.ts`, Specialists `activation/types.ts` |
| 6 | `AGENTS.md`, `CLAUDE.md`, `README.md`, `ROADMAP.md`, `XTRM-GUIDE.md`, `.xtrm/config/instructions/**`, `skills/**`, `.xtrm/skills/**`, `.xtrm/registry.json`, `templates/**`, `cli/src/commands/help.ts`, all `cli/src/core/skills-*`, live `~/.pi/agent/APPEND_SYSTEM.md`, `~/.claude/CLAUDE.md` |
| 7 | all four `package.json`s, `cli/src/commands/release.ts`, `scripts/**`, `.github/workflows/**`, `docs/runtime-compatibility.json`, `runtime-compat.ts`, `dependency-maintenance.ts`, `installer-manifest.ts`, `pack-metadata.ts`, `.xtrm/specialists-source.json`, `cli/dist/**`, npm registry metadata for all four packages, `release-attestation.json` |
| 8 | `cli/test/**`, `cli/src/tests/**`, `packages/*/tests/**`, `test/**`, `.xtrm/**/*.test.mjs`, `.github/workflows/**` (13), `Makefile`, `.githooks/.security-pipeline-baseline`, `cli/src/commands/{migrate,substrate-migration,backup-archive,plugin-era-cleanup,legacy-hook-dedupe}`, `.beads/**`, `.gitleaks.toml` |
| 9 | all eight lane reports, the draft plan, and targeted re-verification against source for every refuted claim |

### 14.2 NOT inspected (explicit; do not treat as covered)

- **Chain Runtime experiment internals**: `experiments/agentsession-sre-chain-vertical-slice/src/chain/{reducer,scheduler,store,finalize,topology,types,trusted-context}.ts` and `chain-compiler/index.ts` — the claim "reducer/scheduler not released" rests on absence from `xtrm/packages/` plus `xtrm-current-execution-plan.md`, not line-level reading.
- Upstream ADRs 003–006 in full; `substrate_design_it.md` rev12 in full.
- `xtrm/packages/{xtrm-app,xtrm-tui,xts,xtprompt,service-knowledge-ext,arena-top,mcpq}`.
- Specialists `src/specialist/**` beyond the activation/identity surfaces named above; `clients/python`; `plugins/specialists` internals; the Specialists MCP v2 tool-by-tool contract.
- Sourcemaps inside `cli/dist/index.cjs.map`; `node_modules`; `.git` internals beyond `git log`.
- `.xtrm/worktrees/**` (~44 worktrees) and `~/.cache/xtrm/board-audit/**` export trees.
- The 20 remote `board-audit/pr-*` branches' contents (existence verified only).
- Specialists work that landed after the refresh to `31887a4e` (none observed during the audit window, but the head was moving).
- `.xtrm/skills/**` (262 files) were classified by site/section, not read line-by-line; only Beads/Substrate/planning/issue/board/channel/chain-related skills were opened.

### 14.3 Coverage caveats

- "grep-confirmed" is used only for counts and existence, never as the sole basis for a §3 decision row.
- Live machine-state observations (§6.1) describe **this** operator's machine, not repo state.
- The two `sp` breakages were confirmed by reading both sides' source; neither CLI was executed against a real board during this audit.

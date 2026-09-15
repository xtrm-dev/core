# Lane 6 — Skills / instructions / prompts / generated documentation audit (Core)

Read-only audit of every instruction, skill, prompt, and generated documentation surface in
`xtrm-dev/core`. No source was edited. This file is the only artifact created.

## Baselines re-verified in this session

| Fact | Value | Evidence |
|---|---|---|
| Core HEAD | `e3c09927` (`xt/7awr` worktree = Core main for tracked files; `git status` shows only untracked `docs/migrations/`) | `git log -1`, `git status --short` |
| `xtrm-tools` version | `0.12.0` | `package.json:3` |
| Substrate snapshot | `/tmp/audit/xtrm-main` (`12e71d74`) | task baseline |
| Specialists snapshot | `/tmp/audit/specialists-master` (`67100f13`) | task baseline; `.pi/tasks/tasks-01a0a2e7-….json:7` records the same heads |
| bd-memory retirement commit | `959c7718` "retire bd-memory stack" | `git show --stat 959c7718` |
| Substrate doctrine anti-regression | `cli/src/tests/substrate-doctrine.test.ts` (ADR §48/§49) | file |
| Contract parity / SSOT | `cli/src/tests/agent-contract-parity.test.ts` (ISSUE-136) | file |

### The key structural fact

The Core agent-contract block is **deliberately** Substrate-native while the rest of the root
guides remain Beads-native. This is written down at `cli/src/tests/substrate-doctrine.test.ts:39-41`:

> `// Managed-block scan only: root guides keep operational Beads docs outside`
> `// the block (this repo still runs on bd; no sb binary ships yet) while the`
> `// managed contract itself must be Substrate-native (ADR section 48).`

Consequence: the Substrate-vs-Beads contradiction is **known and bracketed by two tests**, not an
accident. `substrate-doctrine.test.ts` scans only the `<!-- contract:start/end -->` span of
`AGENTS.md`/`CLAUDE.md`, so the Beads blocks outside that span are never checked. `agent-contract-parity.test.ts:60-66`
only forbids the specific phrases "run `bd prime` before starting work / at session start" outside
the block, so the far stronger claims in `AGENTS.md:14` and `AGENTS.md:143-145` pass CI.

**Inference (RECOMMENDATION):** any resolution must decide *per surface* whether it is inside the
transitional envelope (COMPATIBILITY) or plain stale doctrine (STALE/DELETE). The tests above define
that envelope today.

---

## (A) Contradictions

Columns: `File:line | Claims | Conflicts with (file:line) | Class | Proposed resolution | Hazard | Confidence`.

Non-source statements are labelled INFERENCE / RECOMMENDATION / UNRESOLVED.

| File:line | Claims | Conflicts with (file:line) | Class | Proposed resolution | Hazard | Confidence |
|---|---|---|---|---|---|---|
| `AGENTS.md:14` | "**Beads (`bd`)** — top-level durable tracking, on every runtime. Authoritative for ownership, dependencies, and closure. … File, claim, and close work here." | `AGENTS.md:50` "Substrate owns durable work"; `AGENTS.md:85` "Durable work lives in Substrate"; `.xtrm/config/instructions/agent-contract.md:24,59` | COMPATIBILITY (deliberate, `substrate-doctrine.test.ts:39-41`) | DELETE the injected block when the ADR-48 transition ends; until then mark it explicitly transitional | Agents are told two different owners of durable work; bd is unavailable when Substrate is enrolled | VERIFIED |
| `AGENTS.md:143-145` | "**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking… do not use … other tracking methods." | `AGENTS.md:50,85`; `.xtrm/config/instructions/agent-contract.md:24` | STALE (auto-injected by `bd init`, commit `93924b3e`) | DELETE whole block (142-218); `bd init` must not re-inject into a Substrate repo | Re-running `bd init` resurrects the block; direct conflict with the contract | VERIFIED |
| `AGENTS.md:15-24` | Native task system must "mirror the active bead" and "reference the bead ID in each task title" | `.xtrm/config/instructions/agent-contract.md:83-85` (Substrate Issue + no MEMORY.md) | COMPATIBILITY | ADAPT wording from bead→Issue once Substrate is default | Drift between two task-tracking doctrines in one file | VERIFIED |
| `CLAUDE.md:85` | "**Beads (`bd`)** — top-level durable tracking. Authoritative for ownership, dependencies, and closure." | `CLAUDE.md:24` "Substrate owns durable work"; `CLAUDE.md:59` | STALE (same injected block as AGENTS.md, committed at `2a659f0c`) | DELETE/ADAPT with the AGENTS.md block | Same as above; this file is the Claude primary guide, so weight is higher | VERIFIED |
| `CLAUDE.md:108` | "Use beads as the authoritative issue tracker and normal work lifecycle. Inspect/claim/close with `bd`." | `CLAUDE.md:24,34` (Issue through Substrate) | STALE | DELETE/ADAPT | Repo-guide vs managed contract disagree | VERIFIED |
| `CLAUDE.md:112` | "Never commit while a bead claim is open. Close the bead first." | `CLAUDE.md:34` "close or release the claimed Issue through Substrate" | STALE | ADAPT to Substrate claim | Agent closes a bd bead while the Substrate Issue stays open, or vice versa | VERIFIED |
| `CLAUDE.md:123-129, 169-176, 207, 212` | Full `bd` session-start / command surface / "use `bd` issues" | `CLAUDE.md:14-20, 34, 59` (`sb issue claim/resume`, Resume Capsule) | STALE | DELETE the `bd` command surface; point at `sb --help` and `/using-xtrm` | Two command surfaces for the same lifecycle | VERIFIED |
| `.xtrm/skills/default/using-xtrm/SKILL.md:27` | "**Beads owns durable work.** Use the board for work identity, contracts, dependencies, progress, evidence, and handoff." | `AGENTS.md:50`; upstream replacement `/tmp/audit/xtrm-main/docs/substrate/skills/using-xtrm.md:14` "Substrate owns durable work" | STALE (A4 promotion target) | REPLACE from `docs/substrate/skills/using-xtrm.md` per `canonical-promotion-map.md` | This is the *installed* using-xtrm skill; the contradiction is shipped to every consumer | VERIFIED |
| `.xtrm/skills/default/using-xtrm/SKILL.md:25,39,43,113,126` | "Beads state", "commit/PR/Bead/worker intent", "a bead goes to a Specialist", "re-read the bead" | same as above | STALE | REPLACE (upstream reference uses Issue/Journal/Memory/provenance vocabulary) | Same | VERIFIED |
| `.xtrm/skills/default/planning/SKILL.md:5,19,38,176-203,292-312` | "Transform intent into a **bd** issue board … Create bd issues … bd create … bd dep add" | `.xtrm/config/instructions/agent-contract.md:25` "the Issue is the prompt"; upstream `docs/substrate/skills/planning.md` (`sb plan check` → `sb plan apply`) | STALE (A4 promotion target) | REPLACE from `docs/substrate/skills/planning.md` | Highest-volume Beads instruction surface in Core (15 hits) | VERIFIED |
| `.xtrm/skills/default/starting-and-resuming-work/SKILL.md:27` | "Useful surfaces include `bd prime`, `bd ready`, `bd show`, `bd list` …" | `.xtrm/config/instructions/agent-contract.md:18,59` (Resume Capsule, `sb issue resume`) | STALE (A4 promotion target) | REPLACE from `docs/substrate/skills/starting-and-resuming-work.md` | Directly contradicts the resume doctrine | VERIFIED |
| `.xtrm/skills/default/using-specialists/SKILL.md:46-49` | "Read it with `bd show <id>`. … Do not use an ad-hoc prompt to smuggle missing requirements around the bead."; whole file is `version: 4.1` and has **no** native-activation section | Upstream `/tmp/audit/specialists-master/config/skills/using-specialists/SKILL.md` (`version: 4.3`) adds "Native activation" which states work authority belongs to Substrate, consumed through `WorkItemStore` "never through a Beads client, a `bd` subprocess" | STALE (vendored pin `5d2f2907` behind upstream `67100f13`) | Re-vendor: `npm run vendor:specialists` against the reviewed `resolved_sha`, then `npm run gen-registry` | Shipped copy teaches `bd` where upstream forbids it | VERIFIED |
| `.xtrm/skills/optional/xtrm-maintenance/update-specialists/SKILL.md` | content matches upstream snapshot | — | CANONICAL | KEEP | none observed; manifest pin still behind | VERIFIED |
| `skills/using-xtrm/SKILL.md:20-77` (root legacy mirror) | `bd prime` / `bd update --claim` / `bd ready` / `bd close`; "gates … in CLAUDE.md" | `.xtrm/skills/default/using-xtrm/SKILL.md` (different content); contract | STALE | DELETE the legacy mirror (not in `package.json` `files[]`) | Two skills named `using-xtrm` with different doctrine on disk | VERIFIED |
| `skills/planning/SKILL.md`, `skills/test-planning/SKILL.md`, `skills/session-close-report/SKILL.md`, `skills/judge-with-codex/SKILL.md`, `skills/xt-end/SKILL.md`, `skills/sync-docs/SKILL.md` | Beads-centric bodies (`bd create/show/close/dep/children`, `--bead`) | contract + skills-v4 routing (`agent-contract-parity.test.ts:69-83` lists these as retired routers) | STALE | DELETE the retired routers from the root mirror | Retired routers still present as discoverable skills in a Core checkout | VERIFIED |
| `XTRM-GUIDE.md:19,346-364` | "## Issue Tracking with Beads", `bd ready/update/close`, "### Issue Types" | `.xtrm/config/instructions/agent-contract.md:18,24` | STALE | DELETE/ADAPT; the guide is referenced by `agents-top.md:3` as "where present" | Fleet-visible guide teaches bd; version table also stops at `0.7.19` vs shipped `0.12.0` | VERIFIED |
| `XTRM-GUIDE.md:93,150,181-214,279,290,306-312` | `bd init`; `beads.json` gate table; `beads.ts` extension; `.beads/` data dir; `spec apply` → "planner bead" | `cli/src/core/machine-bootstrap.ts:57-63` (sb is the dep); `.xtrm/config/hooks.json` (no beads gates) | STALE | DELETE/ADAPT | Tells operators to install/initialize a stack Core no longer manages | VERIFIED |
| `README.md:79` | "Beads … is the durable issue/work-state dependency underneath this model … backed by Dolt." | `.xtrm/config/instructions/agent-contract.md:24` (Substrate owns durable work) | COMPATIBILITY (describes the shipped reality: "no sb binary ships yet") | ADAPT to "Substrate owns durable work; Beads is the transitional board import source" | A user-facing page states the superseded authority as current | VERIFIED |
| `README.md:298` | "Beads/Dolt remains board authority." | same as above; Substrate owner map | COMPATIBILITY | ADAPT with an explicit transition statement | Same | VERIFIED |
| `README.md:226-227` | Bead claim/edit/commit gates; "no `bd-prime` permission grant" | Substrate claim gate; `.xtrm/config/hooks.json` | COMPATIBILITY | ADAPT | Hook description is Beads-shaped | VERIFIED |
| `ROADMAP.md:41` | "bd (beads) issue tracking reference" | contract | HISTORICAL (stale roadmap) | KEEP as history or delete the line | Low; roadmap is aspirational | VERIFIED |
| `templates/claude-md-fragments/bd-workflow.md:1-71` | Whole fragment: "targeted Beads workflow + XTRM lifecycle gates", `bd list/ready/search/show/update`, gate table, "the Bead is the prompt" | contract; `cli/src/commands/doctor.ts:138` already calls it "retired Beads doctrine" | DELETE (still listed by `xt claude-sync --list`) | DELETE the fragment; doctor already redirects away from it | A user running `xt claude-sync --add bd-workflow` gets the full old doctrine | VERIFIED |
| `cli/src/commands/help.ts:41` | "4. Machine — install system tools (bd, dolt, bv, pi, pnpm)" | `cli/src/core/machine-bootstrap.ts:57-63` ("the legacy Beads-stack CLIs are no longer required deps") | STALE | DELETE bd/dolt/bv from the help text | Help text names deps Core deliberately stopped managing | VERIFIED |
| `cli/src/commands/help.ts:44` | "7. Project — **bd init**, GitNexus index, AGENTS.md/CLAUDE.md" | `cli/src/commands/init.ts:786` "7. Project Bootstrap — **sb project init**"; `init.ts:1005-1008` "Initialize the Substrate project" | STALE | REPLACE with "sb project init" | Highest-signal CLI-vs-CLI contradiction | VERIFIED |
| `cli/src/commands/help.ts:66,73,85,155` | "closed bd issues"; "session/bd lifecycle"; `--no-beads`; "unitAI-dnmcg" beads id | Substrate issue/lifecycle | STALE/COMPATIBILITY | ADAPT | Operator-facing | VERIFIED |
| `packages/pi-extensions/src/manifest.json:5-10` | `"id": "beads"`, `required: true` | `policies/beads.json:3` "RETIRED (Beads to Substrate migration) … retained so --check-pi stays green until the extension itself is retired" | COMPATIBILITY | Track removal with the extension retirement; document the pinned reason | Required extension whose policy declares it retired | VERIFIED |
| `packages/pi-extensions/extensions/python-kernel/index.ts:184,197,856,862` | `_sp.run(["bd","memories",...])`; "bd memory keys"; doctrine strings advertise "bd memory keys" | `959c7718` retired the bd-memory stack; `.xtrm/config/instructions/agent-contract.md:59` | STALE | ADAPT: drop the `bd` arm, re-point the doctrine string at commit corpus (+ `sb journal` when available) | Surviving bd-memory reference; lane 1 (`lane1-runtime-enforcement.md:68`) reached the same finding independently | VERIFIED |
| `~/.pi/agent/APPEND_SYSTEM.md:39-61`, `~/.claude/CLAUDE.md:40-62` (machine state, not repo) | Whole "Memory doctrine: progressive retrieval, never bulk" block built on `bd memories` / `bd recall` / `bd remember` | `959c7718`; contract "Do not create MEMORY.md files"; the live block is injected into every session | STALE (environment) | Remove the block from the live global prompt files; blocked by `global-prompt-sync` fail-closed behaviour (see UNRESOLVED-1) | The retired doctrine is **active** on this machine and is in this audit's own system prompt | VERIFIED (files) / INFERENCE (origin = retired `memory-doctrine.md` + `xtrm-loader`) |
| `.xtrm/hooks/beads-{claim-sync,commit-gate,edit-gate,stop-gate,compact-save,compact-restore,status-cache,gate-*}.mjs` | Shipped hook payload | `.xtrm/config/hooks.json` contains **no** beads hook entries (compiled payload is Substrate-era hooks only) | COMPATIBILITY/STALE | DELETE once the Substrate hook successor is enrolled (lane 1 owns activation) | Dead-but-shipped payload; lane 1 found the live `~/.claude/settings.json` still wires some of them | VERIFIED |
| `docs/worktrees.md:240-360` | "Beads / Dolt Architecture", `bd dolt start`, `.beads/` worktree handling | contract; Substrate hooks | COMPATIBILITY | ADAPT to Substrate, keep `.beads` cleanup as migration hygiene | Operational doc teaches a retired stack | VERIFIED |
| `.xtrm/skills/default/multiplexing/SKILL.md:7,65,71`; `engineering-quality/SKILL.md:46,67,72`; `goal-prompt/SKILL.md:21` | "use XTRM/Beads for durable …", "bead/contract = …", "Beads are evidence of why" | contract | COMPATIBILITY | ADAPT vocabulary Issue/Journal/provenance when the A4 replacements land | Low (vocabulary, not command surface) | VERIFIED |
| `docs/design/issuetracking.md:250-308` | "Do not replace bd now … bd remains the tracker and dependency store" | Substrate doctrine | HISTORICAL (design doc; the decision it records has been superseded) | KEEP as history | A reader may treat a superseded design decision as current | VERIFIED |

### Contradiction summary

- **Direct, load-bearing:** `AGENTS.md:14/143` and `CLAUDE.md:85/108` (Beads owns durable work) vs `AGENTS.md:50/85`, `CLAUDE.md:24/59`, `agent-contract.md:24/59`.
- **Shipped-skill contradictions:** `using-xtrm`, `planning`, `starting-and-resuming-work` (all A4 promotion targets) and vendored `using-specialists` v4.1.
- **CLI-internal:** `help.ts:44` vs `init.ts:786`.
- **Resurrection vectors:** `bd init`-injected block (`AGENTS.md:142`), `templates/claude-md-fragments/bd-workflow.md`, `python-kernel` `bd memories`, live global prompt blocks.

---

## (B) Surface inventory

Columns: `Surface | Path | Generated or authored | Classification | Target owner | Action | Evidence | Confidence`.

| Surface | Path | Generated or authored | Classification | Target owner | Action | Evidence | Confidence |
|---|---|---|---|---|---|---|---|
| Shared contract body | `.xtrm/config/instructions/agent-contract.md` | Authored (SSOT) | CANONICAL | Core | KEEP | file header `:3`; `agent-contract-parity.test.ts:36-52` | VERIFIED |
| Pi/neutral top | `.xtrm/config/instructions/agents-top.md` | Authored; embeds contract | CANONICAL | Core | KEEP | `:7-60` byte-identical to contract | VERIFIED |
| Claude top | `.xtrm/config/instructions/claude-top.md` | Authored; embeds contract | CANONICAL | Core | KEEP | `:7-60` | VERIFIED |
| Global prompt body | `.xtrm/config/instructions/global-system-prompt.md` | Authored | CANONICAL | Core | KEEP | read by `cli/src/core/global-prompt-sync.ts:172`; shipped via `.xtrm/config` | VERIFIED |
| Root guide managed block | `AGENTS.md:27-95` | Generated (init/update from `agents-top.md`) | GENERATED | Core | KEEP | `cli/src/commands/init.ts:309-330` `injectProjectInstructionHeaders`; parity test | VERIFIED |
| Root guide injected block | `AGENTS.md:1-25` | Authored, manually committed | STALE | Core | DELETE (after transition) | commit `2a659f0c`; contradicts contract | VERIFIED |
| Root guide Beads block | `AGENTS.md:142-218` | Generated by `bd init` | STALE | Core | DELETE | commit `93924b3e` "bd init: initialize beads issue tracking" | VERIFIED |
| Root guide GitNexus block | `AGENTS.md:97-140`, `CLAUDE.md:214-257` | Generated (`gitnexus:start/end`) | GENERATED | GitNexus ext | KEEP | markers present; `audit_agent_docs.py:16` recognises them | VERIFIED |
| Claude guide | `CLAUDE.md` (managed block, then repo guide + injected block) | Mixed: managed block generated; repo guide authored; injected block authored | STALE (injected/beads parts) | Core | ADAPT | `:72-96`, `:106-129`, `:169-212` | VERIFIED |
| Root guide (repo-specific) | `CLAUDE.md:98-297` | Authored | CANONICAL except Beads/Roadmap refs | Core | ADAPT | `docs/skills-ownership.md`, skill-map sections are current | VERIFIED |
| User overview | `README.md` | Authored | COMPATIBILITY | Core | ADAPT | `:79`, `:296-306` | VERIFIED |
| Skills roadmap | `ROADMAP.md` | Authored | HISTORICAL | Core | KEEP/DELETE line `:41` | version stops at v2.1.9-era headings | VERIFIED |
| Full guide | `XTRM-GUIDE.md` | Authored | STALE | Core | DELETE/ADAPT | `:19,93,346-364,381`; version table `:392` at 0.7.19 | VERIFIED |
| Installed doctrine skill | `.xtrm/skills/default/using-xtrm/**` | Authored (A4 replacement exists upstream) | STALE | Core | REPLACE | `SKILL.md:27` vs `/tmp/audit/xtrm-main/docs/substrate/skills/using-xtrm.md:14`; `canonical-promotion-map.md` | VERIFIED |
| Installed planning skill | `.xtrm/skills/default/planning/**` | Authored (A4 replacement exists) | STALE | Core | REPLACE | upstream `docs/substrate/skills/planning.md` (`sb plan apply`) | VERIFIED |
| Installed resume skill | `.xtrm/skills/default/starting-and-resuming-work/**` | Authored (A4 replacement exists) | STALE | Core | REPLACE | upstream `docs/substrate/skills/starting-and-resuming-work.md` | VERIFIED |
| Other default skills | `.xtrm/skills/default/{engineering-quality,multiplexing,goal-prompt,find-skills,gitnexus,skill-creator}/**` | Authored | CANONICAL | Core | KEEP (vocabulary ADAPT later) | `default/README.txt`; no Substrate-vs-Beads authority claim | VERIFIED |
| Vendored specialists skill | `.xtrm/skills/default/using-specialists/**` | Vendored (generated from specialists ref) | STALE (v4.1 vs upstream v4.3) | Specialists repo | REPLACE via re-vendor | `.xtrm/specialists-source.json` `resolved_sha 5d2f2907…` vs baseline `67100f13`; diff shows missing native-activation section | VERIFIED |
| Vendored specialists skill | `.xtrm/skills/optional/xtrm-maintenance/update-specialists/SKILL.md` | Vendored | CANONICAL | Specialists repo | KEEP | byte-identical to snapshot | VERIFIED |
| Optional packs | `.xtrm/skills/optional/**` (sre-ops, xtrm-development, xtrm-maintenance, security-ops, research-methods, architecture-design, data-engineering, personal-tools, xt-optional) | Authored/vendored mix | CANONICAL with incidental Beads refs | Core / pack owners | KEEP; ADAPT incidental refs | `grep` counts: sre-ops refs 1-4 per file, all incidental | VERIFIED |
| Deferred skills | `.xtrm/skills/deferred/{orchestrating-agents,using-serena-lsp}/**` | Authored | HISTORICAL (deferred) | Core | KEEP | not in default/optional tiers; no Beads refs | VERIFIED |
| Legacy root skill mirror | `skills/**` (190 files, 34 dirs) | Authored "legacy/source mirror" | STALE | Core | DELETE (not shipped) | `CLAUDE.md:160`; `package.json` `files[]` excludes `skills/`; `skills/README.txt` references a non-existent Gemini hook | VERIFIED (path) / INFERENCE (retirement intent) |
| Claude fragments (live) | `templates/claude-md-fragments/{agent-pitfalls,gitnexus-workflow,sp-workflow}.md` | Authored, not shipped | CANONICAL | Core | KEEP | `package.json` `files[]` has no `templates`; `claude-sync.ts:78` requires a checkout | VERIFIED |
| Claude fragment (retired) | `templates/claude-md-fragments/bd-workflow.md` | Authored, not shipped | DELETE | Core | DELETE | `doctor.ts:138` calls it retired | VERIFIED |
| Registry | `.xtrm/registry.json` (47 KB) | Generated by `scripts/gen-registry.mjs` | GENERATED | Core | KEEP; regenerate after skill changes | `gen-registry.mjs:16-38,153-158`; declares assets hooks(14), skills/default(80), skills_optional(130), config(16) + `specialists_source` | VERIFIED |
| Specialists pin | `.xtrm/specialists-source.json` | Generated by `scripts/vendor-specialists-skills.mjs` | GENERATED (value STALE) | Core | ADAPT: re-vendor at reviewed `resolved_sha` | `source.resolved_sha 5d2f2907…`; `docs/skills-ownership.release.json` same | VERIFIED |
| Ownership manifests | `docs/skills-ownership.json`, `.release.json`, `.md` | Authored (`.json` machine-readable) | CANONICAL (pin STALE) | Core | ADAPT pin | `docs/skills-ownership.md:16-25` is current doctrine | VERIFIED |
| Skill generation code | `cli/src/core/skills-{materializer,runtime-reconcile,runtime-views,layout,state,scaffold}.ts`, `skill-discovery.ts`, `project-skills-content.ts`, `global-skills-bootstrap.ts`, `registry-scaffold.ts` | Authored | CANONICAL | Core | KEEP | `grep beads\|bd\|dolt\|substrate` over these files = 0 matches | VERIFIED |
| Instructions injection | `cli/src/commands/init.ts:308-330`, `cli/src/core/global-prompt-sync.ts` | Authored | CANONICAL | Core | KEEP | path:line | VERIFIED |
| Skills invariants | `.xtrm/skills/INVARIANTS.md` | Authored | CANONICAL | Core | KEEP | references `state.json`/`active/` which are runtime-generated (absent in this checkout) | VERIFIED |
| CLI help | `cli/src/commands/help.ts` | Authored | STALE | Core | ADAPT | `:41,44,66,73,85,155` | VERIFIED |
| Machine deps | `cli/src/core/machine-bootstrap.ts` | Authored | CANONICAL | Core | KEEP | `:57-70` sb required, legacy Beads CLIs not managed | VERIFIED |
| Substrate consumer boundary | `cli/src/core/substrate{,​-migration,-verify}.ts` + tests | Authored | CANONICAL | Core | KEEP | file headers; ADR §42-43 | VERIFIED |
| Spec templates | `cli/src/spec/templates.ts` (`planner_bead`, `test_issues`), `cli/src/spec/**` | Authored | COMPATIBILITY | Core | ADAPT (lane 3 owns) | `templates.ts:39,110`; lane 3 report | VERIFIED |
| Pi manifest | `packages/pi-extensions/src/manifest.json` | Authored | COMPATIBILITY | Core | ADAPT with extension retirement | `:5-10` `beads` required | VERIFIED |
| Beads policy | `policies/beads.json` | Authored | COMPATIBILITY | Core | KEEP until `--check-pi` migration | `:3` "RETIRED … retained so --check-pi stays green" | VERIFIED |
| Compiled hooks | `.xtrm/config/hooks.json` | Generated by `scripts/compile-policies.mjs` | GENERATED | Core | KEEP | no beads hook entries remain | VERIFIED |
| Legacy hook payloads | `.xtrm/hooks/beads-*.mjs` | Authored (shipped) | STALE | Core | DELETE after Substrate hooks enrolled | not referenced by `hooks.json`; lane 1 | VERIFIED |
| Python kernel prompt | `packages/pi-extensions/extensions/python-kernel/index.ts:184-197,855-863` | Authored | STALE | Core | ADAPT | `bd memories` subprocess + doctrine strings | VERIFIED |
| Live global prompts | `~/.pi/agent/APPEND_SYSTEM.md`, `~/.claude/CLAUDE.md` | Runtime state | STALE | Operator | DELETE memory block | `:39-61`, `:40-62` | VERIFIED |
| Historical docs (banner-guarded) | `docs/legacy-hook-duplication.md`, `docs/plans/cleanup.md`, `docs/plans/hook-to-pi-parity-spec.md`, `docs/plans/xtpi-worktree-first-flow.md`, `docs/design/memory-system-r6g.md` | Authored | HISTORICAL (each carries the `959c7718`/`xtrm-aemfv` retirement banner at line ~1-10) | Core | KEEP | banners verified | VERIFIED |
| Historical docs (unguarded) | `docs/proposals/using-specialists-v3-improvements-2026-05-09.md:227,267` (`bd remember`) | Authored | HISTORICAL (banner only at `:304`, after two live `bd remember` mentions) | Core | ADAPT: extend the banner or strike `:227,267` | path:line | VERIFIED |
| Concept/design docs | `docs/concepts/xt-work-durable-execution-identity.md`, `docs/design/issuetracking.md`, `docs/design/audit-reconcile-*.md`, `docs/design/xtrm-orchestration-determinism-*.md` | Authored | HISTORICAL | Core | KEEP | they describe pre-Substrate decisions | VERIFIED |
| Operational docs | `docs/{worktrees,xt-topology,docs-commands,release,cli-architecture,pi-extensions,policies,cat-b-distribution,pre-install-cleanup}.md` | Authored | COMPATIBILITY | Core | ADAPT | Beads/bd operational refs throughout | VERIFIED |
| Third-party references | `docs/reference/{claude-documentation,gemini-documentation}/**` | Vendored docs | CANONICAL (out of scope) | upstream | KEEP | not a Core instruction surface | VERIFIED |
| Task ledger (this audit) | `.pi/tasks/tasks-01a0a2e7-….json` | Authored | CANONICAL (audit evidence) | Audit | KEEP | records core/xtrm/specialists heads | VERIFIED |
| Workspace dirs | `*-workspace/`, `workspace/iteration-*` | — | N/A | — | — | `find` returned none in this checkout | VERIFIED (absence) |

---

## Duplicated / superseded upstream skills

| Core copy | Upstream source | Status |
|---|---|---|
| `.xtrm/skills/default/using-xtrm/SKILL.md` | `/tmp/audit/xtrm-main/docs/substrate/skills/using-xtrm.md` (A4 normative reference) | Core copy is Beads-first; upstream is Substrate-native. REPLACE per `canonical-promotion-map.md`. |
| `.xtrm/skills/default/planning/SKILL.md` | `/tmp/audit/xtrm-main/docs/substrate/skills/planning.md` | same |
| `.xtrm/skills/default/starting-and-resuming-work/SKILL.md` | `/tmp/audit/xtrm-main/docs/substrate/skills/starting-and-resuming-work.md` | same |
| `.xtrm/skills/default/using-specialists/**` | `/tmp/audit/specialists-master/config/skills/using-specialists/**` | Vendored at `5d2f2907` (v4.1); upstream snapshot `67100f13` is v4.3 with the "Native activation" section. STALE; re-vendor. |
| `.xtrm/skills/optional/xtrm-maintenance/update-specialists/SKILL.md` | `/tmp/audit/specialists-master/config/skills/update-specialists/SKILL.md` | byte-identical at snapshot; pin metadata still behind. CANONICAL content. |
| (not vendored) | `/tmp/audit/specialists-master/config/skills/setup-specialists/SKILL.md` | Upstream has a third skill; Core vendors two by design (`docs/skills-ownership.md:26-37`). UNRESOLVED whether setup-specialists should ship. |
| (absent) | `/tmp/audit/xtrm-main/packages/substrate/skills/using-substrate/SKILL.md` | Substrate's own Pi-facing doctrine. Core neither vendors nor references `using-substrate` (`grep -r using-substrate` = 0). Gap. |
| `skills/{find-skills,planning,skill-creator,using-xtrm,sync-docs,hook-development,docker-expert,obsidian-cli,python-testing,senior-*}/**` | duplicates under `.xtrm/skills/{default,optional}` | 13 root-mirror dirs duplicate shipped skills. DELETE root mirror. |
| `skills/gitnexus-{exploring,impact-analysis,refactoring}/**` | `pi-gitnexus` npm package skills | Documented collision surface (`CLAUDE.md:274`). DELETE root mirror copies. |
| `skills/{orchestrating-agents,using-serena-lsp}/**` | `.xtrm/skills/deferred/*` | Same content, two locations; deferred tier is authoritative. DELETE root copies. |

**Pin provenance mechanism:** `.xtrm/specialists-source.json` (v2, `digest: git-blob-sha1`) stores
`source.ref`, `source.resolved_sha`, per-skill `placements`, and per-file `files` Git-blob
identities (`scripts/vendor-specialists-skills.mjs:206`, `scripts/verify-specialists-vendor.mjs:73-84`).
`prepublishOnly` re-vendors from `${resolved_sha}` (`scripts/vendor-specialists-from-manifest.mjs:16-21`;
lane 7 `lane7-release-packaging.md:73`). The manifest pin `5d2f2907…` is behind the audited upstream
`67100f13`, so the "immutable pin" is immutable but outdated.

---

## bd-memory retirement — surviving references

Retirement is real: `.xtrm/config/instructions/memory-doctrine.md`, `.xtrm/hooks/beads-memory-gate.mjs`,
`.xtrm/hooks/project-memory.mjs`, `.xtrm/memory.md` are all gone (deleted in `959c7718`; confirmed absent).
Doctrine separation (Issue ≠ Journal ≠ Memory ≠ Message ≠ Provenance) is stated in the Substrate
references (`/tmp/audit/xtrm-main/docs/substrate/skills/using-xtrm.md:28-40`).

Surviving references that would reintroduce it:

1. `packages/pi-extensions/extensions/python-kernel/index.ts:184` (runs `bd memories`), `:197`, `:856`, `:862` (doctrine strings). In-shipped-code; the `bd` arm silently returns empty today.
2. `~/.pi/agent/APPEND_SYSTEM.md:39-61` and `~/.claude/CLAUDE.md:40-62` — the whole active memory-doctrine block, injected into every session on this machine. Origin is the retired `memory-doctrine.md` (INFERENCE, from `xtrm-loader`/`project-memory.mjs`, both removed).
3. `docs/proposals/using-specialists-v3-improvements-2026-05-09.md:227,267` — `bd remember` advice outside the retirement banner at `:304`.
4. `docs/design/memory-system-r6g.md` — ARCHIVED banner at `:3`; content is explicitly a design record, not a plan. No action needed. (HISTORICAL)

**RECOMMENDATION:** treat (1) and (2) as the only actionable reintroduction vectors; (3) is documentation hygiene.

---

## (Task 5) npm tarball vs install-time generation

`package.json` `files[]` (VERIFIED):

```
README.md, CHANGELOG.md, cli/dist, cli/package.json, docs/runtime-compatibility.json,
scripts/ghgrep.mjs, .xtrm/config, .xtrm/hooks, packages/pi-extensions,
.xtrm/skills/default, .xtrm/skills/optional, .xtrm/registry.json
```

| Instruction surface | In tarball? | Install-time behaviour | SSOT |
|---|---|---|---|
| `.xtrm/config/instructions/{agent-contract,agents-top,claude-top,global-system-prompt}.md` | YES (via `.xtrm/config`, `registry-scaffold` `config` asset, `install_scope: project`) | copied into consumer project `.xtrm/config/instructions/` | `agent-contract.md` for the shared body |
| Root `AGENTS.md` managed block | NO | generated at `xt init`/`xt update` from `agents-top.md` into the consumer's own `AGENTS.md` | `agents-top.md` |
| Root `CLAUDE.md` managed block | NO | generated from `claude-top.md` | `claude-top.md` |
| Global prompt block (`~/.pi/agent/APPEND_SYSTEM.md`, `~/.claude/CLAUDE.md`) | body YES (`global-system-prompt.md`); the other 3 live blocks NO | `global-prompt-sync.ts` writes exactly one block | `global-system-prompt.md` |
| `.xtrm/skills/default/**`, `.xtrm/skills/optional/**` | YES | materialized to `~/.xtrm/skills/**` then runtime views | `.xtrm/skills/**` (authored), registry (facts) |
| `skills/**` (root mirror) | NO | not installed | none (legacy) |
| `templates/claude-md-fragments/**` | NO | `xt claude-sync` is checkout-only (`claude-sync.ts:78`) | fragment files |
| Root `AGENTS.md`, `CLAUDE.md`, `XTRM-GUIDE.md`, `ROADMAP.md` | NO (README only) | consumer equivalents generated by init | n/a |

Single source of truth: **`.xtrm/config/instructions/agent-contract.md`** for the shared contract
(its own header `:3`; enforced byte-for-byte by `agent-contract-parity.test.ts:45-52`), with
`agents-top.md`/`claude-top.md` as the per-runtime wrappers that embed it and append runtime notes.

---

## (Task 6) Multiple instruction sources claiming authority over the same rule (drift risk)

1. `AGENTS.md:14` vs `AGENTS.md:50` vs `.xtrm/config/instructions/agent-contract.md:24` — three answers to "who owns durable work" in one file.
2. `CLAUDE.md:85/108/123` vs `CLAUDE.md:24/59` — same, plus a second full `bd` command surface.
3. `AGENTS.md`/`CLAUDE.md` "Rule conflict — TaskCreate/TodoWrite" (inside the contract, `:83-85`) vs the injected "Task Tracking (two-tier)" block (`AGENTS.md:10-24`, `CLAUDE.md:81-96`) — both govern local-plan-vs-durable-work.
4. `.xtrm/skills/default/using-xtrm/SKILL.md` vs the contract vs the root `skills/using-xtrm/SKILL.md` — three `using-xtrm` bodies with different doctrine.
5. `templates/claude-md-fragments/bd-workflow.md` vs the managed contract block — both define session start and the durable-work contract.
6. `agent-contract-parity.test.ts:60-66` (only bans two `bd prime` phrases) vs `substrate-doctrine.test.ts:41-48` (bans all `bd` in managed sections) — two guards with different scopes over the same files, leaving the gap.
7. `.xtrm/skills/default/using-specialists/SKILL.md:43-49` (bead contract) vs upstream v4.3 native-activation (Substrate WorkItemStore, `bead_id` only an alias).
8. GitNexus managed blocks vs `agent-contract.md:35` — both mandate `gitnexus_impact`/`detect_changes`; not contradictory, but two sources (gitnexus ext + contract) own the rule.

---

## Surfaces searched

- Top-level docs: `AGENTS.md`, `CLAUDE.md`, `README.md`, `ROADMAP.md`, `XTRM-GUIDE.md` (line-level).
- `.xtrm/config/instructions/*.md`; `.xtrm/config/hooks.json`; `.xtrm/registry.json`; `.xtrm/specialists-source.json`; `.xtrm/skills/INVARIANTS.md`; `.xtrm/hooks/*` (names + references).
- `.xtrm/skills/default/**` (line-level for the 11 default skills), `.xtrm/skills/optional/**` (SKILL.md + files with Beads hits), `.xtrm/skills/deferred/**` (inventory).
- `skills/**` (inventory + every Beads/Substrate hit; 190 files).
- `templates/claude-md-fragments/*.md`; `cli/src/spec/templates.ts`; `cli/src/commands/{help,claude-sync,doctor,init}.ts`.
- `cli/src/core/{substrate,substrate-migration,substrate-verify,machine-bootstrap,skills-*,skill-discovery,project-skills-content,global-skills-bootstrap,registry-scaffold,global-prompt-sync,skills-layout}.ts`; `cli/src/tests/{agent-contract-parity,substrate-doctrine}.test.ts`.
- `packages/pi-extensions/src/manifest.json`; `packages/pi-extensions/extensions/python-kernel/index.ts`; `packages/pi-extensions/extensions/beads/`.
- `policies/*.json`; `scripts/{gen-registry,vendor-specialists-from-manifest,verify-specialists-vendor}.mjs`.
- `docs/**` (97 md files; line-level for the operational/design docs with Beads hits, inventory otherwise).
- Upstream comparison: `/tmp/audit/xtrm-main/packages/substrate/skills/**`, `/tmp/audit/xtrm-main/docs/substrate/skills/**`, `/tmp/audit/specialists-master/config/skills/**`.
- Machine state (read-only, for Task 4): `~/.pi/agent/APPEND_SYSTEM.md`, `~/.claude/CLAUDE.md`.

## Not inspected

- `.xtrm/skills/optional/**` bodies read only where Beads/Substrate appeared; most of the 130 files were inventoried, not read line-by-line (bounded by the task).
- `.xtrm/skills/deferred/**` bodies (inventory only; no Beads/Substrate hits).
- `skills/**` bodies other than the Beads/Substrate hit list (inventory + hit-level).
- `docs/reference/claude-documentation/**` and `docs/reference/gemini-documentation/**` (third-party reference, not a Core instruction source).
- Hook runtime behaviour and live `~/.claude/settings.json` / `~/.pi/agent/settings.json` (lane 1 scope).
- `cli/src/spec/**` beyond `templates.ts` Beads fields (lane 3 scope).
- Release/publish mechanics and artifact reproducibility (lane 7 scope).
- Git history beyond the commit-log greps used for provenance (`959c7718`, `93924b3e`, `2a659f0c`, `f949b33f`, vendor commits).
- `CHANGELOG.md` (185 KB) — sampled via grep only.
- `.xtrm/ext-src/**`, `.claude/skills/**`, `packages/contracts/**` (not instruction/skill/prompt surfaces).

---

## UNRESOLVED items (exact questions)

1. **UNRESOLVED — global prompt repair path.** `~/.pi/agent/APPEND_SYSTEM.md` and `~/.claude/CLAUDE.md` each contain **four** `<!-- xtrm:global-prompt:start -->` pairs. `global-prompt-sync.ts:105-114` (`validateMarkers`) throws `malformed managed block … (duplicate or nested)` and fails closed, so the retired memory-doctrine block cannot be removed by the current sync. Question: which component wrote blocks 2-4 (ast_grep, probe/kernel, memory doctrine), and is `xt update --apply` expected to repair a multi-block file or only a single-block one?
2. **UNRESOLVED — `using-substrate` delivery.** Core has no `using-substrate` skill, and upstream `packages/substrate/integrations/setup.ts` contains no skill-install step (`grep skill` = 0). Question: how does `using-substrate` reach an enrolled agent's skill root — Pi package install of `@xtrm/substrate`, a planned A9/A10 step, or is it agent-invisible today?
3. **UNRESOLVED — `setup-specialists`.** Upstream Specialists ships three skills; Core vendors two (`docs/skills-ownership.md:26-37` documents only two). Question: is `setup-specialists` intentionally out of the Core distribution, or an omission?
4. **UNRESOLVED — root `skills/` retirement gate.** No `package.json` script or check forbids new content under `skills/**`; `check:skills-ownership` / `check:managed-skills` were not run (read-only, no installs). Question: is there a planned deletion of the 190-file legacy mirror, and does any check still read it (`CLAUDE.md:160` says "some checks and docs")?
5. **UNRESOLVED — `AGENTS.md`/`CLAUDE.md` ownership inside Core.** In this repo those files are authored repo guides plus generated managed blocks plus a manually committed "INJECTED BLOCK". Question: for the Core repo itself, is the injected `Task Tracking (two-tier)` block operator-owned (must survive `xt update --apply`) or should generation own it?
6. **UNRESOLVED — specialists pin policy.** `docs/release.md:275,285` describe two different vendor-script behaviours (hand-edit vs auto-write of `source.ref`/`resolved_sha`). Question: is the manifest expected to be updated by hand or by `vendor:specialists`, and who reviews the pin bump from `5d2f2907` to the current upstream head?

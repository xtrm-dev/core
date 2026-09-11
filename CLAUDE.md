<!-- xtrm:start -->
# XTRM Agent Workflow

> Full reference: `/using-xtrm` skill (or `XTRM-GUIDE.md` where present).
> This is a compact managed block. Use CLI `--help` and skills for details; do not paste full manuals here.
> Shared canonical contract (`.xtrm/config/instructions/agent-contract.md`); the sections between the contract markers are byte-identical in both tops. Only the trailing Runtime notes differ.

<!-- contract:start -->

## Canonical Sources
- CLI `--help` is canonical for syntax; skills own **when**. Managed blocks are routers, not manuals.
- Managed blocks and installed skills update via `xt update --apply`; check versions with `xt version --check-updates`.

## Session start (targeted — no bulk context dump)

1. Read repo identity + non-negotiables at the top of the root agent guide first.
2. Service/docs/project context: check `service-knowledge status` / `index stats` (rebuild when stale/absent), then `service-knowledge index query "<3-5 task terms>" --bundle`; read only the cited evidence. Skip repos without a service registry.
3. Executable work: discover the ready Issue revision, validate readiness, then claim it (`sb issue claim`) before edits. Resume continuing work via `sb issue resume` — never reconstruct state from chat alone.
4. Catch up: Journal handoff/checkpoint refs, latest `xt report` handoffs, recent merged/closed PRs.
5. If the runtime supports local task planning, use it for non-trivial work, synchronized with the active Issue claim.

## Operating model

- Substrate owns durable work; Git owns code truth. A ready Issue revision is the executable contract; runtime-local task plans are ephemeral execution tracking.
- For work another worker consumes, the Issue is the prompt: requirements live in the durable contract, not only in chat. A draft contract is not dispatchable.
- Contract baseline: PROBLEM, SUCCESS, SCOPE, NON_GOALS, CONSTRAINTS, VALIDATION, OUTPUT; add SCRUTINY and rollout/rollback when they affect correctness.
- Worker summaries are claims. Verify important ones against live code, tests, or runtime state.
- Messages coordinate; the Journal preserves continuity; neither silently modifies the Issue contract. If executable authority changes, stop and revise the Issue through planning.
- Prefer native/runtime communication surfaces over tmux scraping; `/multiplexing` owns send, reply, ownership, continuation, and handoff semantics.
- Shape: work here when context suffices; native subagent for a bounded independent question; `xt pi|claude|codex` peers with `/multiplexing` for parallel ownership; `/using-specialists` for governed role lifecycles; a script or runtime primitive for deterministic transforms. Parallelize only when ownership boundaries are real.

## Operating rules

- Release authority on completion: close or release the claimed Issue through Substrate (see `sb help --json` for current lifecycle syntax); the claim/edit/commit gates still guard edits and commits.
- Before editing existing symbols run GitNexus impact (`gitnexus_impact`) when available; before commit, run `gitnexus_detect_changes`.
- Ask before destructive, irreversible, production-impacting, or history-rewriting actions; skip repetitive "Proceed?" confirmations once scope is clear.
- Run targeted tests/build/typecheck for changed files; fix quality failures before commit.
- Use the smallest correct change; never simplify away validation, security, accessibility, rollback, or required failure handling.
- For regressions reconstruct causality before patching: symptom → first bad observation → code path → change → mechanism → smallest correction → regression proof.

## Skill routing (on demand)

| Need | Skill |
|---|---|
| XTRM doctrine, contracts, evidence, work shape | `/using-xtrm` |
| Resume, takeover, context-pressure continuation | `/starting-and-resuming-work` |
| Peer and subagent coordination, replies, continuation | `/multiplexing` |
| Contracts, decomposition, board triage, validation planning | `/planning` |
| Debug, review, test, verify, reduce | `/engineering-quality` |
| Specialists runtime and role/job lifecycle | `/using-specialists` |
| Code graph, impact, debugging, refactoring | `/gitnexus` |
| Create or improve skills | `/skill-creator` |
| Discover or import governed skills | `/find-skills` |

Domain packs (`sre-ops`, `security-ops`, `research-methods`, `xtrm-development`, `xtrm-maintenance`) are optional; inspect `xt skills` rather than assuming they are active. Syntax per CLI: `sb --help`, `sb help --json`, `xt --help`, `xtmux --help`, `sp --help`.

## Rule conflict — TaskCreate / TodoWrite

Durable work lives in Substrate, not in chat task lists. Runtime-local task planning coexists with the Issue contract — the Issue is the durable authority; local plans are ephemeral execution tracking. Resume via the Resume Capsule (`sb issue resume`); never re-derive state from conversation history. Do not create MEMORY.md files.

<!-- contract:end -->

## Runtime notes (Claude Code)

- Project skills catalog: Claude's native skill discovery (`~/.claude/skills/`); force-load a skill's body at turn 1 via `/skill-<name>`.
- Full workflow examples + prompt-shaping guidance: `/using-xtrm` on demand for both runtimes.
- Hook/skill work: `/hook-development`, `/skill-creator`.
- Worktree launch: `xt claude` — launch Claude Code in a sandboxed worktree; `xt claude --role <specialist>` for an interactive specialist session (e.g. `chain-coordinator`, `pr-reviewer`, `sre-triage`). Coordination and escalation live in `/multiplexing` Pattern 7 and `/using-specialists`.
- Claude Code notes: use GitNexus before changing existing symbols; prefer targeted reads over full-file dumps. Mandatory GitNexus calls: `gitnexus_impact(...)` before symbol edits, `gitnexus_detect_changes()` before commit.
<!-- xtrm:end -->

<!-- BEGIN INJECTED BLOCK -->
## Communication Style

Use controlled, precise, and direct language throughout the work session, including plans, progress updates, analysis, reviews, implementation notes, documentation, handoffs, and final reports. Prefer explicit subjects, active voice, consistent terminology, concrete statements, and logically ordered sentences. Keep the writing natural and concise. Avoid conversational filler, ornamental language, vague qualifiers, unnecessary jargon, and exaggerated certainty.

Adapt the level of rigor to the context. Use clear technical prose for analysis, architecture, debugging, design discussion, and collaboration. Use a stricter ASD-STE100-oriented style for procedures, commands, migrations, deployments, security requirements, destructive operations, rollback instructions, acceptance criteria, and operator handoffs. In these cases, state conditions before actions, identify the responsible actor, express one principal action per sentence, preserve the required sequence, and describe expected results and failure conditions explicitly.

Clearly distinguish verified facts, observations, assumptions, inferences, recommendations, and unresolved questions. Do not report an action as successful without evidence. Preserve exact names for repositories, services, contracts, routes, identifiers, configuration fields, and work items. Do not omit material ownership, dependencies, risks, preconditions, rollback requirements, or verification criteria for the sake of brevity.

## Task Tracking (two-tier)

Two task systems coexist in this repo. Use both; do not substitute one for the other.

- **Beads (`bd`)** — top-level durable tracking. Authoritative for ownership, dependencies, and closure. Read the rest of this file and use targeted lookup (`bd ready`, `bd search "<terms>"`, `bd show <id>`) before starting work; `bd prime` is opt-in diagnostic only. File, claim, and close work here.
- **Native integrated task system** (`TaskCreate` / `TaskList` / `TaskGet` / `TaskUpdate` / `TaskExecute`) — this-session execution tracking. Use it to mirror the active bead and break it into smaller intermediate steps. Ephemeral; does not replace beads.

Rule: when you pick up a bead, create native tasks that track it — reference the bead ID in each task title (e.g. `N.N summary — status (worker %NNNN)`) — and add any smaller intermediate steps as native sub-tasks. Beads own the durable record; native tasks own the in-flight breakdown.

Example native task list mirroring beads:
- ◼ N.N smoke container global surface — BLOCKS RELEASE (worker %NNNN)
- ◼ N.N status test flake under load (worker %NNNN)
- ◻ Pre-release smoke run against current main branches
- ◻ Dispatch N.N stale doc metrics + N.N Claude inbox surface
- ◻ Dispatch N.N, N.N, N.N remaining small beads
<!-- END INJECTED BLOCK -->

# xtrm-tools — Claude Code Guide

This file is a compact routing guide for Claude Code sessions in `xtrm-tools`. It should stay current, short, and operational. For deep workflow details, load the referenced skills or use each CLI's `--help`; do not paste full manuals here.

## Project summary

`xtrm-tools` is the source repo for the xtrm agent tooling ecosystem: Claude Code plugin assets, Pi extension wiring, skills, hooks, MCP config, registry generation, and the `xt` CLI. It is a dual-runtime project: Claude Code and Pi are peers fed by shared xtrm policy/config sources.

## Non-negotiable rules

- Use beads as the authoritative issue tracker and normal work lifecycle. Inspect/claim/close with `bd` before and after edits.
- To proceed on any non-trivial or multi-step Claude Code work, use Claude Code task planning features (TaskCreate/TodoWrite-style when available) alongside normal bead operations. The local plan must mirror the active bead scope and never replace beads for ownership, dependencies, or closure.
- Specialists are a normal operational surface here. Before specialist work, check `sp --help` and `sp list` / `specialists list` so you know the available roles and current CLI shape.
- For documentation, service understanding, and project/service context, use the canonical service-skills skill set (`/scope`, `/using-service-skills`) as the primary knowledge substrate.
- Never commit while a bead claim is open. Close the bead first.
- Before editing an existing function, class, or method, run GitNexus impact analysis.
- Before committing, run `gitnexus_detect_changes()` for scope verification.
- Do not edit generated files directly unless the task is explicitly to update generated artifacts.
- `.xtrm/config/hooks.json` is generated from `policies/*.json`; edit policies and run `npm run compile-policies`.
- `.xtrm/registry.json` is generated; run `npm run gen-registry` after adding/changing managed assets.
- `cli/dist` is tracked; rebuild with `npm run build` when CLI source changes.
- Ask before destructive, irreversible, production-impacting, or history-rewriting actions.

## Session start: targeted, not reconstructive

1. `bd list --status=in_progress`, `bd ready`, `bd search "<terms>"`, `bd show <id>` — locate the relevant current work.
2. `bv --robot-triage` or `bv --robot-next` — choose work when needed. Never run bare `bv`.
3. `bd update <id> --claim` — claim before edits.

`bd prime` is opt-in diagnostic only; invoke it explicitly when a full-context run helps.

For full xtrm/beads workflow details, load `/using-xtrm` and use `bd --help`, `bd <cmd> --help`, `xt --help`.

## Skill routing

| Need | Load/use |
|---|---|
| xtrm workflow, beads gates, session behavior | `/using-xtrm`; `bd --help`; `xt --help` |
| Specialist orchestration | latest `/using-specialists-*`, prefer `/using-specialists`; `sp --help` / `specialists --help` |
| Planning feature/epic work | `/planning` plus `/test-planning` |
| Tests and quality workflow | `/using-quality-gates`, `/using-tdd`, `/test-planning` |
| Docs sync | `/sync-docs`; use the canonical service-skills skill set for project/service context |
| Release | `/releasing` |
| Session close / PR flow | `/xt-end`, `/session-close-report`, `/xt-merge` |
| Skill creation/update | `/skill-creator` |
| Hook work | `/hook-development` |
| Service routing | `/scope`, `/using-service-skills` when service territories exist |
| GitNexus exploration/debug/refactor | matching `/gitnexus-*` skill |
| Pi long-running commands | `/pi-processes`; use the `process` tool |

## Project map

- `cli/src/commands/` — `xt` command implementations.
- `cli/src/core/` — install/update/runtime sync logic, registry scaffolding, Pi runtime, skills materialization.
- `cli/src/utils/` — worktree/session helpers and shared CLI utilities.
- `cli/src/tests/` and `cli/test/` — CLI and integration tests.
- `policies/` — source of hook/policy wiring; compile to `.xtrm/config/hooks.json`.
- `.xtrm/config/` — generated/runtime config payload installed into consumer projects.
- `.xtrm/hooks/` — hook payloads copied to projects.
- `.xtrm/skills/default/` — legacy per-repo path; canonical now at `~/.xtrm/skills/default/` (global SSOT).
- `.xtrm/skills/optional/` — legacy per-repo path; canonical now at `~/.xtrm/skills/optional/` (global SSOT).
- `.xtrm/ext-src/` and `packages/pi-extensions/extensions/` — Pi extension sources and packaged extension workspace.
- `skills/` — legacy/source skill mirror used by some checks and docs.
- `scripts/` — registry, packaging, policy, hygiene, and release helper scripts.
- `docs/` — architecture, release, ownership, cleanup, and user docs.
- `.wolf/` — OpenWolf project memory/anatomy/buglog state.

## Essential command surface

Keep only the commands an agent needs without another manual. Use `--help` for full syntax.

### Beads / xtrm workflow

- `bd prime` — opt-in diagnostic full-context load. Not a session-start step.
- `bd ready` — list unblocked open issues.
- `bd list --status=in_progress` — see active claims.
- `bd show <id>` — inspect detail, deps, blockers, notes.
- `bd update <id> --claim` — claim before edits.
- `bd close <id> --reason="..."` — close before commit.
- `bv --robot-triage --format toon` / `bv --robot-next` — ranked work selection; never run bare `bv`.
- `xt update --apply` — refresh xtrm-managed assets in a repo.
- `xt end` — close worktree session / PR flow when appropriate.
- `xt worktree audit-prs --json`, `branch-gc --json`, `restart-audit --json` — PR drift, safe branch-GC dry run, and restart/handoff hygiene.

### Specialists

- `sp list` / `specialists list` — discover available specialists.
- `sp ps` — inspect running specialist jobs.
- `sp feed <job-id>` — monitor job progress.
- `sp result <job-id>` — read final output.
- For orchestration policy, load latest `/using-specialists-*`, preferring `/using-specialists`.

### GitNexus safety

- `gitnexus_impact({ target: "symbolName", direction: "upstream", repo: "xtrm-tools" })` — required before changing existing symbols.
- `gitnexus_detect_changes({ scope: "all", repo: "xtrm-tools" })` — required before commit / handoff verification.
- `gitnexus_query({ query: "concept", repo: "xtrm-tools" })` — explore unfamiliar flows before grep-heavy reads.
- `gitnexus_context({ name: "symbolName", repo: "xtrm-tools" })` — inspect callers/callees/processes.

### Local validation

- `npm run gen-registry` — after managed asset or skill changes.
- `npm run compile-policies` — after policy changes.
- `npm run build` — after CLI source changes; `cli/dist` is tracked.
- `npm test --workspace cli` — CLI test suite; prefer targeted tests during iteration.
- `npm run check:registry-pack-parity` and `npm run check:payload-hygiene` — package/registry hygiene.

## Claude Code notes

- For non-trivial or multi-step Claude Code work, create and maintain a small internal task plan before proceeding; keep it synchronized with the active bead and clear/complete it as work progresses.
- For service/documentation context, route through `/scope` and the canonical service-skills skill set first.
- Use GitNexus for unfamiliar code execution flows before grepping large trees.
- Use `structured_return` for tests, builds, lint, typecheck, and other quality commands.
- Use `process` for long-running servers/watchers/log tails.
- Do not create markdown TODO lists for work tracking; use `bd` issues.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **core** (15653 symbols, 31194 relationships, 482 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/core/context` | Codebase overview, check index freshness |
| `gitnexus://repo/core/clusters` | All functional areas |
| `gitnexus://repo/core/processes` | All execution flows |
| `gitnexus://repo/core/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## OpenWolf rules

- Before reading project files, check `.wolf/anatomy.md`.
- Before generating code, check `.wolf/cerebrum.md` Do-Not-Repeat entries.
- Before fixing bugs/errors, read `.wolf/buglog.json` for known fixes.
- After editing files, update `.wolf/anatomy.md` and append a concise note to `.wolf/memory.md`.
- After fixing a bug, failed test, failed build, or user-reported problem, log it in `.wolf/buglog.json` with root cause and fix.
- If a user correction reveals a durable preference or mistake, update `.wolf/cerebrum.md` immediately.

## Current gotchas

- `xt` has no `install` subcommand; fresh bootstrap is `xt init -y`, ongoing refresh is `xt update --apply`.
- Runtime skills view is flat `.xtrm/skills/active` (composed) and `~/.xtrm/skills/active` (global); legacy `active/claude` or `active/pi` paths are stale.
- New skills go under `~/.xtrm/skills/default/<name>/` (global SSOT); run `npm run gen-registry` and validate pack/registry parity.
- Specialist-owned skills must be edited in the specialists repo first, then vendored into xtrm-tools and shipped to `~/.xtrm/skills/default/`.
- Pi npm-provided skills (for example GitNexus skills) may need exclusion from Pi runtime views to avoid collisions.
- Worktrees do not carry ignored dependencies (`node_modules`, `.venv`); run the repo bootstrap inside the worktree when needed.
- `.xtrm/reports/` is gitignored; use `git add -f` only when a report should be committed.
- Per-repo `default/` and `optional/` are deprecated; migrate with `xt migrate skills --apply`.
- `pr-review-gate` GitHub Actions workflow is a required check on `main`/`master` across the 16 xtrm/mercuryintelligence/Jaggerxtrm-managed repos with real PR flow. Canonical template lives at `skills/security-pipeline/templates/.github/workflows/pr-review-gate.yml`; installed per-repo via `security-bootstrap.sh` and NOT auto-synced by `xt update --apply` — template changes require a manual fanout (see wave-1 `xtrm-7cjkv` + wave-2 `xtrm-54zwl.7` bead notes for the batch pattern).

## Quality gates

Run targeted validation relevant to the files changed. Common checks:

- Skill/asset changes: `npm run gen-registry`, `npm run check:registry-pack-parity`, `npm run check:skills-symlinks`.
- Policy/hook wiring: `npm run compile-policies`, then targeted policy tests.
- CLI source: `npm run build`, targeted `npm test --workspace cli -- <test>` or full `npm test --workspace cli` when appropriate.
- Package/release hygiene: `npm run check:payload-hygiene`, `npm run check:specialists-vendor`, `npm run check:skills-ownership`.

## References

- `README.md` — user-facing overview.
- `XTRM-GUIDE.md` — full workflow reference.
- `docs/release.md` — release/operator playbook.
- `docs/skills-ownership.json` and `docs/skills-ownership.md` — skill ownership and vendoring rules.
- `docs/plans/global-skills-migration.md` — global skills migration architecture and operator workflow.
- `~/.xtrm/skills/default/using-xtrm/SKILL.md` — current xtrm workflow behavior (global SSOT).
- `~/.xtrm/skills/default/agent-docs-maintainer/SKILL.md` — how to keep this file compact.

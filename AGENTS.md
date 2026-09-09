<!-- BEGIN INJECTED BLOCK -->
## Communication Style

Use controlled, precise, and direct language throughout the work session, including plans, progress updates, analysis, reviews, implementation notes, documentation, handoffs, and final reports. Prefer explicit subjects, active voice, consistent terminology, concrete statements, and logically ordered sentences. Keep the writing natural and concise. Avoid conversational filler, ornamental language, vague qualifiers, unnecessary jargon, and exaggerated certainty.

Adapt the level of rigor to the context. Use clear technical prose for analysis, architecture, debugging, design discussion, and collaboration. Use a stricter ASD-STE100-oriented style for procedures, commands, migrations, deployments, security requirements, destructive operations, rollback instructions, acceptance criteria, and operator handoffs. In these cases, state conditions before actions, identify the responsible actor, express one principal action per sentence, preserve the required sequence, and describe expected results and failure conditions explicitly.

Clearly distinguish verified facts, observations, assumptions, inferences, recommendations, and unresolved questions. Do not report an action as successful without evidence. Preserve exact names for repositories, services, contracts, routes, identifiers, configuration fields, and work items. Do not omit material ownership, dependencies, risks, preconditions, rollback requirements, or verification criteria for the sake of brevity.

## Task Tracking (two-tier)

Up to two task systems coexist in this repo. Where the runtime exposes both, use both; do not substitute one for the other. On a runtime with no task tools, beads alone is correct and complete — do not invent or call a native task API the runtime does not expose.

- **Beads (`bd`)** — top-level durable tracking, on every runtime. Authoritative for ownership, dependencies, and closure. Read the rest of this file and use targeted lookup (`bd ready`, `bd search "<terms>"`, `bd show <id>`) before starting work; `bd prime` is opt-in diagnostic only. File, claim, and close work here.
- **The runtime's own task system, when the runtime has one** — this-session execution tracking. Use it to mirror the active bead and break it into smaller intermediate steps. Ephemeral; does not replace beads. Names differ per runtime; read the runtime's own tool list rather than assuming a name.

Rule: on a runtime that exposes task tools, when you pick up a bead, create native tasks that track it — reference the bead ID in each task title (e.g. `N.N summary — status (worker %NNNN)`) — and add any smaller intermediate steps as native sub-tasks. Beads own the durable record; native tasks own the in-flight breakdown.

Example native task list mirroring beads:
- ◼ N.N smoke container global surface — BLOCKS RELEASE (worker %NNNN)
- ◼ N.N status test flake under load (worker %NNNN)
- ◻ Pre-release smoke run against current main branches
- ◻ Dispatch N.N stale doc metrics + N.N Claude inbox surface
- ◻ Dispatch N.N, N.N, N.N remaining small beads
<!-- END INJECTED BLOCK -->

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
3. Executable work: targeted Beads lookup (`bd ready`, `bd list --status=in_progress`, `bd search "<terms>"`, `bd show <id>`), then `bd update <id> --claim` before edits.
4. Catch up: handoff/next-session beads, latest `xt report` handoffs, recent merged/closed PRs.
5. If the runtime supports local task planning, use it for non-trivial work, synchronized with the active bead.

## Operating model

- Beads owns durable work identity, dependencies, and closure; runtime-local task plans are ephemeral execution tracking.
- For work another worker consumes, the Bead is the prompt: requirements live in the durable contract, not only in chat. A `contract:draft` item is not dispatchable.
- Contract baseline: PROBLEM, SUCCESS, SCOPE, NON_GOALS, CONSTRAINTS, VALIDATION, OUTPUT; add SCRUTINY and rollout/rollback when they affect correctness.
- Worker summaries are claims. Verify important ones against live code, tests, or runtime state.
- Prefer native/runtime communication surfaces over tmux scraping; `/multiplexing` owns send, reply, ownership, continuation, and handoff semantics.
- Shape: work here when context suffices; native subagent for a bounded independent question; `xt pi|claude|codex` peers with `/multiplexing` for parallel ownership; `/using-specialists` for governed role lifecycles; a script or runtime primitive for deterministic transforms. Parallelize only when ownership boundaries are real.

## Operating rules

- No close-time memory gate: `bd close <id> --reason="..."` succeeds directly; the claim/edit/commit gates still guard edits and commits.
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

Domain packs (`sre-ops`, `security-ops`, `research-methods`, `xtrm-development`, `xtrm-maintenance`) are optional; inspect `xt skills` rather than assuming they are active. Syntax per CLI: `bd --help`, `bv --robot-triage --format toon`, `xt --help`, `xtmux --help`, `sp --help`.

## Rule conflict — TaskCreate / TodoWrite

`bd prime` is an opt-in full-context diagnostic; it is never a session-start step. If that diagnostic reports *"Prohibited: Do NOT use TodoWrite, TaskCreate, or markdown files for task tracking"*, **this project overrides that line.** Runtime-local task planning coexists with beads — beads is the durable authority; local plans are ephemeral execution tracking. Do not create MEMORY.md files.

<!-- contract:end -->

## Runtime notes (Pi / runtime-neutral)

- Project skills catalog: Pi's native `<available_skills>` metadata; force-load a skill's body at turn 1 via `/skill:<name>`.
- Full workflow examples + prompt-shaping guidance: `/skill:using-xtrm` (on demand — no longer eager-injected on Pi).
- Use background process tooling for long-running servers, watchers, and log tails instead of shell backgrounding.
- Worktree launch: `xt pi` — launch Pi in a sandboxed worktree; `xt pi --role <specialist>` for an interactive specialist session (e.g. `chain-coordinator`, `pr-reviewer`, `sre-triage`). Coordination and escalation live in `/multiplexing` Pattern 7 and `/using-specialists`.
<!-- xtrm:end -->

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

<!-- BEGIN BEADS INTEGRATION -->
## Issue Tracking with bd (beads)

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Issue title" --description="Detailed context" -t bug|feature|task -p 0-4 --json
bd create "Issue title" --description="What this issue is about" -p 1 --deps discovered-from:bd-123 --json
```

**Claim and update:**

```bash
bd update <id> --claim --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

## Specialists

MCP is intentionally minimal: only `use_specialist` is exposed. Use CLI for orchestration (`run/feed/result/steer/resume/stop`).
Legacy `start_specialist` is deprecated and should be migrated to `specialists run <name> --prompt "..." --background` ahead of next-major removal.

**Core specialist commands (CLI-first in pi):**
- `specialists list`
- `specialists run <name> --bead <id>`
- `specialists run <name> --prompt "..."`
- `specialists feed -f` / `specialists feed <job-id>`
- `specialists result <job-id>`
- `specialists resume <job-id> "next task"` (for keep-alive jobs in `waiting`)
- `specialists stop <job-id>`

**Running specialists in background (recommended): use the process extension**
- Tool actions: `process start`, `list`, `output`, `logs`, `kill`, `clear`
- Example: `process start "specialists run explorer --bead unitAI-123" name="sp-explorer"`
- Useful commands: `/ps`, `/ps:pin`, `/ps:logs`, `/ps:kill`, `/ps:clear`, `/ps:dock`, `/ps:settings`
- Benefits: unified log dock, follow mode, focus mode, file-based logs, friendly names, auto-cleanup

**Canonical tracked flow**
1. Create/claim bead issue
2. Run specialist with `--bead <id>` (for long work, launch via `process start`)
3. Observe progress (`process output`/`process logs` or `specialists feed`)
4. Read final output (`specialists result <job-id>`)
5. Close/update bead with outcome

Add custom specialists to `.specialists/user/` to extend defaults.

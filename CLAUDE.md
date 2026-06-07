# xtrm-tools — Claude Code Guide

This file is a compact routing guide for Claude Code sessions in `xtrm-tools`. It should stay current, short, and operational. For deep workflow details, load the referenced skills or use each CLI's `--help`; do not paste full manuals here.

## Project summary

`xtrm-tools` is the source repo for the xtrm agent tooling ecosystem: Claude Code plugin assets, Pi extension wiring, skills, hooks, MCP config, registry generation, and the `xt` CLI. It is a dual-runtime project: Claude Code and Pi are peers fed by shared xtrm policy/config sources.

## Non-negotiable rules

- Use beads as the authoritative issue tracker and normal work lifecycle. Inspect/claim/close with `bd` before and after edits.
- To proceed on any non-trivial or multi-step Claude Code work, use Claude Code task planning features (TaskCreate/TodoWrite-style when available) alongside normal bead operations. The local plan must mirror the active bead scope and never replace beads for ownership, dependencies, memory gates, or closure.
- Specialists are a normal operational surface here. Before specialist work, check `sp --help` and `sp list` / `specialists list` so you know the available roles and current CLI shape.
- For documentation, service understanding, and project/service context, use the canonical service-skills skill set (`/scope`, `/using-service-skills`) as the primary knowledge substrate.
- Never commit while a bead claim is open. Close the bead and satisfy memory ack first.
- Before editing an existing function, class, or method, run GitNexus impact analysis.
- Before committing, run `gitnexus_detect_changes()` for scope verification.
- Do not edit generated files directly unless the task is explicitly to update generated artifacts.
- `.xtrm/config/hooks.json` is generated from `policies/*.json`; edit policies and run `npm run compile-policies`.
- `.xtrm/registry.json` is generated; run `npm run gen-registry` after adding/changing managed assets.
- `cli/dist` is tracked; rebuild with `npm run build` when CLI source changes.
- Ask before destructive, irreversible, production-impacting, or history-rewriting actions.

## Session start

1. `bd prime` — load workflow context.
2. `bd memories <topic>` — retrieve relevant memory before answering questions or changing workflow-sensitive code.
3. `bv --robot-triage` or `bv --robot-next` — choose work when needed. Never run bare `bv`.
4. `bd update <id> --claim` — claim before edits.

For full xtrm/beads workflow details, load `/using-xtrm` and use `bd --help`, `bd <cmd> --help`, `xt --help`.

## Skill routing

| Need | Load/use |
|---|---|
| xtrm workflow, beads gates, session behavior | `/using-xtrm`; `bd --help`; `xt --help` |
| Specialist orchestration | latest `/using-specialists-*`, prefer `/using-specialists-v3`; `sp --help` / `specialists --help` |
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
- `.xtrm/skills/default/` — canonical xtrm skill payloads installed to consumers.
- `.xtrm/skills/optional/` — optional skill packs.
- `.xtrm/ext-src/` and `packages/pi-extensions/extensions/` — Pi extension sources and packaged extension workspace.
- `skills/` — legacy/source skill mirror used by some checks and docs.
- `scripts/` — registry, packaging, policy, hygiene, and release helper scripts.
- `docs/` — architecture, release, ownership, cleanup, and user docs.
- `.wolf/` — OpenWolf project memory/anatomy/buglog state.

## Essential command surface

Keep only the commands an agent needs without another manual. Use `--help` for full syntax.

### Beads / xtrm workflow

- `bd prime` — load workflow context and active claims.
- `bd ready` — list unblocked open issues.
- `bd list --status=in_progress` — see active claims.
- `bd show <id>` — inspect detail, deps, blockers, notes.
- `bd update <id> --claim` — claim before edits.
- `bd memories <topic>` / `bd recall <key>` — retrieve durable context.
- `bd remember "<insight>"` — save durable context.
- `bd kv set memory-acked:<id> saved:<key>` or `nothing novel:<reason>` — satisfy close-time memory gate.
- `bd close <id> --reason="..."` — close before commit.
- `bv --robot-triage --format toon` / `bv --robot-next` — ranked work selection; never run bare `bv`.
- `xt update --apply` — refresh xtrm-managed assets in a repo.
- `xt end` — close worktree session / PR flow when appropriate.

### Specialists

- `sp list` / `specialists list` — discover available specialists.
- `sp ps` — inspect running specialist jobs.
- `sp feed <job-id>` — monitor job progress.
- `sp result <job-id>` — read final output.
- For orchestration policy, load latest `/using-specialists-*`, preferring `/using-specialists-v3`.

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

This project is indexed by GitNexus as `xtrm-tools`.

## Required use

- Before editing any existing function/class/method: run `gitnexus_impact({ target: "symbolName", direction: "upstream", repo: "xtrm-tools" })`.
- Warn the user before proceeding if impact risk is HIGH or CRITICAL.
- Before commit: run `gitnexus_detect_changes({ scope: "staged", repo: "xtrm-tools" })` or `scope: "all"` when not staging yet.
- For unfamiliar code: use `gitnexus_query({ query: "concept", repo: "xtrm-tools" })`.
- For callers/callees/full context: use `gitnexus_context({ name: "symbolName", repo: "xtrm-tools" })`.

## Deeper guidance

Load the matching skill instead of expanding this section:
- `/gitnexus-exploring`
- `/gitnexus-impact-analysis`
- `/gitnexus-debugging`
- `/gitnexus-refactoring`
- `/gitnexus-pr-review`
- `/gitnexus-cli`
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
- Runtime skills view is flat `.xtrm/skills/active`; legacy `active/claude` or `active/pi` paths are stale.
- New skills go under `.xtrm/skills/default/<name>/`; run `npm run gen-registry` and validate pack/registry parity.
- Specialist-owned skills must be edited in the specialists repo first, then vendored into xtrm-tools.
- Pi npm-provided skills (for example GitNexus skills) may need exclusion from Pi runtime views to avoid collisions.
- Worktrees do not carry ignored dependencies (`node_modules`, `.venv`); run the repo bootstrap inside the worktree when needed.
- `.xtrm/reports/` is gitignored; use `git add -f` only when a report should be committed.

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
- `.xtrm/skills/default/using-xtrm/SKILL.md` — current xtrm workflow behavior.
- `.xtrm/skills/default/agent-docs-maintainer/SKILL.md` — how to keep this file compact.

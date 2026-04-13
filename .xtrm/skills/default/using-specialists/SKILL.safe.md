---
name: using-specialists-safe
description: >
  Compressed variant of using-specialists. Delegate substantial work to specialists,
  orchestrate chains/epics, and preserve bead-first + merge-gated workflow safety.
version: 4.6
synced_at: zz22-docs
---

> Derived/compressed from `SKILL.md` (safe compression, semantics preserved).

# Using Specialists (Safe Compressed)

You are an **orchestrator**, not an implementer.
Default behavior: delegate substantial work to specialists.

## Core mandate

- Specialists handle ~99% of non-trivial work.
- Orchestrator handles only:
  - trivial one-liners / tiny config tweaks, or
  - cross-job synthesis/coordination decisions.
- For long runs: dispatch, set sleep timer, stop babysitting, check later.

## Non-negotiable rules

1. **Zero implementation by orchestrator** for substantial work.
2. **No self-exploration**: use `explorer` (or `debugger` for root-cause debugging).
3. Use `explorer` before `executor` when scope is unclear; skip explorer only when scope is already concrete.
4. For tracked work, **bead is the prompt** (title/description/notes + ancestry).
5. `--bead` and `--prompt` are **mutually exclusive**.
6. Chains belong to epics; publication is epic-gated.
7. **No manual git merges** for specialist work. Use `sp epic merge <epic>` or `sp merge <chain-root>` (standalone only).
8. No destructive ops by specialists (`rm -rf`, force push, DB drops, credential rotation, mass delete, history rewrite).
9. **Executor does not run tests** (lint + tsc only).
10. Keep executor/debugger alive through review loop; do not stop before reviewer verdict.
11. Executors do not auto-commit; after PASS, `resume` executor with explicit commit instruction.
12. Stop chain members only after final PASS + commit verification + merge (dependents first, owner last).

## Canonical CLI surface (minimum)

```bash
# Discover / health
sp list
sp doctor

# Run
sp run <specialist> --bead <id>
sp run <specialist> --bead <id> --background
sp run executor --worktree --bead <impl-id> --context-depth 2 --background
sp run <specialist> --job <job-id>            # reuse existing worktree
sp run <specialist> --bead <id> --epic <epic-id>
sp run <specialist> --prompt "..."            # ad-hoc, no bead tracking

# Observe
sp ps
sp ps <job-id>
sp feed -f
sp feed <job-id>
sp result <job-id>

# Control
sp steer <job-id> "new direction"
sp resume <job-id> "next task"
sp stop <job-id>

# Publish
sp epic status <epic-id>
sp epic merge <epic-id> [--pr]
sp merge <chain-root-bead> [--rebuild]        # standalone chains only
sp end [--pr]
```

## Object model

- **Job**: one run.
- **Chain**: shared worktree lineage (e.g., explorer → executor → reviewer → fix).
- **Epic**: merge-gated container for one or more chains.
- “Wave” is speech-only shorthand (not persisted).

Epic lifecycle: `open -> resolving -> merge_ready -> merged` (or `failed` / `abandoned`).

## Flag semantics

- `--worktree`: create/reuse isolated workspace (requires `--bead`).
- `--job <id>`: reuse target job workspace.
- `--epic <id>`: explicit epic membership override.
- `--worktree` and `--job` are mutually exclusive.

### `--job` concurrency guard

- MEDIUM/HIGH writers cannot enter target job workspace while target is `starting` or `running` (unless `--force-job`).
- READ_ONLY/LOW can enter.

## Worktree safety boundary

With `--worktree`, write tools are blocked outside the worktree boundary for absolute paths.
Relative paths resolve inside the worktree.

## Bead-first protocol

- Tracked work: use `--bead`; avoid `--prompt`.
- Need more instructions? update bead notes first:

```bash
bd update <id> --notes "INSTRUCTION: ..."
sp run <specialist> --bead <id> --context-depth 2 --background
```

- Use `--context-depth 2` for chained workflows.
- `--no-beads` skips auto-tracking sub-bead creation only.

## Standard tracked pipeline

```bash
# 1) Explore (if needed)
sp run explorer --bead <exp-id> --context-depth 2 --background

# 2) Implement
sp run executor --worktree --bead <impl-id> --context-depth 2 --background

# 3) Review in same workspace
sp run reviewer --job <exec-job> --keep-alive --background --prompt "Review implementation"

# 4a) PASS -> commit via resume, verify commit, merge
sp resume <exec-job> "Reviewer PASS. Git add and commit your changes."
sp merge <chain-root> --rebuild              # if standalone chain
# OR
sp epic merge <epic-id>                      # if epic-owned chain(s)

# 4b) PARTIAL/FAIL -> fix loop in same workspace
sp resume <exec-job> "Reviewer PARTIAL. Fix: <findings>"
sp run reviewer --job <exec-job> --keep-alive --background --prompt "Re-review after fix"
# repeat until PASS
```

## Merge protocol (critical)

- **Epic-owned chains**: publish only via `sp epic merge <epic-id>`.
- `sp merge <chain-root>` is valid only when chain is not in unresolved epic.
- Do not merge inside an active chain; merge after reviewer PASS and commit.
- Staged programs: do not start Stage N+1 before Stage N is complete and published.

## Dependency mapping guidance

- Encode pipeline via `bd dep add`.
- Parallel chains in same stage must be file-disjoint and depend on shared prior stage, not each other.
- Tests are batched beads that depend on all covered impl beads.

## Specialist selection (quick map)

- `explorer`: codebase mapping, read-only discovery.
- `debugger`: root-cause + fix strategy.
- `overthinker`: complex design/tradeoffs.
- `executor`: implementation/docs rewrite, lint+tsc only.
- `reviewer`: PASS/PARTIAL/FAIL on executor output (`--job`).
- `researcher`: external docs/research.
- `test-runner`: test execution and failure interpretation.
- `sync-docs`: doc audit/sync.
- `planner`: issue decomposition and deps.

## Monitoring + recovery

```bash
sp ps
sp feed <job-id>
sp result <job-id>
sp doctor
sp clean --processes
```

- `waiting` usually means keep-alive is healthy; check before stopping.
- If stalled: steer, resume, or replace specialist.
- If `--job` lacks worktree path, target job wasn’t started with `--worktree`.
- If `--prompt`/`--bead` conflict: move instruction to bead notes and run with `--bead` only.

---
name: using-specialists-ultra
description: >
  Ultra-compressed using-specialists playbook: delegate by default, run bead-first
  specialist chains, and publish through merge-gated epic workflows.
version: 4.6
synced_at: zz22-docs
---

> Derived/compressed from `SKILL.md` (ultra compression).

# Using Specialists (Ultra)

## Role
Orchestrator only: route, sequence, monitor, synthesize. For substantial work: **do not implement or explore yourself**.

## Hard constraints
- Default: delegate (≈99%).
- Use `explorer` for discovery, `debugger` for root cause.
- Tracked work: bead is prompt; use `--bead`.
- `--bead` XOR `--prompt`.
- `executor`: lint+tsc only; no tests.
- Keep executor/debugger alive through review loop; use `resume`, not re-dispatch.
- Executors do not auto-commit; after PASS, resume with explicit commit instruction.
- No destructive specialist actions (force push, history rewrite, rm -rf, drops, mass delete, credential rotation).
- No manual git merge for specialist work.
- Epic-owned chains publish via `sp epic merge`; standalone chains via `sp merge` only.
- Stages are sequential; parallelize only independent chains within a stage.

## Minimal commands
```bash
# discover/health
sp list
sp doctor

# run
sp run <name> --bead <id> [--background] [--context-depth 2]
sp run executor --worktree --bead <impl-id> --context-depth 2 --background
sp run <name> --job <job-id>                 # reuse workspace
sp run <name> --bead <id> --epic <epic-id>
sp run <name> --prompt "..."                 # ad-hoc only

# observe/control
sp ps [<job-id>]
sp feed -f | sp feed <job-id>
sp result <job-id>
sp steer <job-id> "..."
sp resume <job-id> "..."
sp stop <job-id>

# publish
sp epic status <epic-id>
sp epic merge <epic-id> [--pr]
sp merge <chain-root-bead> [--rebuild]       # only if not in unresolved epic
```

## Flag semantics
- `--worktree`: new/reused isolated workspace (requires `--bead`).
- `--job`: reuse target workspace.
- `--epic`: explicit epic membership.
- `--worktree` + `--job`: invalid together.
- MEDIUM/HIGH writers blocked from `--job` target while target is `starting/running` (use `--force-job` only when risk accepted).

## Canonical pipeline
```bash
# explore (if needed)
sp run explorer --bead <exp-id> --context-depth 2 --background

# implement
sp run executor --worktree --bead <impl-id> --context-depth 2 --background

# review same workspace
sp run reviewer --job <exec-job> --keep-alive --background --prompt "Review implementation"

# PASS
sp resume <exec-job> "Reviewer PASS. Git add and commit your changes."
sp epic merge <epic-id>        # or sp merge <chain-root> if standalone

# PARTIAL/FAIL
sp resume <exec-job> "Reviewer PARTIAL. Fix: <findings>"
sp run reviewer --job <exec-job> --keep-alive --background --prompt "Re-review"
```

## Bead-first ops
```bash
bd update <id> --notes "INSTRUCTION: ..."
sp run <name> --bead <id> --context-depth 2 --background
```
Use `--context-depth 2` for chained runs.

## Model
- Job = one run.
- Chain = shared-worktree lineage.
- Epic = merge-gated container of chains.
- “Wave” = shorthand only (not persisted).

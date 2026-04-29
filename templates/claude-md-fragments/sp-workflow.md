---
name: sp-workflow
version: 1.0.0
description: Specialists (sp) orchestration invariants — bead-first, worktree, review chain, merge
---
# Specialists (sp) Workflow

> Full skill: `/using-specialists-v2` | CLI reference: `docs/cli-reference.md`

## Hard Rules

1. `--bead` is the prompt for tracked work — never `--prompt` to supplement.
2. Edit-capable specialists run with `--worktree` for the first implementation pass.
3. Reviewer gets its own bead and reuses the executor workspace via `--job <exec-job>`.
4. `--worktree` and `--job` are mutually exclusive.
5. Use `--context-depth 2` for chained work (own bead + predecessor + parent task).
6. Keep executor/debugger jobs alive through review with `--keep-alive` so they can be resumed.
7. Merge specialist branches with `sp merge` or `sp epic merge`. Never manual `git merge`.
8. Specialists must not perform destructive or irreversible actions — surface to the operator instead.

## Daily Commands

```bash
sp list                                      # Specialist registry
sp run <name> --bead <id> --background       # Bead-first dispatch (depth 3 default)
sp run executor --worktree --bead <id> --background       # Edit-capable: auto-provisions worktree
sp run reviewer --bead <id> --job <exec-job> --keep-alive --background
sp ps [<job-id>]                             # Live job snapshot
sp feed <job-id>                             # Event stream (use -f to follow)
sp result <job-id>                           # Last completed turn (works on waiting jobs)
sp steer <job-id> "..."                      # Course-correct a running job
sp resume <job-id> "..."                     # Continue a waiting keep-alive job
sp stop <job-id>                             # Terminate
```

## Publication

```bash
sp merge <chain-root-bead>                   # Standalone chain
sp epic status <epic-id>                     # Epic readiness check
sp epic merge <epic-id>                      # Multi-chain epic publication
```

## Review & Fix Loop

```text
executor --worktree --bead impl
  -> waiting after turn
reviewer --bead review --job <exec-job>
  -> PASS:    publish via sp merge / sp epic merge
  -> PARTIAL: sp resume <exec-job> "Fix only ..."  then re-review
  -> FAIL:    decide: resume, replace bead, or abandon
```

## Monitoring Signal

Context percentage in `sp ps`/feed is an action signal, not a hard limit:

- 0–40 % healthy
- 40–65 % monitor
- 65–80 % steer toward conclusion
- > 80 % finish, summarize, or replace the job

`sp poll` is deprecated — use `sp ps` for state and `sp feed` for streams.

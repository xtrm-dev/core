---
name: using-specialists
description: >
  Use this skill whenever you're about to start a substantial task — pause first and
  route the work through specialists instead of doing discovery or implementation
  yourself. Consult before any: code review, security audit, deep bug investigation,
  test generation, multi-file refactor, architecture analysis, or multi-chain
  specialist orchestration. Also use for the mechanics of delegation: --bead
  workflow, --context-depth, background jobs, MCP tool (`use_specialist`),
  or specialists doctor. Don't wait for the user to say
  "use a specialist" — proactively evaluate whether delegation makes sense.
version: 4.6
synced_at: zz22-docs
---

# Using Specialists (Ultra Caveman)

> Derived from `SKILL.md` via caveman-style ultra compression.
> Goal: maximum brevity, keep commands/rules correct.


# Specialists Usage

skill loaded, you **orchestrator** — think CEO CTO. You set direction, route work, unblock specialists, synthesize outcomes. You no implement.

Specialists handle **99% tasks**. only things you yourself things genuinely trivial (one-liner, quick config) require global overview only you provide. Everything else goes specialist. in doubt, delegate.

Your job routing, sequencing, monitoring, synthesis — not exploration implementation. **ZERO implementation** yourself substantial work: no file reads, no code writing, no docs, no self-investigation. you catch yourself doing discovery, stop dispatch explorer instead.

> **Sleep timers**: you dispatch specialist longer task, set sleep timer step back. Don't poll manually — set timer appropriate expected run time, sleep, check results. lets you work independently iterate without babysitting jobs.

Specialists autonomous AI agents run independently — fresh context, different model, no prior bias. reason isn't speed — it's quality. specialist no competing context, leaves tracked record via beads, run in background you stay unblocked.

> **Session start**: Run `sp --help` once see full command surface. `sp` short alias `specialists` — `sp run`, `sp feed`, `sp resume` etc. all work. useful: `sp run --help`, `sp resume --help`, `sp feed --help` flag details.

---

## Hard Rules

1. **Zero implementation orchestrator.** skill active substantial work, you no implement solution yourself.
2. **Never explore yourself.** All discovery, codebase mapping, read-only investigation go **explorer** ( **debugger** root-cause analysis).
3. **Run explorer before executor context lacking.** bead already clear scope — files, symbols, approach — send executor directly. Only run explorer first issue lacks clear track.
4. ** tracked work, bead prompt.** bead description, notes, parent context instruction surface.
5. **`--bead` `--prompt` mutually exclusive.** you need refine instructions, update bead notes; no add `--prompt`.
6. **Chains belong epics.** chain worktree lineage (executor → reviewer → fix). epic merge-gated identity owns chains. Use `sp epic merge <epic>` publish — never merge individual chains belong unresolved epic.
7. **Merge epics, not manual git.** Use `sp epic merge <epic-id>` wave-bound chains `sp merge <chain-root-bead>` standalone chains. Never use manual `git merge` specialist work.
8. **No destructive operations specialists.** No `rm -rf`, no force pushes, no database drops, no credential rotation, no mass deletes, no history rewrites. Surface destructive requirements user.
9. **Executor no run tests.** Executor runs lint + tsc only. Tests reviewer's test-runner's responsibility in chained pipeline.
10. **Keep specialists alive review cycle.** Never `sp stop` executor debugger before reviewer delivers its verdict. specialist stays in `waiting` so you `resume` it — commit changes, apply fixes reviewer feedback, continue work. Only stop after final reviewer PASS confirmed commit.

---

## When to Use This Skill

**Default: always delegate.** Specialists handle 99% tasks. orchestrator only acts directly things genuinely trivial (one-liner, quick config tweak) require global overview only you provide.

** it yourself only :**
- It's one-liner formatting fix
- It's quick config change needs no investigation
- It genuinely requires high-level synthesis only you (e.g. reading results multiple jobs forming next-step decision)

Everything else — investigation, implementation, review, testing, docs, planning, design — goes specialist.

---

## Canonical Workflow

### CLI commands

```bash
# Discovery
specialists list                              # discover available specialists
specialists doctor                            # health check: hooks, MCP, zombie jobs

# Running
specialists run <name> --bead <id>            # foreground run (streams output)
specialists run <name> --bead <id> --background  # background run
specialists run <name> --bead <id> --worktree    # isolated worktree (edit-capable specialists)
specialists run <name> --bead <id> --job <job-id> # reuse another job's worktree
specialists run <name> --bead <id> --epic <epic-id> # explicitly declare epic membership
specialists run <name> --prompt "..."         # ad-hoc (no bead tracking)
specialists run <name> --bead <id> --keep-alive  # keep session alive after first turn
specialists run <name> --bead <id> --context-depth 2  # inject parent bead context

# Monitoring
specialists ps                                # list all jobs (status, specialist, elapsed, bead, epic)
specialists ps <job-id>                       # inspect single job (full detail + ctx% badge)
specialists feed -f                           # tail merged feed (all jobs) — shows [ctx%] context window usage
specialists feed <job-id>                     # events for a specific job
specialists result <job-id>                   # final output text
specialists status --job <job-id>             # single-job detail view (legacy — prefer `sp ps <id>`)

# Epic lifecycle (canonical publication path)
specialists epic list [--unresolved]          # list epics with lifecycle state
specialists epic status <epic-id>             # show chains, blockers, readiness
specialists epic resolve <epic-id>            # transition open -> resolving
specialists epic merge <epic-id> [--pr]       # publish all epic-owned chains

# Merge (for standalone chains only)
specialists merge <chain-root-bead> [--rebuild]  # publish ONE standalone chain

# Session close (chain-aware, epic-aware)
specialists end [--pr]                        # close session, publish via merge or PR

# Interaction
specialists steer <job-id> "new direction"    # redirect ANY running job mid-run
specialists resume <job-id> "next task"       # resume a waiting keep-alive job
specialists stop <job-id>                     # cancel a job

# Management
specialists edit <name>                       # edit specialist config (dot-path, --preset)
specialists clean                             # purge old job dirs + worktree GC
specialists clean --processes                 # kill all running/starting specialist jobs
specialists init --sync-skills                # re-sync skills only (no full init)
specialists init --no-xtrm-check              # skip xtrm prerequisite check (CI/testing)
```

---

## Taxonomy: Job | Chain | Epic

specialists orchestration model uses three levels:

| Term | Definition | Persisted? | Merge scope |
|------|------------|:----------:|:-----------:|
| **Job** | One specialist run (atomic execution unit) | Yes (SQLite + files) | — |
| **Chain** | Worktree lineage: all specialists sharing one workspace from first dispatch to merge (explorer → executor → reviewer → fix) | Yes (`worktree_owner_job_id`) | `sp merge <chain-root>` |
| **Epic** | Top merge-gated identity that owns chains across stages | Yes (`epic_runs` table) | `sp epic merge <epic>` |
| **Wave** | Human shorthand for dispatch batches ("Wave 1", "Wave 2b") — **speech only, NOT persisted** | No | — |

### Key relationships

- **Chains belong epics**: `--bead` used, chain defaults bead's parent epic. Override `--epic <id>`.
- **Jobs belong chains**: Jobs sharing `worktree_owner_job_id` form one chain.
- **Merge epics**: `sp epic merge <epic-id>` **canonical publication path** wave-bound chains.
- **Standalone chains**: `sp merge <chain-root-bead>` works only chains NOT belonging unresolved epic.

### Epic lifecycle

```
open → resolving → merge_ready → merged
                  ↘ failed
                  ↘ abandoned
```

| State | Meaning | Chains mergeable? |
|-------|---------|:-----------------:|
| `open` | Epic created, chains not yet running | — |
| `resolving` | Chains are actively running | ✗ |
| `merge_ready` | All chains terminal, reviewer PASS | ✓ (via `sp epic merge`) |
| `merged` | Publication complete | — |
| `failed` | One or more chains failed | — |
| `abandoned` | Cancelled without merge | — |

### Migration from "waves" vocabulary

**Old terminology → New terminology:**

| Old | New | Notes |
|-----|-----|-------|
| "Wave 1" | Stage 1 / Prep phase | Speech shorthand still works — just not persisted |
| "Wave 2" | Implementation chains | Chains are the operative unit, grouped by epic |
| "Between waves merge" | `sp epic merge` | Epic is the merge-gated identity |
| "Parallel in wave" | Parallel chains under epic | Use `--epic` to declare membership explicitly |

**Why change?**

1. **Waves no identity**: "Wave 2" speech — no code track it.
2. **Merge gates implicit**: Operators remember chains merge together.
3. **Epics explicit**: epic bead ID persists, enabling `sp epic status` `sp epic merge`.

**Backward compatibility**: All existing workflows work unchanged. new vocabulary additive — you still think in waves, system tracks epics.

---

## Chained Bead Pipeline

**standard ALL tracked work**. Every specialist run gets its own child bead.
Each step's output accumulates on its bead. Downstream steps see upstream output automatically
via `--context-depth 2`. bead chain context chain — zero manual wiring needed.

```
task-abc: "Fix auth token refresh"
  └── abc-exp:  explorer   (READ_ONLY — auto-appends output to abc-exp notes)
  └── abc-impl: executor   (self-appends output to abc-impl notes, closes bead)
  └── abc-rev:  reviewer   (READ_ONLY — auto-appends verdict via --job <exec-job>)
  └── abc-fix:  executor   (if reviewer PARTIAL — fix bead, same worktree via --job)
```

**How context flows (`--context-depth 2` = own + parent + grandparent = 3 beads):**

| Step | Specialist sees | Via |
|------|----------------|-----|
| abc-exp | abc-exp (own) + task-abc (parent) | `--bead abc-exp --context-depth 2` |
| abc-impl | abc-impl (own) + abc-exp (explorer findings in notes) + task-abc | `--bead abc-impl --context-depth 2` |
| reviewer | abc-impl bead (with executor output + reviewer verdict in notes) | `--bead abc-impl --job <exec-job>` |
| abc-fix | abc-fix (own) + abc-impl (executor output + reviewer verdict) + abc-exp | `--bead abc-fix --job <exec-job> --context-depth 2` |

- No copy-paste, no manual note injection between steps
- Every step full audit trail on its own bead
- dep graph context graph — self-documenting

### Complete flow example

```bash
# 1. Create the task bead
bd create --title "Fix auth token refresh bug" --type bug --priority 2
# -> unitAI-abc

# 2. Create chained child beads (create all upfront for clarity)
bd create --title "Explore: map token refresh code paths" --type task --priority 2
# -> unitAI-abc-exp
bd dep add abc-exp abc

bd create --title "Implement: fix token refresh retry on 401" --type task --priority 2
# -> unitAI-abc-impl
bd dep add abc-impl abc-exp

# 3. Wave 1 — Explorer
specialists run explorer --bead abc-exp --context-depth 2 --background
# -> Job started: e1f2g3
# Explorer output auto-appends to abc-exp notes (READ_ONLY behavior)
specialists result e1f2g3

# 4. [MERGE] Merge any worktree branches from Wave 1 into master
# READ_ONLY waves have no worktrees to merge

# 5. Wave 2 — Executor
specialists run executor --worktree --bead abc-impl --context-depth 2 --background
# -> Job started: a1b2c3
# Executor sees: abc-impl + abc-exp (with explorer notes) + abc via context-depth
# Executor self-appends output to abc-impl notes, closes abc-impl on completion

# 6. [MERGE] Merge impl worktree branch into master
sp merge abc-impl --rebuild

# 7. Wave 3 — Reviewer (no separate bead — uses --job + --prompt to enter executor's worktree)
specialists run reviewer --job a1b2c3 --keep-alive --background --prompt "Review the token refresh fix"
# -> Job started: r4v5w6
# Reviewer reads task bead from job a1b2c3's status.json automatically
# Reviewer auto-appends verdict to bead notes (READ_ONLY)
specialists result r4v5w6
# -> PASS: close task bead. PARTIAL/FAIL: go to step 8.

# 8. If PARTIAL — fix loop (same worktree, new child bead)
bd create --title "Fix: reviewer gaps on abc-impl" --type bug --priority 1
# -> unitAI-abc-fix
bd dep add abc-fix abc-impl

specialists run executor --bead abc-fix --job a1b2c3 --context-depth 2 --background
# Fixer runs in same worktree (via --job a1b2c3)
# Sees: abc-fix + abc-impl (executor output + reviewer verdict) + abc-exp via context-depth
# Repeat reviewer --job → fix loop until PASS

# 9. Close when reviewer says PASS
bd close abc --reason "Fixed: token refresh retries on 401. Reviewer PASS."
```

**Why chaining matters:**
- Every step's output preserved — full audit trail on each bead
- `--context-depth 2` gives each specialist previous step's findings automatically
- No copy-pasting results between steps
- orchestrator only creates beads dispatches — zero context injection

---

## --job, --worktree, and --epic Semantics

flags control **workspace isolation** **epic membership**. Executors run in isolated git worktrees so concurrent jobs don't corrupt shared files. Chains declare epic membership enable merge-gated publication.

| Flag | Semantics | Creates worktree? | Sets epic? |
|------|-----------|:----------------:|:----------:|
| `--worktree` | Provision a new isolated workspace; requires `--bead` | Yes | Inherited from bead.parent |
| `--job <id>` | Reuse the workspace of an existing job | No | Inherited from target job |
| `--epic <id>` | Explicitly declare epic membership | No | Yes (overrides default) |

`--worktree` `--job` **mutually exclusive**. Specifying both exits error.

### Epic membership

`--bead` used, chain defaults bead's parent epic ( parent epic-type bead). Override `--epic <id>`:

```bash
# Chain inherits bead.parent as epic
specialists run executor --worktree --bead unitAI-impl
# → epic_id = bead.parent (if epic-type)

# Explicit epic declaration (e.g., prep job with non-epic parent)
specialists run explorer --bead prep-task.1 --epic unitAI-3f7b
# → epic_id = unitAI-3f7b (explicit override)
```

**Why explicit --epic?** Prep jobs (explorer, planner, overthinker) often non-epic parents need belong epic `sp ps` grouping `sp epic status` visibility.

### `--worktree`

Provisions new git worktree + branch specialist run. Branch name derived
deterministically bead id: `feature/<beadId>-<specialist-slug>`.

```bash
specialists run executor --worktree --bead hgpu.3
# stderr: [worktree created: /repo/.worktrees/hgpu.3/hgpu.3-executor  branch: feature/hgpu.3-executor]
```

worktree already exists (interrupted run), it **reused**, not recreated.

### `--job <id>`

Reads `worktree_path` target job's `status.json` uses directory as `cwd`.
caller's own `--bead` remains authoritative — `--job` only selects workspace.

```bash
# Reviewer enters executor's worktree to review exactly what was written
specialists run reviewer --job 49adda --keep-alive --background

# Fix executor re-enters same worktree (--bead provides new fix bead, --job provides workspace)
specialists run executor --bead hgpu.3-fix --job 49adda --context-depth 2 --background
```

**Concurrency guard (MEDIUM/HIGH specialists):**

Blocked entering target job `starting` `running` — prevents concurrent file corruption.

| Target status | MEDIUM/HIGH | READ_ONLY/LOW |
|---------------|:-----------:|:-------------:|
| `starting` | ✗ Blocked | ✓ Allowed |
| `running` | ✗ Blocked | ✓ Allowed |
| `waiting` | ✓ Allowed | ✓ Allowed |
| `done`/`error`/`cancelled` | ✓ Allowed | ✓ Allowed |
| Unknown | ✗ Blocked (conservative) | ✓ Allowed |

**Bypass `--force-job`:**

```bash
specialists run executor --job 49adda --force-job --bead fix-123
```

Use caller explicitly accepts concurrent write risk (e.g., target job known stalled not yet terminal, emergency fix entry).

### When to use each flag

| Scenario | Flag to use |
|----------|------------|
| First executor run for a task | `--worktree --bead <impl-bead>` |
| Reviewer on executor's output | `--job <exec-job-id>` (no `--worktree`) |
| Fix executor after reviewer PARTIAL | `--bead <fix-bead> --job <exec-job-id>` |
| Force entry to blocked worktree | `--bead <fix-bead> --job <exec-job-id> --force-job` |
| Prep job belonging to epic (non-epic parent) | `--bead <prep-bead> --epic <epic-id>` |
| Explorer (READ_ONLY) | Neither — explorers don't need worktrees |
| Overthinker, planner, debugger | Neither — read-only and interactive specialists |

---

### Worktree write-boundary enforcement

Specialists running in worktrees **prevented writing outside their boundary**. session generates Pi extension hooks `tool_call` events blocks `edit`/`write`/`multiEdit`/`notebookEdit` tools absolute paths outside worktree.

**What's blocked:**
- `edit` `/absolute/path/outside/worktree/file.ts`
- `write` `/absolute/path/outside/worktree/new-file.ts`

**What's allowed:**
- Relative paths (`src/file.ts`) — resolve within worktree cwd
- Absolute paths inside worktree boundary

enforcement automatic `--worktree` used. No configuration required. extension fails generate (tmpdir permissions), warning logged session proceeds without protection.

---

## Dependency Mapping

Map bead dependencies match execution pipeline. dep graph wave plan.

### Simple bug fix
```
task → explore → impl
                  └── reviewer via --job (no own bead needed)
                  └── fix (if PARTIAL) → child of impl
```
```bash
bd dep add explore task
bd dep add impl explore
# reviewer: specialists run reviewer --job <impl-job>
# fix: bd dep add fix impl
```

### Complex feature (overthinker)
```
task → explore → design → impl → [reviewer via --job] → [fix if PARTIAL]
```
```bash
bd dep add explore task
bd dep add design explore
bd dep add impl design
# reviewer: specialists run reviewer --job <impl-job>
```

### Epic with N children
Each child gets its own explore → impl chain. Reviewer runs via `--job` per impl.
```
epic
  ├── child-1 → explore-1 → impl-1  (reviewer via --job impl-1-job)
  ├── child-2 → explore-2 → impl-2  (reviewer via --job impl-2-job)
  └── child-N → explore-N → impl-N  (reviewer via --job impl-N-job)
```
Children (chains) within same epic run **in parallel** they own disjoint files.

### Parallel chains (same stage)
Chains in same stage share no intra-stage dependencies. They depend on previous stage's output (same epic parent), not on each other.
```
# Stage 2 parallel executors (after shared Stage 1 explorer):
bd dep add impl-a explore   # impl-a depends on explore, NOT on impl-b
bd dep add impl-b explore   # impl-b depends on explore, NOT on impl-a
```
Each runs in its own `--worktree`. Merge via `sp epic merge <epic>` before Stage 3.

### Test beads (batched)
Tests **batched** — one test bead covers all impls in stage, not per-impl.
test bead depends on **all** impl beads it covers.
```
bd dep add tests impl-a
bd dep add tests impl-b
bd dep add tests impl-c
# specialists run test-runner --bead tests --context-depth 2
```

---

## Review and Fix Loop

review → fix loop mechanism iterative quality improvement within single worktree.

### Standard loop

```
1. Executor provisions --worktree, implements, enters waiting.
   -> Job: exec-job (KEEP ALIVE — do not stop)

2. Reviewer enters same worktree via --job exec-job.
   -> sp ps shows the chain:
      feature/unitAI-impl-executor · unitAI-impl
        ◐ exec-job   executor   waiting
        └ ◐ rev-job   reviewer   starting
   -> Auto-appends verdict (PASS/PARTIAL/FAIL) to bead notes.

3a. PASS:
    -> Resume executor: "Reviewer PASS. Commit your changes."
    -> Verify commit landed on branch (git log)
    -> Stop reviewer, then stop executor
    -> Merge via sp merge

3b. PARTIAL/FAIL:
    -> Resume the SAME executor: "Reviewer PARTIAL. Fix: <specific findings>"
    -> Executor retains full conversation context — no re-dispatch needed
    -> Executor applies fixes, enters waiting again
    -> Return to step 2 (new reviewer on same --job)

4. Repeat until PASS.
```

### Commands

```bash
# Step 1 — Executor with worktree (enters waiting after first turn)
specialists run executor --worktree --bead unitAI-impl --context-depth 2 --background
# -> Job started: exec-job (e.g. 49adda)
# DO NOT sp stop — executor stays alive for the entire review cycle

# Step 2 — Reviewer enters same worktree
specialists run reviewer --job 49adda --keep-alive --background --prompt "Review impl changes"
# -> Job started: rev-job
specialists result rev-job

# Step 3a — PASS: resume executor to commit, then stop both
specialists resume 49adda "Reviewer PASS. Git add and commit your changes."
# Wait for commit, verify with: git log feature/unitAI-impl-executor --oneline -1
specialists stop rev-job
specialists stop 49adda
sp merge unitAI-impl --rebuild

# Step 3b — PARTIAL: resume executor with fix instructions (same session, full context)
specialists resume 49adda "Reviewer PARTIAL. Fix: <paste specific findings here>"
# Executor applies fixes, enters waiting again
# Dispatch new reviewer:
specialists run reviewer --job 49adda --keep-alive --background --prompt "Re-review after fix"
# Repeat until PASS

# After final PASS + commit + stop:
bd close unitAI-task --reason "Reviewer PASS. All findings addressed."
```

### Why resume instead of re-dispatch

Resuming original executor/debugger **always preferred** over dispatching new fix executor:

- **Full context**: specialist remembers what it changed why — no re-discovery
- **No new bead needed**: no fix bead creation, no dep wiring overhead
- **Same worktree**: no `--job` coordination needed, it's already there
- **Cheaper**: one resumed turn vs full new specialist session context injection

Only dispatch new fix executor original specialist dead (crashed, stopped prematurely, context exhausted at >80%).

### Key invariants
- **Never stop executor/debugger before reviewer verdict.** specialist stays in `waiting` throughout review cycle. Stopping prematurely kills resume path risks uncommitted changes.
- **Executors no auto-commit.** After reviewer PASS, you must: resume executor explicit commit instructions. Verify commit landed before stopping.
- Each fix iteration uses `resume` on same specialist — not new child bead new executor.
- Multiple reviewer → resume → re-review cycles expected. worktree specialist session stable all cycles.
- Only stop after: (1) reviewer PASS, (2) executor committed, (3) commit verified on branch.

---

## Chain Lifecycle — Members Are Alive Until Merge

chain not worktree — it **living group specialists** sharing one workspace. All members chain alive (running waiting) until chain merged abandoned. Treat chain members as unit.

### Rules

1. **Never kill individual chain members prematurely.** chain include explorer, overthinker, executor, reviewer — all sharing one worktree via `--job`. no `sp stop` any member chain active, unless member crashed context-exhausted (>80%).
2. ** chain alive until merge.** first dispatch (even it's READ_ONLY explorer) reviewer PASS executor commit — chain one living unit. Members stay in `waiting` between turns.
3. **Resume, don't re-dispatch.** chain member needs act again (executor fixing reviewer findings, overthinker answering follow-ups), use `sp resume` on existing member. Only dispatch replacement original dead.
4. **Merge kills chain.** `sp merge` `sp epic merge` publishes chain's branch, all chain members become obsolete. *(Future: `sp merge` auto-stop all chain members on successful merge — no manual cleanup needed.)*
5. **Stop order matters (until auto-cleanup).** manually stopping chain members after merge: stop dependents first (reviewer), chain owner (executor/explorer). prevents race conditions resume paths.

### Chain member states

| Member state | Meaning | Action |
|-------------|---------|--------|
| `running` | Actively working | Wait or steer |
| `waiting` | Idle, retains full context | Resume when needed |
| `done` | Finished its turn, output appended | Leave alone — chain may still need it |
| `error` | Crashed or failed | May need replacement dispatch |

### What "don't kill" means in practice

```bash
# BAD — killing executor before review cycle completes
sp stop exec-job          # ✗ kills resume path, risks uncommitted work

# BAD — killing overthinker before executor uses its output
sp stop overthinker-job   # ✗ loses context if follow-up questions arise

# GOOD — chain completes naturally
sp resume exec-job "Reviewer PASS. Commit your changes."
# verify commit...
sp merge unitAI-impl      # publishes branch
# THEN stop members (future: auto-stopped by merge)
sp stop rev-job
sp stop exec-job
```

---

## Merge Protocol — Epic Publication

orchestrator owns merge timing, **no longer performs manual git merges**. Use `sp epic merge` `sp merge` instead.

### The canonical path: `sp epic merge <epic-id>`

** ONLY legal publication path wave-bound chains.**

epic merge-gated: all chains must: terminal reviewer PASS before publication. Use `sp epic merge` :

- Publishing multiple chains under one epic (topological order)
- Ensuring merge gates satisfied (no running jobs)
- PR mode (`--pr`) staged publication

```bash
# Check epic readiness
sp epic status unitAI-3f7b
# Shows: chains, blockers, readiness state, reviewer verdicts

# Publish all epic-owned chains
sp epic merge unitAI-3f7b
# → merges in topological order, tsc gate after each

# PR mode (creates PR instead of direct merge)
sp epic merge unitAI-3f7b --pr
```

**What `sp epic merge` :**

1. Reads epic state observability SQLite
2. Checks all chains terminal (`done`/`error`)
3. Verifies latest reviewer verdict PASS
4. Topologically sorts chains bead dependencies
5. each chain: `git merge <branch> --no-ff --no-edit`
6. Runs `bunx tsc --noEmit` after each merge
7. Optionally creates PR `--pr` flag
8. Updates epic state `merged` on success

### When NOT to merge: `sp merge <chain-root>` is blocked

**Standalone chains only.** `sp merge <chain-root-bead>` works ONLY chains NOT belonging unresolved epic:

```bash
# This FAILS if chain belongs to epic with status=open/resolving/merge_ready
sp merge unitAI-impl
# Error: Chain unitAI-impl belongs to unresolved epic unitAI-3f7b (status: resolving).
# Use 'sp epic merge unitAI-3f7b' to publish all chains together.
```

**Why guard exists:**

1. **Merge gates per-epic**: Publishing one chain without its siblings breaks wave model.
2. **Topological order matters**: Chain depend on Chain B — merging first breaks deps.
3. **Epics explicit**: epic bead ID tracked in SQLite, enabling guard.

### When to merge within a chain vs NOT

**no merge within chain.** chain sequence specialists sharing one worktree:
executor → reviewer → fix → re-review. worktree stays live throughout. No merge until
reviewer says PASS.

```
executor --worktree --bead impl     ← creates worktree
reviewer --job <exec-job>           ← enters same worktree (no merge)
executor --bead fix --job <exec-job> ← re-enters same worktree (no merge)
reviewer --job <exec-job>           ← re-enters same worktree (no merge)
PASS → NOW run sp epic merge <epic>
```

** merge between stages (via epic).** next stage's chains depend on stage's code existing on master, merge epic first. dep graph tells you: beads connected `--job` one chain (same worktree, no merge). Beads connected `bd dep add` different file scopes separate chains under same epic.

### Planning context upfront

Before dispatching any chains, identify:
- **Epics** — top merge-gated identity (create epic-type bead first)
- **Chains** — worktree lineages belong epic (use `--epic` prep jobs)
- **Stages** — batches independent chains ("Stage 1" / "Stage 2" orchestrator speech)

dep graph encodes . bead B depends on bead they touch different files, they're separate chains under same epic merge point between stages.

### Epic lifecycle commands

```bash
# List epics with state
sp epic list
sp epic list --unresolved   # show non-terminal epics

# Inspect one epic
sp epic status unitAI-3f7b
# Shows: persisted_state, readiness_state, chains[], blockers[], summary

# Transition states (manual)
sp epic resolve unitAI-3f7b   # open → resolving

# Publish
sp epic merge unitAI-3f7b     # merge_ready → merged
sp epic merge unitAI-3f7b --pr # PR mode
```

### Conflict handling

merge hits conflict:

1. Command fails list conflicting files
2. Resolve conflicts manually in your editor
3. Run `bunx tsc --noEmit` verify
4. Continue next chain ( re-run `sp epic merge <epic>` resume)

**Common conflict pattern:** Parallel chains in same stage both create same utility file (e.g. `job-root.ts`). expected — implementations must: identical. Keep one, delete duplicate during conflict resolution.

---

## Bead-First Workflow (`--bead` is the prompt)

tracked work, bead not bookkeeping — it specialist's prompt.
specialist reads:
- bead title + description
- bead notes (including output appended previous specialists in chain)
- parent/ancestor bead context (controlled `--context-depth`)

**Automatic context injection**: Runner injects ~3800 tokens project memory at spawn:
- `.xtrm/memory.md` (SSOT: no Repeat, How Project Works, Active Context)
- `bd prime` output (workflow rules + all bd memories dump)
- GitNexus cheatsheet ( `.gitnexus/meta.json` exists — ~100 tokens)

prevents specialists rediscovering known gotchas on every run.

`--prompt` `--bead` 't combined. you need give specialist
specific instructions beyond what's in bead description, update bead notes first:

```bash
bd update unitAI-abc --notes "INSTRUCTION: Rewrite docs/cli-reference.md from current
source. Read every command in src/cli/ and src/index.ts. Document all flags and examples."

specialists run executor --bead unitAI-abc --context-depth 2 --background
```

**`--context-depth N`** — how many levels parent-bead context inject (default: 1).
Use **`--context-depth 2`** all chained bead workflows. gives each specialist its
own bead + immediate predecessor's output + one more level context.

**`--no-beads`** — skip creating auto-tracking sub-bead, still reads `--bead` input.

**Edit gate access**: Specialists `--bead` automatically set `bead-claim:<id>` KV key,
enabling write access in worktrees without session-scoped claims. Cleared on run completion.

---

## Choosing the Right Specialist

Run `specialists list` see what's available. Match task type:

| Task type | Best specialist | Why |
|-----------|----------------|-----|
| Architecture exploration / initial discovery | **explorer** (claude-haiku) | Fast codebase mapping, READ_ONLY. Output auto-appends to bead. |
| Live docs / library lookup / code discovery | **researcher** (claude-haiku) | Targeted (ctx7/deepwiki) or discovery (ghgrep → deepwiki) modes. `--keep-alive`. |
| Bug fix / feature implementation | **executor** (gpt-codex) | HIGH perms, writes code, runs lint+tsc, closes beads. `interactive: true` by default — enters `waiting` after first turn, orchestrator must stop explicitly. |
| Bug investigation / "why is X broken" | **debugger** (claude-sonnet) | 4-phase debug-fix-verify cycle. HIGH perms, keep-alive. GitNexus-first. |
| Complex design / tradeoff analysis | **overthinker** (gpt-4) | 4-phase: analysis → devil's advocate → synthesis → conclusion. `--keep-alive`. |
| Code review / compliance | **reviewer** (claude-sonnet) | PASS/PARTIAL/FAIL verdict. Use via `--job <exec-job>`. `--keep-alive`. |
| Multi-backend review | **parallel-review** (claude-sonnet) | Concurrent review across multiple backends |
| Planning / scoping | **planner** (claude-sonnet) | Structured issue breakdown with deps |
| Doc audit / drift detection / targeted sync | **sync-docs** (qwen3.5-plus) | 3-mode: targeted (named docs), area (time-window), full audit. MEDIUM perms, `--keep-alive`. |
| Doc writing / updates | **executor** (gpt-codex) | For heavy doc rewrites; sync-docs handles targeted updates directly |
| Test generation / suite execution | **test-runner** (claude-haiku) | Runs suites, interprets failures |
| Specialist authoring | **specialists-creator** (claude-sonnet) | Guides JSON creation against schema |

### Specialist selection notes

- **executor no run tests** — it runs `lint + tsc` only. Tests belong reviewer test-runner phase.
- **executor enters `waiting` after first turn** — `interactive: true` now default. **Never stop executor before reviewer verdict.** Keep it alive so you : (1) resume fix instructions reviewer says PARTIAL, (2) resume "commit your changes" after reviewer PASS. Executors no auto-commit — you must: explicitly resume them commit. Only `sp stop` after commit verified on branch.
- **explorer** READ_ONLY — its output auto-appends input bead's notes. No implementation.
- **reviewer** best dispatched via `--job <exec-job> --prompt "..."` — it enters same worktree see exactly what written. `--job` alone not enough; `--prompt` `--bead` always required.
- **debugger** over **explorer** you need root cause analysis — GitNexus call-chain tracing, ranked hypotheses, evidence-backed remediation.
- **overthinker** before **executor** any non-trivial task — surfaces edge cases, challenges assumptions, produces solution direction. Cheap relative wrong implementation.
- **researcher** docs specialist — never look up library docs yourself, delegate researcher.
- **sync-docs** interactive — always `--keep-alive`, use `resume` approve/deny after audit.

### Example dispatches

```bash
specialists run explorer --bead unitAI-exp --context-depth 2 --background
specialists run researcher --bead unitAI-research --context-depth 2 --keep-alive --background
specialists run debugger --bead unitAI-bug --context-depth 2 --background
specialists run planner --bead unitAI-scope --context-depth 2 --background
specialists run overthinker --bead unitAI-design --context-depth 2 --keep-alive --background
specialists run executor --worktree --bead unitAI-impl --context-depth 2 --background
specialists run reviewer --job <exec-job-id> --keep-alive --background --prompt "Review the <feature> implementation"
specialists run sync-docs --bead unitAI-docs --context-depth 2 --keep-alive --background
specialists run test-runner --bead unitAI-tests --context-depth 2 --background
specialists run specialists-creator --bead unitAI-skill --context-depth 2 --background
```

### Overthinker-first pattern for complex tasks

```bash
# Full chain: task → explore → design → impl
bd create --title "Redesign auth middleware" --type feature --priority 2  # -> unitAI-task
bd create --title "Explore: map auth middleware" --type task --priority 2  # -> unitAI-exp
bd dep add exp task
bd create --title "Design: auth middleware approach" --type task --priority 2  # -> unitAI-design
bd dep add design exp
bd create --title "Implement: auth middleware redesign" --type task --priority 2  # -> unitAI-impl
bd dep add impl design

# Wave 1: Explorer
specialists run explorer --bead unitAI-exp --context-depth 2 --background
# (output auto-appends to exp notes)

# Wave 2: Overthinker (sees exp findings via context-depth)
specialists run overthinker --bead unitAI-design --context-depth 2 --keep-alive --background
# enters waiting after Phase 4

specialists resume <job-id> "What about the edge case where X?"
specialists resume <job-id> "Is option B safer than option A here?"
specialists stop <job-id>   # when satisfied
# (overthinker output is on unitAI-design notes)

# Wave 3: Executor (sees design + exp + task via context-depth — no manual wiring)
specialists run executor --worktree --bead unitAI-impl --context-depth 2 --background
```

### Monitoring with `sp ps` and `sp list --live`

Use `specialists ps` (alias `sp ps`) job monitoring instead manual JSON polling:

```bash
# Quick overview — all jobs
specialists ps
# Output: ID, status, specialist, elapsed, bead, [ctx%] badge

# Inspect specific job
specialists ps <job-id>
# Shows: full status, worktree path, chain, ctx% (context window utilization)

# The ctx% in `sp feed` and `sp ps` shows context window utilization:
# - 0-40% = OK (plenty of room)
# - 40-65% = MONITOR
# - 65-80% = WARN (▲ indicator shown)
# - >80% = CRITICAL (▲ indicator shown)
```

**Live tmux session selector (`sp list --live`):**

```bash
# Interactive selector for running/waiting tmux sessions
specialists list --live
# Shows: tmux session name, specialist, elapsed, status
# Arrow keys to select, Enter to attach

# Include dead sessions (PID or tmux gone)
specialists list --live --show-dead
# Dead sessions shown with 'dead' status instead of filtered out
```

Dead job detection (`is_dead`) computed at read time — never persisted avoid stale state. job dead :
- PID no longer exists (`kill -0 <pid>` fails)
- tmux session gone (`tmux has-session -t <name>` fails times out)

---

### Pi extensions and packages

Pi extensions global at `~/.pi/agent/extensions/`. Pi packages global npm installs.
Specialists run `--no-extensions` selectively re-enable:

- `quality-gates` — lint/typecheck enforcement (non-READ_ONLY only)
- `service-skills` — service catalog activation
- `pi-gitnexus` — call-chain tracing, blast radius analysis (resolved global npm)
- `pi-serena-tools` — token-efficient LSP reads/edits (resolved global npm)

gitnexus tools used during run, supervisor accumulates `gitnexus_summary`
in `run_complete` event: `files_touched`, `symbols_analyzed`, `highest_risk`,
`tool_invocations`.

---

## Steering and Resume

### Steer — redirect any running job

`steer` sends message running specialist. Delivered after current tool call
finishes, before next LLM call.

```bash
specialists steer a1b2c3 "STOP what you are doing. Focus only on supervisor.ts"
specialists steer a1b2c3 "Do NOT audit. Write the actual file to disk now."
```

### Resume — continue a keep-alive session

`resume` sends new prompt specialist in `waiting` state. Retains full conversation history.

**Specialists always use `--keep-alive`:**

| Specialist | Enters `waiting` after | What to send via `resume` |
|-----------|----------------------|--------------------------|
| **executor** | First turn completion (may be partial if bailed early) | "proceed, this is additive", "Reviewer PARTIAL. Fix: <findings>", or "Reviewer PASS. Git add and commit your changes." |
| **researcher** | Delivering research findings | Follow-up question, new angle, or "done, thanks" |
| **reviewer** | Delivering verdict (PASS/PARTIAL/FAIL) | Your response, clarification, or "accepted, close out" |
| **overthinker** | Phase 4 conclusion | Follow-up question, counter-argument, or "done, thanks" |
| **debugger** | Phase 3 fix attempt or Phase 4 verify result | Follow-up fix, "try different approach", "Reviewer PASS. Git add and commit your changes.", or "done" |
| **sync-docs** | Audit report or targeted update result | "approve", "deny", or specific instructions |

> **Warning:** job in `waiting` looks identical stalled job. **Always check `sp ps`
> before killing keep-alive job.**

> **Critical:** Never stop executor debugger before reviewer delivers its verdict.
> Stopping prematurely: (1) kills resume path fix loops, (2) risks uncommitted changes
> (executors don't auto-commit), (3) forces dispatching new specialist instead resuming.

```bash
# Check before stopping
specialists ps d4e5f6
# -> status: waiting  ← healthy, expecting input

specialists resume d4e5f6 "What about backward compatibility?"
specialists stop d4e5f6   # only when truly done iterating — after reviewer PASS + commit verified
```

---

## Chain and Epic Orchestration

multi-step work, dispatch chains under **epic**.

**chain** worktree lineage (executor → reviewer → fix → re-review). Chains within same epic run in parallel **only they independent** (disjoint file scopes). Stages strictly sequential: **never start Stage N+1 before Stage N completes merged via `sp epic merge`**.

### Chain rules

1. **Sequence between stages.** Prep (explorer/planner) → implementation chains → review → tests → doc sync.
2. **Parallelize only within stage.** Chains don't depend on each other run together.
3. **no overlap stages.** Wait every chain job, read results, update beads, merge epic.
4. **Bead deps encode pipeline.** dependency graph must: match stage order.
5. **`--context-depth 2` all chained runs.** Each specialist sees parent + predecessor.
6. **Merge via `sp epic merge` mandatory.** See Merge Protocol above.

### Polling chains

```bash
specialists ps                                # list all jobs — shows epic grouping, status, elapsed
specialists ps abc123                         # inspect specific job (full detail)
specialists ps --follow                       # live dashboard with epic grouping
```

`sp ps` shows epic-level grouping:

```
◆ epic:unitAI-3f7b · merge_ready · state:resolving · prep done=2/2 · chains pass=3/3
  prep:exp-1 · done
  prep:plan-2 · done
  chain:impl-a (reviewer PASS) · branch:feature/unitAI-impl-a-executor
  chain:impl-b (reviewer PASS) · branch:feature/unitAI-impl-b-executor
  chain:impl-c (reviewer PASS) · branch:feature/unitAI-impl-c-executor
```

stage complete every chain terminal you :
1. Read results: `specialists result <job-id>` each
2. Updated/closed beads as needed
3. Published via `sp epic merge <epic-id>`

### Canonical multi-stage example

```bash
# 0. Create epic bead (top merge-gated identity)
bd create --title "Add worktree isolation to executor" --type epic --priority 1
# -> unitAI-3f7b

# 1. Create prep and impl beads as children of the epic
bd create --title "Explore: map job run architecture" --type task --priority 2  # -> unitAI-exp
bd dep add exp 3f7b
bd create --title "Implement: worktree isolation" --type task --priority 2  # -> unitAI-impl
bd dep add impl exp
# Note: reviewer runs via --job, inherits epic from impl bead.parent

# Stage 1 — Explorer (prep job, declares epic explicitly)
specialists run explorer --bead unitAI-exp --epic unitAI-3f7b --context-depth 2 --background
# -> Job started: job1
specialists result job1

# [NO MERGE] Prep stage has no worktrees to merge

# Stage 2 — Executor (chain inherits epic from bead.parent)
specialists run executor --worktree --bead unitAI-impl --context-depth 2 --background
# -> Job started: job2  (worktree: .worktrees/unitAI-impl/unitAI-impl-executor)
# epic_id = bead.parent (unitAI-3f7b)
specialists result job2

# Stage 3 — Reviewer (uses --job, same worktree)
specialists run reviewer --job job2 --keep-alive --background --prompt "Review implementation"
# -> Job started: job3
specialists result job3
# PASS → ready for epic merge. PARTIAL → fix loop.

# Stage 4 — Fix loop (if PARTIAL)
bd create --title "Fix: reviewer gaps on impl" --type bug --priority 1  # -> unitAI-fix1
bd dep add fix1 impl
specialists run executor --bead fix1 --job job2 --context-depth 2 --background
# Re-review
specialists run reviewer --job job2 --keep-alive --background --prompt "Re-review after fix"

# [MERGE] Publish epic
sp epic status unitAI-3f7b  # verify readiness: merge_ready, all chains PASS
sp epic merge unitAI-3f7b --rebuild

# Close
bd close 3f7b --reason "Worktree isolation implemented. Reviewer PASS. Epic merged."
```

### Within-stage parallelism (multiple chains)

```bash
# Parallel executors — disjoint files, same parent epic
bd create --title "Implement: component A" --type task --priority 2  # -> unitAI-impl-a
bd dep add impl-a exp
bd create --title "Implement: component B" --type task --priority 2  # -> unitAI-impl-b
bd dep add impl-b exp

specialists run executor --worktree --bead unitAI-impl-a --context-depth 2 --background
specialists run executor --worktree --bead unitAI-impl-b --context-depth 2 --background
# Each runs in its own worktree, both belong to unitAI-3f7b (via bead.parent)

# Do NOT start next stage until BOTH complete AND epic is merged
sp epic merge unitAI-3f7b
```

---

## Coordinator Responsibilities

### 1. Route work — don't explore or implement yourself
Discovery goes **explorer** first; implementation goes **executor** only after discovery .

### 2. Validate combined output after each stage
```bash
npm run lint          # project quality gate
npx tsc --noEmit      # type check
git diff --stat       # review what changed
```

### 3. Handle failures — don't silently fall back
```bash
specialists feed <job-id>          # see what happened
specialists doctor                 # check for systemic issues
```

Options specialist fails:
- **Steer**: `specialists steer <id> "Focus on X instead"`
- **Switch**: e.g. sync-docs stalls → try executor
- **Stop report** user before doing it yourself

### 4. Merge via epic (CRITICAL)
See Merge Protocol above. Use `sp epic merge <epic-id>` — no exceptions.

### 5. Run drift detection after doc-heavy sessions
```bash
python3 .xtrm/skills/default/sync-docs/scripts/drift_detector.py scan --json
python3 .xtrm/skills/default/sync-docs/scripts/drift_detector.py update-sync <file>
```

---

## MCP Tools (Claude Code)

| Tool | Purpose |
|------|---------|
| `use_specialist` | Foreground run; pass `bead_id` for tracked work, get final output in conversation context |

MCP intentionally minimal. Use CLI orchestration, monitoring, steering, resume, cancellation.

---

## Known Issues

- **READ_ONLY output auto-appends** input bead after completion (via Supervisor). Output available via `specialists result`.
- **`--bead` `--prompt` conflict** design. tracked work, update bead notes: `bd update <id> --notes "INSTRUCTION: ..."` `--bead` only.
- **Job in `waiting` now shows magenta status** resume hint in `status`, WAIT banner in `feed`, resume footer in `result`. Always check before stopping keep-alive job.
- **Explorer (qwen) produce empty output** — model sometimes completes tool calls fails emit final text summary. bead notes empty. happens, either re-run different model investigation yourself.
- **`specialists init` requires xtrm** — `.xtrm/` directory `xt` CLI must: exist. Use `--no-xtrm-check` bypass in CI/testing.
- **`specialists doctor` now detects skill drift** — compares `config/skills/` hashes against `.xtrm/skills/default/` validates symlink chains.

---

## Troubleshooting

```bash
specialists doctor      # health check: hooks, MCP, zombie jobs, skill drift detection
specialists edit <name> # edit specialist config (dot-path, --preset)
specialists clean --processes  # kill stale/zombie specialist processes
```

- **RPC timeout on worktree job start** (30s, `command id=1`) → pi runs `npm install` in fresh
worktrees `.pi/settings.json` lists local packages. Root cause: worktree gets stale copy
`.pi/settings.json` branch point. Fix: ensure `.pi/settings.json`
`"packages": []` (packages global now). `provisionWorktree()` symlinks
`.pi/npm/node_modules` main repo's as safety net.
- **RPC timeout on non-worktree job** → check : (1) zombie vitest/tinypool processes
(`ps aux | grep vitest`, `kill`), (2) stale dist (`npm run build`),
(3) model provider issues (try different model isolate).
- **"specialist not found"** → `specialists list` (project-scope only)
- **Job hangs** → `specialists steer <id> "finish up"` `specialists stop <id>`
- **Config skipped** → stderr shows `[specialists] skipping <file>: <reason>`
- **Stall timeout** → specialist hit 120s inactivity. Check `specialists feed <id>`, retry switch.
- **`--prompt` `--bead` conflict** → use bead notes: `bd update <id> --notes "INSTRUCTION: ..."` `--bead` only.
- **Worktree already exists** → it reused (not recreated). Safe re-run.
- **`--job` fails: worktree_path missing** → target job not started `--worktree`. Use `--worktree` on next run.
- **`--job` without `--prompt` `--bead`** → reviewer/executor requires one . Use `--prompt "Review the X implementation"` `--job`.
- **Stale specialist processes** → SessionStart hook warns old binary versions. Run `specialists clean --processes` kill them all.
- **`specialists init` fails xtrm error** → xtrm must: installed first: `npm install -g xtrm-tools && xt install`. Use `--no-xtrm-check` in CI.
- **Skill drift detected doctor** → Run `specialists init --sync-skills` re-sync canonical skills `.xtrm/skills/default/` refresh active symlinks.

## Coverage Checklist
- [x] Hard Rules
- [x] When to Use This Skill
- [x] Canonical Workflow
- [x] Taxonomy: Job | Chain | Epic
- [x] Chained Bead Pipeline
- [x] --job, --worktree, and --epic Semantics
- [x] Dependency Mapping
- [x] Review and Fix Loop
- [x] Chain Lifecycle — Members Are Alive Until Merge
- [x] Merge Protocol — Epic Publication
- [x] Bead-First Workflow (`--bead` is the prompt)
- [x] Choosing the Right Specialist
- [x] Steering and Resume
- [x] Chain and Epic Orchestration
- [x] Coordinator Responsibilities
- [x] MCP Tools (Claude Code)
- [x] Known Issues
- [x] Troubleshooting

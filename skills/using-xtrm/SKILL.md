---
name: using-xtrm
description: >
  Behavioral operating manual for an xtrm-equipped Claude Code session.
  Covers when to use which tool, how to handle questions and triggers,
  workflow examples, and skill routing. Reference material (hook list,
  gate rules, full bd commands, git workflow) lives in CLAUDE.md.
  Injected automatically at session start via additionalSystemPrompt.
priority: high
---

# XTRM — When to Use What

> Gates, commands, and git workflow are in CLAUDE.md.
> This is the behavioral layer: triggers, patterns, examples.

## Session Start

```bash
bd prime                          # load workflow context + active claims
bv --robot-triage                 # graph-ranked picks, quick wins, unblock targets
bd update <id> --claim            # claim before any edit
```

> Use `bv --robot-next` for the single top pick. Use `bv --robot-triage --format toon` to save context tokens. **Never run bare `bv` — it launches an interactive TUI.**

### Worktree dependency setup

`xt claude` / `xt pi` sessions use clean git worktrees. Git does not copy ignored dependency artifacts such as `node_modules/`, `.venv/`, build caches, or generated outputs. If a repo's lint/tests need those files, run the repo's normal bootstrap inside the worktree (`make bootstrap`, `just setup`, `npm ci`, `uv sync`, etc.). Do not track dependency directories to make worktrees pass.

## Multi-pane coordination

Route orchestrators to `/multiplexing` and delegated panes to `/multiplexing-team`. A beaded `xtmux message-send` requires a reply unless it explicitly says `--expects-reply=false`.

For reply-required inbound work, preserve the SQLite `messageKey`, acknowledge receipt, then use `message-reply --in-reply-to <messageKey>`; ack or a target/bead-matched send does not fulfil it. If the reply must also wake a pane, use confirmed `safe-send-pointer --reply-to <messageKey>` so fulfilment happens only after injection succeeds.

SQLite owns obligations and waits across restarts. Recover with `obligations list`, `monitor-list`, and `message-status`; never create or delete runtime marker files. Runtime identities and ownership come from the invoking live tmux session/pane, not message text or caller-supplied metadata.

---

## Trigger Patterns

| Situation | Action |
|-----------|--------|
| "What should I work on?" | `bv --robot-triage` — ranked picks with dependency context |
| "What was I working on?" | `bd list --status=in_progress` |
| Unfamiliar area of code | `gitnexus_query({query: "concept"})` before opening any file |
| About to edit a symbol | `gitnexus_impact({target: "name", direction: "upstream"})` |
| Before `git commit` | `gitnexus_detect_changes({scope: "staged"})` to verify scope |
| Coordinating tmux panes or handling a reply-required xtmux message | `/multiplexing` (or `/multiplexing-team` when delegated); preserve and correlate the returned `messageKey` |
| Reading code | `get_symbols_overview` → `find_symbol` — never read whole files |
| Task is tests | use /test-planning
| Task is docs updates | use /sync-docs

---

## Workflow Examples

**Fixing a bug:**
```bash
bd ready                                                        # find the issue
bd update bd-xyz --claim                                        # claim it
gitnexus_impact({target: "parseComposeServices", direction: "upstream"})
# → 2 callers, LOW risk — safe to edit
get_symbols_overview("hooks/init.ts")                           # map file
find_symbol("parseComposeServices", include_body=True)          # read just this
replace_symbol_body("parseComposeServices", newBody)            # Serena edit
bd close bd-xyz --reason="Fix YAML parse edge case"            # close issue
xt end                                                         # push, PR, merge, cleanup
```

**Exploring unfamiliar code:**
```bash
gitnexus_query({query: "session claim enforcement"})
# → beads-gate-core.mjs, resolveClaimAndWorkState, decideCommitGate
gitnexus_context({name: "resolveClaimAndWorkState"})            # callers + callees
get_symbols_overview("hooks/beads-gate-core.mjs")               # map the file
find_symbol("resolveClaimAndWorkState", include_body=True)      # read only this
```

---

## PR / branch / restart audit primitives

`xt worktree` exposes durable PR drift, branch GC, and restart audit primitives that downstream agents (Mercury devops collaborator, specialists orchestrators) compose instead of reimplementing inline `gh`/`git` bash.

| Command | Use when | Composes with |
|---|---|---|
| `xt worktree audit-prs [--json]` | You want a structured report of every xt worktree's PR merge-state (`clean` / `needs-rebase` / `conflicted` / `blocked` / `stale` / `unknown`) without modifying branches | Specialists `doctor --pr-drift` consumes the same `gh pr view` shape; `sp ps --needs-attention` filters jobs whose PR is non-clean |
| `xt worktree branch-gc [--prefix xt/] [--apply --yes] [--json]` | Stale `feature/<bead>-executor\|debugger\|reviewer` or `xt/*` branches need cleanup after merge; default is dry-run, `--apply` deletes only merged/closed PR branches | Run after `/xt-end` / `/xt-merge` to drop the merged branch trail; pairs with specialists chain-cleanup after reviewer PASS |
| `xt worktree restart-audit [--prefix xt/] [--json]` | Container/host restarted; you need a startup/cron-safe audit of orphaned worktree dirs, branch/worktree drift, and PR-attention candidates | Pairs with specialists `doctor --reap-dead-jobs` — worktree-side orphans (this) + job-side orphans (specialists) cover both axes of a restart-recovery sweep |

Safety: all three are read-only by default. `branch-gc` requires explicit `--apply --yes` to delete. Auto-rebase / force-push is never performed — conflict states are reported, never hand-resolved.

`--json` output on all three includes structured fields (repo, branch, pr_url/pr_number, merge_state, action, outcome, duration_ms, redacted error) so cron and Mercury infra can consume them without parsing human output.

---

## Prompt Shaping (silent, before every non-trivial task)

| Task type | Apply |
|-----------|-------|
| `analyze / investigate / why` | `<thinking>` block + structured `<outputs>` |
| `implement / build / fix` | 1-2 `<example>` blocks + `<constraints>` |
| `refactor / simplify` | `<constraints>` (preserve behavior, tests pass) + `<current_state>` |

Vague prompt (under 8 words, no specifics)? Ask one clarifying question before proceeding.

---

## Skill Routing

| Need | Use |
|------|-----|
| Code read / edit | Serena — `get_symbols_overview` → `find_symbol` → `replace_symbol_body` |
| Blast radius before edit | `gitnexus-impact-analysis` |
| Navigate unfamiliar code | `gitnexus-exploring` |
| Trace a bug | `gitnexus-debugging` |
| Safe rename / refactor | `gitnexus-refactoring` |
| Docs maintenance | `sync-docs` |
| Docker service project | `using-service-skills` |
| Build / improve a skill | `skill-creator` |
| Orchestrate tmux panes / answer correlated requests | `multiplexing` / `multiplexing-team` |

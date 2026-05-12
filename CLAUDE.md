# OpenWolf

@.wolf/OPENWOLF.md

This project uses OpenWolf for context management. Read and follow .wolf/OPENWOLF.md every session. Check .wolf/cerebrum.md before generating code. Check .wolf/anatomy.md before reading files.


<!-- XTRM-MANAGED:bd-workflow start v=1.0.0 -->
# XTRM Agent Workflow

> Full reference: [XTRM-GUIDE.md](XTRM-GUIDE.md) | Session manual: `/using-xtrm` skill
> Run `bd prime` at session start (or after `/compact`) for live beads workflow context.

## Session Start

1. `bd prime` — load workflow context and active claims
2. `bd memories <keyword>` — retrieve memories relevant to today's task
3. `bd recall <key>` — retrieve a specific memory by key if needed
4. `bv --robot-triage` — graph-aware triage: ranked picks, unblock targets, project health
5. `bd update <id> --claim` — claim before any file edit

## Execution Interaction Policy

- Proceed by default on standard implementation tasks once scope is clear.
- Do **not** ask repetitive “Proceed? Yes/No” confirmations.
- Ask for confirmation only when actions are destructive, irreversible, or high-risk (e.g. `rm`, history rewrite, mass deletes, credential rotation, prod-impacting ops).
- Prefer concise clarifying questions only when requirements are genuinely ambiguous.

## Active Gates (hooks enforce these — not optional)

| Gate | Trigger | Required action |
|------|---------|-----------------|
| **Edit** | Write/Edit without active claim | `bd update <id> --claim` |
| **Commit** | `git commit` while claim is open | `bd close <id>` first, then commit |
| **Stop** | Session end with unclosed claim | `bd close <id>` |
| **Memory** | `bd close <id>` without issue ack | First run `bd remember "<insight>"` (or decide nothing novel), then `bd kv set "memory-acked:<id>" "saved:<key>"` or `"nothing novel:<reason>"`, then retry `bd close <id> --reason="..."` (Stop hook remains fallback reminder) |

## bd Command Reference

```bash
# Work discovery
bd ready                               # Unblocked open issues
bd show <id>                           # Full detail + deps + blockers
bd list --status=in_progress           # Your active claims
bd query "status=in_progress AND assignee=me"  # Complex filter
bd search <text>                       # Full-text search across issues

# Claiming & updating
bd update <id> --claim                 # Claim (sets you as owner, status→in_progress)
bd update <id> --notes "..."           # Append notes inline
bd update <id> --status=blocked        # Mark blocked
bd update                              # Update last-touched issue (no ID needed)

# Creating
bd create --title="..." --description="..." --type=task --priority=2
# --parent <epic-id>                   epic child: auto-names `.1`, `.2`, … and adds parent edge
# --deps "discovered-from:<parent-id>"  link follow-ups to source
# priority: 0=critical  1=high  2=medium  3=low  4=backlog
# types: task | bug | feature | epic | chore | decision

# Closing
# Memory gate: ack per issue before close
#   bd kv set "memory-acked:<id>" "saved:<key>"  OR  "nothing novel:<reason>"
bd close <id>                          # Close issue (blocked until memory-acked:<id> exists)
bd close <id> --reason="Done: ..."     # Close with context
bd close <id1> <id2> <id3>            # Batch close (each id needs its own memory ack)

# Dependencies
bd dep add <issue> <depends-on>        # issue depends on depends-on (depends-on blocks issue)
bd dep <blocker> --blocks <blocked>    # shorthand: blocker blocks blocked
bd dep relate <a> <b>                  # non-blocking "relates to" link
bd dep tree <id>                       # visualise dependency tree
bd blocked                             # show all currently blocked issues

# Persistent memory
bd remember "<insight>"                # Store across sessions (project-scoped)
bd memories <keyword>                  # Search stored memories
bd recall <key>                        # Retrieve full memory by key
bd forget <key>                        # Remove a memory

# Health & pre-flight
bd stats                               # Open/closed/blocked counts
bd preflight --check                   # Pre-PR readiness (lint, tests, beads)
bd doctor                              # Diagnose installation issues
```

## Git Workflow (strict: one branch per issue)

```bash
git checkout -b feature/<issue-id>-<slug>   # or fix/... chore/...
bd update <id> --claim                       # claim before any edit
# ... write code ...
bd close <id> --reason="..."                 # closes issue
xt end                                       # push, PR, merge, worktree cleanup
```

**Never** continue new work on a previously used branch.

## bv — Graph-Aware Triage

bv is a graph-aware triage engine for the beads issue board. Use it instead of `bd ready` when you need ranked picks, dependency-aware scheduling, or project health signals.

> **CRITICAL: Use ONLY `--robot-*` flags. Bare `bv` launches an interactive TUI that blocks your session.**

```bash
bv --robot-triage             # THE entry point — ranked picks, quick wins, blockers, health
bv --robot-next               # Single top pick + claim command (minimal output)
bv --robot-triage --format toon  # Token-optimized output for lower context usage
```

**Scope boundary:** bv = *what to work on*. `bd` = creating, claiming, closing issues.

| Command | Returns |
|---------|---------|
| `--robot-plan` | Parallel execution tracks with unblocks lists |
| `--robot-insights` | PageRank, betweenness, HITS, cycles, critical path |
| `--robot-forecast <id\|all>` | ETA predictions with dependency-aware scheduling |
| `--robot-alerts` | Stale issues, blocking cascades, priority mismatches |
| `--robot-diff --diff-since <ref>` | Changes since ref: new/closed/modified |

```bash
bv --recipe actionable --robot-plan    # Pre-filter: ready to work
bv --robot-triage --robot-triage-by-track  # Group by parallel work streams
bv --robot-triage | jq '.quick_ref'   # At-a-glance summary
bv --robot-insights | jq '.Cycles'    # Circular deps — must fix
```

## Code Intelligence (mandatory before edits)

Use **Serena** (`using-serena-lsp` skill) for all code reads and edits:
- `find_symbol` → `get_symbols_overview` → `replace_symbol_body`
- Never grep-read-sed when symbolic tools are available

Use **GitNexus** MCP tools before touching any symbol:
- `gitnexus_impact({target: "symbolName", direction: "upstream"})` — blast radius
- `gitnexus_context({name: "symbolName"})` — callers, callees, execution flows
- `gitnexus_detect_changes()` — verify scope before every commit
- `gitnexus_query({query: "concept"})` — explore unfamiliar areas

Stop and warn the user if impact returns HIGH or CRITICAL risk.

## Quality Gates (automatic)

Run on every file edit via PostToolUse hooks:
- **TypeScript/JS**: ESLint + tsc
- **Python**: ruff + mypy

Gate output appears as hook context. Fix failures before proceeding — do not commit with lint errors.

## Worktree Sessions

- `xt claude` — launch Claude Code in a sandboxed worktree
- `xt end` — close session: commit / push / PR / cleanup
<!-- XTRM-MANAGED:bd-workflow end -->

<!-- XTRM-MANAGED:sp-workflow start v=1.0.0 -->
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
<!-- XTRM-MANAGED:sp-workflow end -->

<!-- XTRM-MANAGED:agent-pitfalls start v=1.0.0 -->
## Common Pitfalls

Rules learned the hard way across recent sessions. Each entry: short rule, why it matters, paste-ready command.

- **Use `bd create --parent <epic-id>` for epic children.** Auto-names children `.1`, `.2`, … and adds the parent edge. Without it, children float orphaned and don't appear under `bd dep tree <epic>`.
  ```bash
  bd create --parent unitAI-abc12 --title "..." --type task --priority 2
  ```

- **Memory gate must ack BEFORE `bd close`.** `bd close` is blocked until `memory-acked:<id>` exists. Run `bd remember` (or decide nothing novel), then set the kv, then close. Each id in a batch needs its own ack.
  ```bash
  bd remember "<insight>"                                  # if novel
  bd kv set "memory-acked:<id>" "saved:<key>"              # OR "nothing novel:<reason>"
  bd close <id> --reason="..."
  ```

- **Never run bare `bv` — it opens a TUI and blocks the session.** Always use `--robot-*` flags.
  ```bash
  bv --robot-triage --format toon
  bv --robot-next
  ```

- **`sp stop` cleans `status.json`; `sp merge` then fails to resolve the chain.** Known limitation (unitAI-ofjvj, P0). For doc-only chains, fall back to manual merge — but accept that `tsc` and conflict-reporting gates are skipped.
  ```bash
  git merge --no-ff feature/<branch> -m "Merge feature/<branch>"
  ```

- **`--worktree` and `--job` are mutually exclusive.** Use `--worktree` for the first executor; use `--job <exec-job>` for reviewer and fix passes — it reuses the workspace instead of provisioning a new one.
  ```bash
  sp run executor --worktree --bead <impl> --background
  sp run reviewer --bead <review> --job <exec-job> --keep-alive --background
  ```

- **`--keep-alive` is required for resumable specialists.** Without it, reviewer/overthinker terminate after one turn and `sp resume` has nothing to attach to.
  ```bash
  sp run reviewer --bead <id> --job <exec-job> --keep-alive --background
  sp resume <job-id> "Reviewer PARTIAL. Fix only ..."
  ```

- **`--context-depth` default is 3, not 1.** Chained specialists see own bead + predecessor + parent task. Reduce only with cause.
  ```bash
  sp run executor --bead <id> --context-depth 2 --background    # explicit override
  ```

- **`bd query` for SQL-like compound filters.** Beyond `bd ready` / `bd list`, use `bd query` for predicates.
  ```bash
  bd query "status=in_progress AND assignee=me"
  bd query "type=bug AND priority<=1 AND status=open"
  ```

- **`bd dep <blocker> --blocks <blocked>` is the reverse-direction shorthand of `bd dep add`.** `bd dep add A B` ⇒ A depends on B. `bd dep B --blocks A` is the same edge in blocker-first phrasing. Use `bd dep relate` for non-blocking "see also" links.
  ```bash
  bd dep add child parent              # child depends on parent
  bd dep parent --blocks child         # same edge, blocker-first phrasing
  bd dep relate <a> <b>                # non-blocking link
  ```

- **Per-turn output auto-appends to bead notes for ALL specialists** (not just READ_ONLY). `bd show <bead-id>` reveals the full handoff with `[WAITING]` / `[DONE]` headers — read it before resuming, no need to scrape `sp result`.
  ```bash
  bd show <bead-id>                    # full transcript
  ```

- **GitNexus index goes stale on commit. Preserve embeddings explicitly when reanalyzing.** Running `npx gitnexus analyze` without `--embeddings` deletes any embeddings.
  ```bash
  jq '.stats.embeddings' .gitnexus/meta.json    # 0 = none
  npx gitnexus analyze --embeddings             # only if embeddings exist
  ```

- **`sp poll` is deprecated.** Use `sp ps` for state and `sp feed` for streams. `sp result <job-id>` works on waiting jobs and returns the last completed turn with a `sp resume` footer.
  ```bash
  sp ps                                # live job snapshot
  sp ps <job-id>                       # one job
  sp feed <job-id>                     # stream events for one job
  sp feed -f                           # follow all
  sp result <job-id>                   # last turn (works on waiting jobs)
  ```
<!-- XTRM-MANAGED:agent-pitfalls end -->

# Claude Code Guide for Jaggers Agent Tools

## Architecture
- **Skills**: canonical install payload is in `.xtrm/skills/default/`.
- **Hooks**: canonical install payload is in `.xtrm/hooks/`.
- **Config**: canonical install payload is in `.xtrm/config/` (`hooks.json`, `settings.json`).
- **CLI**: stored in `cli/`. Node.js tool for installation and sync.
- **Documentation**: stored in `docs/` and `.serena/memories/` (SSOT).

## CI/CD
- **GitHub Actions**: Workflows in `.github/workflows/ci.yml`.
- **Validation**:
  - `npm run lint`: Lint Node.js (Eslint) and Python (Ruff).
  - `npm test`: Run global test suite.
  - `pytest skills/documenting/tests`: Run documenting skill tests.

## Development Environment
- **Runtime**: Node.js (CLI), Python 3.8+ (Hooks/Scripts)
- **Dependencies**:
  - CLI: `npm install` in `cli/`
  - Python: Standard library only (no external deps for hooks)

## Specialist Bash Tools
- `ghgrep` — GitHub code search CLI wrapper for `mcp.grep.app` (SSE transport).
  - Example: `ghgrep "useEffect(" --lang TSX,TypeScript --limit 5`
  - Use `--json` for raw MCP payloads.

## Claude hook wiring model
- `xt install` / `xt claude install` reads `.xtrm/config/hooks.json`.
- Hook commands are written to `.claude/settings.json` as absolute `node "<project>/.xtrm/hooks/<script>.mjs"` entries.
- Existing Claude settings are merged; the `hooks` section is replaced from `.xtrm/config/hooks.json`.
- Do not use plugin marketplace or plugin cache paths for xtrm runtime wiring.

## Key Files & Directories
- `cli/lib/sync.js`: Logic for syncing/backporting configurations. Includes dynamic path resolution for hardcoded repo paths.
- `cli/lib/transform-gemini.js`: Logic for transforming Claude config to Gemini.
- `skills/orchestrating-agents/`: Multi-agent orchestration skill with parameter support.
  - `SKILL.md`: Skill definition with `gemini-args` for workflow type selection.
  - `references/handover-protocol.md`: CLI resume flags (Gemini: `-r latest`, Qwen: `-c`).
  - `references/workflows.md`: Multi-turn workflow protocols (Collaborative, Adversarial, Troubleshoot).

## Gemini Support
- The CLI automatically detects `~/.gemini` environments.
- **Slash Commands**: Specialized commands available: `/orchestrate`, `/delegate`, `/document`, `/prompt`.
  - `/orchestrate` supports workflow parameters: `/orchestrate [collaborative|adversarial|troubleshoot|handshake] "task"`
- **Command Sync**: Syncs custom slash commands from `.gemini/commands/`.
- **Auto-Command Generation**: Automatically transforms `SKILL.md` into Gemini `.toml` command files during sync.
  - Supports `gemini-args` for parameterized commands with choice/string types.
- **Path Resolution**: Fixes hardcoded paths in `settings.json` templates by dynamically resolving them to the user's target installation directory.
- `settings.json` is dynamically transformed for Gemini compatibility:
  - Event names mapped (UserPromptSubmit -> BeforeAgent)
  - Paths rewritten to target directory
  - Unsupported fields filtered out

### Multi-Agent CLI Flags
- **Gemini**: Use `-r latest` or `-r <index>` to resume sessions (not `--resume`)
- **Qwen**: Use `-c` or `--continue` to resume most recent session

### Documentation
- `export PYTHONPATH=$PYTHONPATH:$(pwd)/skills/documenting && python3 skills/documenting/scripts/orchestrator.py . feature "desc" --scope=skills --category=docs`
- `python3 skills/documenting/scripts/generate_template.py` - Create memory

<!-- XTRM-MANAGED:gitnexus-workflow start v=1.0.0 -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **xtrm-tools**. Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/xtrm-tools/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/xtrm-tools/context` | Codebase overview, check index freshness |
| `gitnexus://repo/xtrm-tools/clusters` | All functional areas |
| `gitnexus://repo/xtrm-tools/processes` | All execution flows |
| `gitnexus://repo/xtrm-tools/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |
<!-- XTRM-MANAGED:gitnexus-workflow end -->

<!-- specialists:start -->
## Specialists Workflow

> Injected by `specialists init`. Keep this section — agents use it for context.

### When to use specialists

Specialists are autonomous AI agents optimized for heavy tasks: code review, bug analysis, test generation, architecture design. Use them instead of doing the work yourself when the task benefits from specialist focus.

### Tracked vs ad-hoc work

**Tracked work (primary workflow):**
- Use `--bead <id>` when the specialist is executing a tracked work item.
- The bead is the prompt source.
- The orchestrator owns the bead lifecycle.

**Ad-hoc work:**
- Use `--prompt "..."` for quick, untracked runs.
- No bead is created or linked.

### Canonical workflow

**1. Create or identify the bead first**

The bead is the work unit. Always start from bd when work should be tracked.

```bash
bd create "Investigate X" -t task -p 1 --json
```

- Use an existing bead ID if the work item already exists.
- The bead represents a single unit of tracked work in your issue tracker.

**2. Model dependencies in bd**

If this task depends on earlier work, add blocker relationships. The dependency graph powers automatic context injection.

```bash
bd dep add <this-bead-id> <blocker-bead-id>
```

- Blockers must be completed before context is injected.
- Context injection depth is controlled via --context-depth.

**3. Run the specialist with the bead as input**

Use --bead to attach the specialist run to a tracked work item.

```bash
specialists run <name> --bead <id>
```

```bash
specialists run <name> --bead <id> --background
```

- With --bead, the bead is the prompt source.
- The runner does not create a second bead.
- The orchestrator/bead owner keeps lifecycle ownership.

**4. Observe the run**

Track progress and retrieve results.

```bash
specialists feed <job-id>
```

```bash
specialists feed -f
```

```bash
specialists status
```

```bash
specialists result <job-id>
```

- Use feed -f for live global follow across all jobs.
- status shows system health and active jobs.

**5. Close or update the bead in the orchestrator layer**

The orchestrator owns the bead lifecycle when using --bead.

```bash
bd close <id> --reason "Completed"
```

- The specialist does not close beads it did not create.
- Internally this is the ownsBead = false path.

### --context-depth

Controls how many levels of completed blockers are injected as context when using --bead. Default: 1.

- **depth=0**: No dependency context injection. Only the bead itself is used.
- **depth=1**: Inject immediate completed blockers only. This is the default.
- **depth=2**: Inject completed blockers and their completed blockers.
- **depth=N**: Walk N levels up the blocker chain.

### --no-beads

Suppresses creating/tracking a new bead for the run.

- --no-beads does NOT disable bead reading.
- If --bead <id> is provided, the bead is still read and used as the prompt source.
- --no-beads only affects whether the specialist creates a new tracking bead.

### Orchestrator-owned bead lifecycle

When using --bead <id>, the specialist run uses an existing bead owned by the orchestrator.

- The bead is the prompt source.
- The runner does NOT create a second bead.
- The runner does NOT close the bead on completion.
- The orchestrator (bd layer) is responsible for closing/updating the bead.

### Key commands

```bash
specialists init                    # Bootstrap project
specialists run <name> --bead <id>  # Tracked work
specialists run <name> --prompt "..."  # Ad-hoc work
specialists feed -f                 # Follow all jobs
specialists status                  # System health
specialists list                    # Available specialists
```

<!-- specialists:end -->

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **xtrm-tools**. Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/xtrm-tools/context` | Codebase overview, check index freshness |
| `gitnexus://repo/xtrm-tools/clusters` | All functional areas |
| `gitnexus://repo/xtrm-tools/processes` | All execution flows |
| `gitnexus://repo/xtrm-tools/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

# XTRM-Tools

**xtrm** (`xt`) is an agentic workflow system that turns Claude Code and Pi into disciplined, self-managing development agents. Every session is structured, every change is tracked, and every agent knows exactly what to do next.

### Beads — issue tracking built for agents

[Beads](https://github.com/Jaggerxtrm/beads) is a Dolt-backed issue tracker designed for agentic workflows. Issues are first-class citizens: agents claim them before editing, close them before committing, and carry context forward across sessions and machines via persistent memory. The full `bd` CLI is available inside every session — `bd ready`, `bd update <id> --claim`, `bd close <id>`, `bd remember`.

### Hooks — enforcement gates that run automatically

A policy compiler produces hooks for both Claude Code and Pi from a single source. These gates enforce the workflow without relying on the agent to remember: the **Edit gate** blocks writes without an active claim, the **Commit gate** blocks `git commit` until the issue is closed, the **Stop gate** checks for unclosed work at session end, and the **Memory gate** prompts the agent to persist insights before exiting. Quality gates run ESLint, tsc, ruff, and mypy automatically on every file save.

### Skills — reusable agent behaviors

A library of composable skills covers the full development lifecycle: session management (`using-xtrm`), structured planning (`planning`), test coverage strategy (`test-planning`), autonomous session close (`xt-end`), PR queue management (`xt-merge`), documentation maintenance (`documenting`), and domain expertise (backend, devops, security, data science). Skills are injected into the agent context on demand and work identically in Claude Code and Pi.

### Planning mode

The `planning` skill generates a structured issue board from any spec or idea — epics, tasks, dependencies, test coverage annotations — using `bd create` in parallel. Agents can pick up and continue planned work across sessions with full context. GitNexus impact analysis and Serena code intelligence are integrated into the planning flow so blast radius is assessed before a single line is written.

### Statusline

A live statusline renders in every Claude Code session: active claim, open issue count, model, context window health (color-coded truecolor gradient), and token usage — all in a single line below the prompt. No configuration required after `xtrm init`.

### Specialists *(upcoming)*

Native integration with the [specialists](https://github.com/Jaggerxtrm/specialists) framework — spawning purpose-built sub-agents for parallel workloads, code review, and long-running background tasks directly from within a session.

---

**Version 0.7.1** | [Complete Guide](XTRM-GUIDE.md) | [Changelog](CHANGELOG.md)

---

## Documentation

| Doc | Contents |
|-----|----------|
| [XTRM-GUIDE.md](XTRM-GUIDE.md) | Complete reference — architecture, concepts, full workflow |
| [docs/hooks.md](docs/hooks.md) | All hooks — event wiring, gate logic, order, authoring |
| [docs/policies.md](docs/policies.md) | Policy system — compiler, schema, Claude/Pi parity |
| [docs/skills.md](docs/skills.md) | Skills catalog — all skills, categories, how they load |
| [docs/pi-extensions.md](docs/pi-extensions.md) | Pi extensions — managed sync, authoring, parity notes |
| [docs/worktrees.md](docs/worktrees.md) | xt worktrees — `xt claude/pi`, `xt attach`, `xt end`, isolation model |
| [docs/mcp-servers.md](docs/mcp-servers.md) | MCP servers — gitnexus, github-grep, deepwiki, official plugins |
| [docs/bash-tools.md](docs/bash-tools.md) | Bash-native specialist CLIs — ghgrep, ctx7, deepwiki |
| [docs/cli-architecture.md](docs/cli-architecture.md) | CLI internals — install flow, diff/sync engine, config merge |
| [docs/docs-commands.md](docs/docs-commands.md) | Docs command suite — `show`, `list`, `cross-check`, output modes, drift checks |
| [docs/project-skills.md](docs/project-skills.md) | Legacy project-skill migration notes and current asset location |
| [docs/cat-b-distribution.md](docs/cat-b-distribution.md) | Cat B distribution ownership, migration policy, Windows stance |
| [docs/testing.md](docs/testing.md) | Live testing checklist — integration, gates, worktree flows |
| [CHANGELOG.md](CHANGELOG.md) | Full version history |

---

## Quick Start

```bash
# Install globally (one-time)
npm install -g github:Jaggerxtrm/xtrm-tools@latest

# Set up xtrm in your project
xtrm init

# Verify
claude plugin list
# → xtrm-tools@xtrm-tools  Version: 0.7.1  Status: enabled
```

**One-line run:**
```bash
npx -y github:Jaggerxtrm/xtrm-tools init
```

**Typical workflow after install:**
```bash
# Start a sandboxed session in a worktree
xt claude my-feature

# Publish that worktree: rebase, push, open PR, optional cleanup
xt end

# Refresh project memory from bd memories + current repo state
xt memory update

# If multiple xt/* PRs are open, drain the merge queue oldest-first
xt merge
```

`xt end` handles one worktree session at a time. `xt merge` is the follow-up queue operator: it inspects open `xt/*` PRs, processes them FIFO, waits for green CI on the oldest PR, merges it with `--rebase`, then rebases the remaining queued xt branches and repeats. `xt memory update` shells out to the `memory-processor` specialist, which condenses bd memories and current project state into `.xtrm/memory.md`; use `--dry-run` to inspect without writing.

---

## What's Included

### Core Enforcement

| Component | Runtime | Purpose |
|-----------|---------|---------|
| **Beads Gates** | both | Issue tracking — edit/commit/stop gates, memory prompts |
| **Session Flow** | both | Claim sync, stop gate, `xt end` reminder in worktrees |
| **Quality Gates** | both | Auto linting (ESLint, tsc, ruff, mypy) on file edits |
| **GitNexus** | Claude | Knowledge graph context for code exploration |
| **Service Skills** | Pi | Territory-based Docker service skill activation |

### Privacy & Telemetry

**xtrm-tools does not collect any telemetry or analytics.** No usage data, no codebase scanning, no phone-home behavior. All operations run locally in your environment.


### Skills

Skills are resolved through a three-tier registry in `.xtrm/skills/` (`default` + `optional` + `user`). Optional packs are installed by default during `xt install`; activate any pack with `xt skills enable <pack>`. Current optional pack catalog: `research-methods`, `code-quality`, `security-ops`, `data-engineering`, and `architecture-design`.

Skills are organized into two categories: **xtrm workflow** skills built specifically for the xtrm stack, and **general-purpose** expert skills that work in any project.

#### xtrm Workflow Skills

These skills implement the xtrm-specific development workflow — session management, issue tracking, planning, quality, and documentation patterns.

| Skill | Purpose |
|-------|---------|
| `using-xtrm` | Session operating manual — when to use which tool |
| `using-quality-gates` | Quality gate workflow — TDD guard, lint/typecheck cycle |
| `using-serena-lsp` | Code exploration and surgical edits via Serena LSP |
| `using-tdd` | Test-driven development with 80%+ coverage enforcement |
| `using-service-skills` | Service catalog discovery and expert persona activation |
| `xt-end` | Autonomous session close — rebase, push, PR, cleanup |
| `xt-merge` | FIFO PR merge queue for xt worktree sessions |
| `planning` | Structured issue board from any spec, with phases and deps |
| `test-planning` | Test coverage planning alongside implementation work |
| `delegating` | Cost-optimized task delegation to background agents |
| `using-specialists` | Specialist routing and execution workflow (`specialists run/feed/result`) |
| `orchestrating-agents` | Multi-model orchestration (Gemini, Qwen handshake) |
| `documenting` | SSOT doc maintenance with drift detection |
| `sync-docs` | Doc audit and structural sync across a sprint |
| `skill-creator` | Create, improve, and evaluate skills |
| `specialists-creator` | Create and validate `.specialist.yaml` definitions |
| `find-skills` | Discover and install skills on demand |
| `creating-service-skills` | Generate operational service skill packages |
| `scoping-service-skills` | Task intake and service routing |
| `updating-service-skills` | Detect drift and sync expert persona docs |
| `prompt-improving` | Apply Claude XML best practices to prompts |

#### General-Purpose Expert Skills

Domain expert skills that can be used in any project, independent of the xtrm workflow.

| Skill | Purpose |
|-------|---------|
| `senior-backend` | NodeJS, Express, Go, Python, Postgres, REST/GraphQL |
| `senior-devops` | CI/CD, infrastructure as code, cloud platforms |
| `senior-security` | AppSec, pen testing, threat modeling, crypto |
| `senior-data-scientist` | Statistics, ML, A/B testing, causal inference |
| `docker-expert` | Multi-stage builds, Compose, container security |
| `python-testing` | pytest, TDD, fixtures, mocking, coverage |
| `hook-development` | PreToolUse/PostToolUse hook authoring |
| `clean-code` | Pragmatic coding standards, no over-engineering |
| `gitnexus-exploring` | Navigate unfamiliar code via knowledge graph |
| `gitnexus-impact-analysis` | Blast radius before making code changes |
| `gitnexus-debugging` | Trace bugs through call chains |
| `gitnexus-refactoring` | Plan safe refactors via dependency mapping |
| `obsidian-cli` | Interact with Obsidian vaults via CLI |
| `deepwiki` | Query repository/library docs via DeepWiki |

---

## Policy System

Policies in `policies/` are the single source of truth for all enforcement rules. They compile to both Claude hooks and Pi extensions.

| Policy | Runtime | Purpose |
|--------|---------|---------|
| `beads.json` | both | Issue tracking gates |
| `session-flow.json` | both | Claim sync, stop gate, `xt end` reminder |
| `quality-gates.json` | both | Linting/typechecking on file edits |
| `quality-gates-env.json` | both | Warns if tsc/ruff/eslint missing at session start |
| `gitnexus.json` | claude | Knowledge graph enrichment |
| `using-xtrm.json` | claude | Injects session manual at SessionStart |
| `worktree-boundary.json` | claude | Blocks edits outside active worktree |
| `service-skills.json` | pi | Territory-based skill activation |

```bash
node scripts/compile-policies.mjs           # Generate hooks.json
node scripts/compile-policies.mjs --check   # CI drift detection
```

See [docs/policies.md](docs/policies.md) for full schema and authoring reference.

---

## CLI Commands

```
xtrm <command> [options]
```

| Command | Description |
|---------|-------------|
| `install` | Install plugin + beads + gitnexus (interactive target selection) |
| `init` | Initialize project (bd, gitnexus, service-registry) |
| `status` | Read-only diff view |
| `clean` | Remove orphaned hooks |
| `claude [name]` | Launch Claude Code in a sandboxed `xt/<name>` worktree |
| `pi [name]` | Launch Pi in a sandboxed `xt/<name>` worktree |
| `attach [slug]` | Re-attach to an existing worktree and resume the Claude or Pi session |
| `end` | Close worktree session: rebase, push, PR, cleanup |
| `memory update` | Run `memory-processor` to synthesize bd memories + repo state into `.xtrm/memory.md` |
| `merge` | Drain queued `xt/*` PRs via `xt-merge`: FIFO CI gate → rebase merge → rebase cascade |
| `worktree list` | List active `xt/*` worktrees with runtime, last activity, and resume hint |
| `worktree clean` | Remove merged worktrees |
| `docs` | Documentation inspection and drift-check suite (`xtrm docs --help`) |
| `docs show` | Display frontmatter for README, CHANGELOG, docs/*.md |
| `docs list` | Inventory markdown docs with filters, summaries, and optional cache bypass |
| `docs cross-check` | Compare docs against recent PR activity and closed bd issues |
| `debug` | Watch hook and bd lifecycle events in real time |

**Flags:** `--yes / -y` (non-interactive), `--dry-run` (preview), `--prune` (force-replace hooks)

For detailed docs command usage, see [docs/docs-commands.md](docs/docs-commands.md) or run `xtrm docs --help` / `xtrm docs cross-check --help`.

See [docs/cli-architecture.md](docs/cli-architecture.md) for internals.

---

## MCP Servers

| Server | Purpose |
|--------|---------|
| `gitnexus` | Knowledge graph |
| `github-grep` | Code search |
| `deepwiki` | Repository documentation |

Official Claude plugins installed by `xtrm init`: `serena`, `context7`, `github`, `ralph-loop`.

See [docs/mcp-servers.md](docs/mcp-servers.md) for configuration details.

## Specialist Bash Tools

| Tool | Purpose | Install source |
|------|---------|----------------|
| `ghgrep` | GitHub code search CLI wrapper over `mcp.grep.app` | Ships as `bin` in `xtrm-tools` |
| `ctx7` | Context7 docs + skills CLI | Installed by machine-bootstrap (`xt install` / `xt init`) |
| `deepwiki` | Repo documentation Q&A CLI | Installed by machine-bootstrap (`xt install` / `xt init`) |

See [docs/bash-tools.md](docs/bash-tools.md) for usage examples and when to use CLIs vs MCP equivalents.

---

## Issue Tracking (Beads)

```bash
bd ready                           # Find unblocked work
bd update <id> --claim             # Claim an issue
bd close <id> --reason "Done"      # Close when done
```

See [XTRM-GUIDE.md](XTRM-GUIDE.md) for the full `bd` command reference.

---

## Version History

| Version | Date | Highlights |
|---------|------|------------|
| 0.7.1 | 2026-04-02 | Optional packs pre-populated on install; Pi core symlink path fix; new default skills (`deepwiki`, `specialists-creator`, `using-specialists`) |
| 0.5.30 | 2026-03-22 | Fix statusline on fresh installs; `xt end --dry-run` |
| 0.5.29 | 2026-03-22 | Statusline truecolor gradient; `--no-verify` autocommit; xt-merge skill |
| 0.5.24 | 2026-03-21 | Hash-based docs drift detection; CLI docs cleanup |
| 0.5.20 | 2026-03-21 | `xtrm docs show`; worktree-boundary hook; statusline injection |

See [CHANGELOG.md](CHANGELOG.md) for full history.

---

MIT License

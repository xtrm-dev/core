# XTRM-Tools Complete Guide

> **Version 0.7.19** | A comprehensive reference for the XTRM-Tools dual-runtime workflow system (Claude Code + Pi).

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Installation](#installation)
4. [Plugin Structure](#plugin-structure)
5. [Policy System](#policy-system)
6. [Hooks Reference](#hooks-reference)
7. [Pi Extensions](#pi-extensions)
8. [Skills Catalog](#skills-catalog)
9. [CLI Commands](#cli-commands)
10. [MCP Servers](#mcp-servers)
11. [Issue Tracking with Beads](#issue-tracking-with-beads)
12. [Troubleshooting](#troubleshooting)

---

## Overview

XTRM-Tools is a **dual-runtime workflow system** — a Claude Code plugin and a Pi extension suite that implement the same policies in parallel. Both runtimes receive identical enforcement rules (beads gates, session flow, quality gates) compiled from a shared `policies/` source. Claude Code and Pi are peers: neither is downstream of the other.

### Key Features

| Feature | Runtime | Description |
|---------|---------|-------------|
| **Beads Gates** | both | Issue tracking gates — edit, commit, stop, memory gates |
| **Session Flow** | both | Claim sync, stop gate, `xt end` reminder in worktrees |
| **Quality Gates** | both | Automatic linting and type checking on file edits |
| **GitNexus** | Claude | Knowledge graph context for code exploration and impact analysis |
| **Service Skills** | Pi | Docker service expertise with territory-based skill activation |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                       Policy Compiler                               │
│             policies/*.json → hooks.json + Pi extensions            │
└──────────────────────────┬──────────────────────────────────────────┘
                            │
           ┌────────────────┴─────────────────┐
           ▼                                   ▼
┌──────────────────────────┐     ┌─────────────────────────────────┐
│    Claude Code Session   │     │          Pi Session             │
├──────────────────────────┤     ├─────────────────────────────────┤
│ Plugin hooks (hooks/)    │     │ Extensions (config/pi/          │
│ MCP Servers (.mcp.json)  │     │   extensions/)                  │
│                          │     │ Skills (.xtrm/skills/)          │
│                          │     │ MCP Servers (.mcp.json)         │
└──────────────────────────┘     └─────────────────────────────────┘
```

---

## Installation

### Quick Start

```bash
# One-time global installation
npm install -g github:Jaggerxtrm/xtrm-tools@latest

# Set up xtrm in your project (plugin, Pi, skills, beads, GitNexus)
xtrm init

# Verify installation
claude plugin list
# → xtrm-tools@xtrm-tools  Version: 0.7.19  Status: ✔ enabled
```

### One-Line Run

```bash
npx -y github:Jaggerxtrm/xtrm-tools install all
```

### Project Initialization

```bash
cd your-project
xtrm init
# alias: xtrm project init
```

This runs:
- `bd init` — Initializes beads issue tracking
- `gitnexus analyze` (when needed) — indexes or refreshes code graph
- Project MCP server sync for GitNexus
- Project-type detection (TypeScript / Python / Docker)
- `service-registry.json` scaffold/update when Docker services are detected

---

## Plugin Structure

```
plugins/xtrm-tools/
├── .claude-plugin/plugin.json   # Manifest
├── hooks → ../../hooks           # All hook scripts
└── .mcp.json → ../../.mcp.json   # MCP server definitions
```

### plugin.json

```json
{
  "name": "xtrm-tools",
  "version": "0.7.19",
  "description": "xtrm-tools: dual-runtime workflow enforcement (Claude Code + Pi) — hooks, extensions, skills, and MCP servers",
  "mcpServers": "./.mcp.json"
}
```

---

## Policy System

Policies are the **single source of truth** for all enforcement rules.

### Policy Schema

```json
{
  "id": "policy-name",
  "description": "Human-readable description",
  "runtime": "both",           // "claude" | "pi" | "both"
  "order": 10,                 // Execution priority
  "claude": {
    "hooks": [{ "event": "PreToolUse", "matcher": "Write|Edit", "command": "..." }]
  },
  "pi": {
    "extension": "packages/pi-extensions/extensions/policy-name.ts",
    "events": ["tool_call", "tool_result"]
  }
}
```

### Policy Files

| Policy | Runtime | Order | Purpose |
|--------|---------|-------|---------|
| `session-flow.json` | both | 19 | Claim sync, stop gate (blocks with unclosed in_progress claim), `xt end` reminder in worktrees |
| `beads.json` | both | 20 | Issue tracking gates (edit/commit/memory/compact) |
| `quality-gates.json` | both | 30 | Linting/typechecking |
| `quality-gates-env.json` | both | 31 | Warns if tsc/ruff/eslint missing at session start |
| `using-xtrm.json` | claude | 5 | Injects using-xtrm session manual at SessionStart |
| `gitnexus.json` | claude | 40 | Knowledge graph enrichment |
| `worktree-boundary.json` | claude | 15 | Blocks edits outside worktree when in `.xtrm/worktrees` |
| `service-skills.json` | pi | 40 | Territory-based skill activation |

### Compiler

```bash
node scripts/compile-policies.mjs           # Write hooks.json
node scripts/compile-policies.mjs --dry-run # Preview
node scripts/compile-policies.mjs --check   # CI drift check
```

---

## Hooks Reference

### Event Types

| Event | When It Fires |
|-------|---------------|
| `SessionStart` | Session begins |
| `UserPromptSubmit` | After user submits prompt |
| `PreToolUse` | Before tool invocation |
| `PostToolUse` | After tool completes |
| `Stop` | Session ends |
| `PreCompact` | Before compaction |

### Beads Gates

| Hook | Purpose |
|------|---------|
| Edit Gate | Blocks edits without claimed issue |
| Commit Gate | Ensures issues closed before commit |
| Memory Gate | Prompts to persist insights |
| Compact Save/Restore | Preserves claim state across `/compact` |

### Session Flow Gates

| Hook | Purpose |
|------|---------|
| Claim Sync | Notifies when `bd update --claim` runs; notes which issue is claimed |
| Stop Gate | Blocks agent stop when there is an unclosed in_progress claim |
| `xt end` Reminder | When session ends inside a worktree, prompts to run `xt end` |

#### Intended Worktree-First Flow (Pi + Claude)

1. `bd update <id> --claim` — claim the issue
2. Work in the claimed branch/worktree (created manually or via `xt claude`/`xt pi`)
3. Run `xt end` from within the worktree to complete closure lifecycle (commit/push/pr/merge/cleanup)

### GitNexus Hook

Enriches tool output with knowledge graph context via `gitnexus augment`.

---

## Pi Extensions

| Extension | Events | Purpose |
|-----------|--------|---------|
| `beads.ts` | session_start, tool_call, tool_result, agent_end, session_shutdown | Issue tracking gates + memory gate |
| `session-flow.ts` | tool_result, agent_end | Claim sync, stop gate, `xt end` reminder in worktrees |
| `quality-gates.ts` | tool_result | Linting/typechecking after file edits |
| `service-skills.ts` | before_agent_start, tool_result | Territory-based skill activation |

---

## Skills Catalog

### Skills Tier Architecture (`.xtrm/skills/`)

Three-tier layout: `default` (bundled baseline), `optional` (managed packs), and `user` (local overlays).

#### Optional Packs (installed)

| Pack | Skills |
|------|--------|
| `research-methods` | `brainstorming`, `academic-researcher`, `deep-research`, `fact-checker` |
| `code-quality` | `systematic-debugging`, `verification-before-completion`, `code-review-excellence`, `multi-reviewer-patterns` |
| `security-ops` | `security-auditor` |
| `data-engineering` | `data-analyst` |
| `architecture-design` | `architecture-patterns`, `subagent-driven-development`, `prompt-engineering-patterns` |

Enable with `xt skills enable <pack-name>`.

| Skill | Purpose |
|-------|---------|
| `using-xtrm` | Session operating manual — read at session start |
| `test-planning` | Plan test issues alongside implementation work |
| `documenting` | SSOT documentation with drift detection |
| `delegating` | Task delegation to cost-optimized agents |
| `orchestrating-agents` | Multi-model collaboration (Gemini, Qwen) |
| `clean-code` | Pragmatic coding standards |
| `hook-development` | Claude Code plugin hook authoring |
| `skill-creator` | Create and evaluate new skills |
| `find-skills` | Discover and install skills |
| `prompt-improving` | Claude XML prompt optimization |
| `using-serena-lsp` | Serena LSP workflow guide |
| `using-TDD` | TDD workflow enforcement |
| `python-testing` | Pytest strategies and TDD |
| `senior-backend` | Backend development expertise |
| `senior-data-scientist` | Data science and analytics |
| `senior-devops` | DevOps and infrastructure |
| `senior-security` | Security engineering |
| `docker-expert` | Docker containerization |
| `obsidian-cli` | Obsidian vault CLI integration |
| `gitnexus-debugging` | Debug with knowledge graph |
| `gitnexus-exploring` | Navigate code with knowledge graph |
| `gitnexus-impact-analysis` | Blast radius analysis |
| `gitnexus-refactoring` | Safe refactor planning |

### Project Data (`xtrm init` provisions this per repository)

| Data | Purpose |
|------|---------|
| `.beads/` | Beads issue DB and claim-state backing store |
| `service-registry.json` | Service metadata used by global service-skills routing |
| GitNexus index | Project code graph for context/impact analysis |

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `install` | Install plugin + skills + hooks + MCP servers |
| `init` | Initialize project data (bd, gitnexus, service-registry) |
| `status` | Read-only diff view |
| `clean` | Remove orphaned hooks |
| `reset` | Clear preferences |
| `claude` | Launch Claude Code in a sandboxed worktree |
| `pi` | Launch Pi in a sandboxed worktree |
| `end` | Close worktree session: rebase, push, PR, cleanup |
| `worktree list` | List all active worktrees |
| `worktree clean` | Remove stale/merged worktrees |
| `worktree remove` | Remove a specific worktree |
| `docs` | Documentation inspection and drift-check suite (`xtrm docs --help`) |
| `docs show` | Display frontmatter for README, CHANGELOG, docs/*.md |
| `docs list` | Inventory markdown docs with summaries, filters, and JSON output |
| `docs cross-check` | Validate docs against recent PR activity and closed bd issues |
| `debug` | Watch xtrm hook and bd lifecycle events in real time |

### Flags

| Flag | Description |
|------|-------------|
| `--yes`, `-y` | Non-interactive |
| `--dry-run` | Preview only |
| `--prune` | Force-replace hooks |
| `--force` | Overwrite existing |

For the docs command suite, use:
- `xtrm docs --help` for the submenu
- `xtrm docs cross-check --help` for drift-check flags and output modes
- [docs/docs-commands.md](docs/docs-commands.md) for the detailed reference

---

## MCP Servers

| Server | Purpose |
|--------|---------|
| `serena` | Code analysis via LSP |
| `context7` | Documentation lookup |
| `github-grep` | Code search |
| `deepwiki` | Technical documentation |
| `gitnexus` | Knowledge graph |

---

## Issue Tracking with Beads

```bash
bd ready                    # Find unblocked work
bd update <id> --claim      # Claim an issue
bd close <id> --reason "Done"  # Close when done
```

### Issue Types

| Type | Description |
|------|-------------|
| `bug` | Something broken |
| `feature` | New functionality |
| `task` | Work item |
| `epic` | Large feature |
| `chore` | Maintenance |

---

## Troubleshooting

### Plugin Not Loading

```bash
claude plugin list
claude plugin validate /path/to/xtrm-tools/plugins/xtrm-tools
```

### Hooks Not Firing

```bash
node scripts/compile-policies.mjs --check
```

### Beads Issues

```bash
which bd && which dolt
bd status
```

---

## Version History

| Version | Date | Highlights |
|---------|------|------------|
| 0.7.19 | 2026-05-14 | `xt init` now cleans stray GitNexus skills dirt after bootstrap; fresh-repo smoke restores clean active skills state |
| 0.7.18 | 2026-05-14 | Security baseline pipeline added: gitleaks, semgrep, osv-scanner, plus pre-commit/pre-push mirrors and payload hygiene gates |
| 0.7.17 | 2026-05-05 | Vendored `using-specialists-v3`; install/update now ship canonical specialists skill list |
| 0.7.16 | 2026-05-05 | `xt update` and `xt install` repair broken `.xtrm/skills/default` symlinks before registry install |
| 0.7.15 | 2026-05-05 | Updated `using-xtrm` and docs to cover `xt update`, release prepare/publish, and SSOT session report behavior |
| 0.7.14 | 2026-05-05 | Added `xt update`, `xt release prepare/publish`, and versioned session reports under `.xtrm/reports/` |
| 0.7.1 | 2026-04-02 | Versioned session reports and docs sync landed for Cat B workflows |

See [CHANGELOG.md](CHANGELOG.md) for full history.

---

## License

MIT License

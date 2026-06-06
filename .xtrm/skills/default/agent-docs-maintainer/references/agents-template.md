# AGENTS.md compact template

```md
# <Project> — Agent Guide

## Project summary
<2-5 lines for any agent/runtime. Avoid Claude-only tool names here.>

## Operating rules
- Use beads for tracking; claim before edits and close before commit.
- Ask before destructive or production-impacting actions.
- Use project quality gates after edits.
- Prefer project skills and CLI `--help` over copied manuals.

## Skill and workflow routing
| Need | Use |
|---|---|
| xtrm/beads workflow | `/using-xtrm`, `bd --help`, `xt --help` |
| Specialists | latest `/using-specialists-*`, prefer `/using-specialists-v3`; `sp --help` |
| Service expertise | `/scope`, `/using-service-skills` if service skills are present |
| Planning/tests/docs | `/planning`, `/test-planning`, `/sync-docs` |
Must use bd, gitnexus, specialists in smart ways. Before running any particular command - use the --help/help for each tool.
## Project map
- `<path>` — <purpose>
- `<path>` — <purpose>
- `<path>` — <purpose>

## Runtime notes
- Pi: use process tool for long-running commands.
- Generic agents: do not assume Claude-only Serena tools; use available code navigation tools.

## Essential commands
List only the handful needed every session: bd inspect/claim/close, specialist discovery/status if relevant, mandatory GitNexus calls, and project validation commands. For full syntax, use `--help`.

## Services
If service registry or service skills exist, route service tasks through `/scope` before touching service code.

## Current gotchas
Max 5-10 active, current gotchas. No history.
```

`AGENTS.md` should be more portable than `CLAUDE.md`. Keep Claude-only instructions out unless explicitly scoped.

# CLAUDE.md compact template

```md
# <Project> — Claude Code Guide

## Project summary
<2-5 lines: what this repo is, main runtime/language/package, current architecture in plain terms.>

## Non-negotiable rules
- Claim a bead before edits: `bd update <id> --claim`.
- Before editing existing functions/classes/methods, run GitNexus impact analysis.
- Close the bead and satisfy the memory gate before committing.
- Run targeted quality gates after edits.
- Do not edit generated files directly; update the source and regenerate.

## Skill routing
| Need | Load/use |
|---|---|
| xtrm workflow / beads gates | `/using-xtrm`; CLI details: `bd --help`, `xt --help` |
| Specialist orchestration | latest `/using-specialists-*`, prefer `/using-specialists-v3` |
| GitNexus impact/debug/refactor | `/gitnexus-impact-analysis`, `/gitnexus-debugging`, `/gitnexus-refactoring` |
| Service routing | `/scope`, `/using-service-skills` when service registry/skills exist |
| Release/session close | `/releasing`, `/xt-end`, `/session-close-report` |
Must use bd, gitnexus, specialists in smart ways. Before running any particular command - use the --help/help for each tool.

## Project map
- `<path>` — <purpose>
- `<path>` — <purpose>
- `<path>` — <purpose>

## Claude Code notes
- Use Serena symbol tools for code navigation and symbol edits.
- Use GitNexus before changing existing symbols.
- Prefer targeted reads over full-file dumps.

## Essential commands
Keep a tiny command surface, not a full manual:
- `bd ready`, `bd list --status=in_progress`, `bd show <id>` — inspect work.
- `bd update <id> --claim` and `bd close <id> --reason="..."` — lifecycle.
- `sp list`, `sp ps`, `sp feed <job-id>`, `sp result <job-id>` — specialist basics when relevant.
- `gitnexus_impact(...)` before symbol edits; `gitnexus_detect_changes(...)` before commit.
- `<project test command>` and `<project build command>` — validation.

For full syntax, use each CLI's `--help`.

## Current gotchas
- <current gotcha, max 1-2 lines>
- <current gotcha, max 1-2 lines>

## References
- `README.md` — user-facing overview.
- `<docs path>` — detailed architecture/runbook.
```

Keep this template under 300 lines unless the project has a documented exception.

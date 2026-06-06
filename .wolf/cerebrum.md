# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-03-31

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->

## Key Learnings

- Specialists defaults migrated to npm package runtime: `.specialists/default/` is no longer the source of truth. Local default mirrors/YAMLs shadow package roles and should be removed unless intentionally overriding; preserve project-only roles in `.specialists/user/`.
- xtrm-ui owns Pi thinking display policy: default compact mode should hide assistant thinking with no placeholder; expansion (Ctrl+O/tool expanded) should reveal full thinking.
- xtrm-ui supersedes pi-dex; stale `npm:pi-dex` entries should be pruned from Pi settings to avoid tool/theme conflicts.
- **Project:** xtrm-tools
- **Description:** Claude Code tools installer (skills, hooks, MCP servers)

- Pi Serena tools availability depends on global Pi package `npm:pi-serena-tools`; if Serena tools appear disabled/unavailable in Pi, run/verify `pi install npm:pi-serena-tools` before blaming Serena or specialists.

## Do-Not-Repeat

[2026-06-06] Agent docs compaction should not remove every command. Keep a tiny essential command surface (bd ready/list/show/claim/close, sp list/ps/feed/result, mandatory GitNexus impact/detect_changes, project validation) and replace only full manuals/dumps with skill or --help pointers.

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->

[2026-05-07] XTRM UI hidden thinking must render with NO placeholder. Do not add a positive `showThinkingPlaceholder` preference or any path that can re-enable placeholder text; compact mode should be silent until expanded.

[2026-04-02] When dispatching executor to create a new skill alongside existing skills, steer it to NOT delete or modify any existing .xtrm/skills/default/* directories. Executor deleted find-docs (untracked by git) while cleaning active/ symlinks — git checkout could not restore it. Always include explicit instruction: "Do not delete or modify any existing skill directories."

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->

[2026-05-08] Do not early-stop specialists to take over the work yourself. If a specialist appears stuck, diagnose with `sp ps`, `sp feed`, `sp result`, and observability, then report/steer; only stop on explicit user instruction or destructive/runaway behavior. Bad specialist behavior usually means the bead/contract/prompt was underspecified by the orchestrator: write clearer, bounded, meaningful bead descriptions and specialist contracts up front.

[2026-05-15] XTRM UI external tool borders should not duplicate the tool name in the crossing/top border label. Keep the tool identity in the compact content line only; border should be plain shape chrome.

[2026-05-15] XTRM UI external tool compacting must preserve expanded-view behavior: compact rows may summarize, but Ctrl+O should reveal original/full tool text. Border chrome should be visually thin/subtle, not prominent.

[2026-05-15] XTRM UI external frames must contain exactly one tool identity in compact view: use the compact result summary only, not both the tool call header and result line. Do not frame call+result together for compact external tools.

[2026-05-15] XTRM UI external frames must avoid transient duplicate call+result display during pending/partial phase. Hide or frame only the compact summary after result exists; pending should not frame native call+result content.

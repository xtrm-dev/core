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

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->

[2026-05-07] XTRM UI hidden thinking must render with NO placeholder. Do not add a positive `showThinkingPlaceholder` preference or any path that can re-enable placeholder text; compact mode should be silent until expanded.

[2026-04-02] When dispatching executor to create a new skill alongside existing skills, steer it to NOT delete or modify any existing .xtrm/skills/default/* directories. Executor deleted find-docs (untracked by git) while cleaning active/ symlinks — git checkout could not restore it. Always include explicit instruction: "Do not delete or modify any existing skill directories."

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->

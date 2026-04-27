---
name: extension-migration-or-bulk-refactor-workflow
description: Workflow command scaffold for extension-migration-or-bulk-refactor-workflow in xtrm-tools.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /extension-migration-or-bulk-refactor-workflow

Use this workflow when working on **extension-migration-or-bulk-refactor-workflow** in `xtrm-tools`.

## Goal

Migrating, renaming, or refactoring multiple extensions or core files in bulk, often as part of a larger architecture change (e.g., moving from symlinks to package-based extensions). This workflow involves moving many files, updating import paths, and cleaning up legacy code.

## Common Files

- `packages/pi-extensions/extensions/*/index.ts`
- `packages/pi-extensions/extensions/*/package.json`
- `packages/pi-extensions/src/core/*.ts`
- `packages/pi-extensions/src/shared/*.ts`
- `packages/pi-extensions/package.json`
- `packages/pi-extensions/MIGRATION_NOTES.md`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Move or copy extension source files to new locations.
- Update package.json and related metadata.
- Update import paths and registry/index files.
- Remove legacy or deprecated files and symlinks.
- Update documentation to reflect new architecture.

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.
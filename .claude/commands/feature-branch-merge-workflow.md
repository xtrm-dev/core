---
name: feature-branch-merge-workflow
description: Workflow command scaffold for feature-branch-merge-workflow in xtrm-tools.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /feature-branch-merge-workflow

Use this workflow when working on **feature-branch-merge-workflow** in `xtrm-tools`.

## Goal

Merging a feature branch back into main, typically after a sequence of related commits. These merges often repeat the exact file changes of the feature branch, and are used to consolidate work and resolve conflicts.

## Common Files

- `packages/pi-extensions/extensions/README.md`
- `packages/pi-extensions/package.json`
- `packages/pi-extensions/src/core/README.md`
- `packages/pi-extensions/src/index.ts`
- `packages/pi-extensions/MIGRATION_NOTES.md`
- `packages/pi-extensions/extensions/*/index.ts`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Complete feature or migration work on a branch.
- Merge the branch into main, resolving any conflicts.
- Commit the merge, which repeats the file changes from the feature branch.

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.
---
name: package-metadata-and-publish-workflow
description: Workflow command scaffold for package-metadata-and-publish-workflow in xtrm-tools.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /package-metadata-and-publish-workflow

Use this workflow when working on **package-metadata-and-publish-workflow** in `xtrm-tools`.

## Goal

Updating package metadata, documentation, and scripts in preparation for npm publish or after a package rename. This includes changes to package.json, README, registry, and sync scripts, often followed by a publish or release.

## Common Files

- `packages/pi-extensions/package.json`
- `packages/pi-extensions/README.md`
- `docs/pi-extensions.md`
- `package.json`
- `.xtrm/registry.json`
- `scripts/sync-cli-version.mjs`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Update package.json with new metadata or version.
- Edit or create README.md for the package.
- Update documentation files referencing the package.
- Update or regenerate registry files (e.g., .xtrm/registry.json).
- Update or run scripts that sync versions (e.g., scripts/sync-cli-version.mjs).

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.
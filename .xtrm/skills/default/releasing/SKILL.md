---
name: releasing
description: >-
  Cut a release with the canonical xt release prepare/publish flow. Use when the
  operator wants to publish a new tag (vX.Y.Z). Prepare drafts CHANGELOG from xt
  reports and performs deterministic release-file mutations; publish creates the
  annotated tag, pushes commits/tags, and can create a GitHub release.
version: 1.2.0
---

# releasing

Canonical release publication via `xt release prepare` and `xt release publish`.

## When to use

The operator wants to cut a release. They say "release it", "ship vX.Y.Z", "cut a tag", or just "release".

## How

1. Determine target version. Default is patch bump from most recent semver tag. Operator may specify `--minor`, `--major`, or explicit version.

2. Determine tag range. Default is `<latest-tag>..HEAD`. For backfills, operator names `--from` / `--to` explicitly.

3. Prepare release files:

   ```bash
   xt release prepare --patch
   # or: xt release prepare --minor --from <tag> --to HEAD
   ```

   `prepare` is the canonical path. It builds the xt report bundle, calls the specialists changelog drafting script (`sp script changelog-keeper`), updates release files, rebuilds dist, and enforces the release scope guard.

   Current blocker: until specialists issue `unitAI-dnmcg` lands, `prepare` can fail with `interactive specialists are not allowed` because the changelog drafting specialist is not yet script-compatible. If that happens, do a manual prepare using the same scope rules and then continue with `xt release publish`.

4. Verify release diff before publishing.

   ```bash
   git diff --stat HEAD~1 HEAD
   git status --short
   ```

   Release diff must be limited to release artifacts such as:
   - `CHANGELOG.md`
   - package manifests / lockfile for version sync
   - generated `cli/dist/**` or `dist/**`

5. Publish:

   ```bash
   xt release publish
   # optional GitHub release:
   xt release publish --gh-release
   ```

   `publish` creates the annotated tag for the current package version, pushes commits and tags, and optionally creates the GitHub release.

6. Confirm:

   ```bash
   git tag --list 'v*' | tail -3
   git log --oneline -1
   git status --short --branch
   ```

## Why this design

- `xt` owns deterministic release mutation: changelog insertion, version bump, build, scope guard, commit/tag/push.
- The specialist owns only changelog drafting from xt reports through a script-compatible, READ_ONLY surface.
- xt reports are synthesis input, not raw git log + bd query. Reports are pre-curated, signal-rich, written in user-facing language.
- `xt release publish` is intentionally separate so operators can inspect prepared release files before pushing the tag.

## Manual fallback while unitAI-dnmcg is open

If `xt release prepare` fails on the changelog script compatibility guard:

1. Draft the CHANGELOG section manually from `.xtrm/reports/` and recent commits.
2. Bump package versions and lockfile.
3. Run `npm run build`.
4. Commit with `release: vX.Y.Z`.
5. Run `xt release publish`.

Do not broaden the release diff beyond release artifacts.

## Parallel sessions

Each orchestrator runs this skill in its own session. Specialist commits + tags + pushes atomically. If two sessions try same version, first push wins; second sees remote tag conflict and aborts cleanly. Operator picks next version and retries.

## Don't

- Don't call `sp release prepare` / `sp release publish` as the canonical path. They are deprecated aliases in specialists.
- Don't bypass `xt release publish` for tag/push unless the command itself is broken.
- Don't broaden release diffs with source/docs/config changes. File a separate bead for non-release work.
- Don't pre-stage unrelated files. The release scope guard should see a clean tree except allowed release artifacts.

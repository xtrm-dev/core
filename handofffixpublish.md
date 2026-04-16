# Handoff: fix main package publish

## Current state

- Remote git already contains commit `78ef093` on `main`.
- npmjs currently shows:
  - `xtrm-tools` = `0.7.3`
  - `@jaggerxtrm/pi-extensions` = `0.7.8`
- A local publish attempt tried to publish `xtrm-tools@0.7.9` and failed with:
  - `You cannot publish over the previously published versions: 0.7.9.`
- No GitHub release should be created until the main package is published cleanly.

## Goal

Publish the main `xtrm-tools` package cleanly to npmjs, then verify the final version.

## Required workflow

1. Inspect local repo/package versions and npm registry config.
2. Determine whether local package versions were bumped beyond `0.7.8`.
3. If local root version is `0.7.9`, bump forward cleanly to `0.7.10`.
4. Sync workspace package versions.
5. Publish **only** the main package `xtrm-tools` to npmjs explicitly.
6. Verify npmjs shows the new version.
7. Do **not** create git tags or GitHub releases in this step.
8. Do **not** republish `@jaggerxtrm/pi-extensions` unless its version also intentionally changed.

## Commands to run

### Inspect

```bash
npm config get registry
npm view xtrm-tools version --registry https://registry.npmjs.org
node -p "require('./package.json').version"
node -p "require('./cli/package.json').version"
node -p "require('./packages/pi-extensions/package.json').version"
```

### If local root version is already `0.7.9`

```bash
npm version 0.7.10 --no-git-tag-version
npm run sync:cli-version
```

### Publish to npmjs explicitly

```bash
NPM_CONFIG_REGISTRY=https://registry.npmjs.org npm publish --tag latest
```

### Verify

```bash
npm view xtrm-tools version --registry https://registry.npmjs.org
```

## Deliver back

Report these exact items:

- final published `xtrm-tools` version on npmjs
- local versions of:
  - root `package.json`
  - `cli/package.json`
  - `packages/pi-extensions/package.json`
- whether any local commit was created
- exact commands run

## Recommendation

The safest recovery path is to publish `xtrm-tools@0.7.10` to npmjs and leave `@jaggerxtrm/pi-extensions` at `0.7.8` unless there is a deliberate reason to bump it too.

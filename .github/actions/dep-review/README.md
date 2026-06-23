# dep-review action

Deterministic dependency-bump review for the `updating-dependencies` capability.
It runs `scripts/dep-inspect.mjs`, emits `dependency_update_case.json`, renders a
PR comment from the skill template, applies a verdict label, and fails only on
`SECURITY_FORCED` / `BLOCKED`.

No LLM runs in CI. No mutation beyond PR comment + label.

## Required permissions

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: write        # PR comments + labels are issue API endpoints
```

## Minimal consumer workflow

Pin both checkout and this action to full commit SHAs.

```yaml
name: dependency-review

on:
  pull_request:
    paths:
      - package.json
      - bun.lock
      - package-lock.json
      - pnpm-lock.yaml
      - yarn.lock

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  dep-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5
      - uses: xtrm-dev/xtrm-tools/.github/actions/dep-review@<FULL_XTRM_TOOLS_SHA>
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          runtime-reachable: unknown
          affected-services: specialists
```

## Inputs

The action can parse Dependabot-style PR titles such as
`Bump vite from 8.0.13 to 8.0.16`. For non-standard PR titles, pass explicit
package fields:

```yaml
with:
  package-name: vite
  ecosystem: npm
  from-version: 8.0.13
  to-version: 8.0.16
  runtime-reachable: no
```

`advisories-json` is intended for deterministic tests/manual overrides. Normal
runs omit it and use OSV lookup.

## Verdict labels

- `dependency-review/pass`
- `dependency-review/notes`
- `dependency-review/cooldown`
- `dependency-review/security-forced`
- `dependency-review/blocked`
- `dependency-review/incomplete`

Only `dependency-review/security-forced` and `dependency-review/blocked` fail
the check.

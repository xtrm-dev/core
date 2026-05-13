---
title: Release contract epic (xtrm-9xg2) completion
date: 2026-05-13
scope: release-contract-epic
status: complete
---

# Release contract epic completion — xtrm-9xg2

## Summary

Closed all four target children of the xtrm-tools ↔ specialists release contract epic. The cross-repo handshake is now operational end-to-end: specialists' `release-gate.yml` fires `repository_dispatch` to xtrm-tools with the asset-contract SHA, and xtrm-tools' `specialists-validation.yml` verifies the shipped manifest against the vendor mirror.

Specialists side already closed via `unitAI-ye5s9` (master commit `484aced8`), which introduced `dist/asset-contract.json` and `.github/workflows/release-gate.yml`.

## Beads closed

| Bead | Title | Priority |
|------|-------|----------|
| xtrm-cvjg | CI: specialists repository_dispatch validation | P3 |
| xtrm-nogp | CI: install order matrix smoke | P0 |
| xtrm-sn9t | CI: fresh-machine xt install/update smoke with packed specialists | P1 |
| xtrm-2yn4 | CI: release gates explicit in npm publish workflow | P1 |
| xtrm-9xg2 | (Parent epic) | P1 |

Each closed with impl/review sub-beads, executor → reviewer chain, reviewer PASS, sp finalize, merge.

## Workflows shipped

- `.github/workflows/specialists-validation.yml` (cvjg) — `repository_dispatch` + `workflow_dispatch`; checks out specialists at the dispatched SHA, runs `scripts/verify-asset-contract.mjs` against `.xtrm/skills/default/`. Fails on missing `using-specialists-v3` or `update-specialists` payload or any sha256 drift on owned skills.
- `.github/workflows/install-order-matrix.yml` (nogp) — 4-leg matrix (`xt-only`, `sp-only`, `xt-then-sp`, `sp-then-xt`) on ubuntu-latest. Each leg uses `mktemp -d`, no `SPECIALISTS_REPO_PATH`, asserts zero symlinks under `.xtrm/`, and asserts the documented prerequisite error wording when `sp init` runs before `xt init`. Helper: `scripts/__tests__/install-order-asserts.sh`.
- `.github/workflows/fresh-machine-smoke.yml` (sn9t) — `workflow_dispatch` with `specialists_ref` (default `master`) and `specialists_tarball_url` inputs. Packs both repos, installs both tarballs globally, runs `xt install/init/doctor/update/doctor` + `sp init/doctor/list` in a fresh git repo, asserts registry/skills present, no `"Source and destination must not be the same"` string in logs.
- `.github/workflows/pre-publish-readiness.yml` (2yn4) — operator-triggered readiness gate.
- `.github/workflows/publish.yml` (2yn4) — extended with gate order: checkout xtrm-tools → checkout specialists → record SHA → setup-node 22.x → `npm ci` → `npm run build` → `check:skills-ownership` → `check:specialists-vendor` (with explicit `SPECIALISTS_REPO_PATH`) → `check:layout-guards` → `check:payload-hygiene` → `check:registry-pack-parity` → `node scripts/verify-asset-contract.mjs` → `npm publish --provenance`.

## Scripts added

- `scripts/verify-asset-contract.mjs` — reads `dist/asset-contract.json` shipped by specialists; derives skill name from `path.basename(path.dirname(entry.path))`; hashes corresponding `.xtrm/skills/default/<skill>/<basename>`; exits 1 on drift, missing files, or absent must-have skills (`using-specialists-v3`, `update-specialists`).
- `scripts/__tests__/install-order-asserts.sh` — helper assertions shared by all 4 matrix legs.
- `package.json` — added `check:asset-contract` script entry.

## Cross-repo handshake (operational)

```
specialists/release-gate.yml
  └─ repository_dispatch (event_type=specialists-asset-validation)
       client_payload = { specialists_sha, specialists_tag, specialists_package_version }
       └─→ xtrm-tools/specialists-validation.yml
            └─ checkout specialists @ SHA
            └─ verify-asset-contract.mjs against .xtrm/skills/default
            └─ exit 0 (PASS) | exit 1 (drift detected)
```

## Smoke test plan

Post-merge verification commands:

```bash
# From specialists repo
gh workflow run release-gate.yml
# expect: specialists-validation run appears in xtrm-tools Actions tab

# From xtrm-tools repo
gh workflow run specialists-validation.yml -f specialists_sha=484aced8
gh workflow run install-order-matrix.yml
gh workflow run fresh-machine-smoke.yml
```

## Open / deferred

- `xtrm-9xg2.2..5` (flat active layout CI guard + doctor/update/init shell smoke) — separate workstream; epic was force-closed with these remaining.
- `xtrm-4ud5` — deprecate bad 2.x stream after rename.
- `xtrm-o0eu` (epic) — `@jaggerxtrm/xtrm` rename / scoped migration; explicitly excluded from this session.

## Risk notes

- `publish.yml` hardcodes `Jaggerxtrm/specialists@master` for checkout. If specialists changes default branch or the release-gate SHA contract, gate breaks.
- `verify-asset-contract.mjs` assumes `shipped_skills[].path` + `sha256` schema. Schema bump in specialists requires script update.
- Fresh-machine smoke is operator-triggered, not blocking auto-publish.

## Commits

Branch `xt/2thx` ahead of `origin/main` by the merge commits:

- `2ad4bd5` Merge feature/xtrm-cvjg.1-executor (xtrm-cvjg)
- `95fe49b` Merge feature/xtrm-nogp.1-executor (xtrm-nogp)
- `cda0a64` Merge feature/xtrm-sn9t.1-executor (xtrm-sn9t)
- `01a909e` Merge feature/xtrm-2yn4.1-executor (xtrm-2yn4)

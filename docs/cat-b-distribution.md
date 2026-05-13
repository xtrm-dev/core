---
updated_at: 2026-05-13
---

# Cat B distribution

## Ownership model

`xtrm-tools` owns only `releasing` in this bundle.

These skills stay canonical in `specialists` and ship as vendored copies at publish time:

- `update-specialists`
- `using-kpi`
- `using-nodes`
- `specialists-creator`
- `using-specialists`
- `using-specialists-v2`
- `using-specialists-v3`
- `using-specialists-auto`
- `using-script-specialists`

Publish flow refreshes `.xtrm/skills/default/` from `specialists` before registry generation. The publish workflow (`publish.yml`) additionally verifies the vendored mirror against the specialists-side `dist/asset-contract.json` (deterministic sha256 manifest) via `scripts/verify-asset-contract.mjs`, so drift between the npm tarball payload and the specialists release cannot ship. See [`release.md`](release.md) for the full gate chain.

## Migration policy

`xt init` and `xt update` treat existing `.claude/skills/` as migration boundary, not scratch space.

- Clean install: no existing `.claude/skills/` → behavior unchanged.
- Existing symlink to current `.xtrm/skills/active/` → no-op.
- Existing real dir with content matching current managed view → replaced with managed symlink.
- Existing real dir with foreign content → command fails fast, prints this doc link, and does not delete data.
- `--force` or `XTRM_FORCE_SKILLS_MIGRATION=1` → backup first, then replace.

Backup path is predictable:

- `.claude/skills.bak-<ISO-timestamp>/`

Recommended before migration:

1. Copy `.claude/skills/` somewhere safe.
2. Move hand-curated content into `.xtrm/skills/user/`.
3. Re-run `xt init` or `xt update`.

Post-migration, user-authored content belongs under `.xtrm/skills/user/`, not under `.claude/skills/`.

## Windows stance

Windows copy-fallback is **not implemented**.

Current posture: unsupported for this symlink path until follow-up bead lands. Repro: run `xt init` on Windows and watch `fs.symlink` path in `cli/src/core/skills-scaffold.ts` fail or diverge from Unix behavior.

If Windows support is needed, follow-up should either:

- implement copy-fallback in `skills-scaffold.ts`, or
- ship explicit Windows-specific install path with tests.

Until then, Windows users need a supported Unix-like environment.

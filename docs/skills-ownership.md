---
updated_at: 2026-05-13
---

# Skills ownership

Machine-readable source: `docs/skills-ownership.json`.

- `releasing` authored and owned by `xtrm-tools`.
- `update-specialists`, `using-kpi`, `using-nodes`, `specialists-creator`, `using-specialists`, `using-specialists-v2`, `using-specialists-v3`, `using-specialists-auto`, `using-script-specialists` authored in `specialists` and vendored into `xtrm-tools` at publish time.
- `xtrm-tools` ships vendor copy in `.xtrm/skills/default/` and `npm publish` refreshes payload via `scripts/vendor-specialists-skills.mjs` before `gen-registry`. The script also writes `source.ref` and `source.resolved_sha` to `.xtrm/specialists-source.json` (no hand-edits).
- Publish vendor path defaults to `../specialists`; override with `SPECIALISTS_REPO_PATH` when CI layout differs.
- Release metadata lives in `docs/skills-ownership.release.json`.
- `publish.yml` verifies the mirror against specialists' `dist/asset-contract.json` (sha256) via `scripts/verify-asset-contract.mjs` before `npm publish`. Drift between vendored and shipped fails the gate. See [`release.md`](release.md).

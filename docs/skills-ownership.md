# Skills ownership

- `releasing` authored and owned by `xtrm-tools`.
- `update-specialists`, `using-kpi`, `using-nodes`, `specialists-creator`, `using-specialists`, `using-specialists-v2`, `using-script-specialists` authored in `specialists` and vendored into `xtrm-tools` at publish time.
- `xtrm-tools` ships vendor copy in `.xtrm/skills/default/` and `npm publish` refreshes payload via `scripts/vendor-specialists-skills.mjs` before `gen-registry`.
- Publish vendor path defaults to `../specialists`; override with `SPECIALISTS_REPO_PATH` when CI layout differs.

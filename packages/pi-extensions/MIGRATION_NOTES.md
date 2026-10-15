# Pi extension source migration notes (P2)

## Legacy → new source map

| Legacy path | New path | Notes |
|---|---|---|
| `packages/pi-extensions/extensions/compact-header` | `packages/pi-extensions/extensions/compact-header` | extension source moved unchanged |
| `packages/pi-extensions/extensions/custom-footer` | `packages/pi-extensions/extensions/custom-footer` | now imports `../../src/core` |
| `packages/pi-extensions/extensions/git-checkpoint` | `packages/pi-extensions/extensions/git-checkpoint` | extension source moved unchanged |
| `packages/pi-extensions/extensions/quality-gates` | `packages/pi-extensions/extensions/quality-gates` | now imports `../../src/core` |
| `packages/pi-extensions/extensions/service-skills` | `packages/pi-extensions/extensions/service-knowledge` | retired service-skills; replaced by self-gating service-knowledge (xtrm-6z6.1) |
| `packages/pi-extensions/extensions/xtrm-loader` | `packages/pi-extensions/extensions/xtrm-loader` | now imports `../../src/core` |
| `packages/pi-extensions/extensions/xtrm-ui` | `packages/pi-extensions/extensions/xtrm-ui` | theme assets moved to package-level `themes/xtrm-ui` |
| `packages/pi-extensions/src/core` | `packages/pi-extensions/src/core` | internal helpers; no separate `@xtrm/pi-core` package required |
| `~/.pi/agent/extensions/python-kernel.ts` (user-local loose file) | `packages/pi-extensions/extensions/python-kernel` | persistent sequential python3 tool moved into the managed package (xtrm-3ljgz.1) |

## python-kernel (xtrm-3ljgz.1)

- The persistent `python` tool moved from the user-local
  `~/.pi/agent/extensions/python-kernel.ts` into the managed package.
- **Prerequisite:** `python3` must be on PATH. A missing interpreter is
  reported as a structured tool error on every call — the host never crashes.
- **Manual loose-file migration:** compare the managed copy against your local
  file for customisations, apply them to the managed copy if needed, then
  delete `~/.pi/agent/extensions/python-kernel.ts` yourself and restart pi (or
  `/reload`). xt never deletes user-owned loose files.
- `xt update` recognises a local source checkout
  (`../../dev/core/packages/pi-extensions` in `~/.pi/agent/settings.json`) as
  the same managed package and will not register the npm copy beside it.

## Retired extensions

## Retired extensions

- `beads` and `session-flow` were retired (CORE-2372). The `beads` extension blocked
  every mutating file tool while `cwd/.beads` existed and no active `bd` claim (or
  Substrate fallback marker) was present, and blocked `git commit` while a claim was
  open. `session-flow` carried the Beads claim-sync notice and the Beads stop gate.
  Beads is a retired board and Substrate owns work authorization, so the gates are
  removed rather than ported: no edit, commit or stop gate replaces them. Both sources,
  their `src/extensions/*.ts` shims, `policies/beads.json`, `policies/session-flow.json`,
  the legacy-path-map entries and `src/core/adapter.ts`'s `isBeadsProject` /
  `parseBdCounts` helpers are deleted, and both ids are recorded in
  `src/manifest.json.disabled` with reasons. `cli/src/core/plugin-era-cleanup.ts` still
  names `beads` and `session-flow` as stale-install cleanup targets for
  `~/.pi/agent/extensions`; that is inventory, not enrollment. The `xt end` worktree
  reminder from `session-flow` is not preserved anywhere and must be re-added as its own
  non-Beads surface if it is wanted back.

- `auto-session-name` was retired (xtrm-rhmm1): the launcher now passes
  `--name <worktree-slug>` to pi/claude directly, so the extension's
  first-message-based naming is redundant and would fight the launcher-owned
  name. Removed from `src/manifest.json`, `src/registry.ts`, the legacy path
  map, and the plugin-era cleanup set.
- `custom-provider-qwen-cli` was removed: the qwen-cli provider is no longer
  part of the managed set; consumers that need Qwen models use the upstream
  pi qwen provider directly.
- `lsp-bootstrap` was removed: auto-installing LSP binaries on agent start was
  surprising and is no longer part of the managed set.
- `pi-serena-compact` and `serena-pool` were already disabled as retired
  (XTRM no longer manages Serena MCP integration) and their sources are now
  removed.

## Asset migration

- `xtrm-ui/themes/*.json` moved to `packages/pi-extensions/themes/xtrm-ui/*.json`.
- `xtrm-ui` now discovers themes from `join(__dirname, "../../themes/xtrm-ui")`.

## Follow-up updates required in later phases
1. **Installer/runtime sync paths**
   - Replace hardcoded `packages/pi-extensions/extensions/**` references with `packages/pi-extensions/extensions/**` in install/runtime copy logic.
2. **Registry generation**
   - Update `scripts/gen-registry.mjs` asset sources once package path is the canonical source-of-truth.
3. **Tests and fixtures**
   - Update tests asserting extension source paths (currently expecting `packages/pi-extensions/extensions`).
4. **Policies/docs references**
   - Update docs/policies that still mention `packages/pi-extensions/extensions` after runtime switch lands.
5. **Packaging entrypoint wiring**
   - Wire `packages/pi-extensions/src/index.ts` into Pi package install flow and extension registration.

## Stale installed copy divergence (xtrm-h7uwi.4)

- A stale copy exists at `~/.pi/agent/local/pi-extensions` (v0.11.6, last
  touched 2026-07-13). It is NOT referenced by any active pi wiring:
  `~/.pi/agent/settings.json` packages list points at the package source
  checkout (the local `packages/pi-extensions` path), which
  `xt update` already treats as the managed package. The `local/` copy is dead
  weight — it diverges silently from source and nothing consumes it.
- **Decision (report-only, no deletion):** the brief forbids touching
  `~/.pi/agent/local/pi-extensions` and `pi install`. The copy stays; this
  note records the divergence so a later operator can delete it. Do NOT treat
  it as authoritative — treat `packages/pi-extensions` as the source of truth.
- **Preventing silent divergence:** the canonical sync is the release contract
  (`npm run release:pi-extensions`, prepublish `verify:runtime` +
  `verify:python-kernel-v2`). A fresh session reaches the new surface via the
  settings.json source path with no reinstall needed; when switching to the
  npm package, `pi install npm:@jaggerxtrm/pi-extensions` replaces the source
  path. No sync script is warranted while the source path is active.

## service-skills → service-knowledge rename (xtrm-6z6.1)

- The `service-skills` extension is RETIRED (moved to `src/manifest.json.disabled`
  with a reason). Its source dir `extensions/service-skills/` and
  `src/extensions/service-skills.ts` were removed.
- The replacement is `extensions/service-knowledge/` (extension id
  `service-knowledge`, manifest entry active, `src/extensions/service-knowledge.ts`,
  legacy-path-map entry updated).
- Behavior change: the old extension registered unconditionally-ish and only
  scanned `.xtrm/skills/user/packs` + the `service-skills` umbrella; the new one
  is self-gating with `find_umbrella_packs` semantics (roots
  `[.xtrm/skills, .xtrm/skills/user/packs]`, `service-knowledge` wins over
  `service-skills`, reserved pack names skipped). No canonical registry → zero
  surface. Legacy `.claude/skills` fallback deliberately dropped.
- Context note injection uses `before_agent_start` (documented `{message}`
  injection point) — NOT `session_start` return values (not consumed as
  messages; xtrm-vs7f8 audit finding).

## python-kernel v2 (xtrm-h7uwi.1-.4 + xtrm-vs7f8)

- Skillbridge: python-backed skills (`SKILL.md` + `src/<pkg>/__init__.py`) mount
  as importable kernel modules via `PI_SKILL_PATHS`/`PI_SKILL_IMPORTS`. The
  import name is the package dir basename under `src/`, not the skill dir name
  (xtrm-vs7f8 fix).
- QoL: stdlib prelude (`json, re, os, sys, subprocess, Path`) pre-loaded; output
  cap (default 20KB) returns head 8KB + marker + tail 4KB with shape hint, full
  copy in a temp file (`PI_KERNEL_TMP`).
- Audit seam: `_AUDIT` reserved in the driver, bound into skill namespaces,
  copied into every reply; report-only policy hook behind `auditPolicy` option
  or `PI_KERNEL_AUDIT_POLICY=1`.
- Release path: `scripts/verify-python-kernel-v2.mjs` (23 checks) wired into
  prepublishOnly as `verify:python-kernel-v2`.
- Docs and e2e smoke transcripts live in `packages/pi-extensions/docs/e2e-smoke/`.

## service-knowledge ext relocation (xtrm-6z6.5)

- `extensions/service-knowledge/` + `src/extensions/service-knowledge.ts` +
  `tests/service-knowledge.test.ts` moved OUT of this package into the xtrm
  repo as the standalone npm pi-package `@jaggerxtrm/pi-service-knowledge`
  (`packages/service-knowledge-ext`). Co-locates with the service-knowledge
  Python package it mirrors.
- Core manifest: `service-knowledge` moved to `disabled` (reason:
  "Relocated to @jaggerxtrm/pi-service-knowledge (xtrm-6z6.5)"). The bundle no
  longer ships it.
- `src/shared/legacy-path-map.ts` entry for service-knowledge now carries a
  note pointing at the new package.
- python-kernel STAYS in this package (operator decision: agent-critical
  kernel stays bundled).
- To use the ext pre-merge: `-e <xtrm>/packages/service-knowledge-ext/index.ts`
  or enroll the local source path in `~/.pi/agent/settings.json`.

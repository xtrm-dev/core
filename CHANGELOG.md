# Changelog

All notable changes to Claude Code skills and configuration will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- **Service-skills Phase C auto-reconcile via service-skills-sync specialist (epic xtrm-d8r36, PR #313).** Reusable workflow `service-skills-drift-sweep.yml` auto-reconcile job rewritten to invoke the same `service-skills-sync` specialist that runs locally under `/updating-service-skills`, eliminating the Phase B two-codepath split. New caller inputs: `specialists-version` (default `'3.17.0'`, exact npm pin per xtrm-d8r36.2), `specialists-git-ref` (optional `github:xtrm-dev/specialists#<sha>` override for using HEAD before a release publishes), `specialists-pack` (default `'default'`), `specialists-model` (default `'nano-gpt/moonshotai/kimi-k2.6:thinking'`, seeded into `~/.config/specialists/user.json` via `sp init --global` + `sp edit --global` because v1.6.0 ships `execution.model: null`), `bun-version` (default `'1.3.12'`, required because `sp` ships as a `#!/usr/bin/env bun` bundle), `beads-version` (default `'1.0.5'`, satisfies `service-skills-sync.capabilities.external_commands`), `pi-version` (default `'0.79.10'`, provides the `pi` binary that `sp script` spawns), `runs-on-reconcile` (JSON, default `'"ubuntu-latest"'`; self-hosted callers pass `'["self-hosted","infra"]'`). Auto-reconcile job now installs specialists + bd + pi into `$RUNNER_TEMP/sp-install-<run-id>-<attempt>/` (per-job tmpdir, immune to persistent-runner state leaks), seeds `$HOME/.pi/agent/{models.json,auth.json}` from the `nano-gpt-api-key` secret with a populated `models[]` entry, then invokes `sp script service-skills-sync --template-field script_template --vars repo/pack/cwd --model <pinned> --json --allow-write-capable --allow-skills --allow-local-scripts`. Phase B `reconcile.py` stays in-tree as a fallback path when any of those steps fail (graceful degradation). Verified end-to-end on `mercuryintelligence/infra` action 28038439215: `sp success:true`, structured JSON returned, run log shows `::notice::reconcile path used: specialist`. Runner-env tooling gaps tracked separately (xtrm-d8r36.8 scope.py/service-registry.json + xtrm-d8r36.9 gitnexus glibc) — those gate actual reconciliation outcome, not the specialist code path. (xtrm-d8r36.1–xtrm-d8r36.6 / PR #313)
- **Service-skills Phase B auto-reconcile pipeline (xtrm-pm5d8 / epic xtrm-lwpcn).** Reusable workflow `xtrm-dev/core/.github/workflows/service-skills-drift-sweep.yml@main` now ships a second job, `auto-reconcile`, that calls an LLM to rewrite drifted `SKILL.md` files and opens an auto-PR. Opt in per-repo with new caller input `reconcile-enabled: true` + secret `nano-gpt-api-key`; default behavior unchanged (Phase A detect+comment only). New inputs `nano-gpt-model` (default `moonshotai/kimi-k2.6:thinking`, subscription-covered) and `nano-gpt-api-url` (default `https://nano-gpt.com/api/v1/chat/completions`, hostname locked to `nano-gpt.com`). Workflow concurrency group `service-skills-drift-${{ github.ref }}` with `cancel-in-progress: false` queues successive merges. Anti-loop guard skips runs from `xtrm-auto-reconcile/*` branches or `github-actions[bot]` actor. (xtrm-pm5d8 / PRs #300, #301, #305, #307, #308, #309, #310, #311)
- **`.xtrm/skills/default/service-skills/scripts/reconcile.py`** — new zero-install Python reconciler that ships in the service-skills skill pack. Reads `NANO_GPT_API_KEY` (required), `NANO_GPT_MODEL`, `NANO_GPT_API_URL`, `NANO_GPT_TIMEOUT_SECONDS` (default 300), `XTRM_AUTO_RECONCILE_COST_LIMIT_TOKENS`. CLI flags `--json`, `--dry-run`, `--max-files N`. Exit codes: 0 success / partial-with-reconciled, 1 failed / partial-with-zero, 2 missing API key. 13 unit tests. (xtrm-pm5d8.1)
- **`docs/service-skills-auto-reconcile.md`** — per-repo enablement guide with Step 0 (`xt update --apply`), secret setup, caller workflow template, failure-mode + troubleshooting matrices. (xtrm-pm5d8.7 / PRs #303, #304)

### Changed

- **`agent-docs-maintainer` skill** now treats repo identity as a first-class audit requirement: docs that lead with managed xtrm/GitNexus/beads boilerplate are flagged, routing/managed line budgets are scored separately from substantive Stack Overview prose, concise operational-entry command lists are no longer treated as CLI manual bloat, and stale-term checks can be extended per repo with `.xtrm/agent-docs.toml`. (xtrm-jdn8e)

## [v0.9.0] — 2026-06-07

### Added

- **`agent-docs-maintainer` skill** — compact `CLAUDE.md`/`AGENTS.md` audit and template guidance for keeping agent docs as routing docs, preserving beads, specialists, GitNexus, task planning, and canonical service-skills requirements without embedding full CLI manuals. (xtrm-ot9cy, xtrm-v8oa1)

- **`xt spec` command family** — PRD-level intake CLI that compiles `spec.yaml` artifacts into planner-bead input for the specialists pipeline. Six subcommands: `xt spec draft <desc>` (templated yaml scaffold), `xt spec validate <path>` (8-gate validator with `--json`), `xt spec doctor` (runtime readiness probe against deployed planning + test-planning skills), `xt spec apply <path>` (emit planner bead with `<change-contract>` XML + dispatch planner; `--check-only`, `--dry-run`, `--reconcile`), `xt spec status <path>` (drift detection vs bd state), `xt spec archive <path>` (7-gate refusal + immutable snapshot). Apply is runtime-gated on the readiness probe — refuses with exit 65 until deployed skills carry the bd-native primitives owned by `~/dev/specialists`. Composition gate (`sp chain review/approve`) stays the operator's call; a guard test fails the suite if `sp chain approve` or `bd update --claim` ever leaks into the spec code paths. (xtrm-ai9xl)
- **`docs/specs/` reference set** — `SCHEMA.md`, `EXAMPLE.yaml`, `VALIDATE-JSON.md`, `CHANGE-CONTRACT-SHAPE.md`, `ARCHIVE-GATE.md`, `UPSTREAM-DEPENDENCIES.md`. (xtrm-ai9xl)
- **`docs/migration/create-spec-deprecation.md`** — preemptive contract for any future `/create-spec` slash command: yaml-only output, no bd writes, 2-release grace. (xtrm-ai9xl.6)

### Changed

- **Managed xtrm agent instruction templates** now use compact session-start guidance, explicitly call out Claude TaskCreate/TodoWrite-style planning where applicable, and add catch-up hygiene for handoff beads, recent reports/PRs, issue triage, and service-skills freshness. (xtrm-ycpjr, xtrm-gk0oi, xtrm-h5i5v)

- **`XTRM-GUIDE.md` CLI table** now lists every `xt spec` subcommand plus the composition-gate non-feature note and the `/create-spec` deprecation pointer. (xtrm-ai9xl)

## [v0.8.5] — 2026-06-03

Service-skills migration now *sticks* in a consumer. Repos migrated to the v2 umbrella layout on 0.8.2–0.8.4 could end up without the `service-skills` skill in their active view; this release heals them on the next `xt update --apply`. Publish root `xtrm-tools` from this release commit/tag.

### `xtrm-tools` v0.8.5 — 2026-06-03

#### Fixed

- **`layout_migrator` syncs `PACK.json` after migration.** Moving per-service dirs into `service-skills/services/` and generating the `<repo>-services` umbrella left `PACK.json` listing the now-nested services and omitting the umbrella → `PACK_METADATA_MISMATCH`, which blocked the active-view rebuild invariant. `PACK.json` `skills[]` is now recomputed from the filesystem (direct-child dirs containing `SKILL.md`) — umbrella in, ghost services out, regular skills kept; idempotent. (xtrm-x8b5g, #284)
- **Active view is rebuilt after a migration.** `xt update` only rebuilt the runtime active view when registry files drifted, and `xt init` rebuilds *before* the migration step — so a migration-only pass (2nd apply, or a package-current repo on the old layout) migrated the data but left `.xtrm/skills/active` frozen, and the consumer never saw the new `service-skills` machinery + `<repo>-services` umbrella. `ensureServiceSkills` now forces `rebuildAllRuntimeActiveViews` after a migration (best-effort, idempotent) so both `init` and `update` reflect the new layout. (xtrm-x8b5g, #284)

## [v0.8.4] — 2026-06-03

Service-skills field-hardening: the v2 drift/sync machinery met real consumer repos (mercury-market-data) and this release fixes the adaptation gaps that surfaced — an unbounded gitnexus fan-out that could OOM the host, a worktree-blind gitnexus label that silenced the librarian's semantic tiering, a registration path that faked `last_sync` and masked drift, a layout migration that left dead `.claude/skills` refs, and territory globs that quietly swept gitignored build trees. Reference docs are also reconciled to the consolidated v2 skill. Publish root `xtrm-tools` from this release commit/tag.

### `xtrm-tools` v0.8.4 — 2026-06-03

#### Fixed

- **`drift_detector` enrichment is bounded and the gitnexus subprocess tree is reaped.** `scan_drift` fanned out one `npx gitnexus` subprocess per drifted file with no cap, and a plain kill left the `node` grandchild resident — an unfiltered/broad territory (real incident: 4991 candidates) could OOM the host. Candidates are now filtered to git-tracked files first, capped at `DRIFT_MAX_ENRICH` (default 200) with an mtime fallback beyond it, and gitnexus runs in its own process group so a timeout/failure kills the whole tree. The post-merge sweep forces the cheap mtime path. (xtrm-08i0b, #280)
- **gitnexus `--repo` resolves to the main-worktree label, not the worktree dir.** In an sp-auto-provisioned linked worktree, `_gitnexus_repo_name()` returned the worktree basename (which gitnexus never indexed) → `--repo` injection failed → drift silently degraded to mtime-only. Since the `service-skills-sync` librarian *always* runs in a worktree, it never got semantic enrichment. Now resolved via `git rev-parse --git-common-dir`; a second hardcoded site in `scan_drift` is fixed too. (xtrm-vvhfs, #281)
- **Registration no longer fakes a sync; never-synced services surface as drift.** `register_service` stamped `last_sync=now` with no `last_sync_ref`; done in bulk this set every service's `last_sync` to now so the mtime pre-filter returned 0 candidates and masked real drift. Registration is now catalogue-only — only a verified audit (`update_sync_time`) stamps `last_sync` + `last_sync_ref` atomically — and `scan_drift` surfaces a catalogued-but-never-synced service's whole territory as drift (needs initial sync) instead of skipping it. (xtrm-008tr, #281)
- **`layout_migrator` rewrites legacy in-body `.claude/skills/<alias>` references.** The migrator moves each `SKILL.md` verbatim, so self/cross refs kept pointing at the dead flat path. They are now rewritten to the new `.xtrm/.../service-skills/services/<service-id>` dir (alias = service-id or registry `container`); unmapped segments are left intact and reported. (xtrm-8ike5, #281)

#### Added

- **`drift_detector.py validate-territories`** — a read-only lint that reports territory globs sweeping in gitignored build/vendor/cache files (`git ls-files` delta per pattern), with a narrow-the-glob tip. `scan_drift` also emits a one-line advisory when it drops gitignored candidates. The danger was already removed by the #280 git-tracked filter; this surfaces the sloppy patterns so they get tightened. (xtrm-br179, #282)

#### Changed

- **Reference docs reconciled to the consolidated v2 `service-skills` skill** (`docs/skills.md`, `docs/project-skills.md`, `docs/testing.md`) — the old five-skill trinity framing is replaced with the single umbrella skill + a forward pointer to the devops system. (xtrm-060ov, #278)

## [v0.8.3] — 2026-06-01

Service-skills reliability hardening: makes the v2 drift/sync machinery actually fire in consumers and tier drift **semantically** instead of silently degrading to mtime. The critical fix (lg9km) repairs `drift_detector sync` so it stamps `last_sync_ref` — without it semantic tiering was dead in every consumer. Plus the dormant-hooks reconcile on `xt update`, post-merge drift automation, and gitnexus-mandatory librarian verdicts. Publish root `xtrm-tools` from this release commit/tag.

### `xtrm-tools` v0.8.3 — 2026-06-01

#### Fixed

- **`drift_detector.py sync` now stamps `last_sync_ref` to HEAD.** The CLI path (`drift_detector.py sync <id>`) passed `project_root=None` straight to `_git_head` → `git -C None …` raised → `last_sync_ref` was always `""`, forcing `gitnexus_status=no_ref` → mtime fallback for *every* service permanently. Semantic drift tiering over the committed range `last_sync_ref..HEAD` now works for all service repos — the mechanical root of the long-standing mtime-fallback behavior. (xtrm-lg9km, #277)
- **`xt update --apply` now wires xtrm-managed hooks into the consumer's existing `.claude/settings.json`** via a focused, idempotent `reconcileProjectClaudeHooks`. Previously the settings-hooks reconcile was skipped on update (only reached when `registryChanges>0`), so the 0.8.2 service-skills hooks (SessionStart cataloger · PreToolUse activator · PostToolUse drift) stayed **dormant** in existing consumers. A hook-only change now flips already-current → refreshed; non-hook keys (model/permissions) are preserved. (xtrm-0p7bp, #274)

#### Added

- **Post-merge drift automation.** A managed `post-merge` git hook (`post_merge_drift_sweep.py`) is wired on the foolproof path (`xt update --apply` / `xt init`, via the installer's `--hooks-only` mode). On a default-branch merge it runs a cost-bounded `scan_drift` since each service's `last_sync_ref`, surfaces drift, and drops a pending marker at `.xtrm/.service-skills-drift-pending`. It never auto-runs a model-backed specialist — reconcile stays agent-driven via `/updating-service-skills`. (xtrm-jcmub, #275)

#### Changed

- **Service-skills librarian: gitnexus-mandatory triage + verdict taxonomy.** String-only "unchanged" verdicts are forbidden: `audited-and-unchanged` now requires a cited gitnexus signal; a `drift_detector` tooling failure means *repair gitnexus then re-triage* (never grep-only); a genuine gitnexus outage downgrades to the weaker `synced (string-level only)` verdict. Updated `references/updating.md` (Step-1 fallback + new Verdict Taxonomy section + mandatory Verdict/Triage output lines) and the cross-repo `service-skills-sync` specialist contract. (xtrm-q7436, #276)

## [v0.8.2] — 2026-05-31

Service Skills v2: the five separate service-skills (`creating-`, `scoping-`, `updating-`, `using-service-skills` + the `service-skills-set` bundle) are consolidated into **one umbrella `service-skills` skill**, with a per-repo generated `<repo>-services` umbrella and a hard-cut layout migrator. Upgrading is foolproof — a normal `xt update --apply` (or `xt init`) auto-migrates any old-layout pack and self-wires the Claude hooks; repos without a service-registry are unaffected. Publish root `xtrm-tools` from this release commit/tag.

### `xtrm-tools` v0.8.2 — 2026-05-31

#### Added

- **Foolproof service-skills migration**: `xt update --apply` and `xt init` now run `ensureServiceSkills` — registry-gated and idempotent, it delivers the consolidated `service-skills` machinery, auto-migrates old-layout packs to the v2 umbrella (`…/service-skills/services/<svc>/`), relocates + rewrites the registry under `.xtrm`, generates the per-repo `<repo>-services` umbrella, and demotes stale shadow registries. No manual scripts, nothing to guess. (xtrm-u54wt.4)
- Service-skills Claude hooks (SessionStart cataloger · PreToolUse activator · PostToolUse drift) now ship via a global `service-skills` policy, registry-gated so they no-op in repos with no service-registry. (xtrm-u54wt.3)

#### Changed

- **Service Skills consolidated to one umbrella skill**: `service-skills` (router `SKILL.md` + `references/` + `scripts/` + `install/` + `tests/`) replaces the four trinity skills and the `service-skills-set` bundle. Per-service skills live at `packs/<pack>/service-skills/services/<svc>/`; all paths resolve via `bootstrap.py` helpers; `.claude/skills` is a Claude view only. (epic xtrm-b86y5)
- Runtime skills materializer now keys the runtime skill name on the SKILL.md frontmatter `name`, not the directory name — fixing a hard duplicate-name collision between the per-repo umbrella dir and the `service-skills` machinery skill that previously threw during `xt update`. (xtrm-u54wt.1)
- Umbrella service-registry now wins resolution precedence over stale root/legacy `.claude` registries, and the layout migrator demotes shadowing registries so a migrated repo can't be re-shadowed. (xtrm-u54wt.2)
- Pi `service-skills` extension retargeted to the v2 umbrella paths + registry. (xtrm-u54wt.5)
- `install-service-skills.py` is now a thin, runtime-agnostic manual fallback (layout migration + git-hook install) rather than a broken Trinity copy; the README centers installation on `xt update --apply`. (xtrm-u54wt.6, .7)
- Skills: `planning` and `test-planning` now require explicit logging/telemetry contracts plus smoke/E2E validation for agent, workflow, devops, hook, MCP, deploy, shell, and boundary changes. `test-planning` also documents specialist-chain test-authoring mode and concrete `test-runner` command contracts for autonomous QA loops. (xtrm-tkqjn.11, PR #270)
- Specialists authoring docs: `specialists-creator` now documents `output_file` and `notes_mode` behavior for handoff files, including `final-only` pipeline output mode. (unitAI-f58ma)
- Vendored specialists-owned skills refreshed to the `@jaggerxtrm/specialists` **v3.17.0** release (`resolved_sha` 4de671aa); asset-contract verified against the released contract. (xtrm-xli5l)

#### Removed

- Dead trinity installer module (`cli/src/commands/install-service-skills.ts`) and its stale migration tests, which expected the pre-v2 split layout. (xtrm-u54wt.8)

## [v0.8.1] — 2026-05-27

Patch release for the post-v0.8.0 CLI maintenance surface and Pi compact UI polish. The root `xtrm-tools`, `xtrm-cli`, and `@jaggerxtrm/pi-extensions` workspaces share version 0.8.1; publish root `xtrm-tools` and the Pi extensions package from the same release commit/tag.

### `xtrm-tools` v0.8.1 — 2026-05-27

#### Added

- `xt update --all-repos` sweeps `~/dev` and `~/projects` for xtrm-managed repos; dry-run inventories by default, while `--apply` patches changed repos and commits each one with `chore: apply bd auto-stage patch (xtrm-tools auto-applied)`. (xtrm-h9hqg)

#### Changed

- `xt init` and `xt update` now apply/report the bd auto-stage patch: set `export.git-add: false` to stop mid-work `.beads/issues.jsonl` staging, then append an idempotent pre-commit shim that stages the freshly exported JSONL snapshot at commit time. Hook resolution honors `core.hooksPath`, including bd v1.0.3's valid `.beads/hooks/pre-commit` target. (xtrm-h9hqg)
- `xt init` and `xt update` now include bd/GitNexus dependency maintenance summaries: installed-vs-latest detection, non-major auto-upgrade attempts on apply, `bd doctor --fix --yes`, and GitNexus reindex when status is stale/missing/schema-drifted. (xtrm-h9hqg)
- `update-xt` skill now documents bd auto-stage patch checks, `xt update --all-repos`, dependency maintenance summaries, and the valid bd v1.0.3 `.beads/hooks/pre-commit` hook target. (xtrm-h9hqg)
- `using-specialists-v3` was refreshed with Iron-style review hardening: SCRUTINY taxonomy, mandatory code-sanity/obligations gates for production diffs, Git State Precondition, and the manual Cherry-Pick Playbook while prohibiting `sp merge` / `sp epic merge`. (unitAI-qr8mg)

### `@jaggerxtrm/pi-extensions` v0.8.1 — 2026-05-27

#### Changed

- `xtrm-ui` compact shell rows now render native bash tool activity as `bash:<command>` instead of `Ran <command>`, with no space after the colon for grep/shell-heavy workflows. (xtrm-pkaxm)
- `xtrm-ui` compact summaries now allow longer one-line subjects and metadata before truncation, so legitimate short shell commands remain fully visible in compact mode. (xtrm-pkaxm)
- `xtrm-ui` compact result metadata now includes payload size in a colon-delimited `duration:payload:count` form (for example `19ms:1.2KB:3 lines`) across native bash and external tool compaction paths where text payloads are available. (xtrm-pkaxm)


## [v0.8.0] — 2026-05-23

Cumulative roll-up of two weeks of cross-package infrastructure work. Minor bump justified by the combined surface: this is the first xtrm-tools release that **simultaneously** consolidates the dolt shared-server pattern (already in 0.7.21 — restated here so the bundle reads cleanly), the `@jaggerxtrm/pi-extensions` serena-pool integration (sub-package versions 0.7.22 → 0.7.25, all published independently to npm and now mirrored in tree), and the `@jaggerxtrm/specialists` v3.16.0 skill-mirror refresh that introduces bare-mode authoring on the consumer side. None of the changes individually warranted breaking the 0.7.21-line pattern; together they justify a minor bump because **fresh `npm install -g xtrm-tools` consumers now receive a materially different runtime surface** vs. the 0.7.21 tarball.

### Context (the prior work this bundles)

- **Dolt shared-server pattern (carried from v0.7.21).** `.beads/config.yaml` ships `dolt.shared-server: true` so consumer repos route bd writes to a single per-machine `~/.beads/shared-server/` dolt server instead of spawning per-project dolt instances. This is the foundation that makes parallel specialist workflows possible without exhausting CPU/RAM. Already in 0.7.21; included in this rollup so the cumulative narrative is explicit. See v0.7.21 entry for full context. (xtrm-f3s2)
- **Serena pool sub-package (`@jaggerxtrm/pi-extensions` 0.7.22 → 0.7.25, all published to npm).** Shared Serena MCP daemon per repo root via deterministic port hashing; pi-serena-tools picks up `SERENA_MCP_PORT` and reuses the daemon instead of spawning its own. Ownership-based orphan cleanup (process-group lifecycle, never path matching). E2E driver under `DEBUG=serena-pool`. v0.7.25 supersedes a transient v0.7.24 npm-only publish. Sub-package was already released on npm; **this xtrm-tools release brings the source code into origin/main**, closing the divergence where origin/main had `packages/pi-extensions @ 0.7.21` while npm had 0.7.25. (xtrm-sqo33, xtrm-0vda4)

### Added

- `packages/pi-extensions/extensions/serena-pool/` (index.ts + package.json + e2e tests) lands in origin/main matching the npm-published `@jaggerxtrm/pi-extensions@0.7.25`. Consumers cloning xtrm-tools from GitHub and using the local checkout now see the same source code that's in the npm package — closes the runtime gap where `@jaggerxtrm/specialists` v3.15.4+ requires serena-pool but a GitHub clone of xtrm-tools didn't have it. (PR #266)
- `docs/pi-extensions.md` documents the serena-pool releases and ownership-cleanup model. (48fea105)
- `packages/pi-extensions/extensions/README.md`: per-extension authoring guide.

### Changed

- `.xtrm/skills/default/specialists-creator/SKILL.md` vendored from `@jaggerxtrm/specialists@v3.16.0` (canonical sha `275336d0`). New sections: **System Prompt Mode** (`prompt.system_prompt_mode: append|replace` with per-runner default table and 4-combination truth table), **`specialist.mandatory_rules`** (template_sets, `disable_default_globals` quirk, inline_rules, full canonical-set listing), **Script-Class vs Package-Class Runtime** (which runner injects which prompt blocks, which fields silently no-op on script-class), and **Bare specialists** subsection (when to use `execution.bare: true`, the cp-from-npm-package recipe, orthogonality with `system_prompt_mode`, mandatory_rules bypass warning). Run `xt update --apply` in any consumer repo to propagate. (PR #265)
- `.xtrm/skills/default/using-specialists-v3/SKILL.md` re-vendored from the same canonical commit; minor delta vs v0.7.21. (PR #265)
- `.xtrm/registry.json` + `.xtrm/specialists-source.json`: new sha256 hashes and `resolved_sha: 275336d0`. Generated by `scripts/gen-registry.mjs` after `scripts/vendor-specialists-skills.mjs`. (PR #265)
- `packages/pi-extensions/extensions/xtrm-ui/`: compact tool-result rows use `›` marker instead of `•`; `TOOL_ROW_MARKER` centralized; external badge parsing accepts both old and new markers for compatibility. (xtrm-0vda4)
- Security: align runner fallback labels for xtrm-tools across the security-pipeline skill. (2a3c4057, d6e6e689, 7acccd51)
- `.xtrm/skills/default/planning/SKILL.md`: align relationship-vocabulary examples with the dependency-types refactor that landed in specialists v3.15.3. (dc2920d6, 32124f20)
- README documents the `xt update` workflow more explicitly. (871a97e3)
- `.xtrm/skills/default/issue-triage/`: scope the specialist duplicate workflow more tightly. (2ee83e1c)

### Fixed

- Origin/main divergence with npm registry resolved (PR #266 rebase-merge): origin/main now matches the published `@jaggerxtrm/pi-extensions@0.7.25` source. Anyone cloning xtrm-tools fresh and using the local checkout no longer hits the silent `[serena-pool] pre-spawn ensure failed:` warning that came from missing source files.

### Notes for consumers

- Update path: `npm i -g xtrm-tools@0.8.0` then `xt update --apply` in each managed repo. The vendored `.xtrm/skills/default/` surface in the new tarball carries the bare-mode authoring documentation forward.
- This release also re-unifies workspace versions via the project's `sync:cli-version` prebuild hook: `xtrm-cli` and `@jaggerxtrm/pi-extensions` are also bumped to `0.8.0`. The 0.7.22 → 0.7.25 pi-extensions tarballs remain as historical patch releases for that sub-package; consumers depending on `@jaggerxtrm/pi-extensions@^0.7.21` automatically pick up 0.8.0.
- Existing v0.7.22 — v0.7.25 git tags remain pi-extensions sub-package release markers from the period when its version drifted from the root. Going forward, all three packages share the same version (root xtrm-tools / xtrm-cli / @jaggerxtrm/pi-extensions).

## [v0.7.25] — 2026-05-21

This section documents an independently-published `@jaggerxtrm/pi-extensions` patch release; root `xtrm-tools` remains on the v0.7.21 line.

### `@jaggerxtrm/pi-extensions` v0.7.25 — 2026-05-21

#### Fixed
- `serena-pool`: debug logging now passes the message as a separate console argument instead of interpolating it into the format string, satisfying the semgrep pre-push security gate. Supersedes the already-published npm-only v0.7.24 package for GitHub release purposes. (xtrm-sqo33)

## [v0.7.24] — 2026-05-21

This section documents an independently-published `@jaggerxtrm/pi-extensions` patch release; root `xtrm-tools` remains on the v0.7.21 line.

### `@jaggerxtrm/pi-extensions` v0.7.24 — 2026-05-21

#### Changed
- `xtrm-ui`: compact tool-result rows now use the lighter `›` marker instead of `•` for xtrm-ui-owned native and external compact summaries. The marker is centralized as `TOOL_ROW_MARKER`; external badge parsing accepts both old and new markers for compatibility, and prompt/input prefix behavior remains unchanged. (xtrm-0vda4)

## [v0.7.23] — 2026-05-21

This section documents an independently-published `@jaggerxtrm/pi-extensions` patch release; root `xtrm-tools` remains on the v0.7.21 line.

### `@jaggerxtrm/pi-extensions` v0.7.23 — 2026-05-21

#### Changed
- `serena-pool`: added ownership-based orphan cleanup for the shared Serena daemon. The extension records pid/pgid/start time under `/tmp/serena-pool`, reaps only process groups it owns after the recorded daemon is verifiably dead, and leaves unrelated editor/test/hook LSP processes untouched. (xtrm-zfw28)
- `serena-pool`: added `DEBUG=serena-pool` tracing and an e2e driver under `extensions/serena-pool/test/e2e.ts` to exercise shared-daemon startup and cleanup behavior. (xtrm-zfw28)

## [v0.7.22] — 2026-05-21

This section documents an independently-published `@jaggerxtrm/pi-extensions` patch release; root `xtrm-tools` remains on the v0.7.21 line.

### `@jaggerxtrm/pi-extensions` v0.7.22 — 2026-05-21

#### Added
- New `serena-pool` managed Pi extension. On `session_start`, it resolves the git repo root, maps that root to a deterministic local port, starts one shared Serena MCP daemon when needed, sets `SERENA_MCP_PORT` for `pi-serena-tools`, and keeps the daemon alive across Pi sessions so repeated tool calls do not spawn duplicate Serena servers. (xtrm-0nu9p)

## [v0.7.21]

This section bundles two independently-published releases under the same root version number; each subheading corresponds to a distinct npm package and publish date.

### `xtrm-tools` v0.7.21 — 2026-05-19

#### Added
- New `issue-triage` skill at `.xtrm/skills/default/issue-triage/`: bead board grooming pass using the full `bd dep --type` vocabulary (blocks, tracks, relates-to, parent-child, discovered-from, until, caused-by, validates, supersedes). Workflow phases: Snapshot → Cluster Discovery (mechanical + AI duplicate detection + explorer specialist for code-overlap + overthinker for synthesis) → Rewire (per-cluster confirm) → Verify (cycles/lint) → Handoff (triage report + optional P0 next-session pickup). Generates an executable `apply.sh` artifact alongside the triage bead so operators can review every mutation as a reviewable diff. Includes GitNexus inline reinforcement path (with explicit fallback flag when no index is available), a relationship-vocabulary cheat-sheet, pitfalls section, and an output checklist. Validated via two A/B eval iterations (10/10 vs no-skill baseline 9/10; 14/14 vs prior iteration 11/14). (xtrm-125p, xtrm-iank)

#### Changed
- `sp-terminal-overlay`: `/sp-ps` and `/xtrm-ps` now render a one-shot `sp ps` snapshot instead of defaulting to `sp ps --follow`; `--follow`/`-f` args are stripped so repainting dashboards do not loop indefinitely in the overlay. `/sp-feed` remains the streaming command. (xtrm-x76a)
- Vendored `using-specialists-v3` skill bumped to upstream `specialists` master (resolved_sha `68d81ec`). The "Dependency Linking" section is rewritten as "Dependency Linking And Relationship Vocabulary" with full `--type` semantics: orchestrators no longer overload `blocks` for follow-ups (`discovered-from`), root-cause links (`caused-by`), verification pairs (`validates`), duplicates (`supersedes`), or restitch replacements. Aligns with the new `issue-triage` skill's vocabulary table. (0ded9e6)
- `package.json` `files` whitelist now excludes `.xtrm/skills/default/*-workspace/**` so per-skill eval workspaces (created during A/B benchmarking under the skill-creator loop) are not pulled into `npm pack`. (xtrm-ph91)

#### Fixed
- `xtrm-ui` (carried from pi-extensions v0.7.21): native/standard Pi tools clear their pending call row as soon as the final tool result is received, avoiding the transient two-row flicker before compact rendering collapses to one row. See xtrm-a404.
- `xtrm-ui` (carried from pi-extensions v0.7.21): external tool background chrome aligns with native tool rows and colors only the displayed tool-name token with a non-bold dark-on-cold badge. See xtrm-bm43, xtrm-do9o.

### `@jaggerxtrm/pi-extensions` v0.7.21 — 2026-05-16

#### Fixed
- `xtrm-ui`: native/standard Pi tools (`bash`, `read`, `edit`, `write`, `find`, `grep`, `ls`) now clear their pending call row as soon as the final tool result is received, avoiding the transient two-row flicker before compact rendering collapses to one row. (xtrm-a404)
- `xtrm-ui`: external tool background chrome now aligns with native tool rows and colors only the actual displayed tool-name token with a non-bold dark-on-cold badge, leaving the bullet and result text unfilled. Bumped the internal external tool frame patch version so `/reload` replaces older prototype wrappers. (xtrm-bm43, xtrm-do9o)

## [v0.7.20] - 2026-05-15

### Added
- `@jaggerxtrm/pi-extensions`: new `sp-terminal-overlay` managed Pi extension with `/sp-feed`, `/sp-ps` (`/xtrm-ps` alias), and `/xtrm-terminal <command>` overlay commands for streaming specialist feed/dashboard output inside Pi. The overlay is centered, fixed-height, scrollable, throttles live redraws, and preserves safe SGR colors for append-style `sp feed` output. (xtrm-3e4n)

### Changed
- `xtrm-ui`: non-native/external tool output can now use selectable chrome via `/xtrm-ui chrome background|box` or `/xtrm-ui-external-chrome background|box`; background mode uses native-density rows with a cold badge on only the displayed tool-name token, while box mode keeps the tight framed style. `structured_return` and `process` now share the compact summary treatment used for Serena/GitNexus tools and retain expanded-output behavior. (xtrm-3e4n)
- Decision for GitHub #257: xtrm will not provision or track per-worktree dependency artifacts. `xt claude` / `xt pi` launch output and xtrm/specialist guidance now explain that clean git worktrees omit ignored directories such as `node_modules/` and `.venv/`, and instruct users to run the repo's normal bootstrap inside the worktree (`make bootstrap`, `just setup`, `npm ci`, `uv sync`, etc.) when lint/tests need those dependencies. (xtrm-tbih / #257)

## [0.7.19] - 2026-05-14

### Fixed
- `xt init`'s Project Bootstrap phase no longer leaves Skills Runtime in an `incomplete: active` state on a fresh repo. Bare `gitnexus analyze` (invoked by xt init) unconditionally writes 6 skills to `<project>/.claude/skills/gitnexus/<name>/SKILL.md`, and because xtrm makes `.claude/skills` a symlink to `.xtrm/skills/active/`, those writes landed as a non-symlink directory at `.xtrm/skills/active/gitnexus/` — breaking the flat-active-view invariant and tripping `hasOnlyValidSymlinkEntries` → `activeReady=false`. After `gitnexus analyze` returns, `runGitNexusInitForProject` now removes that polluting subdir (idempotent, try/catch wrapped). No functionality loss — the same gitnexus skills are already vendored as flat `gitnexus-cli`, `gitnexus-debugging`, etc. under `.xtrm/skills/default/` and symlinked into `active/`. Fresh-repo smoke now reports `✓ All phases verified successfully.` (5/5 green). (xtrm-wbfd / PR #252)

## [0.7.18] - 2026-05-14

### Added
- Security baseline pipeline: new GitHub Actions workflows for `gitleaks`, `semgrep`, and `osv-scanner` triggered on push and PR; project-level `.githooks/pre-commit` + `.githooks/pre-push` security mirrors with `.local` extension hooks; `.pre-commit-config.yaml` framework integration; `.gitleaks.toml`, `.semgrepignore`, and `.github/dependabot.yml`. New helper scripts `scripts/osv-diff.sh`, `scripts/semgrep-diff.sh`, `scripts/security-scan.sh`. (xtrm-6m4y / PR #206)
- Vendor freshness manifest committed at `.xtrm/specialists-source.json` so CI's `Verify specialists vendor freshness` step has a reference snapshot (was previously generated only at `prepublishOnly` time, leaving main CI red on every push). (PR #206)
- `xt doctor`: report global xt-managed Pi package health in text and JSON via `piPackages`, including missing, outdated, and version-unknown states with remediation; doctor remains report-only and never installs packages. (xtrm-modr)
- `xt update`: check global xt-managed Pi package freshness during dry-run and JSON output, and refresh only missing/outdated managed packages when `--apply` is used. (xtrm-5nwu)
- `xt update --root <dir>`: surface partial-install repos in the output. Directories under `<root>` that contain a `.xtrm/` folder but no `.xtrm/registry.json` are now reported with status `incomplete` and a remediation hint (run `xt init` or `xt install`). Previously these were silently skipped. New `scanXtrmRepos` helper exposes the split (`managed`, `incomplete`) for programmatic callers; `findManagedRepos` kept as a backward-compatible thin wrapper. (xtrm-asqq)
- `policies/beads.json`: wire `beads-compact-save.mjs` to `PreCompact` and `beads-compact-restore.mjs` to `SessionStart` so beads state survives Claude Code compaction; generated `.xtrm/config/hooks.json` carries a narrow wrapper-level `script` field for these entries only. (xtrm-4amc.5)
- `xtrm update --help` advertises the `init` alias so operators discover the unified entry point from either command. (xtrm-4amc.7)
- `xt status`: `--check` flag for non-interactive summary that never prompts. The inline sync prompt is also auto-skipped when stdin is not a TTY, so agents and CI can use `xt status` for a quick "is everything fine?" check without engaging the interactive multiselect. JSON output unchanged; interactive TTY behavior preserved. (xtrm-d3wx / PR #225)
- `prepublishOnly`: new `check:payload-hygiene` step runs `npm pack --dry-run` and fails the publish gate on (a) forbidden packed paths matching a denylist (`.xtrm/worktrees/`, `.pi/`, `.serena/`, `__pycache__/`, `*.log`, `*.db`, `*.sqlite*`, `workspace/`, `evals/`, `.specialists/jobs/`, `.specialists/db/`, `.beads/dolt/`, `.beads/backup/`, `.beads/issues.jsonl`) and (b) absolute-path leaks (`/home/*`, `/Users/*`, `file:///home/`, `file:///Users/`) in packed text content. Both checks always run and report independently. (xtrm-7xxz / PR #228, xtrm-zb9q / PR #230)
- **Release contract: cross-repo handshake with specialists.** New end-to-end gate chain that fails the npm publish if the vendored specialists payload drifts from upstream. (xtrm-9xg2 / PR #238, finalised in PR #239)
  - `.github/workflows/specialists-validation.yml`: triggered by `repository_dispatch` (type=`specialists-asset-validation`) from specialists' release-gate workflow, or manually via `workflow_dispatch`. Checks out specialists at the dispatched SHA and runs `scripts/verify-asset-contract.mjs` against `.xtrm/skills/default/`. Hard-fails if `using-specialists-v3` or `update-specialists` (must-have specialists-owned skills) are missing from the mirror or their sha256 drifts. (xtrm-cvjg)
  - `scripts/verify-asset-contract.mjs`: reads specialists' `dist/asset-contract.json` (sha256 manifest per shipped skill), filters by `docs/skills-ownership.json` owner=specialists, hashes each vendored file under `.xtrm/skills/default/<skill>/<basename>`, exits 1 on any drift. Skill name derived from `path.basename(path.dirname(entry.path))` — no `entry.skill` field exists.
  - `.github/workflows/install-order-matrix.yml`: 4-leg matrix (`xt-only`, `sp-only`, `xt-then-sp`, `sp-then-xt`) over `mktemp -d` repos validates the canonical install order. Each leg asserts the documented prerequisite error wording when sp init runs before xt init, and that no symlinks ever appear under `.xtrm/`. Helper at `scripts/__tests__/install-order-asserts.sh`. Operator-triggered only (third-party install behaviour outside release-contract scope; see docs/release.md). (xtrm-nogp / PR #238, xtrm-g20x for scope)
  - `.github/workflows/fresh-machine-smoke.yml`: end-to-end smoke that packs xtrm-tools + specialists via `npm pack`, installs both tarballs globally on a fresh ubuntu-latest runner, runs `xt init -y` + `xt doctor` + `xt update --apply` + `sp init/doctor/list` in a `mktemp -d` git repo. Reusable via `workflow_call` (used by `publish.yml`) and `workflow_dispatch` (operator). Assertions narrowed to release-contract invariants only: 3 must-have specialists skills land in the mirror, no symlink leaks, no `Source and destination must not be the same` regression. (xtrm-sn9t / PR #238, refined by xtrm-3qts / PR #243)
  - `.github/workflows/pre-publish-readiness.yml`: operator dry-run of the entire publish chain (resolve_ref → fresh_machine_smoke → publish_dry_run) minus the actual `npm publish`. All 6 publish gates run including `verify-asset-contract.mjs` and `npm pack --dry-run`. Green = safe to tag. (xtrm-a8x4 / PR #239)
  - `docs/release.md`: operator + agent release playbook. Architecture diagram, per-gate enforcement table, operator procedure, gate-specific recovery, 12 hard rules for agents touching release plumbing, runtime prerequisites (`sp` requires Bun), install-order-matrix scope clarification. (xtrm-a8x4 / PR #239)
- `.pi/settings.json` `.skills` array: installer now seeds **two** entries in resolution order — `../.xtrm/skills/active` (project-local, wins) and `~/.xtrm/skills/default` (user-level fallback). Without the fallback, specialist configs that reference skills not vendored into a project failed to resolve in pi (`validateBeforeRun` warnings). User-added entries between the two managed ones are preserved on `xt update`; idempotent. (xtrm-4h6u / PR #247)
- `installFromRegistry` now snapshots `packageRoot/.xtrm/registry.json` → `userXtrmDir/registry.json` after the file-by-file copy loop. Freshly init'd repos show as managed in `xt update --root` immediately — no manual `cp` from xtrm-tools. Skipped in dry-run. (xtrm-ya2i / PR #246, supersedes xtrm-tools-adh)
- `using-specialists-auto` vendored as a new specialists-owned skill in `.xtrm/skills/default/`; added to both `docs/skills-ownership.json` and `docs/skills-ownership.release.json`. (xtrm-lhqy / PR #239)

### Changed
- Pi runtime package assurance now uses the canonical xt-managed package inventory, including `npm:@jaggerxtrm/pi-extensions`, instead of a two-package allowlist. (xtrm-ppwi)
- Pi package freshness classification is centralized behind provider-injected helpers so commands can share deterministic missing/outdated/version-unknown behavior. (xtrm-basg)
- `scripts/gen-registry.mjs` no longer emits a `pi_extensions` asset for project scaffold; `packages/pi-extensions` is global-only install and is not copied into target projects' `.xtrm/`. Re-lands the fix from commit `452d961` lost during the 2026-05-09 integration restitch. (xtrm-xvjg)
- `session-close-report`: add paranoid cleanup, due-diligence, and CHANGELOG synchronization requirements so session handoffs include process cleanup, content audits, and consumer-facing changelog checks.
- `releasing`: update the release skill to drive releases end-to-end without relying on the deprecated `xt release` flow.
- `using-specialists-v3`: strengthen specialist orchestration guidance around runtime listing, file-layer discipline, security/code-sanity chains, monitoring, and worktree cleanup.
- `planning` skill: align Phase 4 with the `using-specialists-v3` 7-section bead contract (PROBLEM/SUCCESS/SCOPE/NON_GOALS/CONSTRAINTS/VALIDATION/OUTPUT). Affects every bead created by a planner specialist run going forward. (xtrm-bkgf)
- `transcriber` specialist migrated from `dashscope/qwen3.5-plus` to `nano-gpt/qwen/qwen3.5-397b-a17b-thinking` after dashscope provider was retired. Companion to specialists `unitAI-ght3j`.
- `prepublishOnly`'s `--specialists-ref` updated from the deleted `integration/2026-05-09-orchestrator` branch to `master` so the vendor step uses a live ref (vendor script's sibling-path fallback was masking the misconfiguration). (xtrm-m6yd)
- `package.json` `files`: add 3 negation entries (`!.xtrm/skills/default/**/evals/**`, `!.xtrm/skills/default/**/workspace/iteration-*/**`, `!packages/*/.serena/**`) so eval/workspace/.serena artifacts no longer ship in `npm pack`. `.npmignore` had identical patterns added first but turned out to be largely ignored when `files` is set; the negation form in `files` is the supported pattern in this repo. (xtrm-87b2 / PR #234, xtrm-0svb / PR #231)
- `scripts/gen-registry.mjs`: now reads `package.json` `files` negation entries and skips matching paths during registry generation, so `.xtrm/registry.json` stays in sync with the published pack contents. Closes the parity gap that surfaced when pack exclusions stopped matching the registry. (xtrm-y6sn / PR #234)
- `.github/workflows/publish.yml`: restructured into a 3-job DAG. `resolve_ref` reads `.source.resolved_sha` (preferred) or `.source.ref` from `.xtrm/specialists-source.json` via jq; `fresh_machine_smoke` is invoked via `workflow_call` with that pinned ref; `publish` job depends on both via `needs:` and runs the 6 gates (`check:skills-ownership`, `check:specialists-vendor` with explicit step-level `SPECIALISTS_REPO_PATH` env, `check:layout-guards`, `check:payload-hygiene`, `check:registry-pack-parity`, `verify-asset-contract.mjs`) before `npm publish --provenance`. Drift between vendored mirror and shipped specialists tarball is now impossible to ship by construction. (xtrm-2yn4 / PR #238, xtrm-nmiv, xtrm-8uox / PR #242)
- `scripts/vendor-specialists-skills.mjs`: now captures the supplied `--specialists-ref <value>` and writes both `source.ref` and `source.resolved_sha` (git HEAD of the specialists checkout at vendor time) into `.xtrm/specialists-source.json`. `publish.yml` reads `.source.resolved_sha` via jq, so the live specialists tarball used by `fresh_machine_smoke` matches the vendored mirror by construction — no more "is master still at the SHA I vendored against?" race. (xtrm-lhqy / PR #239)
- `cli/src/core/machine-bootstrap.ts`: `checkDep` now extends `process.env.PATH` with `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin` once on module load, so `spawnSync` finds binaries that were just installed in the same process. Fixes `xt init -y` bailing before the Project Bootstrap phase on fresh ubuntu-latest runners with a cached PATH that didn't include the install destinations. (xtrm-5k0o / PR #239)
- `cli/src/core/pi-runtime.ts`: `updatePiSettings` exported for direct testability; emits both `../.xtrm/skills/active` and `~/.xtrm/skills/default` in `.skills`; preserves user-added entries between the two managed paths; idempotent across repeated `xt update` runs. (xtrm-4h6u / PR #247)
- `scripts/check-payload-hygiene.mjs`: new `ABSOLUTE_PATH_LEAK_ALLOWLIST` (`CHANGELOG.md` + the hygiene script itself) suppresses self-trips when those files legitimately document absolute-path patterns. Forbidden-path scanning still applies to those files. (xtrm-h67r / PR #244)
- Workflow `run:` scripts no longer interpolate `${{ ... }}` github-context expressions inline. All instances rewritten to step-level `env:` blocks consuming `"$VARNAME"` (double-quoted), unblocking semgrep `yaml.github-actions.security.run-shell-injection`. Applies to `specialists-validation.yml`, `publish.yml`, `pre-publish-readiness.yml`, `fresh-machine-smoke.yml`. (xtrm-6cl8 / PR #238)
- `docs/cat-b-distribution.md` + `docs/skills-ownership.md`: refreshed specialist-owned skill lists (added `using-specialists-v3` + `using-specialists-auto`), mention the new asset-contract verification gate, document the vendor-script auto-write of `source.ref` + `source.resolved_sha`. (xtrm-so64 / PR #245)
- `.xtrm/skills/default/update-xt/SKILL.md`: refreshed for this session's installer changes — two-path pi skills expectation (xtrm-4h6u), `xt init` auto-seeding `registry.json` (xtrm-ya2i), worktree-build caveat (`npm run build` blocked inside `.xtrm/worktrees/`), `pnpm-workspace.yaml` row in the worktree artifact inventory (xtrm-ombq), and a new section **"Migrating a dev-linked project to a real consumer install"** with the full recipe for projects that have manually symlinked `.xtrm/skills/default` to npm-linked xtrm-tools. (xtrm-bmiq / PR #248)

### Fixed
- `xtrm-cli` workspace tarball startup no longer resolves package assets at import time, so temp-installed `xt` / `xtrm` `--version` and help commands work without a root `.xtrm/registry.json`; the workspace package is marked private while root `xtrm-tools` remains the canonical distributable. (xtrm-cplc)
- Pi runtime sync (`xtrm-n83y`) now installs `npm:pi-mcp-adapter` as a required managed Pi package, preventing Pi MCP startup blocks after `xt init` / `xt update` while still removing stale `~/.pi/agent/extensions/pi-mcp-adapter` extension overrides.
- `.beads/` is no longer committed as a self-referential symlink (introduced accidentally in PR #196); restored as a tracked directory with sensitive runtime files (`.beads-credential-key`, `interactions.jsonl`) properly gitignored, and `dolt.shared-server: true` added to `.beads/config.yaml` for parity with sibling projects. Fresh clones no longer fail with "too many levels of symbolic links". (xtrm-f3s2)
- `xtrm docs` (`list`, `verify`, `show`, `cross-check`): use `findProjectRoot()` instead of `findRepoRoot()` so the scanner respects the current project / fixture cwd rather than always traversing the xtrm-tools package source's `docs/`. (xtrm-4amc.1)
- `runProjectInit` throws an actionable `Compilation failed: ...` error when the source repo root cannot be resolved, instead of resolving to undefined and silently no-op'ing. (xtrm-4amc.7)
- `cli/src/utils/worktree-session.ts`: new `suppressBeadsWorktreeNoise` helper runs after the existing `.beads`-dir-to-symlink swap during worktree provisioning. Appends `.beads` to the per-worktree `<gitdir>/info/exclude` and runs `git update-index --skip-worktree` on tracked `.beads/*` files. Future `xt claude` / `xt pi` worktree checkpoint commits no longer carry 1.7k lines of phantom `.beads/` deletions, eliminating the manual commit-rewrite workaround for edit-capable specialists. (xtrm-nsca)
- `xt end`: new pre-push guard parses `git diff <upstream>..HEAD --raw -- .beads/` and aborts the push with an actionable error if any path under `.beads/` has destination mode `120000` (symlink). Defense-in-depth catches the case where prevention is bypassed (executors using `git add -A`, manual operator pushes, external scripts) so a `.beads` self-symlink can never be merged to a shipping branch. (xtrm-w1ip)
- `scripts/check-layout-guards.mjs` no longer flags itself as an offender. The script contains the staleActiveTiers strings by necessity to detect them in other files; added a self-reference to the `transientAllowlist`. Unblocks `npm run check:layout-guards` as a usable release gate. (xtrm-4kt0)
- Stale GitNexus "(N symbols, M relationships, K execution flows)" counter scrubbed from tracked `AGENTS.md` + `CLAUDE.md`; new `check:gitnexus-no-counter` build gate prevents the counter from being reintroduced by ad-hoc `gitnexus analyze` runs that bypass `--skip-agents-md --no-stats` (specialists supervisor already passes both since fd60db04). Wired into `prepublishOnly`. (xtrm-c6sf)
- `cli/src/utils/worktree-session.ts`: drop the `.beads` dir→symlink swap entirely. `launchWorktreeSession` now `rm -rf <worktree>/.beads` and marks the tracked `.beads/*` paths as `skip-worktree`. Modern bd 1.0.3 stores `core.hooksPath` as an absolute parent path at `bd init`, so the worktree inherits parent hooks via shared git config — no on-disk `.beads/` is needed, and bd resolves the DB via git common-dir. Removes a serious merge hazard: any branch carrying the worktree-local `.beads` symlink (mode 120000) wipes the parent's `.beads/` on squash-merge into main (real incident: projects/infra PR #39, 2026-05-12). Supersedes `xtrm-as7d` / `xtrm-nsca`. The `xt end` pre-push guard (xtrm-w1ip) stays in place as defense-in-depth for older clones and non-CLI push paths. (xtrm-cbjo)
- OSV dependency advisories cleared: removed unused `@artale/pi-procs`, removed bundled `tdd-guard` + `tdd-guard-vitest` dev deps (the Vitest TDD reporter is now opt-in via `tdd-guard-vitest` resolved-at-runtime), pinned Vite via the `cli/pnpm-lock.yaml` `overrides` block, declared `yaml` as a direct `cli/package.json` dependency (was previously hoisted from `tdd-guard`'s transitive tree — broke when tdd-guard was removed), refreshed lockfiles. OSV/audit/typecheck/tests all green post-changes. (xtrm-krk0 / PR #206)
- `scripts/scaffolder.py`: `ensure_legacy_symlink` no longer rejects every real caller. The previous confinement check required the legacy symlink's own location to live inside `pack_root`, but `scaffold_service_skill` deliberately places it at `<project>/.claude/skills/<service-id>` (sibling tree); every call raised `ValueError` after files + registry state were already written, leaving partial state. Dropped the misguided legacy-path check; the target-confinement check that prevents symlink escape via `..` or absolute paths is preserved. (xtrm-g41r / PR #220)
- `cli/src/utils/worktree-session.ts`: generalize `markBeadsSkipWorktree` → `markPathSkipWorktree(worktreePath, pathspec)` and invoke from `ensureWorktreeSpecialists` for `.specialists/default` + `.specialists/user`. Closes the parity gap with `xtrm-cbjo` — `.specialists/user/*` had the same dir→symlink merge-hazard shape (a chain branch capturing the swap would wipe parent specialist overrides on squash-merge). (xtrm-6jd2 / PR #221)
- `cli/src/commands/end.ts`: `findBeadsSymlinkIntroductions` pre-push guard now also flags mode-120000 introductions under `.specialists/*`, not just `.beads/*`. Error message and recovery hint generalized to cover both prefixes. (xtrm-6jd2 / PR #221)
- `cli/test/extensions/beads.test.ts` + `cli/test/extensions/custom-footer-parity.test.ts`: added `vi.mock` for `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` above the extension import so vitest doesn't fail the entire test file at module-load time. Those packages are Pi-provided runtime peers not in cli's `package.json`; CI's `npm install` never pulled them in. (xtrm-qdsx / PR #220)
- `cli/test/init-cli.test.ts`: bump per-test timeout to 60s for `xt init --yes bypasses confirmation and completes quickly`. The assertion is "no interactive prompt", not "fast"; wall-clock reaches ~28s on slow CI runners because `spawnSync` waits for the child after its internal 15s SIGTERM. (xtrm-qdsx / PR #220)
- `xt doctor`: resolve the project root via `findProjectRoot()` when `--cwd` is omitted, instead of using `process.cwd()` literally. Previously, running `xt doctor` from anywhere except the project root crashed with `ENOENT: no such file or directory, open '/.xtrm/registry.json'`. Explicit `--cwd <path>` still overrides; running outside any xtrm project now throws a clear `Not inside an xtrm project: …` error. (xtrm-sxug / PR #224)
- Pi runtime detection: `xt update` and `xt doctor` no longer report globally-installed xt-managed Pi packages as `state: missing, installedVersion: null`. The freshness path now falls back to the global npm root (resolved via `npm root -g`) when the agent-local `$PI_AGENT_DIR/npm/node_modules/<pkg>` path is absent, then chooses the agent-local path when both exist. Regression tests assert agent-local-wins and globally-installed scoped packages never report missing. (xtrm-ntf8 / PR #226)
- `cli/src/core/pi-runtime.ts`: 4 inline `// nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal` annotations for `path.join(agentDir, ..., npmPackageName, ...)` call sites. `npmPackageName` is sourced from the xt-managed allowlist constants (`XT_MANAGED_PI_PACKAGES`), not user input, so the semgrep finding is a false positive. Unblocks pre-push push of `xtrm-ntf8`. (xtrm-1hwe / PR #226)
- `cli/src/core/claude-runtime-sync.ts`: harden `resolveHooksForProjectRuntime` against single-object wrapper shape. The function previously assumed `wrappers` is always an array and called `wrappers.map(...)` directly; some upstream test was leaving `hooks.json` in `{event: { hooks: [...] }}` shape instead of `{event: [{ hooks: [...] }]}`, causing `install-integration.test.ts` to flake in full-suite runs. Now normalises with `Array.isArray(wrappers) ? wrappers : [wrappers as HookWrapper]`. Behavior on canonical array shape unchanged. (xtrm-0kgm / PR #227)
- `.gitignore` / `.pi/npm`: the host-specific `.pi/npm` self-referential symlink no longer gets re-committed by every executor that touches `.pi/`. Root cause: `.gitignore` had `.pi/npm/` (trailing slash matches **directory only**), but `.pi/npm` was a symlink — git treats symlinks as regular files, so the pattern silently never matched. Now lists both `.pi/npm` (symlink/file form) and `.pi/npm/` (directory form). `git rm --cached .pi/npm` removes the existing tracked entry. (xtrm-5kn1 / PR #235)
- Pi runtime: `resolveGlobalNpmRootDir()` is no longer shelled out per-package inside the freshness loop. `assureXtManagedPiPackages` and `getXtManagedPiPackageDoctorReport` now hoist the call to once-per-invocation, dropping the per-command `npm root -g` subprocess count from 8 to 1 (visible on machines where npm startup is slow). (xtrm-w6ey / PR #236)
- Multiple skill / runtime files cleaned of absolute-path leaks surfaced by the new `check:payload-hygiene` gate: `CHANGELOG.md` (`/home/<user>/.claude/hooks/...` → `~/.claude/hooks/...`), `hook-development/references/patterns.md` + `update-xt/SKILL.md` + `vaultctl/SKILL.md` (`/home/<user>/` → portable tokens), and `last30days/scripts/test-v1-vs-v2.sh` (`/Users/<user>/last30days-skill` → `$HOME/last30days-skill`, `/Users/<user>/.local/bin/claude` → `${CLAUDE_BIN:-$(command -v claude)}`; the latter is a net portability improvement since the original hardcoded paths only worked on the upstream author's machine). (xtrm-ykv4 / PR #233)
- `cli/src/commands/init.ts upsertManagedBlock`: regex switched from lazy `*?` to greedy `*` so duplicate-content + trailing-orphan-end-marker tails left behind by older versions get swept into the replacement. Previously only the first `start..end` pair was replaced, leaving a duplicate `# XTRM Agent Workflow` block + free-floating end marker in tracked AGENTS.md files. Visible in this repo until this PR — `AGENTS.md` cleaned in the same change (378 → 273 lines, single managed block). 6 regression tests in `cli/src/tests/upsert-managed-block.test.ts`. (xtrm-ya67 / PR #249)
- `skills/updating-service-skills/scripts/drift_detector.py`: pyright now reports 0 errors / 0 warnings via `typing.cast(str, project_root)` after the resolution dance plus `type:ignore[import-not-found]` on the dynamic `from bootstrap import ...` line. Unblocks pre-commit hooks in downstream projects where the script is vendored. (xtrm-2oho / PR #246)
- `.gitignore`: add `pnpm-workspace.yaml` (root + `cli/`). Specialist tooling occasionally shells out to pnpm in this npm-workspaces repo, generating a stray workspace file that executor checkpoint commits would silently stage into chain branches. (xtrm-ombq / PR #246)
- Workflow scripts now use `xt init -y` (the canonical non-interactive bootstrap) instead of the non-existent `xt install` subcommand. Earlier smoke runs failed with `error: too many arguments. Expected 0 arguments but got 1.` (xtrm-eb6y / PR #238)
- `install-order-matrix.yml` leg step: capture per-command exit codes and `trap dump_logs ERR` to print every `/tmp/{xt,sp}-*.{stdout,stderr,log}` on failure. Without this, the leg failed silently with no diagnostic when xt init bailed. Added `git init` + an empty bootstrap commit before `xt init -y` so the Project Bootstrap phase can run. (xtrm-dr1k / PR #238)
- `fresh-machine-smoke.yml`: scope narrowed to release-contract invariants only. `xt init`/`sp init` exit codes are captured and reported as `::warning::` (upstream package quirks like `@beads/bd` postinstall binary download or `oh-pi` exposing `oh-pi` instead of `pi` are outside the release contract). Validate step asserts: 3 must-have specialists skills in `.xtrm/skills/default/`, no symlinks under `.xtrm/`, no "Source and destination must not be the same" regression. (xtrm-3qts / PR #243, xtrm-gqiw / PR #240)
- `fresh-machine-smoke.yml` + `install-order-matrix.yml` now install Bun via `oven-sh/setup-bun@v2`. Specialists' `sp` binary uses `#!/usr/bin/env bun` (engines.bun ≥ 1.0.0). Without Bun on the runner, every `sp init/doctor/list` failed with `/usr/bin/env: 'bun': No such file or directory`. (xtrm-ss0j / PR #241)
- CHANGELOG.md: literal `/home/dawid/` + `/Users/mvanhorn/` placeholders inside an entry describing past leak fixes replaced with `/home/<user>/` / `/Users/<user>/` so the payload-hygiene gate doesn't trip on its own meta-documentation. (xtrm-h67r / PR #244)

## [0.7.17] - 2026-05-05

### Added
- Vendored `using-specialists-v3` skill from the specialists repo into `.xtrm/skills/default/`. The skill now ships in the npm tarball and is installed by `xt install` / `xt update` without requiring a specialists checkout.

### Changed
- `scripts/vendor-specialists-skills.mjs` includes `using-specialists-v3` in the canonical vendor list.
- Refreshed `using-specialists-v2/SKILL.md` from the specialists source.

## [0.7.16] - 2026-05-05

### Fixed
- `xt update` and `xt install` now repair a broken `.xtrm/skills/default` symlink before running the registry install. Previously only `xt init` repaired stale dev-mode symlinks, so updates failed on machines where the legacy symlink target no longer existed. The npm package root is always the source.

## [0.7.15] - 2026-05-05

### Changed
- Updated `using-xtrm` and `docs/XTRM-GUIDE.md` to document `xt update`, `xt release prepare/publish`, and same-day SSOT session report behavior.

## [0.7.14] - 2026-05-05

### Added
- `xt update` command with dry-run/apply modes, `--repo`, `--root`, JSON/human output, and multi-repo xtrm-managed asset refresh.
- `xt release prepare` and `xt release publish` command surface, with canonical xt report bundling in `cli/src/core/xt-reports.ts`.
- Versioned session reports under `.xtrm/reports/`, including the completed 2026-05-04 Cat B handoff report.

### Changed
- Cat B distribution now uses xtrm-tools as the npm distributor for filesystem-bound skills/hooks, while seven specialists-owned skills are vendored from the specialists repo at publish time.
- Skills runtime layout is flat: `.xtrm/skills/active/` is the single active view; stale per-runtime `active/claude` and `active/pi` assumptions were removed.
- `xt doctor` now reports Cat B skill/hook drift, runtime view readiness, duplicate canonical names, JSON output, and `--check-drift` CI behavior.
- `session-close-report` now updates the latest same-day SSOT report instead of creating duplicate reports for parallel orchestrators.
- Cat B migration docs now protect existing `.claude/skills` content and document the Windows stance.

### Fixed
- Annotated tag report date resolution now uses `git log -1 --format=%cs`, preventing empty xt report bundles for annotated tags.

## [0.7.1] - 2026-04-02

### Added

## [0.7.3] - 2026-04-04

### Changed
- **Pi extensions architecture**: Refactored from project-level copies to global symlink model. Extensions now live in `packages/pi-extensions/extensions/` (source of truth) and are symlinked to `~/.pi/agent/extensions/`. This eliminates project-level conflicts and worktrees no longer need extension bootstrap.
- **Directory rename**: `.xtrm/extensions/` renamed to `packages/pi-extensions/extensions/` to prevent Pi auto-discovery of project-level extensions (which would duplicate global symlinks).
- **Legacy path removal**: `.pi/node_modules/@xtrm/pi-core` deprecated; `@xtrm/pi-core` now lives in `packages/pi-extensions/src/core/`.
- **`docs/pi-extensions.md`**: Comprehensive rewrite documenting global symlink model, sync behavior, worktree compatibility, and active extensions (v2.0.0).
- **`docs/xtrm-directory.md`**: Updated directory layout to reflect `ext-src/` and global symlink architecture (v1.1.0).
- **`docs/xtrm-ui.md`**: Updated source paths from `packages/pi-extensions/extensions/` to `packages/pi-extensions/extensions/` (v1.2.0).

### Fixed
- **Worktree extension sync**: Extensions are now global symlinks — worktrees automatically share extensions with main repo without bootstrap or drift issues.
- **Pi runtime self-heal**: Launch-time repair now handles stale symlinks and orphaned extensions correctly.

- **`docs/skills-tier-architecture.md`**: New reference document covering three-tier skills model (default/optional/user), state.json schema, PACK.json schema, runtime active views, and xt skills CLI commands.
- **`docs/xtrm-directory.md`**: New reference document for centralized `.xtrm/` directory layout — skills, hooks, extensions, worktrees, reports, registry.json.
- **`docs/bash-tools.md`**: New reference for specialist bash CLIs (`ghgrep`, `ctx7`, `deepwiki`) including install source, usage examples, and CLI-vs-MCP guidance; README now links and surfaces `ghgrep` under capabilities.

### Changed
- **Optional packs install behavior docs**: Updated README + skills docs to reflect that `xt install` now pre-populates `.xtrm/skills/optional/`; packs are activated with `xt skills enable <pack>`.
- **Pi core resolution path docs**: Updated Pi architecture docs to reflect the new symlink location at `.xtrm/extensions/node_modules/@xtrm/pi-core` (replacing legacy `.pi/node_modules/@xtrm/pi-core`).
- **Default skills catalog docs**: Added `deepwiki`, `specialists-creator`, and `using-specialists` to default-skill listings in README and skills documentation.
- **`docs/skills.md`**: Rewritten to cover tier architecture, xt skills CLI, and updated skill catalog (v2.0.0).
- **`docs/cli-architecture.md`**: Updated skills.ts section — enable/disable/create-pack now fully implemented, added runtime flags documentation (v1.5.0).
- **`docs/skills-registry-exploration.md`**: Updated implementation status — Phase v0.9 pack lifecycle delivered, enable/disable/create-pack implemented (v1.2.0).
- **`docs/XTRM-GUIDE.md`**: Added xt skills section, fixed stale .agents/skills references.
- **`XTRM-GUIDE.md` (root)**: Fixed stale .agents/skills references in architecture diagram.

### Deprecated
- **`.agents/skills/`**: Documentation updated to reflect migration to `.xtrm/skills/` (see xtrm-directory.md).


## [0.7.0] - 2026-03-31

### Added
- **`xt report`**: Session close report CLI — `generate` collects git/bd/specialist data into a skeleton at `.xtrm/reports/`, `show`/`list`/`diff` for consumption. Agent fills `<!-- FILL -->` sections with session insights via the `session-close-report` skill.
- **`session-close-report` skill**: Structured handoff report workflow — agent generates skeleton, fills narrative sections from session context, produces a reference-quality technical handoff for the next agent.

---

## [0.5.45] - 2026-03-25

### Changed
- **`xt memory update`**: Replaced raw specialist stream with ora spinner + final summary output. Shows animated spinner while specialist runs; on finish prints `✓ .xtrm/memory.md written.` (or `✗`) followed by the last 10 meaningful lines dimmed.

---

## [0.5.44] - 2026-03-25

### Added
- **`xt help`**: `xtrm memory update` entry added to PRIMARY COMMANDS section.

---

## [0.5.43] - 2026-03-25

### Fixed
- Restore specialists project hooks in `.claude/settings.json` — incorrectly removed in 0.5.42

---

## [0.5.42] - 2026-03-25

### Fixed
- Remove accidentally committed specialists hooks from `.claude/settings.json` (reverted in 0.5.43 — see note)

---

## [0.5.41] - 2026-03-25

### Added
- **`xt memory update`**: New CLI command that shells out to the `memory-processor` specialist to synthesize bd memories + project state into `.xtrm/memory.md`. Supports `--dry-run` (report only) and `--no-beads` flags.
- **`memory-processor` specialist** (`specialists/memory-processor.specialist.yaml`): Autonomous specialist that cross-references bd memories against current source code, writes a condensed `.xtrm/memory.md` (100–200 lines, 3 sections: Architecture & Decisions, Non-obvious Gotchas, Process & Workflow Rules), and prunes stale/redundant/contradicted memories from bd.
- **`.xtrm/memory.md` injection at SessionStart**: `using-xtrm-reminder.mjs` now appends `.xtrm/memory.md` to the system prompt when present — synthesized project context is available from turn 1.
- **Pi parity — memory.md injection**: `xtrm-loader` Pi extension now injects `.xtrm/memory.md` in `before_agent_start` (same semantics as Claude Code SessionStart injection).
- **Pi parity — memory gate prompt**: `beads` Pi extension memory gate now uses the same 4-criteria checklist and articulated ack format as the Claude hook.

### Changed
- **`beads-memory-gate.mjs`**: Switched from blocking (exit 2 + stderr) to non-blocking (`additionalContext` + exit 0) — memory gate is advisory, not a hard stop.
- **`beads-stop-gate.mjs`**: Switched from blocking to non-blocking (`additionalContext` + exit 0) — eliminates spurious stop-gate noise between conversational turns.
- **Memory gate prompt** (`beads-gate-messages.mjs`): Now uses 4-criteria quality filter (hard to rediscover, non-obvious from source, will affect future decisions, still relevant in ~14 days) with mandatory articulated ack (not just `1`).

---

## [Legacy Unreleased]

### Added
- **Optional skill packs installed (commit `0e711e76`)**: added domain bundles under `.xtrm/skills/optional/` — `research-methods` (`brainstorming`, `academic-researcher`, `deep-research`, `fact-checker`), `code-quality` (`systematic-debugging`, `verification-before-completion`, `code-review-excellence`, `multi-reviewer-patterns`), `security-ops` (`security-auditor`), `data-engineering` (`data-analyst`), `architecture-design` (`architecture-patterns`, `subagent-driven-development`, `prompt-engineering-patterns`).
- gitnexus hook now fires on Grep/Read/Glob tools (parity with Pi); quality-check covers .cjs/.mjs files; quality gate env pre-check at SessionStart; policies.md rewritten from scaffold; using-xtrm SKILL.md rewritten; worktree-session migrated to bd worktree; branch state + xt end reminders in gate messages
- `xtrm docs cross-check` command suite documentation across README, guides, CLI help, and detailed docs reference
- docs: sync skills CLI docs — add xt skills to cli-architecture.md, update hooks.md dual-path resolution, mark Phase v0.8 DELIVERED in skills-registry-exploration.md (xtrm-ghgi)

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed
- v0.5.26 docs sync and Pi parity updates: quality gates, beads/session-flow lifecycle, using-xtrm loader parity, and policy-path normalization
- Pi installer parity: `xt pi setup` now matches `xt pi install/reload` for extension deployment; managed extensions use sync + auto-discovery and no longer use duplicate `pi install -l` registration
- Pi custom-footer now tracks Claude statusline parity with richer runtime/git snapshots and a two-line footer layout (metadata + issue row), including pi-dex-safe reapply behavior.
- Pi npm packages now install globally (no per-project .pi/npm/)

---

## [0.5.29] - 2026-03-22

### Added
- `skills/merge-prs/SKILL.md` and `specialists/merge-prs.specialist.yaml` for PR merge workflow
- Release script now encodes `--tag latest` for npm publish

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed
- Detect default branch via `symbolic-ref` + master fallback, replaced 9 hardcoded `origin/main` references
- Optimized Pi installer with pre-check and diff-based sync
- Statusline improvements: fixed sessionId fallback, fixed hardcoded icons, added statusline-claim to .gitignore

### Fixed
- **Autocommit now uses `--no-verify`**: both Claude hook (`beads-claim-sync.mjs`) and Pi extension (`beads/index.ts`) skip pre-commit hooks on automated `bd close` commits

---

## [0.5.20] - 2026-03-21

### Added
- **`xtrm docs show`**: New command to display frontmatter for README, CHANGELOG, and docs/*.md files with `--raw` and `--json` options
- **`worktree-boundary.mjs`**: PreToolUse hook that blocks Write/Edit outside `.xtrm/worktrees/<name>` when in worktree session
- **`worktree-boundary.json`**: Policy for worktree boundary enforcement
- **`statusline.mjs`**: Two-line status injection showing XTRM, model, branch, and claim state

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed
- **`beads-claim-sync.mjs`**: Now stages untracked files before auto-commit on `bd close`
- **Statusline format**: XTRM bold prepended, no hardcoded colors (theme-adaptive), issue ID shown before title in claim line

### Fixed
- **plugin.json sync**: `sync-cli-version.mjs` now syncs both root and plugin cache plugin.json files

---

## [0.5.0] - 2026-03-20

### Added

#### xt CLI Redesign (epic hxmh)
- **`xt` binary alias**: `xt` registered as a secondary bin alias for `xtrm`
- **`xt claude` / `xt pi` runtime namespaces**: Session launcher with worktree-first flow; creates `<project>-xt-<runtime>-<date>` worktree, Dolt-bootstraps Beads server, execs the agent
- **`xt claude install/reload/status/doctor`** and **`xt pi install/setup/status/doctor/reload`**: Per-runtime management subcommands
- **`xt end`**: Session close — `xt/*` branch gate, dirty-tree gate, rebase `origin/main`, `--force-with-lease` push, `gh pr create`, optional worktree removal
- **`xt worktree list/clean/remove`**: List `xt/*` worktrees with merged status, batch-clean merged, manual remove
- **`xt init`**: Project init command
- **`skills/xt-end/SKILL.md`**: Autonomous session-close skill for agents

#### Pi Extensions — Directory Package Format
- All 13 Pi extensions converted from flat `.ts` files to directory packages: `<name>/index.ts` + `<name>/package.json` with `exports` field
- Format: `{"name": "@xtrm/pi-<name>", "version": "1.0.0", "type": "module", "exports": {".": "./index.ts"}}`

#### Pi Installer Improvements
- `xtrm pi install` now registers each extension via `pi install -l <path>` after copying
- `diffPiExtensions` now compares extension directories using `sha256(package.json + index.ts)`

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed

- **`xtrm install all` / `basic`** now print a deprecation notice; primary entry point is `xtrm install`
- **Project namespace removed**: `xtrm install project <name>` removed
- **Gemini/Qwen scoped out**: no longer surfaced in `xtrm --help`
- **`exitOverride` fix**: `--help` now exits `0` instead of `1`
- **Version restarted at `0.5.0`** (was `2.4.6`)

### Fixed

- **Pi extensions not loadable**: flat `.ts` files were silently ignored — Pi requires directory packages with `package.json` + `exports`
- **Claude-only target detection**: `xtrm install all` enumerates Claude Code targets only
- **Project-skill install-all coverage**: regression tests verify merged hook counts and copied assets

### Previous Unreleased

- **`AGENTS.md` — bd (beads) issue tracking section**: comprehensive `bd` CLI reference
- **`xtrm install project all` / `xtrm install project '*'`**: non-interactive project skill install

---

## [2.0.0] - 2026-03-12

### Added

#### Project Skills Engine
- **`cli/src/commands/install-project.ts`**: Generic "Plug & Play" project skill installer with deep merge for `settings.json` hooks
- **`cli/src/commands/help.ts`**: Self-documenting help command with full CLI reference
- **Project skills directory structure**: `project-skills/<skill>/.claude/` standard for modular tool packages

#### Project Skills (5 skills shipped)
- **`service-skills-set`**: Docker service expertise with SessionStart, PreToolUse, PostToolUse hooks
- **`tdd-guard`**: Test-Driven Development enforcement with PreToolUse, UserPromptSubmit, SessionStart hooks
- **`ts-quality-gate`**: TypeScript/ESLint/Prettier quality gate with `quality-check.cjs` (ported from bartolli/claude-code-typescript-hooks)
- **`py-quality-gate`**: Python ruff/mypy quality gate with `quality-check.py` (custom implementation)
- **`main-guard`**: Git branch protection with `main-guard.cjs` (blocks direct edits to main/master)

#### Installation Commands
- **`xtrm install`**: Global installation (replaces `sync`)
- **`xtrm install all` / `xtrm install '*'`**: Non-interactive global install across all known targets
- **`~/.agents/skills`**: Skills-only target added so the installed `skills/` tree is available without touching hooks/config
- **`xtrm install project all` / `xtrm install project '*'`**: Install every project-specific skill package into the current repository
- **`xtrm install project <tool-name>`**: Install project-specific skill package
- **`xtrm install project list`**: List available project skills with descriptions

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed

#### CLI Rebranding
- **Package renamed**: `jaggers-agent-tools` → `xtrm-tools`
- **Binary renamed**: `jaggers-config` → `xtrm`
- **Version bumped**: 1.7.0 → 2.0.0 (breaking changes)

#### Command Restructure
- **`sync` command** → renamed to `install` with updated messaging
- **Default action**: Now shows help instead of running sync automatically
- **`add-optional` command**: Removed (optional MCP servers now part of `install`)

#### Architecture Decision
- **Claude Code only support**: Removed multi-agent hook translation for Gemini/Qwen
- **Focus**: Robust, well-tested Claude Code installation engine

### Removed

#### Multi-Agent Support
- **`cli/src/utils/transform-gemini.ts`**: Deleted (Gemini hook translation)
- **`cli/src/adapters/gemini.ts`**: Deleted (Gemini adapter)
- **`cli/src/adapters/qwen.ts`**: Deleted (Qwen adapter)
- **`transformToGeminiHooks`**, **`transformToGeminiFormat`**: Removed from `config-adapter.ts`
- **Gemini/Qwen command generation**: Removed from `sync-executor.ts`

#### Deprecated Commands
- **`jaggers-config add-optional`**: Superseded by `xtrm install`
- **`jaggers-config sync`**: Superseded by `xtrm install`

### Fixed

- **Project skills structure**: Standardized `.claude/settings.json` + `.claude/skills/` format
- **Hook paths**: Corrected `$CLAUDE_PROJECT_DIR` references in all project skills
- **Documentation**: README.md updated with accurate skill list and installation instructions

### Documentation

- **README.md**: Added Project Skills section, manual setup guide for Gemini/Qwen users
- **Updated installation instructions**: `npm install -g github:Jaggerxtrm/xtrm-tools` recommended
- **Each project skill**: Includes `README.md` and `SKILL.md` with usage guide

### Migration Guide

#### For Existing Users

```bash
# Old command (no longer works)
jaggers-config sync

# New command
xtrm install

# Global installation (recommended)
npm install -g github:Jaggerxtrm/xtrm-tools

# One-time run
npx -y github:Jaggerxtrm/xtrm-tools install
```

#### For Gemini/Qwen Users

Automated hook translation is no longer supported. See README.md "Manual Setup for Gemini/Qwen" section for manual configuration instructions.

---

## [1.7.0] - 2026-02-25

### Added

#### GitNexus Integration
- **Optional MCP server**: `gitnexus` added to `config/mcp_servers_optional.json` with auto-install support (`npm install -g gitnexus`)
- **PreToolUse hook**: `hooks/gitnexus/gitnexus-hook.cjs` — enriches Grep/Glob/Bash tool calls with knowledge-graph context via `gitnexus augment`
- **4 knowledge-graph skills**: `skills/gitnexus/{exploring,debugging,impact-analysis,refactoring}/SKILL.md` — synced via standard pipeline

#### Unified 3-Phase Sync Flow
- **`cli/src/core/preflight.ts`**: Parallel `Promise.all` preflight checks across all targets. Returns `PreflightPlan` with file diffs, MCP status, and optional server list. Per-target error isolation — one bad target never aborts the rest.
- **`cli/src/core/interactive-plan.ts`**: Single `prompts` multiselect plan — all targets, files, MCP servers, and optional servers in one view. `[~]` drifted and `[?]` optional items pre-unchecked by default.

#### MCP CLI Sync
- **`sync-mcp-cli.ts`**: Unified MCP CLI sync for Claude, Gemini, and Qwen via official `mcp add/remove/list` commands. Idempotent — re-running is always safe.
- **Env file management**: `~/.config/jaggers-agent-tools/.env` — auto-created on first sync, validates required env vars (e.g. `CONTEXT7_API_KEY`), preserves existing values.
- **ConfigAdapter enhancements**: Qwen and Antigravity support added; `type` field auto-handled per agent; `EnvVarTransformer` extended for cross-agent compatibility.

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed

#### Sync Command — 3-Phase Rewrite
- `cli/src/commands/sync.ts` fully rewritten: Phase 1 preflight spinner → Phase 2 multiselect plan → Phase 3 ordered execution (prerequisite installs → file sync → MCP sync → post-install messages)
- `--dry-run`: displays full plan grouped by target, prints "Dry run — no changes written", exits cleanly
- `-y`/`--yes`: auto-applies pre-checked defaults without prompting
- `--prune`: propagated through `plan.syncMode` to `executeSync` correctly
- `--backport`: reverses sync direction (local → repo)

#### sync-executor.ts
- Removed inline `promptOptionalServers` call and manifest-based prompt tracking
- Added `selectedMcpServers?: string[]` parameter — optional server names pre-selected upstream in Phase 2

#### MCP Configuration
- Split into `config/mcp_servers.json` (core: serena, context7, github-grep, deepwiki) and `config/mcp_servers_optional.json` (optional: unitAI, omni-search-engine, gitnexus)
- `_notes.install_cmd` and `_notes.post_install_message` metadata — drives Phase 3 auto-install
- Core servers: removed unused `filesystem`, `git`, `memory`, `gmail`, `yfinance-market-intelligence`
- `serena` command updated to uvx-from-git with auto project detection

#### Exported Symbols
- `getCurrentServers(agent)` and `AgentName` exported from `cli/src/utils/sync-mcp-cli.ts` (consumed by `preflight.ts`)

### Deprecated
- **`jaggers-config add-optional`**: now prints a redirect notice — optional servers are part of `jaggers-config sync`
- **JSON file sync for Claude/Gemini/Qwen MCP**: superseded by official `mcp` CLI method
- **Repo `.env` files**: use centralized `~/.config/jaggers-agent-tools/.env`

### Removed
- **Old Claude-specific sync**: `cli/lib/sync-claude-mcp.js` (replaced by unified `sync-mcp-cli.ts`)

### Fixed
- **`--prune` propagation**: `runPreflight` now sets `syncMode: 'prune'` when `--prune` passed (was hardcoded `'copy'`)
- **Optional server "already installed" filter**: now uses live `getCurrentServers()` call per agent instead of only checking core MCP names

### Documentation
- Updated SSoT: `ssot_jaggers-agent-tools_installer_architecture` → v1.4.0
- Updated SSoT: `ssot_cli_ux_improvements` → v2.0.0
- Updated SSoT: `ssot_cli_universal_hub` → v2.2.0
- Updated SSoT: `ssot_cli_mcp_servers` → v3.2.1

---

## [1.6.0] - 2026-02-24

### Added

#### Documenting Skill Hardening
- **`drift_detector.py`**: New script with `scan`, `check`, and `hook` subcommands — detects stale memories by cross-referencing `tracks:` globs against git-modified files
- **`tracks:` frontmatter field**: Each memory now declares which file globs it documents; added to schema, all templates, and all 11 existing memories
- **Intra-memory INDEX blocks**: `validate_metadata.py` now auto-generates a `<!-- INDEX -->` TOC table inside each memory from `##` headings + first-sentence summaries — allows agents to navigate without reading full documents
- **Stop hook**: `config/settings.json` wired with Stop hook → `drift_detector.py hook`; fires at session end, injects a one-line reminder only when stale memories detected (zero token cost when clean)
- **23 tests**: `test_validate_metadata.py` (4) and `test_drift_detector.py` (8, including `**` glob regression tests) added to existing suite

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed
- **`validate_metadata.py`**: INDEX generation now unconditional (no longer blocked by schema validation errors)
- **`SKILL.md` workflow**: Rewritten with drift-first 5-step protocol and decision table (new feature → SSOT, bug fix → changelog only, etc.)
- **All 11 existing memories**: `tracks:` globs added; INDEX blocks regenerated

### Fixed
- `extract_headings`: closing ` ``` ` was captured as section summary due to `in_code` toggle firing before capture check — fixed with `continue`
- `match_files_to_tracks`: `**/` expansion was producing `*.py` (too broad); replaced with recursive segment-by-segment `_match_glob` helper
- `inject_index`: frontmatter split hardened with anchored regex to prevent corruption on non-standard file openings
- `generate_index_table`: anchor generation collapsed consecutive hyphens from stripped `()/` chars

### Documentation
- Updated SSOT: `ssot_jaggers-agent-tools_documenting_workflow_2026-02-03` → v2.0.0

---

## [1.5.0] - 2026-02-23

### Added

#### Service Skills Set (`project-skills/service-skills-set/`)
- **Complete rewrite** of project-specific service skill infrastructure — replaces deprecated `service-skill-builder`
- **Trinity skills** installed into `.claude/skills/` of any target project:
  - `creating-service-skills` — 3-phase workflow: scaffold → Serena LSP deep dive → hook registration
  - `using-service-skills` — SessionStart catalog injection + PreToolUse skill enforcement
  - `updating-service-skills` — PostToolUse drift detection
- **Scripts**:
  - `scaffolder.py` — generates SKILL.md skeleton, script stubs, and auto-detects official docs from 30+ technology mappings (Docker images, requirements.txt, Cargo.toml, package.json)
  - `deep_dive.py` — prints Serena LSP-driven research protocol with tool table for Phase 2
  - `cataloger.py` — SessionStart hook; outputs ~150-token XML service catalog
  - `skill_activator.py` — PreToolUse hook; territory glob + Bash command matching; injects skill load enforcement
  - `drift_detector.py` — PostToolUse hook (`check-hook` stdin mode) + manual `check`, `sync`, `scan` subcommands
  - `bootstrap.py` — shared registry CRUD and project root resolution via git
- **Service registry**: `.claude/skills/service-registry.json` with territory globs, skill path, last sync
- **Git hooks** (`pre-commit`, `pre-push`): idempotent marker-based installation for SSOT reminder and skill staleness warning
- **Installer** (`install-service-skills.py`): single-purpose ~90-line script; copies trinity, merges settings.json hooks, activates git hooks; idempotent
- **Phase 3 — Hook Registration**: new phase in `creating-service-skills` workflow verifies PreToolUse wiring, confirms territory globs in registry, communicates auto-activation to user

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed
- Project structure: moved into `project-skills/service-skills-set/` with `.claude/` subdirectory
- `settings.json` PostToolUse hook moved to project-level (was only in skill frontmatter — now always-on)
- PreToolUse added to `settings.json` for territory-based skill auto-enforcement

### Fixed
- `allowed-tools` in skill frontmatter: corrected to Claude Code native tool names — removed invalid MCP/Serena names
- `SessionStart` removed from skill frontmatter (unsupported); moved to `settings.json`
- Removed `disable-model-invocation: true` from workflow skill and scaffolder template
- `project_root.glob()` type error in `bootstrap.py` fixed by wrapping with `Path()`

### Documentation
- Added `project-skills/service-skills-set/service-skills-readme.md`
- New SSOT memory: `ssot_jaggers-agent-tools_service_skills_set_2026-02-23`

---

## [1.4.0] - 2026-02-23

### Changed

#### Delegating Skill Hardening
- **Description rewrite**: Proactive language with trigger keywords (`tests`, `typos`, `refactors`, `code reviews`, `debugging`) — auto-discovery now fires without explicit "delegate" keyword
- **Frontmatter cleanup**: Removed unsupported fields (`version`, `gemini-command`, `gemini-prompt`); added `allowed-tools: Bash`
- **CCS nested session fix**: All CCS execution commands now use `env -u CLAUDECODE ccs {profile} -p "{task}"` — confirmed working inside Claude Code sessions
- **Interactive menu**: Replaced TypeScript `ask_user()` pseudocode with prose `AskUserQuestion` instructions

#### skill-suggestion.py Hook
- **Orchestration patterns**: Added `ORCHESTRATION_PATTERNS` — hook now fires for code reviews, feature implementation, debugging, security audits, commit validation
- **CLAUDECODE detection**: Hints correctly say "Gemini or Qwen directly" when running inside Claude Code (CCS unavailable), "CCS backend" otherwise
- **Security exclusion fix**: Narrowed `security` exclude pattern to only block auth/vuln *implementation* — security *reviews* now correctly route to orchestration

### Files Modified
- `skills/delegating/SKILL.md` — Description, frontmatter, pseudocode, CCS command
- `hooks/skill-suggestion.py` — Orchestration patterns, CLAUDECODE detection, security exclusion

### Documentation
- Updated SSOT: `ssot_cli_hooks_2026-02-03` → v1.1.0
- New SSOT: `ssot_jaggers-agent-tools_delegating_skill_2026-02-23` v1.0.0

---

## [1.3.0] - 2026-02-22

### Added

#### CLI UX Improvements (vsync-inspired)
- **Ora Spinners**: Visual feedback for all async operations (detect, diff, sync)
- **Enhanced Status**: Last sync time, item counts, health indicators, actionable hints
- **Single Confirmation**: Collect all changesets, display full plan, ask once
- **Drifted Items Feedback**: Report skipped drifted items post-sync with backport hint

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed

#### Safety Improvements
- **Prune Mode Guard**: Added `PruneModeReadError` — aborts if system read fails in prune mode
- **Repo Root Detection**: Dynamic detection via `findRepoRoot()` utility (walks up looking for `skills/` + `hooks/`)
- **Dry-Run Banner**: Moved from before target selection to after plan display
- **Error Handling**: Global handlers for clean error messages (no stack traces)
- **Ignored Items**: Filter `__pycache__`, `.DS_Store`, `node_modules` from diff scanning

### Dependencies
- Added `ora` for spinner UI

### Files Modified
- `cli/src/core/diff.ts` — Prune guard, ignored items filtering
- `cli/src/utils/repo-root.ts` — New utility
- `cli/src/commands/sync.ts` — Spinners, single confirm, feedback improvements
- `cli/src/commands/status.ts` — Enhanced output with timestamps
- `cli/src/core/manifest.ts` — Added `getManifestPath()`
- `cli/src/index.ts` — Global error handlers

### Documentation
- New SSOT: `ssot_cli_ux_improvements_2026-02-22.md`

---

## [1.2.0] - 2026-02-21

### Added

#### CLI: TypeScript Migration
- **Full TypeScript rewrite** of `cli/` — all modules ported from plain JavaScript ESM to strict TypeScript
- **Commander.js** replaces `minimist` for structured sub-command routing
- **Zod schemas** for runtime validation of `ChangeSet`, `SyncMode`, `Manifest`, `MCPServer`
- **Adapter Pattern** — `ToolAdapter` base class with `ClaudeAdapter`, `GeminiAdapter`, `QwenAdapter` implementations
  - `detectAdapter(systemRoot)` factory replaces scattered `includes('.claude')` checks codebase-wide
- **Rollback protection** — `core/rollback.ts` backs up every file before write; restores all on any failure
- **Hash-only diffing** — Pure MD5 comparison via `utils/hash.ts`; mtime used only as drift tie-breaker
- **`prepare` npm script** — auto-builds on `npm install`, restoring `npx github:Jaggerxtrm/jaggers-agent-tools` support
- **`vitest` test infrastructure** added to devDependencies (tests deferred, see `docs/plans/cli-testing.md`)

#### New sub-commands
- `jaggers-config sync [--dry-run] [-y] [--prune] [--backport]` — main sync
- `jaggers-config status` — read-only diff view (no file writes)
- `jaggers-config reset` — replaces `--reset` flag from old CLI

#### Windows Compatibility (baked in)
- `registry.ts` normalises backslashes before path matching
- `config-adapter.ts` uses `python` (not `python3`) on Windows for hook scripts
- `sync-executor.ts` falls back from symlinks to copy on Windows with a user warning

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed
- `cli/package.json` `bin` and root `package.json` `bin` now point to `cli/dist/index.js` (compiled output)
- `cli/package.json` `scripts` updated: `build` (tsup), `dev` (tsx), `typecheck` (tsc), `test` (vitest), `start` (node dist)
- Old `cli/index.js` and `cli/lib/*.js` preserved on disk but no longer referenced

### Fixed
- **Double-shebang bug** in tsup output — removed `banner` config, relying on tsup's auto-detection from `src/index.ts`

---

## [1.1.1] - 2026-02-03

### Added
- **Orchestrating Agents Skill**: Multi-model collaboration skill for Gemini and Qwen.
- **Handshaking Workflows**: Deep multi-turn loops (Collaborative Design, Adversarial Review, Troubleshoot Session).
- **Gemini Command Sync**: CLI support for synchronizing `.toml` commands and auto-generating them from skills.
- **Cross-Agent Interactivity**: Support for both Gemini (`ask_user`) and Claude (`AskUserQuestion`) interactive menus.
- Implement specialized Gemini slash commands (/delegate, /document, /prompt)
- Enable zero-cloning installation via npx github:Jaggerxtrm/jaggers-agent-tools
- Implement Vault Sync Architecture for non-destructive settings management. Protects local secrets, MCP servers, and auth data during sync. Includes atomic writes and dry-run mode.
- **Architecture Roadmap**: Document CLI architectural improvements in ROADMAP.md based on multi-agent orchestration findings (Transactional Sync, Manifest Versioning, Namespace Prefixes, Observability).

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed
- **CLI Enhancement**: Automatically transforms `SKILL.md` into Gemini `.toml` command files during sync.
- **Hook Migration**: Refined hook transformation logic for cross-agent compatibility.
- Update SSOT and CHANGELOG for cross-agent compatibility and CLI improvements
- Consolidate all v1.1.0 improvements: Zero-Cloning, Metadata-driven commands, and multi-turn orchestration
- **ROADMAP.md**: Added "CLI Architecture Improvements" section with 5 phases addressing transactional sync, versioning, collision detection, observability, and transformation refactoring.

### Fixed
- Fix hook execution timeouts by updating settings.json to use milliseconds and enhancing transform-gemini.js to handle unit mismatches and improve hook naming.
- Prevent redundant auto-generation of commands for core skills in CLI
- Fix hardcoded paths in settings.json during sync
- Fix ReferenceError in sync.js by adding missing import and verify via Qwen handshake

---

## [6.0.0] - 2026-02-01

### Added

#### `delegating` Skill (Unified)
- **New `delegating` skill** replaces `ccs-delegation`
- **Unified Backends**: Supports both CCS (cost-optimized) and unitAI (multi-agent workflows)
- **Configuration-Driven**: All logic defined in `config.yaml`
- **Auto-Focus**: Detects security/performance/quality focus from keywords
- **Autonomous Workflow Selection**: Claude picks optimal unitAI workflow based on patterns

### Removed

#### `ccs-delegation` Skill
- **Deprecated**: Fully replaced by `delegating` skill
- **Removed**: `skills/ccs-delegation` directory deleted

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed

#### Skill Suggestions Hook
- **Updated**: Suggests `/delegation` instead of `/ccs-delegation`
- **Renamed**: `skill-suggestion.sh` → `skill-suggestion.py` for Python implementation

---

## [5.1.0] - 2026-01-30

### Changed

#### Naming Convention Alignment
- **Skill `p` renamed to `prompt-improving`**
  - Updated skill directory: `~/.claude/skills/p` → `~/.claude/skills/prompt-improving`
  - Updated YAML frontmatter: `name: p` → `name: prompt-improving`
  - Updated trigger syntax: `/p` → `/prompt-improving`
  - Updated hook suggestions to reference `/prompt-improving`
  - Follows Claude's naming convention with `-ing` suffix for improved clarity

#### Breaking Changes
- **`/p` command no longer works** - Use `/prompt-improving` instead
- Users with muscle memory for `/p` will need to adapt to `/prompt-improving`
- Hook suggestions now display `/prompt-improving` in systemMessage

#### Migration Guide (5.0.0 → 5.1.0)
**For Users:**
- Replace all `/p "prompt"` invocations with `/prompt-improving "prompt"`
- Update any documentation or workflows referencing the `/p` skill

**For Backward Compatibility (Optional):**
If you prefer to keep `/p` working via symlink:
```bash
ln -s ~/.claude/skills/prompt-improving ~/.claude/skills/p
```

---

## [5.0.0] - 2026-01-30

### Added

#### Skills Enhancement
- **UserPromptSubmit Hook** (`~/.claude/hooks/skill-suggestion.sh`)
  - Proactive skill suggestions for `/p` and `/ccs` based on prompt analysis
  - Bilingual pattern matching (Italian + English)
  - Flexible synonym detection (e.g., "correggi|fix|sistema|repair")
  - Sub-100ms execution time, no LLM calls
  - Opt-in configuration via `settings.json`
  - Detects simple tasks (typo, test, refactor, docs) → suggests `/ccs`
  - Detects short/generic prompts → suggests `/p` for structure

#### Configuration
- **skillSuggestions config** in `settings.json`
  - `enabled: true` - Hook active by default
  - Can be disabled without restart
- **UserPromptSubmit hook registration** in `settings.json`
  - Timeout: 1s
  - Command: `~/.claude/hooks/skill-suggestion.sh`

#### Skill Features
- **AskUserQuestion dialogs** in `ccs-delegation` skill for interactive delegation choice
- **AskUserQuestion clarification** in `p` skill for ambiguous prompts (<8 words)

- **pi-serena-compact**: Pi extension that compacts verbose output from Serena/GitNexus MCP tools (6 lines default, 12 for read_file/shell commands, respects expanded view toggle)
### Changed

#### Skill `p` (Prompt Improver)
- **SKILL.md**: Reduced from 118 to 64 lines (-46% size)
- **Simplified context detection**: From 10 categories to 3 (ANALYSIS, DEV, REFACTOR)
- **Removed multi-iteration improvement loop**: Single-pass processing only
- **Inline scoring heuristics**: Replaced complex quality metrics with simple keyword checks
- **Reference structure**: Merged prefill patterns into `xml_core.md` (+20 lines)

#### Skill `ccs-delegation`
- **SKILL.md**: Reduced from 486 to 151 lines (-69% size)
- **Keyword-based profile selection**: Replaced quantitative complexity scoring (0-10 scale)
  - Simple patterns: `typo|test|doc` → glm
  - Reasoning patterns: `analiz|think|reason` → gemini
  - Architecture patterns: `architecture|entire|codebase` → gemini
- **Bilingual support**: IT+EN keywords throughout (e.g., "correggi|fix", "aggiungi.*test|add.*test")
- **Simplified execution flow**: Detect → Ask → Select Profile → Execute (removed fallback chains)

#### Performance Improvements
- **Skill load time**: 5-8s → <1s (-80-85% reduction)
- **Total token overhead**: 155KB → 16KB (-90% reduction)
- **Pattern matching**: Extended from basic English to IT+EN with wildcards

### Removed

#### Skill `p` References (46KB total)
- `quality_metrics.md` (12.7KB, 511 lines) - Complex 0-100 scoring system
- `context_detection_rules.md` (10.4KB) - 10-category detection rules
- `prefill_patterns.md` (10KB) - Standalone prefill examples (merged into xml_core.md)
- `before_after_examples.md` (12.9KB) - Redundant examples

#### Skill `ccs-delegation` References (95KB total)
- `task_complexity_scoring.md` (14.4KB, 478 lines) - Quantitative complexity algorithm
- `smart_context_gathering.md` (16.6KB, 643 lines) - Multi-level context system
- `fallback_chain.md` (15.5KB) - Edge-case fallback handling
- `parallel_delegation.md` (17.1KB) - Multi-agent parallel execution
- `delegation_history_analysis.md` (15.7KB) - Learning/persistence system

### Fixed

#### Pattern Matching
- **Too rigid English-only patterns** → Extended to bilingual IT+EN with synonyms
- **Missing common terms** → Added: "rimuovi|remove", "modifica|modify", "sistema|repair"
- **Case sensitivity issues** → All patterns use case-insensitive matching (`grep -i`)

#### Hook Configuration
- **Hook script not executable** → Added `chmod +x` to deployment checklist
- **Missing skillSuggestions config** → Added to `settings.json` with `enabled: true`

---

## [4.2.0] - Pre-refactoring baseline

### Changed
#### Skills State Before Refactoring
- **Skill `p`**: 118 lines, 52KB references (9 files)
- **Skill `ccs-delegation`**: 486 lines, 103KB references (6 files)
- **Total overhead**: 155KB token cost per skill activation
- **Load time**: 5-8 seconds per skill invocation

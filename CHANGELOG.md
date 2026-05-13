# Changelog

All notable changes to Claude Code skills and configuration will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- Security baseline pipeline: new GitHub Actions workflows for `gitleaks`, `semgrep`, and `osv-scanner` triggered on push and PR; project-level `.githooks/pre-commit` + `.githooks/pre-push` security mirrors with `.local` extension hooks; `.pre-commit-config.yaml` framework integration; `.gitleaks.toml`, `.semgrepignore`, and `.github/dependabot.yml`. New helper scripts `scripts/osv-diff.sh`, `scripts/semgrep-diff.sh`, `scripts/security-scan.sh`. (xtrm-6m4y / PR #206)
- Vendor freshness manifest committed at `.xtrm/specialists-source.json` so CI's `Verify specialists vendor freshness` step has a reference snapshot (was previously generated only at `prepublishOnly` time, leaving main CI red on every push). (PR #206)
- `xt doctor`: report global xt-managed Pi package health in text and JSON via `piPackages`, including missing, outdated, and version-unknown states with remediation; doctor remains report-only and never installs packages. (xtrm-modr)
- `xt update`: check global xt-managed Pi package freshness during dry-run and JSON output, and refresh only missing/outdated managed packages when `--apply` is used. (xtrm-5nwu)
- `xt update --root <dir>`: surface partial-install repos in the output. Directories under `<root>` that contain a `.xtrm/` folder but no `.xtrm/registry.json` are now reported with status `incomplete` and a remediation hint (run `xt init` or `xt install`). Previously these were silently skipped. New `scanXtrmRepos` helper exposes the split (`managed`, `incomplete`) for programmatic callers; `findManagedRepos` kept as a backward-compatible thin wrapper. (xtrm-asqq)
- `policies/beads.json`: wire `beads-compact-save.mjs` to `PreCompact` and `beads-compact-restore.mjs` to `SessionStart` so beads state survives Claude Code compaction; generated `.xtrm/config/hooks.json` carries a narrow wrapper-level `script` field for these entries only. (xtrm-4amc.5)
- `xtrm update --help` advertises the `init` alias so operators discover the unified entry point from either command. (xtrm-4amc.7)

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
  - Command: `/home/dawid/.claude/hooks/skill-suggestion.sh`

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

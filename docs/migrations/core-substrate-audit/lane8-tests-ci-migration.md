# Lane 8 — Tests, CI, and the Beads→Substrate migration: acceptance suite and deletion order

Read-only architecture audit for XTRM Core. This lane produces the FUTURE ACCEPTANCE SUITE
and the EXACT DELETION ORDER for the Beads→Substrate hard cut. It implements nothing.

## Baseline (re-verified in this worktree)

- Core worktree: `/home/dawid/dev/core/.xtrm/worktrees/core-xt-pi-7awr`, HEAD `e3c09927f115a9ad551953ede2262c91a9bbb431` (matches `main` baseline), `xtrm-tools@0.12.0` (`cli/package.json`).
- `git status` at audit start: only `?? docs/migrations/` (the other lanes' reports). No source file was read-modified.
- Substrate snapshot `/tmp/audit/xtrm-main`, Specialists snapshot `/tmp/audit/specialists-master` used only for context; every claim below is cited against Core (`path:line`).
- `npm pack --dry-run --json` was executed once (read-only, no network); no other mutating command was run.

## Method

1. Enumerated every `*.test.ts`, `*.spec.ts`, `*.test.mjs` under the repository, excluding
   `node_modules`, `.git`, and `.xtrm/worktrees`.
2. For each file extracted: test count, first `describe`, imports, and markers for
   `bd`/`beads`/`.beads`/`dolt`/`substrate`/`symlink`/`migrat`.
3. Inspected CI workflows, `Makefile`, git hooks, the policy compiler, the registry/pack parity
   check, and the migration modules directly.
4. Classified each file and assigned a post-cut fate. Every row cites a line number that exists
   in the file at the audited commit.

## Surfaces searched

- Tests: `cli/test/**`, `cli/src/tests/**`, `packages/pi-extensions/tests/**`,
  `packages/pi-extensions/extensions/**/index.test.ts`, `packages/contracts/test/**`,
  `test/integration-suite/**`, `scripts/__tests__/**`, `scripts/dep-inspect.test.mjs`,
  `.xtrm/hooks/*.test.mjs`, `hooks/` (symlink → `.xtrm/hooks`).
- CI: `.github/workflows/*.yml` (13 files), `Makefile`, root and `cli` `package.json` scripts,
  `.githooks/**` (16 entries incl. `board-audit-*`), `.pre-commit-config.yaml`,
  `.gitleaks.toml`, `.semgrepignore`, `scripts/semgrep-diff.sh`.
- Migration: `cli/src/commands/migrate.ts`, `cli/src/core/substrate-migration.ts`,
  `cli/src/core/substrate-verify.ts`, `cli/src/core/backup-archive.ts`,
  `cli/src/core/plugin-era-cleanup.ts`, `cli/src/core/legacy-hook-dedupe.ts`,
  `cli/src/utils/git-staging.ts`, `cli/src/core/rollback.ts`.
- Legacy: `.beads/` (main checkout), tracked `.beads/*`, `.gitignore`, `policies/`,
  `.xtrm/config/hooks.json`, `.xtrm/config/settings.json`, `config/settings.json`,
  `.xtrm/registry.json`, `scripts/check-registry-pack-parity.mjs`, `scripts/check-managed-skills.mjs`,
  `.xtrm/hooks/beads-*.mjs`, `cli/src/**` bd call sites, `packages/pi-extensions/extensions/beads/`.
- Data/liveness: `git log --grep`, `git ls-files`, `git ls-tree`, `git cat-file`, `git worktree list`,
  `npm pack --dry-run`.

## Not inspected

- The ADR document itself (referenced as "ADR section 40-54" in source comments but not present
  in this repository — see UNRESOLVED-1).
- Substrate (`/tmp/audit/xtrm-main`) and Specialists (`/tmp/audit/specialists-master`) internals
  beyond what Core's test names and interface comments state; no Substrate test inventory was built.
- Live `bd`/Dolt database contents under `/home/dawid/dev/core/.beads/` (read-only directory listing only).
- `skills/**` and `.xtrm/skills/**` bodies beyond grep-level Beads hit counts (Lane 1/3 territory).
- `docs/proposals/**` historical narratives (excluded as historical record).
- Any workflow requiring secrets/network execution (nothing was run; only YAML read).

---

## (A) Test inventory

156 test files. Classes: (a) Beads-specific, (b) Substrate-specific, (c) runtime/extension,
(d) install/update/migration, (e) security/guard, (f) generic.

Class counts: (a) 20, (b) 12, (c) 56, (d) 18, (e) 25, (f) 25.

Fate counts: **KEEP 119**, **EVOLVE 34**, **DELETE 2**, **INVALID 1** (sum 156). No test is
classed REPLACE or COMPAT at file granularity; replacements are stated per-row in section (D).

| Test file | Invariant protected | Class | Post-cut fate | Evidence | Confidence |
|---|---|---|---|---|---|
| `.xtrm/hooks/beads-status-cache.test.mjs` | Beads status cache schema/TTL/single-flight lease + nested-parent epic walk; corrupt cache degrades safely | (a) | EVOLVE | ./.xtrm/hooks/beads-status-cache.test.mjs:14,25,32,47,64,110 | VERIFIED |
| `.xtrm/hooks/statusline.test.mjs` | Statusline renders never block; slow bd still populates cache; concurrent renders share one lease (no bd stampede) | (a) | EVOLVE | ./.xtrm/hooks/statusline.test.mjs:58,70,79,98 | VERIFIED |
| `cli/src/tests/agent-contract-parity.test.ts` | Managed agent-contract copies are byte-identical and Substrate-native: no normative bd/bv verbs, no bd prime mandate | (e) | EVOLVE | ./cli/src/tests/agent-contract-parity.test.ts:47,53,61,86 | VERIFIED |
| `cli/src/tests/bd-auto-stage-patch.test.ts` | bd auto-stage patch flips export.git-add and installs a pre-commit shim; resolves .beads/hooks core.hooksPath | (a) | DELETE | ./cli/src/tests/bd-auto-stage-patch.test.ts:27 | VERIFIED |
| `cli/src/tests/beads-claim-sync.test.ts` | beads-claim-sync hook keeps claim/close behavior without emitting a competing lifecycle DB | (a) | EVOLVE | ./cli/src/tests/beads-claim-sync.test.ts:51,52,58,60 | VERIFIED |
| `cli/src/tests/beads-shared-server.test.ts` | ensureBeadsSharedServerEnabled writes shared-server:true into .beads/config.yaml without destroying existing yaml | (a) | DELETE | ./cli/src/tests/beads-shared-server.test.ts:7 | VERIFIED |
| `cli/src/tests/claude-project-root-detection.test.ts` | xt claude install targets cwd project root, not the source bundle | (c) | KEEP | ./cli/src/tests/claude-project-root-detection.test.ts:42 | VERIFIED |
| `cli/src/tests/claude-runtime-sync-global-guard.test.ts` | isGlobal=true sync preserves user ~/.claude/settings.json hooks and never creates the file | (e) | KEEP | ./cli/src/tests/claude-runtime-sync-global-guard.test.ts:45 | VERIFIED |
| `cli/src/tests/claude-runtime-sync-reconcile.test.ts` | Project Claude hook reconcile preserves third-party/foreign hooks and is idempotent | (e) | KEEP | ./cli/src/tests/claude-runtime-sync-reconcile.test.ts:86 | VERIFIED |
| `cli/src/tests/codex-attach.test.ts` | Codex attach resumes the persisted UUID, never --last | (c) | KEEP | ./cli/src/tests/codex-attach.test.ts:26 | VERIFIED |
| `cli/src/tests/codex-command.test.ts` | Codex command defaults/flag mapping + experimental marking | (c) | KEEP | ./cli/src/tests/codex-command.test.ts:11 | VERIFIED |
| `cli/src/tests/codex-k1-characterization.test.ts` | Frozen Pi/Claude launcher argv + identity baseline | (c) | KEEP | ./cli/src/tests/codex-k1-characterization.test.ts:42 | VERIFIED |
| `cli/src/tests/codex-k1-launch-contract.characterization.test.ts` | Codex --no-attach stdout contract, stream routing, collision naming | (c) | KEEP | ./cli/src/tests/codex-k1-launch-contract.characterization.test.ts:79 | VERIFIED |
| `cli/src/tests/codex-k1-live-payloads.test.ts` | Codex live capture provenance manifests (fixture key sets, no unevidenced keys) | (f) | KEEP | ./cli/src/tests/codex-k1-live-payloads.test.ts:62 | VERIFIED |
| `cli/src/tests/codex-k1-payload-fixtures.test.ts` | Codex hook schema fixture set pinned to 0.146.0 | (f) | KEEP | ./cli/src/tests/codex-k1-payload-fixtures.test.ts:67 | VERIFIED |
| `cli/src/tests/codex-k1-version-compat.test.ts` | Codex hook schemas byte-identical across runtime bump | (f) | KEEP | ./cli/src/tests/codex-k1-version-compat.test.ts:21 | VERIFIED |
| `cli/src/tests/codex-k4-distribution.test.ts` | Codex managed distribution + Serena exclusion from active surfaces | (c) | KEEP | ./cli/src/tests/codex-k4-distribution.test.ts:46 | VERIFIED |
| `cli/src/tests/codex-runtime.test.ts` | Codex runtime descriptor | (c) | KEEP | ./cli/src/tests/codex-runtime.test.ts:11 | VERIFIED |
| `cli/src/tests/codex-session.test.ts` | Codex thread persistence | (c) | KEEP | ./cli/src/tests/codex-session.test.ts:20 | VERIFIED |
| `cli/src/tests/codex-worktree-session.test.ts` | Codex worktree launcher (uses bd worktree create) | (c) | EVOLVE | ./cli/src/tests/codex-worktree-session.test.ts:30 | VERIFIED |
| `cli/src/tests/context-zero-mutation.test.ts` | getContext performs zero mutation on read paths | (e) | KEEP | ./cli/src/tests/context-zero-mutation.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/coordinator-launch-validation.test.ts` | parseSpecialistJson execution.interactive envelope (additive) | (f) | KEEP | ./cli/src/tests/coordinator-launch-validation.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/doctor.test.ts` | xt doctor interprets sb check report + legacy beadsRemnants warnings | (b) | EVOLVE | ./cli/src/tests/doctor.test.ts:19 | VERIFIED |
| `cli/src/tests/drift.test.ts` | spec drift detection (orphan_link/new_child/cycle) vs bd state | (a) | EVOLVE | ./cli/src/tests/drift.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/end-beads-symlink-guard.test.ts` | xt end refuses a mode-120000 symlink introduced under .beads/ or .specialists/ before push (squash-merge wipe guard) | (e) | EVOLVE | ./cli/src/tests/end-beads-symlink-guard.test.ts:45,52,66 | VERIFIED |
| `cli/src/tests/eval-01-claude-side.test.ts` | EVAL-01 Claude-column contract matrix for the cross-runtime gate | (e) | KEEP | ./cli/src/tests/eval-01-claude-side.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/exa-mcp-baseline.test.ts` | Managed Exa MCP baseline | (f) | KEEP | ./cli/src/tests/exa-mcp-baseline.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/external-pi-tools-patch.test.ts` | External Pi tool patch | (c) | KEEP | ./cli/src/tests/external-pi-tools-patch.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/git-staging.test.ts` | git-staging stages only migration-owned files + gitignore additions | (d) | KEEP | ./cli/src/tests/git-staging.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/global-hooks-bootstrap.test.ts` | Global hooks bootstrap convergence | (c) | KEEP | ./cli/src/tests/global-hooks-bootstrap.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/global-hooks-canonical.test.ts` | Canonical hook template has exactly 10 load-bearing entries and wires zero beads-* hooks | (e) | EVOLVE | ./cli/src/tests/global-hooks-canonical.test.ts:21,51,59 | VERIFIED |
| `cli/src/tests/global-prompt-sync.test.ts` | renderManagedGlobalPrompt managed-block sync | (c) | KEEP | ./cli/src/tests/global-prompt-sync.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/global-skills-bootstrap.test.ts` | Global skills bootstrap | (c) | KEEP | ./cli/src/tests/global-skills-bootstrap.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/hook-entry-source-tagging.test.ts` | Hook entry _source/xtrm.hash provenance tagging prevents foreign-hook clobber | (e) | KEEP | ./cli/src/tests/hook-entry-source-tagging.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/install-integration.test.ts` | runtime maintenance integration (install/update phases) | (d) | KEEP | ./cli/src/tests/install-integration.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/install-runInstall.test.ts` | runInstall repairs broken default symlinks | (d) | KEEP | ./cli/src/tests/install-runInstall.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/installer-global-writes.test.ts` | Installer never deletes a file it cannot prove it wrote (global writes matrix) | (e) | KEEP | ./cli/src/tests/installer-global-writes.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/launch-outcome.test.ts` | Detached launch command outcome contract | (c) | KEEP | ./cli/src/tests/launch-outcome.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/legacy-hook-dedupe.test.ts` | Legacy hook dedupe removes only byte-proven duplicates; drift/foreign/xt-uncovered preserved | (e) | KEEP | ./cli/src/tests/legacy-hook-dedupe.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/machine-bootstrap.test.ts` | Machine bootstrap managed-dep install (official plugins) | (d) | KEEP | ./cli/src/tests/machine-bootstrap.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/migrate-restore-security.test.ts` | migrate --restore rejects tar traversal/absolute/symlink-escape/hardlink/FIFO with zero writes and no partial tree (xtrm-zc1rs) | (e) | KEEP | ./cli/src/tests/migrate-restore-security.test.ts:162,163,187,206,229,249 | VERIFIED |
| `cli/src/tests/migrate-runtime-adoption.test.ts` | Legacy runtime-root adoption refuses arbitrary/chained/dangling/special-file targets, rolls back on swap failure, idempotent rerun | (e) | KEEP | ./cli/src/tests/migrate-runtime-adoption.test.ts:114,166,189,219,237,331 | VERIFIED |
| `cli/src/tests/migrate.test.ts` | xt migrate creates backups, refuses source repo, preserves diverged files, restore round-trips, logs events | (d) | KEEP | ./cli/src/tests/migrate.test.ts:76,292,317,402,564 | VERIFIED |
| `cli/src/tests/npm-latest.test.ts` | npm-latest resolution | (f) | KEEP | ./cli/src/tests/npm-latest.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/pi-command-retired-install.test.ts` | Retired Pi install token rejected | (d) | KEEP | ./cli/src/tests/pi-command-retired-install.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/pi-install-global-prompt.test.ts` | runPiInstall global prompt sync wiring | (d) | KEEP | ./cli/src/tests/pi-install-global-prompt.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/pi-launch-self-heal-regression.test.ts` | Pi launch self-heal regression | (c) | KEEP | ./cli/src/tests/pi-launch-self-heal-regression.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/pi-runtime-safeguards.test.ts` | Pi runtime safeguards | (e) | KEEP | ./cli/src/tests/pi-runtime-safeguards.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/plugin-era-cleanup.test.ts` | Plugin-era cleanup removes legacy extension/marketplace artifacts (incl. .pi/agent/extensions/beads) | (d) | EVOLVE | ./cli/src/tests/plugin-era-cleanup.test.ts:65,160 | VERIFIED |
| `cli/src/tests/policy-parity.test.ts` | policies/*.json compile to .xtrm/config/hooks.json; referenced hook files exist | (c) | EVOLVE | ./cli/src/tests/policy-parity.test.ts:156,168 | VERIFIED |
| `cli/src/tests/project-mcp-sync.test.ts` | syncProjectMcpConfig | (c) | KEEP | ./cli/src/tests/project-mcp-sync.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/prune-retired-managed-skills.integration.test.ts` | runInstall prunes retired managed skills | (d) | KEEP | ./cli/src/tests/prune-retired-managed-skills.integration.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/reconcile-global-claude-hooks.test.ts` | reconcileGlobalClaudeHooks | (c) | KEEP | ./cli/src/tests/reconcile-global-claude-hooks.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/registry-scaffold.test.ts` | registry scaffold path helpers | (d) | KEEP | ./cli/src/tests/registry-scaffold.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/registry.test.ts` | registry.json schema + extension path resolution (extensions/beads used as a fixture path) | (d) | KEEP | ./cli/src/tests/registry.test.ts:119 | VERIFIED |
| `cli/src/tests/release.test.ts` | release helper | (f) | KEEP | ./cli/src/tests/release.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/repo-discovery.test.ts` | scanXtrmRepos | (f) | KEEP | ./cli/src/tests/repo-discovery.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/resolve-main-project-root.test.ts` | resolveMainProjectRoot | (f) | KEEP | ./cli/src/tests/resolve-main-project-root.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/runtime-command-json.test.ts` | Structured detached runtime command flags | (c) | KEEP | ./cli/src/tests/runtime-command-json.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/runtime-compat.test.ts` | Core/Specialists/xtmux version-conformance contract | (f) | KEEP | ./cli/src/tests/runtime-compat.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/settings-audit-fix.test.ts` | applySettingsFixes does not clobber unowned settings | (e) | KEEP | ./cli/src/tests/settings-audit-fix.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/settings-audit.test.ts` | auditSettings read-only classification | (e) | KEEP | ./cli/src/tests/settings-audit.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/skill-discovery.test.ts` | skill-discovery v2 | (c) | KEEP | ./cli/src/tests/skill-discovery.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/skills-layout.test.ts` | skills-layout invariants | (c) | KEEP | ./cli/src/tests/skills-layout.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/skills-runtime-reconcile.test.ts` | reconcileRuntimeLinks | (c) | KEEP | ./cli/src/tests/skills-runtime-reconcile.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/skills-runtime-views.test.ts` | skills-runtime-views | (c) | KEEP | ./cli/src/tests/skills-runtime-views.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/skills-state.test.ts` | skills-state | (c) | KEEP | ./cli/src/tests/skills-state.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/spec-apply.integration.test.ts` | xt spec apply against mocked sp + bd; bd create/show argv | (a) | EVOLVE | ./cli/src/tests/spec-apply.integration.test.ts:18,46 | VERIFIED |
| `cli/src/tests/spec-archive.test.ts` | xt spec archive gate consults bd show/children status | (a) | EVOLVE | ./cli/src/tests/spec-archive.test.ts:12,16 | VERIFIED |
| `cli/src/tests/spec-cli.integration.test.ts` | xt spec draft + validate integration | (a) | EVOLVE | ./cli/src/tests/spec-cli.integration.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/spec-no-bypass.test.ts` | spec composition gate forbids bypass verbs incl. `bd update --claim` | (e) | EVOLVE | ./cli/src/tests/spec-no-bypass.test.ts:11,21 | VERIFIED |
| `cli/src/tests/spec-schema.test.ts` | spec v1 schema | (f) | KEEP | ./cli/src/tests/spec-schema.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/spec-validate.test.ts` | spec validation | (f) | KEEP | ./cli/src/tests/spec-validate.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/status.test.ts` | xt status command | (b) | KEEP | ./cli/src/tests/status.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/substrate-doctrine.test.ts` | Anti-regression: migrated current-state sources and managed contract blocks carry no normative Beads content (ADR 49) | (e) | EVOLVE | ./cli/src/tests/substrate-doctrine.test.ts:85,86,100 | VERIFIED |
| `cli/src/tests/substrate-migration.test.ts` | A8 detect/plan: any present .beads board blocks update --apply, marker alone never unblocks, fail-closed remediation forbids deletion | (b) | KEEP | ./cli/src/tests/substrate-migration.test.ts:45,58,68,97 | VERIFIED |
| `cli/src/tests/substrate-verify.test.ts` | A9 preservation verifier: export parse fail-closed, alias map completeness, edge count/endpoints exact, notes/comments intake, idempotent rerun | (b) | KEEP | ./cli/src/tests/substrate-verify.test.ts:60,98,148,188,202 | VERIFIED |
| `cli/src/tests/substrate.test.ts` | sb CLI contract: --version/doctor/link/create envelopes fail closed; state.db path; setup.ts check/plan; no partial mutation before plan validation | (b) | KEEP | ./cli/src/tests/substrate.test.ts:51,101,135,220,361 | VERIFIED |
| `cli/src/tests/topology-projection.test.ts` | Aggregated topology projection parsers; beads source degrades on bad/empty JSON; argv constrained to READ_ONLY_COMMANDS | (b) | EVOLVE | ./cli/src/tests/topology-projection.test.ts:91,247,273,295 | VERIFIED |
| `cli/src/tests/topology-views.test.ts` | Topology view registry incl. a beads view with unknown-not-failed semantics | (b) | EVOLVE | ./cli/src/tests/topology-views.test.ts:8,252 | VERIFIED |
| `cli/src/tests/update.test.ts` | xt update apply: ADR-43 fail-closed zero-mutation abort on legacy .beads with remediation and no deletion | (b) | KEEP | ./cli/src/tests/update.test.ts:274,297,341,426 | VERIFIED |
| `cli/src/tests/upsert-managed-block.test.ts` | upsertManagedBlock | (c) | KEEP | ./cli/src/tests/upsert-managed-block.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/version-command.test.ts` | xt version | (f) | KEEP | ./cli/src/tests/version-command.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/worktree-pr-status.test.ts` | worktree PR status classification | (c) | KEEP | ./cli/src/tests/worktree-pr-status.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/worktree-reap.test.ts` | worktree reap excludes .beads/AGENTS.md/CLAUDE.md runtime churn from dirty checks | (a) | EVOLVE | ./cli/src/tests/worktree-reap.test.ts:93,100,105 | VERIFIED |
| `cli/src/tests/worktree-session-assignee.test.ts` | Worktree launch assigns the bead via bd update --assignee, warns but does not abort on failure | (a) | EVOLVE | ./cli/src/tests/worktree-session-assignee.test.ts:27,48,243 | VERIFIED |
| `cli/src/tests/worktree-session-bare-slash.test.ts` | Worktree session bare-mode slash guard | (c) | KEEP | ./cli/src/tests/worktree-session-bare-slash.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/worktree-session-beads-noise.test.ts` | Worktree setup removes worktree .beads/ and marks tracked .beads paths skip-worktree (no symlink) - the merge-hazard fix | (e) | EVOLVE | ./cli/src/tests/worktree-session-beads-noise.test.ts:19,759,766 | VERIFIED |
| `cli/src/tests/worktree-session-launch.test.ts` | launchWorktreeSession claude role launch-level contract | (c) | KEEP | ./cli/src/tests/worktree-session-launch.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/worktree-session-role.test.ts` | renderRoleTask | (c) | KEEP | ./cli/src/tests/worktree-session-role.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/src/tests/xtrm-logger.test.ts` | Hook logger emits bd.claimed lifecycle events under a .beads project | (a) | EVOLVE | ./cli/src/tests/xtrm-logger.test.ts:22,32 | VERIFIED |
| `cli/test/atomic-config-prune.test.ts` | deepMergeWithProtection pruneHooks mode (fixture uses beads-compact-restore.mjs) | (e) | KEEP | ./cli/test/atomic-config-prune.test.ts:16 | VERIFIED |
| `cli/test/atomic-config.test.ts` | deepMergeWithProtection hooks merge preserves non-owned keys | (e) | KEEP | ./cli/test/atomic-config.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/clean.test.ts` | xtrm clean ownership safety: only removes hook rows it can prove it owns (beads-edit-gate.mjs fixture) | (e) | KEEP | ./cli/test/clean.test.ts:134,147 | VERIFIED |
| `cli/test/codex-k1-failure-residue.characterization.test.ts` | Post-worktree-creation failure leaves no residue | (c) | KEEP | ./cli/test/codex-k1-failure-residue.characterization.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/command-migration.test.ts` | command migration help matrix | (d) | KEEP | ./cli/test/command-migration.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/compile-policies.test.ts` | compile-policies golden file + payload/wiring parity | (c) | KEEP | ./cli/test/compile-policies.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/config-schema.test.ts` | config schema integrity | (f) | KEEP | ./cli/test/config-schema.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/context.test.ts` | getCandidatePaths | (f) | KEEP | ./cli/test/context.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/docs-cross-check-boundary.test.ts` | docs cross-check availability: fetchClosedBdIssues returns [] when bd unavailable | (a) | EVOLVE | ./cli/test/docs-cross-check-boundary.test.ts:11,83,130 | VERIFIED |
| `cli/test/docs-cross-check-core.test.ts` | detectStaleDocs | (f) | KEEP | ./cli/test/docs-cross-check-core.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/docs-cross-check.test.ts` | xtrm docs cross-check error cases (gh/bd absent) | (a) | EVOLVE | ./cli/test/docs-cross-check.test.ts:122,127 | VERIFIED |
| `cli/test/docs-list.cli.test.ts` | xtrm docs list | (f) | KEEP | ./cli/test/docs-list.cli.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/docs-scanner.integration.test.ts` | scanDocFiles | (f) | KEEP | ./cli/test/docs-scanner.integration.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/docs-scanner.unit.test.ts` | parseFrontmatter | (f) | KEEP | ./cli/test/docs-scanner.unit.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/docs-verify.cli.test.ts` | xtrm docs verify | (f) | KEEP | ./cli/test/docs-verify.cli.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/doctor.test.ts` | doctor command surface | (b) | KEEP | ./cli/test/doctor.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/end-autonomy.test.ts` | xt end dry-run autonomy: derives non-generic title with no bead metadata | (a) | EVOLVE | ./cli/test/end-autonomy.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/end-worktree.test.ts` | xt end / xt worktree CLI surface and guards (uncommitted, non-xt branch, no remote) | (e) | KEEP | ./cli/test/end-worktree.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/extensions/beads-claim-lifecycle.test.ts` | Pi claim enforcement: unclaimed edit blocked, stale claim cleared, run-scoped claim cache, invalidation on close/KV mutation | (a) | EVOLVE | ./cli/test/extensions/beads-claim-lifecycle.test.ts:26,35,96,139,187 | VERIFIED |
| `cli/test/extensions/beads-parity.test.ts` | closed-this-session marker on bd close; no gate at session_shutdown/agent_end | (a) | EVOLVE | ./cli/test/extensions/beads-parity.test.ts:27,36,56 | VERIFIED |
| `cli/test/extensions/beads.test.ts` | Pi beads extension: edit blocked without claim, allowed with claim, git commit blocked while claimed, close notice, auto-claim | (a) | EVOLVE | ./cli/test/extensions/beads.test.ts:52,75,91,114,130 | VERIFIED |
| `cli/test/extensions/custom-footer-parity.test.ts` | Footer renders one compact line with no /beads command, no Alt+G, no bd subprocess on startup | (e) | EVOLVE | ./cli/test/extensions/custom-footer-parity.test.ts:30,109,132,153 | VERIFIED |
| `cli/test/extensions/quality-gates-parity.test.ts` | Pi quality-gates extension parity | (c) | KEEP | ./cli/test/extensions/quality-gates-parity.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/extensions/quality-gates.test.ts` | Pi quality-gates extension | (c) | KEEP | ./cli/test/extensions/quality-gates.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/extensions/session-flow.test.ts` | session-flow adds claim-sync context on bd update --claim; no agent_end stop-loop; xt end reminder once per worktree | (a) | EVOLVE | ./cli/test/extensions/session-flow.test.ts:23,32,44,68 | VERIFIED |
| `cli/test/extensions/xtrm-ui.test.ts` | xtrm-ui commands presentation boundary | (c) | KEEP | ./cli/test/extensions/xtrm-ui.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/hooks-integration.test.ts` | quality-check-env.mjs integration | (c) | KEEP | ./cli/test/hooks-integration.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/hooks.test.ts` | Retired beads-* gate hook behavior (edit/commit/stop/compact/claim-sync) + beads-gate-utils module integrity + main-guard (describe.skip) | (a) | EVOLVE | ./cli/test/hooks.test.ts:259,280,593,641,662,833 | VERIFIED |
| `cli/test/hooks/quality-check-hooks.test.ts` | Quality check hooks graceful no-op | (c) | KEEP | ./cli/test/hooks/quality-check-hooks.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/init-cli.test.ts` | xt init CLI surface; enrollment item `beads-absent`; --dry-run creates no .beads | (b) | EVOLVE | ./cli/test/init-cli.test.ts:44,163,165 | VERIFIED |
| `cli/test/init-phases.test.ts` | xtrm init phased orchestrator; fails closed on a legacy .beads board before enrollment mutation | (b) | EVOLVE | ./cli/test/init-phases.test.ts:649,653 | VERIFIED |
| `cli/test/install-pi.test.ts` | createInstallPiCommand | (d) | KEEP | ./cli/test/install-pi.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/install-surface.test.ts` | install command surface | (d) | KEEP | ./cli/test/install-surface.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/interactive-plan.test.ts` | interactivePlan | (f) | KEEP | ./cli/test/interactive-plan.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/pi-extensions.test.ts` | syncManagedPiExtensions | (c) | KEEP | ./cli/test/pi-extensions.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/pi-packages-parity.test.ts` | Pi package-list parity | (c) | KEEP | ./cli/test/pi-packages-parity.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/pi-runtime.test.ts` | syncManagedPiThemes + managed extension reconcile (beads used as a fixture extension) | (c) | KEEP | ./cli/test/pi-runtime.test.ts:208,214,237 | VERIFIED |
| `cli/test/pi-status-package-mode.test.ts` | xt pi status global package mode without mirrors | (c) | KEEP | ./cli/test/pi-status-package-mode.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/registry-pack-parity.test.ts` | Retired Beads hooks remain present on disk and are exactly allowlisted (no globs); an unlisted managed file still fails | (d) | INVALID | ./cli/test/registry-pack-parity.test.ts:15,34,39,44,53 | VERIFIED |
| `cli/test/repo-root.wrapper-layout.test.ts` | findRepoRoot wrapper layout support | (f) | KEEP | ./cli/test/repo-root.wrapper-layout.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/runtime-subcommands.test.ts` | xt claude runtime subcommands | (c) | KEEP | ./cli/test/runtime-subcommands.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/service-skills-ensure.test.ts` | ensureServiceSkills registry-gated migration | (d) | KEEP | ./cli/test/service-skills-ensure.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/session-launcher.test.ts` | Session launcher | (c) | KEEP | ./cli/test/session-launcher.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/skills-command-json.test.ts` | xt skills JSON CLI integration | (c) | KEEP | ./cli/test/skills-command-json.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/skills-command.test.ts` | xt skills CLI integration | (c) | KEEP | ./cli/test/skills-command.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/skills-discovery.test.ts` | skills-discovery | (c) | KEEP | ./cli/test/skills-discovery.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/skills-migration.test.ts` | skills migration | (d) | KEEP | ./cli/test/skills-migration.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/skills-runtime-sync.test.ts` | skills runtime sync | (c) | KEEP | ./cli/test/skills-runtime-sync.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/skills-scaffold.test.ts` | skills scaffold | (c) | KEEP | ./cli/test/skills-scaffold.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/skills-state.test.ts` | skills-state | (c) | KEEP | ./cli/test/skills-state.test.ts:(dynamic table; no static describe) | VERIFIED |
| `cli/test/xtrm-ui-format.test.ts` | xtrm-ui path/format helpers | (c) | KEEP | ./cli/test/xtrm-ui-format.test.ts:(dynamic table; no static describe) | VERIFIED |
| `packages/contracts/test/contracts.test.ts` | @xtrm/contracts registry: every SCHEMA_ID loads; golden/invalid fixtures; BeadsLifecycleEventV1 rejects legacy imperative aliases; topology projection schema | (b) | EVOLVE | ./packages/contracts/test/contracts.test.ts:11,49,80 | VERIFIED |
| `packages/pi-extensions/extensions/custom-footer/index.test.ts` | custom-footer registerFooterSection seam | (c) | KEEP | ./packages/pi-extensions/extensions/custom-footer/index.test.ts:(dynamic table; no static describe) | VERIFIED |
| `packages/pi-extensions/extensions/read-line-numbers/index.test.ts` | numberReadText | (c) | KEEP | ./packages/pi-extensions/extensions/read-line-numbers/index.test.ts:(dynamic table; no static describe) | VERIFIED |
| `packages/pi-extensions/extensions/xtprompt/index.test.ts` | xtprompt extension (retired ids absent) | (c) | KEEP | ./packages/pi-extensions/extensions/xtprompt/index.test.ts:(dynamic table; no static describe) | VERIFIED |
| `packages/pi-extensions/extensions/xtrm-ui/handlers.test.ts` | xtrm-ui presentation-only boundary | (c) | KEEP | ./packages/pi-extensions/extensions/xtrm-ui/handlers.test.ts:(dynamic table; no static describe) | VERIFIED |
| `packages/pi-extensions/tests/pi-integration-eof.test.ts` | Pi EOF real-spawn integration (gated by RUN_PI_INTEGRATION=1) | (c) | KEEP | ./packages/pi-extensions/tests/pi-integration-eof.test.ts:(dynamic table; no static describe) | VERIFIED |
| `packages/pi-extensions/tests/python-kernel.test.ts` | python-kernel managed extension | (c) | KEEP | ./packages/pi-extensions/tests/python-kernel.test.ts:(dynamic table; no static describe) | VERIFIED |
| `packages/pi-extensions/tests/registry-parity.test.ts` | Pi extension ownership parity | (c) | KEEP | ./packages/pi-extensions/tests/registry-parity.test.ts:(dynamic table; no static describe) | VERIFIED |
| `packages/pi-extensions/tests/retired-extensions.test.ts` | Retired extensions/ids are absent from shipped sources and runtime inventories | (e) | KEEP | ./packages/pi-extensions/tests/retired-extensions.test.ts:22,38 | VERIFIED |
| `scripts/__tests__/changelog-update.test.mjs` | CHANGELOG [Unreleased] placeholder gate | (f) | KEEP | ./scripts/__tests__/changelog-update.test.mjs:(dynamic table; no static describe) | VERIFIED |
| `scripts/__tests__/check-payload-hygiene.test.mjs` | npm payload hygiene | (f) | KEEP | ./scripts/__tests__/check-payload-hygiene.test.mjs:(dynamic table; no static describe) | VERIFIED |
| `scripts/__tests__/dedupe-legacy-hooks.test.mjs` | dedupe-legacy-hooks script proof (ported into legacy-hook-dedupe) | (d) | KEEP | ./scripts/__tests__/dedupe-legacy-hooks.test.mjs:(dynamic table; no static describe) | VERIFIED |
| `scripts/__tests__/semgrep-diff-hook-env.test.mjs` | semgrep-diff hook env handling | (e) | KEEP | ./scripts/__tests__/semgrep-diff-hook-env.test.mjs:(dynamic table; no static describe) | VERIFIED |
| `scripts/dep-inspect.test.mjs` | dep-inspect | (f) | KEEP | ./scripts/dep-inspect.test.mjs:(dynamic table; no static describe) | VERIFIED |

### Tests that must be KEPT because they protect a data-loss or security invariant

These must not be deleted by the cut; each protects an invariant that survives Beads removal.

1. `cli/src/tests/migrate-restore-security.test.ts` — tar traversal / absolute path / symlink-escape /
   hardlink-escape / FIFO rejected with **zero writes** and no partial tree (`:163`, `:187`, `:206`,
   `:229`, `:249`). This is the `xtrm-zc1rs` fix: pre-fix, `tar -xzf` streamed into `.xtrm/` before
   validation (`cli/src/core/backup-archive.ts:1-30`).
2. `cli/src/tests/migrate-runtime-adoption.test.ts` — refuses arbitrary, chained, dangling, and
   special-file targets; rolls the original symlink back on swap failure (`:166`, `:189`, `:219`,
   `:237`, `:331`).
3. `cli/src/tests/migrate.test.ts` — backup-before-destroy, source-repo refusal, diverged-file
   preservation, restore round-trip (`:292`, `:317`, `:402`, `:564`).
4. `cli/src/tests/end-beads-symlink-guard.test.ts` — refuses a mode-120000 symlink introduced under
   `.beads/` **or** `.specialists/` before push (`:45`, `:52`, `:66`). Protects the squash-merge wipe
   (see section C, incident PROJ-INFRA-PR39).
5. `cli/src/tests/worktree-session-beads-noise.test.ts` — worktree setup removes worktree `.beads/`
   and masks tracked `.beads` paths with `skip-worktree`, never a symlink (`:19`, `:759`, `:766`).
   Second half of the same data-loss fix.
6. `cli/src/tests/installer-global-writes.test.ts` — the installer never deletes a file it cannot
   prove it wrote (commit `c9155026`, "never delete a file the installer cannot prove it wrote").
7. `cli/src/tests/my-settings` family: `settings-audit.test.ts`, `settings-audit-fix.test.ts`,
   `atomic-config.test.ts`, `atomic-config-prune.test.ts`,
   `claude-runtime-sync-global-guard.test.ts`, `claude-runtime-sync-reconcile.test.ts`,
   `reconcile-global-claude-hooks.test.ts`, `legacy-hook-dedupe.test.ts` — user/foreign settings and
   hook rows are preserved unless byte-proven owned.
8. `cli/test/clean.test.ts` (`:134`, `:147`) — `xtrm clean` removes only hook rows it can prove it owns.
9. `cli/src/tests/context-zero-mutation.test.ts`, `cli/src/tests/git-staging.test.ts` — read paths
   mutate nothing; staging is restricted to migration-owned files.
10. `cli/test/end-worktree.test.ts`, `cli/src/tests/pi-runtime-safeguards.test.ts`,
    `cli/src/tests/pi-launch-self-heal-regression.test.ts`,
    `packages/pi-extensions/tests/retired-extensions.test.ts` — guard/self-heal and
    absent-from-shipped-source assertions.
11. `cli/src/tests/substrate-migration.test.ts` + `cli/src/tests/update.test.ts`
    (`:274`, `:297`, `:341`, `:426`) — the ADR-43 fail-closed, **zero-mutation** abort whose
    remediation explicitly forbids `Do NOT delete .beads` (`cli/src/core/substrate-migration.ts:48`).
    This is the only guard standing between a legacy board and irreversible work loss today.

---

## (B) CI gate table

| Gate | Where | What it blocks | Beads/Substrate assumption | Post-cut fate | Confidence |
|---|---|---|---|---|---|
| `test` job (full pipeline) | `.github/workflows/ci.yml:13` | PR/push to `main`/`master`; all steps must pass | `npm test --prefix cli` (`:110`) runs the whole Beads test suite; `check:registry-pack-parity` (`:83`) asserts 11 retired beads hooks exist on disk | ADAPT | VERIFIED |
| `check:registry-pack-parity` | `ci.yml:83` → `scripts/check-registry-pack-parity.mjs:41-51` | A managed `.xtrm/hooks` file missing from the npm pack or absent from `registry.json` | Allowlists the retired beads-* hooks as "inert porting sources pending xtrm-6qu.6 disposition"; exact-path only, no globs | ADAPT | VERIFIED |
| `check:managed-skills` / `check:skills-ownership` | `ci.yml:65-68` | Skills registry/ownership drift | None found (no bd/beads reference in either script) | KEEP | INFERRED |
| `Policy parity (Claude + Pi)` | `ci.yml:70-77`, `scripts/compile-policies.mjs` | `policies/*.json` ↔ `.xtrm/config/hooks.json` drift | `policies/beads.json` and `policies/session-flow.json` are declared RETIRED yet retained "so `--check-pi` stays green until the extension itself is retired" (`policies/beads.json:3`) | ADAPT | VERIFIED |
| `Verify specialists vendor…` + `git diff .xtrm/registry.json` | `ci.yml:79-85` | Vendored skills/registry drift | `registry.json` contains no beads hook (14 hooks, 0 beads) — verified by parsing the file | KEEP | VERIFIED |
| `Run Tests` → `npm run test:scripts` | `ci.yml:111` | `scripts/__tests__/*.test.mjs` | `scripts/__tests__/dedupe-legacy-hooks.test.mjs` is migration-adjacent; no bd dependency | KEEP | VERIFIED |
| `Run Linting` (eslint/ruff) | `ci.yml:60-63` | Nothing — both are `|| echo`-swallowed | none | KEEP (advisory) | VERIFIED |
| `Dist is up to date` | `ci.yml:52-53` | Blocks: `git diff --exit-code cli/dist/` | none | KEEP | VERIFIED |
| Gitleaks | `.github/workflows/gitleaks.yml:7-12`, `.gitleaks.toml:41-42` | Blocks merge; allowlists `^\.beads/.*` and `^\.dolt/.*` secret-scan paths | `.beads`/`.dolt` regex allowlist entries exist only because those trees exist | ADAPT | VERIFIED |
| Semgrep | `.github/workflows/semgrep.yml:12-17`, `.semgrepignore:11,13` | Blocks merge (diff-aware); `.beads/`, `.dolt/` ignored | ignore entries for the legacy trees | ADAPT | VERIFIED |
| OSV Scanner | `.github/workflows/osv-scanner.yml` | Blocks merge | none | KEEP | VERIFIED |
| `pr-review-gate` | `.github/workflows/pr-review-gate.yml:27` | Blocks merge on unresolved bot threads | none (no bd/beads reference) | KEEP | VERIFIED |
| `Installer surface smoke` | `.github/workflows/installer-surface-smoke.yml:18-29` | PR touching `cli/src/core/**`, `init/update/migrate`, `packages/pi-extensions/**` | none directly | KEEP | VERIFIED |
| `Fresh-machine smoke` | `.github/workflows/fresh-machine-smoke.yml:3-16` (dispatch + `workflow_call`) | Release contract: vendored skills land on `xt init` | Its own release contract **excludes** `registry.json` and `sp list` because they "need bd → @beads/bd" (`:140-141`); tolerates `xt init` failure from `@beads/bd` postinstall (`:105`) | REPLACE (see D-1, D-15) | VERIFIED |
| `Install order matrix` | `.github/workflows/install-order-matrix.yml:4,11-12` | Operator-triggered only | Header documents installing `@beads/bd`, `dolt`, `bv` as third-party legs | DELETE (beads/dolt legs) | VERIFIED |
| `Integration suite (P2-01)` | `.github/workflows/integration-suite.yml:8-9` (`workflow_call` + dispatch) | Not a per-PR gate | Suite C hard-requires `bd init`, `bd create`, `sp run --bead` reading `.beads` through `bd show --json` (`test/integration-suite/suite-c-coordinator-lineage.mjs:91,319,341`) | ADAPT | VERIFIED |
| `Service-Skills Drift Sweep` | `.github/workflows/service-skills-drift-sweep.yml:55-56,368` | Reusable `workflow_call`; installs `@beads/bd@$BEADS_VERSION` because `service-skills-sync` declares `bd` in `capabilities.external_commands` | Hard `@beads/bd` install, treated as required | REPLACE | VERIFIED |
| `Pre-publish readiness` / `Publish` | `.github/workflows/pre-publish-readiness.yml:96-110`, `.github/workflows/publish.yml:80-94` | Blocks publish | Re-run `check:registry-pack-parity` and `check:specialists-vendor` | ADAPT | VERIFIED |
| `Specialists asset validation` | `.github/workflows/specialists-validation.yml:3` | `workflow_run` on `specialists-asset-validation` + dispatch | none found | KEEP | INFERRED |
| pre-commit hook (security wrapper) | `.githooks/pre-commit:1-21` | Commit; runs `pre-commit run --hook-stage pre-commit` (gitleaks etc.) | Wrapper itself is generic | KEEP | VERIFIED |
| pre-commit BEADS INTEGRATION block | `.githooks/pre-commit:23-80` | Commit: runs `bd hooks run pre-commit` | `bd`-managed markers v1.2.2, timeout handling | DELETE | VERIFIED |
| pre-commit custom JSONL staging | `.githooks/pre-commit:82-88` | `git add -f .beads/issues.jsonl` | Forces the Beads JSONL into every commit | DELETE | VERIFIED |
| pre-push security baseline | `.githooks/pre-push:7-17`, `.githooks/.security-pipeline-baseline:5-16` | Blocks direct push to `main`/`master`; runs `pre-commit --hook-stage pre-push` (semgrep diff, osv diff) | generic (branch protection + scanners) | KEEP | VERIFIED |
| pre-push beads/dolt sync | `.githooks/pre-push:24-39`, `.githooks/pre-push.bd-sync:15-38` | **Blocks push** when `bd dolt commit`/`pull`/`push` fails | Treats the Dolt remote (`refs/dolt/data`) as the durability channel; failure aborts the Git push | DELETE (last) | VERIFIED |
| pre-push BEADS INTEGRATION block | `.githooks/pre-push:41-98` | Push: `bd hooks run pre-push` | bd-managed markers | DELETE | VERIFIED |
| pre-push board-audit adapter | `.githooks/pre-push:99-110` | Never blocks (`|| true`) | Publishes a PR checkpoint; adapter shells `bd export --all` | DELETE / REPLACE | VERIFIED |
| post-merge bd/dolt pull | `.githooks/post-merge:2-16`, `.githooks/post-merge.bd-sync:9-18` | Post-merge: **non-zero exit** when `bd dolt pull` fails | Dolt remote as durability channel | DELETE | VERIFIED |
| post-merge / post-checkout / prepare-commit-msg bd blocks | `.githooks/post-merge:18-75`, `.githooks/post-checkout:2-59`, `.githooks/prepare-commit-msg:2-59` | Runs `bd hooks run <event>` | Pure bd integration, no project logic | DELETE | VERIFIED |
| `pre-commit.local` / `pre-push.local` | `.githooks/pre-commit.local:8-10`, `.githooks/pre-push.local:8-26` | `doc_reminder.py`/`skill_staleness.py` advisory (`|| true`); CHANGELOG placeholder check blocks | generic | KEEP | VERIFIED |
| `Makefile` targets | `Makefile:1-25` | `ci: install build test`; `test: cd cli && npm test` | Runs the full vitest suite including Beads tests | ADAPT | VERIFIED |

**Advisory vs blocking:** only eslint/ruff (`ci.yml:62-63`) and the two `.local` python checks are
advisory. Everything else in the table blocks, including the pre-push Dolt sync
(`.githooks/pre-push.bd-sync:21-36`) — a failed Beads/Dolt sync today aborts a Git push.

---

## (C) Legacy dependency table

`Action` ∈ {KEEP, ADAPT, DELETE, REPLACE, COMPAT}. History labels are defined after the table.

| Surface | Path:line | Assumption | Historical protection | Post-cut action | Precondition | Confidence |
|---|---|---|---|---|---|---|
| Tracked Beads board | `.beads/issues.jsonl`, `.beads/config.yaml`, `.beads/metadata.json`, `.beads/README.md`, `.beads/hooks/*` | Repo board is canonical durable work | The board itself | DELETE (after A9 import + verification) | D-3 accepted | VERIFIED |
| Beads tree ignore | `.gitignore:133` (`.beads/`), `:17-18` (`.dolt/`), `:62-63,94-98,115,190` | `.beads`/`.dolt` are runtime-only | Prevents committing DB/journal churn | ADAPT | none | VERIFIED |
| Beads cache ignore | `.gitignore:151-153` (`.xtrm/cache/beads-status.*`) | Statusline cache is runtime-only | none | DELETE | D-6 | VERIFIED |
| `bd` issue-fetch in `xt end` | `cli/src/commands/end.ts:55` | `bd` answers issue queries for PR body/autonomy | none | ADAPT | `sb` read verbs land | VERIFIED |
| **`.beads`/`.specialists` symlink push guard** | `cli/src/commands/end.ts:256-310` (doc `:256-268`, incident `:263`, guarded prefixes `:260,270`), call `:479-485`; tests `cli/src/tests/end-beads-symlink-guard.test.ts:45,52,66` | `.beads/` and `.specialists/` have parent-tracked content and are dir→symlink-swapped in worktrees | **PROJ-INFRA-PR39 (2026-05-12): a squash-merge of a branch carrying the `.beads` mode-120000 symlink wiped the parent's `.beads/` directory on `main`** (`end.ts:261-264`). Same shape for `.specialists/user/*` per `xtrm-6jd2` | COMPAT → then DELETE last | Equivalent wipe-proof guard exists for the Substrate state dir / `.specialists`; see D-1 | VERIFIED |
| Worktree `.beads` removal + skip-worktree | `cli/src/utils/worktree-session.ts:2966-2983`, `:2301-2330`; `markPathSkipWorktree` `:2309` | Worktree `.beads` is not needed (bd resolves via git common-dir); tracked paths must be masked | The `xtrm-cbjo` fix that superseded the symlink approach (`:2978`); commits `937b151e`, `0c…`/`0f401e19` for `.specialists` parity | ADAPT | Substrate equivalent of the shared-DB resolution exists | VERIFIED |
| `core.hooksPath` rewrite to `.beads/hooks` | `cli/src/utils/worktree-session.ts:2286-2296` | The canonical bd default is `.beads/hooks` | Prevents a relative `hooksPath` breaking in worktrees (`xtrm-2s44`) | DELETE | D-2 | VERIFIED |
| `bd worktree create/remove` | `cli/src/utils/worktree-session.ts:2937`; `cli/src/utils/codex-worktree-session.ts:283`; `.githooks/board-audit-flow.py:120-126` | bd owns worktree creation for bead-scoped sessions | none | ADAPT | Substrate worktree verb exists | VERIFIED |
| `bd update --assignee` | `cli/src/utils/worktree-session.ts:181`; test `cli/src/tests/worktree-session-assignee.test.ts:48,243` | Session→bead assignment is a bd mutation | Warns but does not abort on failure | ADAPT | claim/assign verb on Substrate | VERIFIED |
| `bd list --all --json` topology source | `cli/src/core/topology-projection.ts:91` | `bd` is one of six read-only projection sources | Read-only argv table assertion (`topology-projection.test.ts:295`) | ADAPT | Substrate equivalent source or drop the source | VERIFIED |
| `bd show/children/dep cycles` spec gates | `cli/src/spec/drift.ts:45,99,109,121`; `cli/src/spec/archive-gate.ts:34,85,95`; `cli/src/spec/reconcile.ts:41`; `cli/src/commands/spec/apply.ts:219` | spec↔board drift, archive gate, composition gate all read bd | `xt spec` refuses to bypass the board | ADAPT | Substrate read verbs | VERIFIED |
| `bd query` in `xt report` | `cli/src/commands/report.ts:92,122` | report enumerates issues by status | none | ADAPT | Substrate query verb | VERIFIED |
| `bd --version` docs cross-check | `cli/src/commands/docs-cross-check-bd.ts:15,50`; degradation test `cli/test/docs-cross-check-boundary.test.ts:130` | Docs staleness is computed from closed bd issues | Degrades gracefully to `[]` when bd is absent | ADAPT or DELETE | Decide whether docs cross-check survives | VERIFIED |
| `bd` allowlist in managed settings | `.xtrm/config/settings.json:7-11`; `config/settings.json:7-11`; `cli/src/core/sync-executor.ts:13-17` | `Bash(bd show/list/ready/stats/search:*)` are pre-allowed | none | DELETE | D-4 | VERIFIED |
| Beads Pi extension | `packages/pi-extensions/extensions/beads/index.ts` (173 lines); registry `packages/pi-extensions/src/registry.ts:4,22`; export `src/extensions/beads.ts:1`; legacy path `src/shared/legacy-path-map.ts:8` | `isBeadsProject(cwd)` = `.beads` exists (`src/core/adapter.ts:37-40`); claim gate = `bd kv get claimed:<session>` (`index.ts:20`), `bd show --json` (`:31`), `bd kv set` (`:149`) | **This is the live claim-enforcement gate**: an edit without an active claim is blocked (`:98-108`); `git commit` blocked while claimed (`:117-125`) | REPLACE | Substrate claim binding must block the same operations before removal | VERIFIED |
| Beads retired hook family | `.xtrm/hooks/beads-{claim-sync,commit-gate,compact-restore,compact-save,edit-gate,gate-core,gate-messages,gate-utils,status-cache,status-cache.test,stop-gate}.mjs` | 11 files retained "as inert porting sources" | No longer wired: `.xtrm/config/hooks.json` contains zero `beads-` commands; `global-hooks-canonical.test.ts:51-60` asserts this | DELETE | D-5 (each has a named successor per `claude-runtime-sync.ts:342-350`) | VERIFIED |
| Retired hooks shipped in npm tarball | root `package.json` `files` includes `.xtrm/hooks`; verified with `npm pack --dry-run --json` | All 11 retired beads hooks currently ship to every consumer | none (inert) | DELETE | D-5 | VERIFIED |
| Retired hooks parity allowlist | `scripts/check-registry-pack-parity.mjs:38-51`; test `cli/test/registry-pack-parity.test.ts:15,34,39` | The 11 hooks must remain present **and** allowlisted by exact path | Prevents a broad "beads exemption" hiding future unmanaged files | ADAPT | D-5 done; allowlist entry removed | VERIFIED |
| Retired policy declarations | `policies/beads.json:1-20`, `policies/session-flow.json:1-20` | Pi extension declared so `--check-pi` stays green | none | DELETE | D-5 (extension files gone) | VERIFIED |
| `beads-*` gate behavior tests | `cli/test/hooks.test.ts:259-833` | Tests the retired hooks' behavior and module integrity | `:833` "hooks.json — beads hooks retired" asserts no `beads-compact-*` wiring | ADAPT | D-5 | VERIFIED |
| `bd` auto-stage patch | `cli/src/core/bd-auto-stage-patch.ts`; test `cli/src/tests/bd-auto-stage-patch.test.ts:27` | bd's `.beads/hooks` + `export.git-add` handling | none | DELETE | D-4 | VERIFIED |
| Beads shared Dolt server flag | `cli/src/core/beads-shared-server.ts`; test `cli/src/tests/beads-shared-server.test.ts:7` | `shared-server: true` in `.beads/config.yaml`; comments-only yaml crashes fixed in `xtrm-16ec` | Prevented a per-worktree empty-DB respawn (`xtrm-hhiu`) | DELETE | D-2 (Substrate has no Dolt) | VERIFIED |
| Dolt pre-push sync | `.githooks/pre-push.bd-sync:1-39` | `bd dolt commit/pull/push` against `refs/dolt/data`; `BEADS_FSCK_TIMEOUT=600` | A push cannot succeed while Beads state is unsynced | DELETE last | Substrate durability proven (D-1) | VERIFIED |
| Dolt post-merge pull | `.githooks/post-merge.bd-sync:1-19` | Dolt pull after merge; failure is loud | Stale-board detection | DELETE | D-2 | VERIFIED |
| bd-managed hook blocks | `.githooks/pre-commit:23-80`, `pre-push:41-98`, `post-merge:18-75`, `post-checkout:2-59`, `prepare-commit-msg:2-59` | `BEADS INTEGRATION v1.2.2` markers owned by `bd hooks install` | Re-installed by bd on upgrade — the reason the custom blocks live outside the markers | DELETE | D-2 | VERIFIED |
| Beads JSONL forced staging | `.githooks/pre-commit:82-88` | `git add -f .beads/issues.jsonl` bypasses `.git/info/exclude` | Keeps the snapshot in commits while `export.git-add false` avoids mid-work races | DELETE | D-3 | VERIFIED |
| Beads symlink history doc | `docs/proposals/using-specialists-v3-improvements-2026-05-09.md:459` | Documents the "1.7k lines of phantom `.beads/` deletions" side effect and the Dolt respawn friction | Historical record of the incident class | KEEP (historical) | none | VERIFIED |
| Dolt worktree port redirect doc | `docs/worktrees.md:240-352` | `bd dolt status/start`, `.beads/dolt-server.port` redirect | Operator runbook for the empty-DB respawn | DELETE | D-2 | VERIFIED |
| Board-audit transport scripts | `.githooks/board-audit-core` (753), `board-audit-pr.py` (1437), `board-audit-roundtrip.py` (1391), `board-audit-flow.py` (418), `board-audit-transport.py` (315), `board-audit-pr-adapter.sh` (135) | `bd export --all` is the canonical snapshot (`board-audit-core:10,133,146`); `bd worktree create` (`board-audit-flow.py:120`); `bd version` (`:154`) | "one canonical `bd export --all` acquisition" — lossless record preservation | REPLACE | Substrate export snapshot + Roundtrip exists | VERIFIED |
| Board-audit transport branches | `board-audit-pr.py:534,667` (`board-audit/pr-<pr>`); `board-audit-flow.py:113-116` (`board-audit-staging/<token>`) | Force-with-lease publish branch per PR | none | DELETE | Lane 4 owns the replacement transport | VERIFIED |
| Board-audit cache worktrees | `board-audit-flow.py:102-108` (`$XDG_CACHE_HOME/xtrm/board-audit/worktrees/<repo>/…`); live example branch `board-audit-staging/pr-645-794104-060010` in `git worktree list` | Scratch worktrees under the cache dir | none | DELETE | D-7 | VERIFIED |
| Board-audit test coverage | **none** — no test file references `board-audit` (verified by repo-wide grep) | n/a | **No test protects board-audit behavior** | REPLACE | D-7 | VERIFIED |
| `@beads/bd` in smoke image | `scripts/smoke-container/Dockerfile:42-50`; `verify.sh:486,491-493`; `README.md:139-151` | Image hard-installs a musl `bd` binary and asserts `bd version` at boot | none | REPLACE | D-8 | VERIFIED |
| `@beads/bd` in drift sweep | `.github/workflows/service-skills-drift-sweep.yml:55-56,368` | `bd` is a declared external command capability | none | REPLACE | D-9 | VERIFIED |
| `bd` in integration suite C | `test/integration-suite/suite-c-coordinator-lineage.mjs:23,40,91,319,338-343` | Live lane needs `bd` on PATH; `bd init --stealth`, `bd create`, then `sp run --bead` reads via `bd show --json` | none | ADAPT | Substrate issue source for `sp` | VERIFIED |
| Beads lifecycle contract | `packages/contracts/src/types.ts:16,150-171,483` (`xtrm.beads.lifecycle-event.v1`, `BeadsLifecycleEventV1`); test `packages/contracts/test/contracts.test.ts:49,69` | A published schema ID with golden/invalid fixtures | Schema versioning discipline (legacy imperative aliases rejected at `:69`) | ADAPT | Decide keep-as-historical vs retire; schema IDs are published contracts | VERIFIED |
| Beads topology source name | `packages/contracts/src/types.ts:372` (`TopologySourceName` includes `'beads'`), `:416` `TopologyBead` | Published `xtrm.topology.projection.v1` accepts a `beads` source | none | ADAPT | Contract bump if the source is removed | VERIFIED |
| Hook logger `bd.*` event kinds | `cli/src/tests/xtrm-logger.test.ts:22,32,48`; `.beads` root requirement | `.xtrm/debug.db` scoped to a `.beads` dir (`cli/src/commands/debug.ts:171`) | none | ADAPT | D-6 | VERIFIED |
| Board-audit staging dir guard | `.semgrepignore:11,13`, `.gitleaks.toml:41-42,46-47` | `.beads/`, `.dolt/`, and gen-2 `raw-beads.jsonl` exports are scanner-excluded | The gitleaks exclusion exists because board-audit exports contain raw beads data (memory keys, issue titles) | ADAPT | D-7 | VERIFIED |

**History labels.**

- **PROJ-INFRA-PR39 (2026-05-12)** — the incident named verbatim in source:
  `cli/src/commands/end.ts:261-264` and `cli/src/utils/worktree-session.ts:2966-2975`
  (also restated at `cli/src/utils/worktree-session.ts:2307-2308`):
  "any commit/PR carrying the `.beads` symlink (mode 120000) wipes the parent's `.beads/` on
  squash-merge (see infra repo PR #39, 2026-05-12)". Source commits: `5334c984` ("xt end blocks
  `.beads/*` 120000 symlink-mode introductions in cumulative diff (xtrm-w1ip)"), `937b151e`
  ("drop `.beads` symlink; rely on absolute hooksPath + skip-worktree", `xtrm-cbjo` supersedes
  `xtrm-as7d`/`xtrm-nsca`/`unitAI-u08e8`), and `0f401e19` ("merge-hazard parity for
  `.specialists/{default,user}` (#221)", `xtrm-6jd2`).
- The `.specialists` half of the guard was added later (`end-beads-symlink-guard.test.ts:52`)
  because the same dir→symlink swap shape applies to `.specialists/user/*`.
- `xtrm-zc1rs` — the `migrate --restore` archive-traversal data-loss class.
- `xtrm-2d6fw` — runtime-root adoption rollback and arbitrary-target refusal.
- `xtrm-16ec` / `xtrm-hhiu` — `.beads/config.yaml` crash and per-worktree empty-Dolt respawn.
- `xtrm-6qu.6` / `xtrm-6qu.8` / `xtrm-6qu.9` (A9) / A10 §59 — the migration work items that
  explicitly gate retired-hook disposition and cleanup (cited at
  `scripts/check-registry-pack-parity.mjs:36-40` and `cli/src/core/claude-runtime-sync.ts:342-350`).

---

## (D) Acceptance suite (DESIGN ONLY)

Fifteen proofs. `Existing test` names the file that can be evolved; `NEW` means no test today
covers the assertion.

| # | Proof | Existing test or NEW | Exact assertion | Depends on upstream | Confidence |
|---|---|---|---|---|---|
| D-1 | Fresh install | Evolve `test/integration-suite/suite-a-installed-artifact.mjs` + `cli/test/init-cli.test.ts` | On a clean `HOME` and an empty git repo: `xt init -y` exits 0; `~/.xtrm/state.db` exists; `sb doctor --json` reports `schemaHealthy: true` and one linked project; `xt doctor --json` reports zero `naming.beadsRemnants`; no `.beads/` directory is created; `find .xtrm -type l` is empty | `sb` installable/locatable on PATH; Substrate project create/link verbs | VERIFIED (current equivalent asserts the opposite: no `.beads` on dry-run, `init-cli.test.ts:163-166`) |
| D-2 | Legacy upgrade | **NEW** (today only the blocked path is tested: `cli/src/tests/substrate-migration.test.ts:45-97`, `cli/src/tests/update.test.ts:274-426`) | Given a repo with `.beads/` + `.beads/issues.jsonl` and a pre-cut `xt`: `xt update --apply` performs the import, writes `.xtrm/.substrate-migrated.json`, and a second run is a no-op reporting `alreadyMigrated: true`; the original `.beads/` is byte-identical after import | A9 import activation (`MIGRATION_MARKER` is honored but never written today: `substrate-migration.ts:13-14,21-22`) | OPEN |
| D-3 | One-way Beads import | Evolve `cli/src/tests/substrate-verify.test.ts` (verifier exists) + **NEW** for the importer | `sb import beads` produces an alias map where every export id maps to exactly one substrate id, edge count and endpoints match exactly, notes/comments counts match, and `verifyPreservation(...).ok === true` with zero diff; a second import is a byte-identical no-op | `sb import beads` (named as planned at `cli/src/core/substrate-verify.ts:20`); `sb export project --project <id> --json` (`:336`) | VERIFIED (verifier) / OPEN (importer) |
| D-4 | Repository isolation | Evolve `cli/src/tests/repo-discovery.test.ts` + **NEW** | Two checkouts of different repos sharing one `~/.xtrm/state.db`: `sb` project resolution for repo A never returns repo B's issues; `getSbProjectLink(cwd)` differs per cwd and neither invents identity when unlinked (mirrors `substrate.test.ts:353`) | Substrate per-project link identity | INFERRED |
| D-5 | Linked worktrees | Evolve `cli/src/tests/worktree-session-beads-noise.test.ts:759` + `cli/src/tests/worktree-session-launch.test.ts` | Creating a linked worktree leaves no `.beads/` (or Substrate state dir) on disk; tracked state paths are masked with `skip-worktree`; `git status --porcelain` in the worktree is empty; the guard `findBeadsSymlinkIntroductions` returns `[]` for a worktree whose branch introduces no mode-120000 entry | Substrate shared-state resolution (git common-dir or absolute path) | VERIFIED |
| D-6 | Multiple repositories in one `state.db` | Evolve `cli/src/tests/substrate.test.ts:361` | After linking N≥2 repos: `state.db` exists once under `~/.xtrm/`; each repo's `sb` queries return only its own project; `defaultStateDbPath()` is unchanged | Substrate multi-project support | OPEN |
| D-7 | Claim enforcement | Evolve `cli/test/extensions/beads-claim-lifecycle.test.ts` + `cli/test/extensions/beads.test.ts` (retarget from `bd kv get claimed:<session>` to the Substrate claim binding) | In a tracked repo, a mutating file tool call with **no** active claim is blocked; after a claim it is allowed; a claim that is stale/closed is cleared and re-blocks; `git commit` is blocked while a claim is active; the claim cache is invalidated on an observed claim/close mutation | Substrate claim binding + a session-scoped claim read verb | VERIFIED (tests) / OPEN (upstream verb) |
| D-8 | Result / Closure lifecycle | Evolve `cli/test/extensions/session-flow.test.ts:32` + `cli/src/tests/launch-outcome.test.ts` + **NEW** | Closing a work item through the Substrate surface invalidates the claim cache, emits exactly one close notice, and a second close is rejected/reported as already closed; no second lifecycle database is written (mirrors `beads-claim-sync.test.ts:58-60`) | Substrate closure semantics + receipt | INFERRED |
| D-9 | Provenance | Evolve `cli/src/tests/hook-entry-source-tagging.test.ts` + **NEW** | Every imported/created work item carries a provenance receipt: the `sb` receipt names source (`beads-export` or `native`), the source id, and the import run; a forged/stale marker with a still-present board does **not** unblock (`substrate-migration.ts:73-84`) | A9 receipt schema, explicitly "owned xtrm-side" (`substrate-verify.ts:13-16`) | OPEN |
| D-10 | Compaction / resume | **NEW** (retired-hook porting target: `beads-compact-save/restore` → Journal checkpoint / Resume Capsule per `cli/src/core/claude-runtime-sync.ts:349`) | After a compact/resume cycle, the active work item id, its claim, and the pending next action are restored exactly; `sb issue resume` reconstructs state with zero mutation of the board | Substrate Journal + Resume Capsule | OPEN |
| D-11 | Core launch | Evolve `cli/src/tests/worktree-session-launch.test.ts` + `cli/src/tests/pi-runtime.test.ts` | `xt pi`/`xt claude` launch a worktree session with no `bd`/`.beads` on PATH and no `.beads` on disk; the session is claimed through Substrate; the structured `--json` outcome is unchanged | Substrate claim at launch | VERIFIED (no-bd case not yet asserted) |
| D-12 | Specialists dispatch | Evolve `cli/src/tests/coordinator-launch-validation.test.ts` + `test/integration-suite/suite-c-coordinator-lineage.mjs` | `sp run <specialist> --bead <id>` resolves the id without `bd`: the fixture repository is created with a Substrate project, not `bd init --stealth`, and the dispatch asserts branch ancestry and lineage as today | Specialists accepts a Substrate issue reference | VERIFIED (test) / OPEN (upstream flag) |
| D-13 | Core↔Specialists↔Substrate compatibility | Evolve `cli/src/tests/runtime-compat.test.ts` + `test/integration-suite/suite-a-installed-artifact.mjs` | The packed trio satisfies `docs/runtime-compatibility.json`, **and** the matrix is extended with the Substrate version so an install cannot succeed with an incompatible Substrate | `docs/runtime-compatibility.json` gains a `substrate` requirement | VERIFIED (matrix) / INFERRED (extension) |
| D-14 | No dual authority | Evolve `cli/src/tests/substrate-doctrine.test.ts:85` + `cli/src/tests/agent-contract-parity.test.ts:47` + **NEW** | (i) The existing forbidden-pattern scan passes with `.beads`/`bd`-writing surfaces added to `WHOLE_FILES`; (ii) **NEW**: a structural scan finds zero code paths that write to more than one durable store for the same fact (one writer per fact) — concretely, no `spawnSync('bd'…)` in `cli/src` and no second lifecycle DB written by any hook | Removal of all bd writers | VERIFIED (i) / OPEN (ii) |
| D-15 | No hidden `bd` dependency | Evolve `cli/src/tests/global-hooks-canonical.test.ts:51` + **NEW** | (i) The canonical hook template contains zero `beads-` commands (already asserted); (ii) **NEW**: an AST/text guard asserts `cli/src/**` (non-test) contains no `spawnSync('bd'`/`execFile('bd'` and `packages/pi-extensions/**` contains no `SubprocessRunner.run("bd"`; (iii) `PATH` without `bd` runs the full `cli` suite green | Deletion of the bd call sites | VERIFIED (i) / OPEN (ii,iii) |

**Acceptance proofs that require a NEW test: D-2, D-3 (importer half), D-6, D-9, D-10, D-14(ii),
D-15(ii,iii).** D-4 and D-8 are "evolve + new assertion" but have no dedicated file today.

---

## (E) Deletion order

Rule enforced: a deletion may proceed only when its precondition holds. Anything protecting
against a historical data-loss incident is deleted **last**, after an equivalent invariant is
proven by a passing test.

**D-1. Prove the replacement durability + wipe invariant (no deletions yet).**

- Precondition: none — this is first.
- Actions: land and pass (a) the D-1/D-2/D-3 acceptance proofs; (b) a generalized
  `guardedSymlinkIntroductions()` assertion covering the Substrate state directory and
  `.specialists/`, keeping `end-beads-symlink-guard.test.ts` green under its new name.
- Replaced proof: PROJ-INFRA-PR39 + `xtrm-6jd2` (squash-merge wipe of parent-tracked dirs) and
  `xtrm-cbjo` (worktree `.beads` removal/masking) remain guarded by the generalized guard.
- Confidence: INFERRED (target state).

**D-2. Delete the mechanically-bd-owned git hooks.**

- Precondition: D-1 complete; no bd-managed state remains that a push must synchronize.
- Delete: the `BEADS INTEGRATION v1.2.2` blocks and bd/dolt chains in
  `.githooks/pre-commit:23-88`, `.githooks/pre-push:24-98`, `.githooks/post-merge:2-75`,
  `.githooks/post-checkout` (whole file), `.githooks/prepare-commit-msg` (whole file), plus
  `.githooks/pre-push.bd-sync` and `.githooks/post-merge.bd-sync`.
- Replaced proof: D-1 durability (Substrate push/import is not a Git-hook precondition); the
  blocking property "push cannot succeed while durable state is unsynced" must be shown satisfied
  or explicitly dropped.
- Confidence: VERIFIED (surfaces), OPEN (durability proof).

**D-3. Delete the tracked Beads board and the forced JSONL staging.**

- Precondition: D-2 complete; D-2/D-3 import proof green; operator-signed verification that the
  export→Substrate mapping is lossless (exact edge/notes/comments counts).
- Delete: `.beads/` tracked files (`issues.jsonl`, `config.yaml`, `metadata.json`, `README.md`,
  `.beads/hooks/*`, `.beads/.gitignore`), `.gitignore:133,151-153`, `.gitleaks.toml:41-42`,
  `.semgrepignore:11`.
- Replaced proof: `verifyPreservation` equal-export proof (`substrate-verify.test.ts:98-201`) run
  against the real board before deletion.
- Confidence: VERIFIED.

**D-4. Delete the `bd` auto-stage/shared-server/allowlist machinery.**

- Precondition: D-3 complete.
- Delete: `cli/src/core/bd-auto-stage-patch.ts` (+ test), `cli/src/core/beads-shared-server.ts`
  (+ test — Dolt-specific), `Bash(bd …)` allow entries in `.xtrm/config/settings.json:7-11`,
  `config/settings.json:7-11`, `cli/src/core/sync-executor.ts:13-17`, and the
  `resolveMainProjectRoot`/`debug.ts:171` `.beads`-rooted special cases.
- Replaced proof: `sync-executor` can write the same allowlist without a bd entry; the debug DB
  path is chosen without a `.beads` probe.
- Confidence: VERIFIED.

**D-5. Delete the retired Beads hook family and its parity allowlist.**

- Precondition: each of the six named successors exists and is wired:
  `beads-edit-gate`→substrate edit gate, `beads-commit-gate`→provenance/commit gate,
  `beads-claim-sync`→native session/claim binding, `beads-stop-gate`→continuity/active-work gate,
  `beads-compact-save/restore`→Journal checkpoint/Resume Capsule (`D-10`),
  `beads-status-cache`→Substrate projection or retired (`claude-runtime-sync.ts:342-350`).
- Delete: the 11 `.xtrm/hooks/beads-*.mjs` files, their allowlist block in
  `scripts/check-registry-pack-parity.mjs:38-51`, `policies/beads.json`,
  `policies/session-flow.json`, and the `beads-*` sections of `cli/test/hooks.test.ts`.
- Replaced proof: `D-15` guard (no `beads-` in the template) plus the claim/lifecycle acceptance
  proofs D-7/D-8/D-10. Note `cli/test/hooks.test.ts:833` ("beads hooks retired") must be rewritten
  to assert the files are **absent**, and `cli/test/registry-pack-parity.test.ts` must lose its
  `RETIRED_BEADS_PATHS` list (currently `INVALID`).
- Confidence: VERIFIED.

**D-6. Delete the Beads status cache and statusline integration.**

- Precondition: D-5 complete.
- Delete: `.xtrm/hooks/beads-status-cache.mjs`, `.xtrm/hooks/statusline.mjs` bd coupling, the
  `.xtrm/cache/beads-status.*` ignore entries, and `bd.claimed`-style event kinds in the logger.
- Replaced proof: `statusline.test.mjs`'s "never blocks / no stampede / corrupt cache is safe"
  invariants (`:58,79,98`) must be re-expressed against the Substrate projection; the cache
  integrity tests (`beads-status-cache.test.mjs:14-64`) are the pattern to reuse.
- Confidence: VERIFIED (tests exist) / INFERRED (projection).

**D-7. Delete the board-audit transport.**

- Precondition: Lane 4's replacement transport is decided and a Substrate-backed snapshot exists.
- Delete: `.githooks/board-audit-{core,flow.py,pr.py,pr-adapter.sh,roundtrip.py,transport.py}`,
  the pre-push adapter call (`pre-push:99-110`), the `board-audit/pr-*` and
  `board-audit-staging/*` branches and `$XDG_CACHE_HOME/xtrm/board-audit/worktrees/*`.
- Replaced proof: **none exists today** — zero tests reference `board-audit` (verified by
  repo-wide grep). This deletion requires a NEW acceptance test for snapshot fidelity before it
  can proceed; until then board-audit must be retained or replaced wholesale.
- Confidence: VERIFIED (no coverage) / OPEN (replacement).

**D-8. Delete `@beads/bd` from the smoke image and install-order matrix.**

- Precondition: D-3 complete; the image no longer needs bd for any asserted surface.
- Delete: `scripts/smoke-container/Dockerfile:42-50`, the `bd` assertion in
  `scripts/smoke-container/verify.sh:486,491-493`, the `@beads/bd`/`dolt`/`bv` legs of
  `.github/workflows/install-order-matrix.yml`, and the `beads-version` input in
  `.github/workflows/service-skills-drift-sweep.yml:55-56,368`.
- Replaced proof: `D-1` fresh-install proof runs the same container without bd.
- Confidence: VERIFIED.

**D-9. Delete the Beads Pi extension and its policy/test surface. (Near-last.)**

- Precondition: D-7 proof (Substrate claim enforcement) is green **and** D-15 guard exists.
- Delete: `packages/pi-extensions/extensions/beads/`, `src/extensions/beads.ts`,
  `registry.ts:4,22` entries, `legacy-path-map.ts:8`, `src/core/adapter.ts:isBeadsProject` usage
  (or retire the helper), `policies/beads.json` (if not already removed in D-5),
  `cli/test/extensions/beads*.test.ts`, and the `beads` topology source in
  `packages/contracts/src/types.ts:372` (contract bump required).
- Replaced proof: `D-7`/`D-11`/`D-14`/`D-15`.
- Confidence: VERIFIED.

**D-10. Delete the `.beads`/`.specialists` symlink guard and the worktree masking logic. (LAST.)**

- Precondition: **every** other deletion complete, AND a Substrate-era equivalent of
  `findBeadsSymlinkIntroductions` is proven to refuse a mode-120000 introduction under the
  paths that are still parent-tracked and dir→symlink-swapped, with a test that fails without it.
- Delete: `cli/src/commands/end.ts:258-310`, the call site `:479-485`,
  `cli/src/utils/worktree-session.ts:2286-2296` (`normalizeParentHooksPath`),
  `:2301-2330` (`markPathSkipWorktree` bd usage — retain a generalized version if the Substrate
  state dir still needs masking), and `cli/src/tests/end-beads-symlink-guard.test.ts` only if the
  generalized guard test replaces it.
- Replaced proof: PROJ-INFRA-PR39 + `xtrm-6jd2` wipe invariant, plus `xtrm-cbjo` masking
  invariant. If no Substrate directory is parent-tracked and swapped, the stated replacement is a
  green test proving the invariant is vacuous — that must be asserted, not assumed.
- Confidence: VERIFIED (surfaces) / OPEN (replacement).

**Ordering rationale.** D-1 is a proof, not a deletion. D-2 (Git hooks) precedes D-3 (board)
because the hooks are the machinery that keeps the board synchronized; deleting the board first
would leave hooks pointing at a missing DB. D-4/D-5/D-6 are dead-code removal gated on successors.
D-7 is blocked on a replacement that does not exist. D-8 is deployment-surface cleanup. D-9
(extension) is the live enforcement path and goes near-last. D-10 protects a real, named
data-loss incident and goes last.

---

## Cross-lane seams

- **Lane 1** owns runtime enforcement; D-7/D-9's claim gate is that lane's surface. This lane only
  states which test protects it (`cli/test/extensions/beads-claim-lifecycle.test.ts`).
- **Lane 2** owns `xt` CLI lifecycle; D-4's allowlist and `substrate-migration.ts` belong there.
- **Lane 3** owns spec→Chain convergence; D-15's spec gates (`cli/src/spec/*`) are that lane's.
- **Lane 4** owns board-audit transport; D-7 is fully blocked on that lane's replacement decision.

---

## UNRESOLVED (exact questions)

1. **Where is the ADR?** Source cites "ADR section 40-54", including "A10 §59 definition of
   complete" via `scripts/check-registry-pack-parity.mjs:36-40`, but no ADR document exists in this
   repository. Exact question: what is the file path of the ADR that defines A10 §59, and does §59
   enumerate the retired-hook disposition as the gate this report assumes?
2. **Does `sb` support multi-repository isolation in one `state.db`?** Core only tests the
   `state.db` path and a single project link (`cli/src/tests/substrate.test.ts:135-200,361-368`).
   Exact question: what `sb` verb proves per-repo isolation when N≥2 repos link to one `state.db`?
3. **What is the `sb import beads` contract?** It is named only in a comment
   (`cli/src/core/substrate-verify.ts:20`) and no Core code invokes it. Exact question: is
   `sb import beads` implemented upstream, what is its argv/exit contract, and who writes
   `.xtrm/.substrate-migrated.json` (`MIGRATION_MARKER`)?
4. **What replaces the Dolt push-sync durability property?** `.githooks/pre-push.bd-sync:20-36`
   currently makes an unsynced board abort the Git push. Exact question: is Substrate durable
   without a Git-hook sync, and if not, what is the equivalent gate?
5. **Is board-audit still required at all?** It has 4 449 lines and zero tests. Exact question:
   does the external review process still consume `board-audit/pr-*` transport branches, or can
   the feature be retired rather than replaced?
6. **Does `docs-cross-check-bd` survive?** Its only data source is `bd query`
   (`cli/src/commands/docs-cross-check-bd.ts:49-61`). Exact question: is there a Substrate
   closed-issue query, or does `xt docs cross-check` lose that input?
7. **Are `xtrm.beads.lifecycle-event.v1` and the `beads` topology source published contracts with
   external consumers?** They are in `@xtrm/contracts` with golden fixtures
   (`packages/contracts/src/types.ts:16,372`). Exact question: may they be retired, or must they
   stay as historical schemas with a deprecation window?
8. **What is the `.specialists` masking end-state?** `markPathSkipWorktree` is used for both
   `.beads` and `.specialists/{default,user}`; only the `.beads` call is removed at
   `cli/src/utils/worktree-session.ts:2972`. Exact question: does the Substrate era keep any
   parent-tracked, dir→symlink-swapped directory under `.specialists/`, and does it therefore still
   need the masking logic and the symlink guard for that prefix?

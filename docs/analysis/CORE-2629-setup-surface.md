# CORE-2629 — One setup surface: gap analysis against Phase 2 · XT-114

Scoping research only. No installers implemented. Read-only probes with temp HOME.

## 1. Evidence base

- PRD: docs/plans/xtrm-build-order/PRD.md — Phase 1 steps 2/4/5/6b (lines 377-520), Phase 2 lines 619-955, plus Step 26 (line 1136), Step 27 (line 1156) and Step 46 (line 1388) from Phases 3 and 6.
- Substrate Issues cited (all `sb issue show`): CORE-2380, CORE-2378, CORE-2400, CORE-2379, CORE-2591, CORE-2385, CORE-2386, CORE-2383, CORE-2384, CORE-2382, CORE-2377, CORE-2513, CORE-2570.
- Jira: XT-114 parent, themes XT-125 (Pi runtime), XT-126 (install/update), XT-127 (global state), XT-128 (releases), XT-129 (picker/xtmux), XT-130 (Claude plugin). Jira keys could NOT be read: acli on ssh server is authenticated to xtrmxt.atlassian.net, not mercuryintel.atlassian.net where XT lives. List of unreadable keys: XT-114, XT-115, XT-116, XT-117, XT-119, XT-120, XT-121, XT-122, XT-123, XT-125, XT-126, XT-127, XT-128, XT-129, XT-130, XT-160, XT-162, XT-165, XT-166, XT-167, XT-172, XT-173, XT-174, XT-175, XT-178, XT-181, XT-183, XT-184, XT-185, XT-186, XT-187, XT-188, XT-189, XT-190, XT-191, XT-192. (No auth change made, per constraint.)
- Temp-HOME dry run: `HOME=/tmp/xtsetup-dryrun/home node .../cli/dist/index.cjs init --dry-run -y` in a fresh git repo. Output shows Machine Bootstrap, Claude Runtime Sync, Pi Runtime, Skills, Project Bootstrap phases; skills "20 changes pending"; sb init deferred. Confirms xt init already orchestrates many components but several (below) are not in any phase.

## 2. Traceability table

Columns: Component | Phase 2 step / Issue requiring it | State | Evidence.

| Component | Required by | State | Evidence |
|---|---|---|---|
| Machine bootstrap: sb, pi, pnpm, gitnexus, (claude, deepwiki, ctx7) | Step 9 CORE-2380; Step 10 CORE-2378/CORE-2400/CORE-2379 | partial | machine-bootstrap.ts MANAGED_DEPS lists sb, oh-pi(pi), pnpm, gitnexus, deepwiki, ctx7; no claude dep; pi still resolves via oh-pi alias. Dry run shows sb 0.3.1, pi 1.5.2, pnpm missing. |
| Pi runtime packages managed set (gitnexus, guardrails, goal, tasks, service-knowledge, ast-grep, agentrun, billion-context, substrate, pi-claude-bridge) | Step 10/11 CORE-2379, CORE-2385, CORE-2591 | partial | pi-runtime.ts MANAGED_PACKAGES includes pi-claude-bridge@0.12.0 (CORE-2591 DONE). But CORE-2385 (pi-subagents, pi-processes) not present in MANAGED_PACKAGES. Dry-run reports 9 managed packages. |
| Registry scaffold skills copy + global skills bootstrap | Step 2 CORE-2513; Step 17 | done-ish | init.ts phases 6; registry-scaffold installFromRegistry; global-skills-bootstrap. Dry run "20 changes pending". |
| Claude runtime sync (hooks/settings) | Step 12 (draft), Step 17 | partial | runClaudeRuntimeSyncPhase called in init; reconcileProjectClaudeHooks in update. |
| Global hooks bootstrap + reconcile | Step 2 CORE-2513 | done-ish | ensureGlobalHooksBootstrapped, reconcileGlobalClaudeHooks/PiHooks in init/update. |
| Substrate enrollment + sb init | Step 3 (done), Step 9 | done | init.ts phase 3.5a/3.5b; runSbInitForProject. |
| Project bootstrap (gitnexus index, CLAUDE.md/AGENTS.md headers, service hooks) | Step 17 CORE-2383 | partial | runProjectBootstrap called; dry run lists. |
| Dependency maintenance (sb doctor, gitnexus freshness) | Step 18 | partial | runDependencyMaintenance called. |
| prepare-commit-msg trailer hook (step 6b) | Step 6b CORE-2570 / XTRM-684 | NOT COVERED (missing) | No prepare-commit-msg installed in any repo: core, specialists and xtrm all lack one in both `.githooks/` and the default `.git/hooks/`. CORE-2570 is the Issue that installs it (§7 resolution 1 of this document, from the operator ruling of 2026-11-11, makes it default); it is not implemented yet, so no xt command installs it and there is no call site in init.ts/update.ts. |
| sb links sync scheduler (reconciler, xtrm #345) | Step 14 (delivered) / Step 26 | NOT COVERED (missing) | `sb links sync` verb exists in substrate 0.3.1; no cron/systemd timer on server or PC schedules it. Server has xt-worktree-reap timer only. |
| Claude route switch (claude_bridge block in ~/.config/specialists/user.json) | SPECIALISTS-4442 (not a core Issue) | NOT COVERED (missing) | No installer in core; .xtrm does not write it; docs say opt-in. |
| pi-claude-bridge package | CORE-2591 (DONE) | covered (done) | MANAGED_PACKAGES contains it; xt init/update reconcile it. |
| substrate CLI/plugin version 0.3.1 | Step 3 (sb creates state) + manual | partial | sb 0.3.1 on PC and server (hand-installed); server Claude substrate plugin still 0.2.3 (installed_plugins.json shows 0.2.3 vs PC 0.2.6). No xt init step upgrades Claude plugins. |
| gh shim + XTRM_LINK_GATE | Step 15 (identity, CORE-2528) | partial | xt identity setup installs shim; not invoked by xt init/update. XTRM_LINK_GATE default warn (xtrm #347) not configured anywhere by installer. |
| git-cliff | not cited in any step | NOT COVERED (missing) | git-cliff binary present on PC (/run/.../bin/git-cliff) via npm; not in MANAGED_DEPS/machine-bootstrap; no step references it. |
| skill pack swap programme -> project-management | Step 46 (Phase 6) / CORE-2624 (done) | NOT COVERED on HOME (pending) | manifests pc.json/server.json/state.json still list "programme"; skills dir still has programme pack. CORE-2624 renamed the pack but HOME manifests not migrated. No xt update step migrates pack names. |
| skill-suggest@xtrm plugin | Step 4c CORE-2532 (hotfix) / Step 12b | partial | Plugin installed on PC only (installed_plugins.json has skill-suggest@xtrm 0.1.0); server does not. Not in xt init Claude plugin list (OFFICIAL_CLAUDE_PLUGINS = ['context7'] only). |
| service-knowledge install everywhere | Step 15c (XTRM-631) | partial | ensureServiceSkills is called in init.ts inside runProjectBootstrap (cli/src/commands/init.ts) and in update.ts; remaining gap is only where not covered (e.g. non-service repos / older layouts). |
| xt-worktree-reap timer (systemd) | Step 27/24 | partial | Timer exists on server only; not installed by xt init on PC; no unit file shipped by core. |
| agent author identity / git identity env | Step 20 CORE-2525 | partial | git-identity.ts helpers exist; launcher exports env; not an installer concern but doctor could check. |

## 3. Uncovered components and the amendments that closed them (not a parallel design)

Five components are truly uncovered by any existing step (items 1–4 and 7 below; items 5 and 6 are partially covered components that still need an amendment, and item 7 is additionally owned by no core step at all). Each item below is a gap, not an open question: the ruling that settles it is section 7.

1. prepare-commit-msg trailer hook (step 6b / CORE-2570): **Settled by §7 resolution 1 (operator ruling of 2026-11-11) — `xt init` and `xt update` chain the hook by default, there is no opt-in flag, and `xt doctor` warns when it is missing.** No amendment is needed beyond that ruling.

2. sb links sync scheduler (Step 26 / XTRM-728): amend Step 26's "Still to build here: running it on a schedule in the agent host" to add a concrete deliverable: ship a systemd user timer unit (xt-links-sync.timer/service) installed by `xt init`/`xt update` on the server role only, with a role-conditional `xt doctor` timer check. **Settled by §7 resolution 2: server only (the PC uses the remote `sb`), installed by `xt init`/`xt update` on the server role, checked by `xt doctor`.**

3. skill pack rename programme -> project-management (CORE-2624 done): amend Step 4/Step 17 to add a one-time migration in xt update: rewrite enabledPacks entries "programme" -> "project-management" in ~/.xtrm/skills/state.json and manifests/*.json, idempotent. **Settled by §7 resolution 3: one-time idempotent migration in `xt update`, backup first.**

4. git-cliff: amend Step 18 (Clean-PATH E2E) or Step 9 to add git-cliff to MANAGED_DEPS (npm, required:false) so xt init installs it. Note: currently only referenced in changelog/release docs; not a runtime requirement. **Settled by §7 resolution 4: managed, `required: false`.**

Additionally, partially covered items needing amendments:

5. substrate Claude plugin upgrade (0.2.3 -> 0.3.1 on server): amend Step 9/17 to add Claude plugin version reconciliation to xt init/update (today only Pi packages are reconciled; Claude plugins are installed by hand / marketplace). **Settled by §7 resolution 5: yes, in `xt init`/`xt update`; it is reconciling the version of the one plugin Step 12 defines, not a second plugin.**

6. skill-suggest@xtrm plugin: amend Step 4c/Step 12 to include it in the Claude plugin baseline installed by xt init (OFFICIAL_CLAUDE_PLUGINS list or a new XTRM_CLAUDE_PLUGINS list). **Settled by §7 resolution 6: yes, by default, on the operator ruling.**

7. Claude route switch installer: amend SPECIALISTS-4442 (not a core Issue) — propose a small core helper `xt specialists claude-route enable` that writes the claude_bridge block, gated by explicit operator consent (no billing/cred). This is the one component that is genuinely not owned by any core step. **Settled by §7 resolution 7: filed as child Issue CORE-2632 under CORE-2629, with SPECIALISTS-4442 as its dependency.**

## 4. Maintainer-side requirement mapping

"One declarative component registry, installer + doctor check per component, tests keeping them in sync" maps to:
- Step 17 CORE-2383 (docs + doctor checks) for the doctor side.
- Step 18 CORE-2382/CORE-2377 (clean-PATH E2E) for the test side.
- Step 9 CORE-2380 for the registry/installer side.
Proposed amendment (not operator-settled; it follows the §7 preamble that `xt init`/`xt update` configure everything, but no resolution names the registry): add one sentence to Step 17: "xt doctor iterates a single declarative component registry (cli/src/core/component-registry.ts, one entry per component with installer + check + machine roles) and fails if any registered component lacks a check or any check lacks a registry entry." This is an amendment to existing steps, not a new design; the registry pattern already exists (MANAGED_DEPS, MANAGED_PACKAGES).

## 5. Child contracts

Exactly one new child contract exists, and it is filed: **CORE-2632**, the consent-gated Claude route switch installer (`xt specialists claude-route enable`), under CORE-2629 with SPECIALISTS-4442 as its dependency (§7 resolution 7). All other components map to existing Issues listed above; those are extended rather than duplicated.

## 6. Jira keys not read

See section 1. acli auth unchanged.

## 7. Resolutions (core-85, 2026-11-12)

Applying the operator's 11-11 rulings (linking automated as far as possible; xt init/update configure everything):

1. 6b trailer hook: xt init/update install it by default; xt doctor warns when missing; no opt-in flag. This is the operator approval CORE-2570 waited for.
2. sb links sync timer: server only (PC uses remote sb); installed by xt init/update on the server role; checked by doctor.
3. programme -> project-management: one-time idempotent migration in xt update, backup first.
4. git-cliff: managed, required:false.
5. Claude plugin version reconciliation (incl. substrate plugin 0.3.1): yes, in xt init/update.
6. skill-suggest: included in the Claude plugin baseline installed by xt init (OFFICIAL_CLAUDE_PLUGINS / new XTRM_CLAUDE_PLUGINS list), amending Step 4c/12. (Operator ruling: yes, by default.)
7. Claude route switch: an xt command writes the claude_bridge block only after explicit operator consent. Filed as child Issue CORE-2632 under CORE-2629, with SPECIALISTS-4442 as its dependency.

Child Issues for resolutions 1-6 are NOT filed; core-85 extends one existing host Issue per resolution: 1 CORE-2570, 2 XTRM-728, 3 CORE-2624, 4 CORE-2380/CORE-2383, 5 CORE-2380/CORE-2383, 6 CORE-2532. Resolution 7 is the only filed child (CORE-2632).

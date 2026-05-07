# anatomy.md
> Manual note 2026-05-07: session report .xtrm/reports/2026-05-07-986757b.md documents substantial dirty-state handoff for xtrm-tools-be9, including Pi UI compaction/theme changes, .pi/npm runtime drift, and specialists default mirror deletions.
> Manual note 2026-05-07: xtrm-tools-be9 fix updates scaffoldSkillsDefaultFromPackage to replace valid-but-stale .xtrm/skills/default symlinks unless they resolve to the current package payload.

> Auto-maintained by OpenWolf. Last scanned: 2026-04-02T22:22:27.122Z
> Manual note 2026-04-16: Pi runtime now prefers packages/pi-extensions/* and prunes stale npm:pi-dex settings conflicts.
> Manual note 2026-05-04: xtrm-loader memory injection is silent during before_agent_start; xtrm-ui dark pending row backgrounds use surfaceMuted across active pi-extension theme copies.
> Manual note 2026-05-04: specialists-agent-guard Claude hook blocks raw Agent only when using-specialists markers are active; pi-runtime tests mock PiPackageInstallRunner with {status, stdout, stderr}.
> Files: 541 tracked | Anatomy hits: 0 | Misses: 0
> Manual note 2026-05-04: session report 2026-05-04-95d4f878.md covers completed xtrm-emr8 Cat B epic, xt release ul5a merge, and stash@{0} dirty-state caveat.
> Manual note 2026-05-05: session-close-report skill now prefers updating the latest same-day SSOT report instead of creating duplicate reports for parallel orchestrators.
> Manual note 2026-05-05: using-xtrm and docs/XTRM-GUIDE now document xt update, xt release prepare/publish, and same-day report SSOT behavior.

## ./

- `handofffixpublish.md` — Handoff steps for repairing main package publish (~260 tok)
- `.gitignore` — Git ignore rules (~318 tok)
- `.mcp.json` (~41 tok)
- `.npmignore` (~42 tok)
- `.session-meta.json` (~20 tok)
- `.smoke-test` (~8 tok)
- `.xtrm-session-state.json` (~101 tok)
- `AGENTS.md` — XTRM Agent Workflow (~6368 tok)
- `CHANGELOG.md` — Change log (~8790 tok)
- `CLAUDE.md` — OpenWolf (~4753 tok)
- `context.md` — Summary (~300 tok)
- `Makefile` — Make build targets (~65 tok)
- `package-lock.json` — npm lock file (~79494 tok)
- `package.json` — Node.js package manifest (~686 tok)
- `README.md` — Project documentation (~3081 tok)
- `ROADMAP.md` — Skills Roadmap (~5073 tok)
- `test-hook.sh` — Test script for skill-suggestion hook (~1210 tok)
- `test-vault-dryrun.js` — Declares testDryRunFunctionality (~1028 tok)
- `test.md` — Test File (~29 tok)
- `update_installer.py` (~326 tok)
- `update_script.py` — read_file, write_file (~81 tok)
- `XTRM-GUIDE.md` — XTRM-Tools Complete Guide (~3093 tok)

## .beads/

- `.beads-credential-key` (~9 tok)
- `.gitignore` — Git ignore rules (~393 tok)
- `.local_version` (~2 tok)
- `config.yaml` — Beads Configuration File (~596 tok)
- `dolt-server.activity` (~3 tok)
- `interactions.jsonl` (~954 tok)
- `last-touched` (~3 tok)
- `metadata.json` (~48 tok)
- `README.md` — Project documentation (~562 tok)

## .beads/backup/

- `backup_state.json` (~78 tok)
- `comments.jsonl` (~5765 tok)
- `config.jsonl` (~14120 tok)
- `dependencies.jsonl` (~12607 tok)
- `labels.jsonl` (~1714 tok)

## .beads/dolt/

- `.bd-dolt-ok` (~1 tok)
- `.beads-credential-key` (~8 tok)
- `config.yaml` — Dolt SQL server configuration (~614 tok)

## .beads/dolt/.dolt/

- `config.json` (~21 tok)
- `repo_state.json` (~86 tok)
- `sql-server.info` (~14 tok)

## .beads/dolt/.dolt/noms/

- `journal.idx` (~0 tok)
- `LOCK` (~0 tok)
- `manifest` (~39 tok)
- `vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv` (~484 tok)

## .beads/dolt/.dolt/stats/.dolt/

- `config.json` (~1 tok)
- `repo_state.json` (~24 tok)

## .beads/dolt/.dolt/stats/.dolt/noms/

- `journal.idx` (~0 tok)
- `LOCK` (~0 tok)
- `manifest` (~39 tok)
- `vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv` (~119261 tok)

## .beads/dolt/jaggers_agent_tools/.dolt/

- `config.json` (~1 tok)
- `repo_state.json` (~86 tok)

## .beads/dolt/jaggers_agent_tools/.dolt/noms/

- `ft5s54jtmcpa9hchvh74ls4bbmm6691s.darc` (~696 tok)
- `journal.idx` (~4240 tok)
- `manifest` (~48 tok)
- `vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv` (~243437 tok)

## .beads/dolt/jaggers_agent_tools/.dolt/noms/oldgen/

- `LOCK` (~0 tok)
- `manifest` (~40 tok)

## .beads/dolt/jaggers_agent_tools/.dolt/stats/.dolt/

- `config.json` (~1 tok)
- `repo_state.json` (~24 tok)

## .beads/dolt/jaggers_agent_tools/.dolt/stats/.dolt/noms/

- `journal.idx` (~68 tok)
- `LOCK` (~0 tok)
- `manifest` (~39 tok)
- `vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv` (~485 tok)

## .beads/hooks/

- `post-checkout` — --- BEGIN BEADS INTEGRATION v0.61.0 --- (~213 tok)
- `post-merge` — --- BEGIN BEADS INTEGRATION v0.61.0 --- (~210 tok)
- `pre-commit` — --- BEGIN BEADS INTEGRATION v0.61.0 --- (~254 tok)
- `pre-push` — --- BEGIN BEADS INTEGRATION v0.61.0 --- (~251 tok)
- `prepare-commit-msg` — --- BEGIN BEADS INTEGRATION v0.61.0 --- (~219 tok)

## .claude/

- `service-registry.json` (~13 tok)
- `settings.json` (~1261 tok)
- `settings.local.json` (~34 tok)

## .claude/docs/

- `main-guard-readme.md` — Main Guard (~834 tok)
- `py-quality-gate-readme.md` — PY Quality Gate (~709 tok)
- `quality-gates-readme.md` — Quality Gates (~661 tok)
- `service-skills-set-readme.md` — Service Skills Set (~805 tok)
- `ts-quality-gate-readme.md` — TS Quality Gate (~650 tok)

## .claude/git-hooks/

- `doc_reminder.py` — get_staged_files, main (~550 tok)
- `skill_staleness.py` — get_push_ranges, get_changed_files, file_touches_service, is_globally_triggered + 2 more (~1876 tok)

## .claude/hooks/

- `hook-config.json` — Declares assertions (~424 tok)
- `quality-check.cjs` — Node.js Quality Check Hook (~10854 tok)
- `quality-check.py` — URL configuration (~3734 tok)
- `specialists-complete.mjs` — specialists-complete — Claude Code UserPromptSubmit hook (~456 tok)
- `specialists-session-start.mjs` — specialists-session-start — Claude Code SessionStart hook (~1247 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## .claude/skills/

- `README.txt` — Local Agent Skills (~412 tok)

## .claude/skills/clean-code/

- `SKILL.md` — Clean Code - Pragmatic AI Coding Standards (~1650 tok)

## .claude/skills/creating-service-skills/

- `SKILL.md` — Creating Service Skills (~4295 tok)

## .claude/skills/creating-service-skills/references/

- `script_quality_standards.md` — Script Quality Standards for Service Skills (~3783 tok)
- `service_skill_system_guide.md` — Service Skill System: Architecture & Operations Guide (~2872 tok)

## .claude/skills/creating-service-skills/scripts/

- `bootstrap.py` — /*", "").replace("/**", "").rstrip("/") (~2419 tok)
- `deep_dive.py` — API router (~3264 tok)
- `scaffolder.py` — scaffold_service_skill, write_skill_md, write_script_stubs, check_container + 6 more (~4288 tok)

## .claude/skills/delegating/

- `config.yaml` — Delegation Configuration (~2096 tok)
- `SKILL.md` — Delegating Tasks (~1696 tok)

## .claude/skills/delegating/references/

- `orchestration-protocols.md` — Multi-Agent Orchestration Protocols (~551 tok)

## .claude/skills/docker-expert/

- `SKILL.md` — Docker Expert (~3511 tok)

## .claude/skills/documenting/

- `CHANGELOG.md` — Change log (~156 tok)
- `README.md` — Project documentation (~1023 tok)
- `SKILL.md` — Documenting Skill (~1039 tok)

## .claude/skills/documenting/examples/

- `example_pattern.md` — Purpose (~482 tok)
- `example_reference.md` — Purpose (~429 tok)
- `example_ssot_analytics.md` — Purpose (~539 tok)
- `example_workflow.md` — Example Workflow: Documenting a New Feature (~810 tok)

## .claude/skills/documenting/references/

- `changelog-format.md` — CHANGELOG Format Reference (~497 tok)
- `metadata-schema.md` — SSOT Metadata Schema (~988 tok)
- `taxonomy.md` — SSOT Taxonomy & Naming Conventions (~754 tok)
- `versioning-rules.md` — Versioning Rules for SSOT (~603 tok)

## .claude/skills/documenting/scripts/

- `bump_version.sh` — Semantic version bumping utility for SSOT memories (~394 tok)
- `drift_detector.py` — find_project_root, get_memories_dir, extract_frontmatter, extract_tracks + 10 more (~2400 tok)
- `generate_template.py` — generate_timestamp, generate_date, generate_template, main (~1729 tok)
- `list_by_category.sh` — List Serena memories filtered by category suffix (~718 tok)
- `orchestrator.py` — ChangeType: document_change, validate_all, main (~2460 tok)
- `validate_metadata.py` — extract_headings, generate_index_table, inject_index, extract_frontmatter + 5 more (~2300 tok)

## .claude/skills/documenting/scripts/changelog/

- `__init__.py` (~0 tok)
- `add_entry.py` — ChangeCategory: add_entry, add_entry_to_file, main (~1886 tok)
- `bump_release.py` — bump_release, bump_release_file, main (~980 tok)
- `init_changelog.py` — Initialize a new CHANGELOG.md file. (~511 tok)
- `validate_changelog.py` — validate_changelog, validate_file, main (~1008 tok)

## .claude/skills/documenting/templates/

- `CHANGELOG.md.template` — Changelog (~91 tok)

## .claude/skills/documenting/tests/

- `integration_test.sh` — Integration test for documenting skill workflows (~656 tok)
- `test_changelog.py` — Tests for CHANGELOG management scripts. (~1445 tok)
- `test_drift_detector.py` — /*.ts" (~622 tok)
- `test_orchestrator.py` — Tests for documentation orchestrator. (~420 tok)
- `test_validate_metadata.py` — Tests: extract_headings, generate_index_table, inject_index_replaces_existing, inject_index_adds_when_missing (~530 tok)

## .claude/skills/find-skills/

- `SKILL.md` — Find Skills (~1157 tok)

## .claude/skills/gitnexus-exploring/

- `SKILL.md` — Exploring Codebases with GitNexus (~671 tok)

## .claude/skills/gitnexus-impact-analysis/

- `SKILL.md` — Impact Analysis with GitNexus (~671 tok)

## .claude/skills/gitnexus-refactoring/

- `SKILL.md` — Refactoring with GitNexus (~971 tok)

## .claude/skills/gitnexus/gitnexus-cli/

- `SKILL.md` — GitNexus CLI Commands (~859 tok)

## .claude/skills/gitnexus/gitnexus-debugging/

- `SKILL.md` — Debugging with GitNexus (~780 tok)

## .claude/skills/gitnexus/gitnexus-exploring/

- `SKILL.md` — Exploring Codebases with GitNexus (~749 tok)

## .claude/skills/gitnexus/gitnexus-guide/

- `SKILL.md` — GitNexus Guide (~867 tok)

## .claude/skills/gitnexus/gitnexus-impact-analysis/

- `SKILL.md` — Impact Analysis with GitNexus (~723 tok)

## .claude/skills/gitnexus/gitnexus-refactoring/

- `SKILL.md` — Refactoring with GitNexus (~1010 tok)

## .claude/skills/hook-development/

- `SKILL.md` — Hook Development for Claude Code Plugins (~4830 tok)

## .claude/skills/hook-development/examples/

- `load-context.sh` — Example SessionStart hook for loading project context (~479 tok)
- `quality-check.js` — React App Quality Check Hook (~10527 tok)
- `validate-bash.sh` — Example PreToolUse hook for validating Bash commands (~373 tok)
- `validate-write.sh` — Example PreToolUse hook for validating Write/Edit operations (~350 tok)

## .claude/skills/hook-development/references/

- `advanced.md` — Advanced Hook Use Cases (~2820 tok)
- `migration.md` — Migrating from Basic to Advanced Hooks (~2054 tok)
- `patterns.md` — Common Hook Patterns (~2225 tok)

## .claude/skills/hook-development/scripts/

- `hook-linter.sh` — Hook Linter (~1137 tok)
- `README.md` — Project documentation (~920 tok)
- `test-hook.sh` — Hook Testing Helper (~1470 tok)
- `validate-hook-schema.sh` — Hook Schema Validator (~1414 tok)

## .claude/skills/obsidian-cli/

- `SKILL.md` — Obsidian CLI (~795 tok)

## .claude/skills/orchestrating-agents/

- `config.yaml` — Orchestration Configuration (~438 tok)
- `SKILL.md` — Orchestrating Agents (~1340 tok)

## .claude/skills/orchestrating-agents/references/

- `agent-context-integration.md` — AgentContext Integration (~283 tok)
- `examples.md` — Handshake Examples (~310 tok)
- `handover-protocol.md` — Handover Protocol (~349 tok)
- `workflows.md` — Multi-Turn Orchestration Workflows (~537 tok)

## .claude/skills/orchestrating-agents/scripts/

- `detect_neighbors.py` — check_command, main (~171 tok)

## .claude/skills/planning/

- `SKILL.md` — Planning (~3282 tok)

## .claude/skills/planning/evals/

- `evals.json` (~424 tok)

## .claude/skills/prompt-improving/

- `README.md` — Project documentation (~1139 tok)
- `SKILL.md` — Prompt Improver ( /prompt-improving ) (~815 tok)

## .claude/skills/prompt-improving/references/

- `analysis_commands.md` — Analysis Frameworks (~137 tok)
- `chain_of_thought.md` — Chain of Thought (CoT) (~134 tok)
- `mcp_definitions.md` — MCP Tool Definitions (~128 tok)
- `multishot.md` — Multishot Prompting (~143 tok)
- `xml_core.md` — XML Tags for Clarity & Structure (~444 tok)

## .claude/skills/python-testing/

- `SKILL.md` — Python Testing Patterns (~4688 tok)

## .claude/skills/scoping-service-skills/

- `SKILL.md` — Scoping Service Skills ( /scope ) (~1724 tok)

## .claude/skills/scoping-service-skills/scripts/

- `scope.py` — find_registry, main (~656 tok)

## .claude/skills/senior-backend/

- `SKILL.md` — Senior Backend (~1136 tok)

## .claude/skills/senior-backend/references/

- `api_design_patterns.md` — Api Design Patterns (~403 tok)
- `backend_security_practices.md` — Backend Security Practices (~405 tok)
- `database_optimization_guide.md` — Database Optimization Guide (~405 tok)

## .claude/skills/senior-backend/scripts/

- `api_load_tester.py` — ApiLoadTester: run, validate_target, analyze, generate_report + 1 more (~888 tok)
- `api_scaffolder.py` — ApiScaffolder: run, validate_target, analyze, generate_report + 1 more (~888 tok)
- `database_migration_tool.py` — DatabaseMigrationTool: run, validate_target, analyze, generate_report + 1 more (~900 tok)

## .claude/skills/senior-data-scientist/

- `SKILL.md` — Senior Data Scientist (~1408 tok)

## .claude/skills/senior-data-scientist/references/

- `experiment_design_frameworks.md` — Experiment Design Frameworks (~359 tok)
- `feature_engineering_patterns.md` — Feature Engineering Patterns (~359 tok)
- `statistical_methods_advanced.md` — Statistical Methods Advanced (~359 tok)

## .claude/skills/senior-data-scientist/scripts/

- `experiment_designer.py` — ExperimentDesigner: validate_config, process, main (~796 tok)
- `feature_engineering_pipeline.py` — FeatureEngineeringPipeline: validate_config, process, main (~808 tok)
- `model_evaluation_suite.py` — ModelEvaluationSuite: validate_config, process, main (~800 tok)

## .claude/skills/senior-devops/

- `SKILL.md` — Senior Devops (~1118 tok)

## .claude/skills/senior-devops/references/

- `cicd_pipeline_guide.md` — Cicd Pipeline Guide (~403 tok)
- `deployment_strategies.md` — Deployment Strategies (~403 tok)
- `infrastructure_as_code.md` — Infrastructure As Code (~404 tok)

## .claude/skills/senior-devops/scripts/

- `deployment_manager.py` — DeploymentManager: run, validate_target, analyze, generate_report + 1 more (~893 tok)
- `pipeline_generator.py` — PipelineGenerator: run, validate_target, analyze, generate_report + 1 more (~893 tok)
- `terraform_scaffolder.py` — TerraformScaffolder: run, validate_target, analyze, generate_report + 1 more (~896 tok)

## .claude/skills/senior-security/

- `SKILL.md` — Senior Security (~1133 tok)

## .claude/skills/senior-security/references/

- `cryptography_implementation.md` — Cryptography Implementation (~406 tok)
- `penetration_testing_guide.md` — Penetration Testing Guide (~405 tok)
- `security_architecture_patterns.md` — Security Architecture Patterns (~407 tok)

## .claude/skills/senior-security/scripts/

- `pentest_automator.py` — PentestAutomator: run, validate_target, analyze, generate_report + 1 more (~892 tok)
- `security_auditor.py` — SecurityAuditor: run, validate_target, analyze, generate_report + 1 more (~891 tok)
- `threat_modeler.py` — ThreatModeler: run, validate_target, analyze, generate_report + 1 more (~888 tok)

## .claude/skills/session-close-report/

- `SKILL.md` — session-close-report (~1150 tok)

## .claude/skills/skill-creator/

- `LICENSE.txt` — Declares name (~2840 tok)
- `SKILL.md` — Skill Creator (~8048 tok)

## .claude/skills/skill-creator/agents/

- `analyzer.md` — Post-hoc Analyzer Agent (~2594 tok)
- `comparator.md` — Blind Comparator Agent (~1821 tok)
- `grader.md` — Grader Agent (~2258 tok)

## .claude/skills/skill-creator/assets/

- `eval_review.html` — Eval Set Review - __SKILL_NAME_PLACEHOLDER__ (~1883 tok)

## .claude/skills/skill-creator/eval-viewer/

- `generate_review.py` — Generate and serve a review page for eval results. (~4656 tok)
- `viewer.html` — Eval Review (~11994 tok)

## .claude/skills/skill-creator/references/

- `schemas.md` — JSON Schemas (~3015 tok)

## .claude/skills/skill-creator/scripts/

- `__init__.py` (~0 tok)
- `aggregate_benchmark.py` — calculate_stats, load_run_results, aggregate_results, generate_benchmark + 1 more (~4082 tok)
- `generate_report.py` — Generate an HTML report from run_loop.py output. (~3668 tok)
- `improve_description.py` — Improve a skill description based on eval results. (~3063 tok)
- `package_skill.py` — should_exclude, package_skill, main (~1205 tok)
- `quick_validate.py` — validate_skill (~1135 tok)
- `run_eval.py` — Run trigger evaluation for a skill description. (~3276 tok)
- `run_loop.py` — Run the eval + improve loop until all pass or max iterations reached. (~3910 tok)
- `utils.py` — Shared utilities for skill-creator scripts. (~475 tok)

## .claude/skills/specialists-creator/

- `SKILL.md` — Specialist Author Guide (~4669 tok)

## .claude/skills/specialists-creator/scripts/

- `validate-specialist.ts` — Declares printUsage (~332 tok)

## .claude/skills/sync-docs-workspace/iteration-1/

- `benchmark.json` (~3036 tok)
- `benchmark.md` — Skill Benchmark: sync-docs (~95 tok)

## .claude/skills/sync-docs-workspace/iteration-1/eval-doc-audit/

- `eval_metadata.json` (~342 tok)

## .claude/skills/sync-docs-workspace/iteration-1/eval-doc-audit/with_skill/outputs/

- `result.md` — Doc Audit Report — xtrm-tools (~2561 tok)

## .claude/skills/sync-docs-workspace/iteration-1/eval-doc-audit/with_skill/run-1/

- `grading.json` (~454 tok)
- `timing.json` (~23 tok)

## .claude/skills/sync-docs-workspace/iteration-1/eval-doc-audit/without_skill/

- `timing.json` (~25 tok)

## .claude/skills/sync-docs-workspace/iteration-1/eval-doc-audit/without_skill/outputs/

- `result.md` — Doc Audit: README.md vs docs/ (~1741 tok)

## .claude/skills/sync-docs-workspace/iteration-1/eval-doc-audit/without_skill/run-1/

- `grading.json` (~463 tok)
- `timing.json` (~25 tok)

## .claude/skills/sync-docs-workspace/iteration-1/eval-fix-mode/

- `eval_metadata.json` (~282 tok)

## .claude/skills/sync-docs-workspace/iteration-1/eval-fix-mode/with_skill/outputs/

- `result.md` — sync-docs --fix Run Summary (~1579 tok)

## .claude/skills/sync-docs-workspace/iteration-1/eval-fix-mode/with_skill/run-1/

- `grading.json` (~371 tok)
- `timing.json` (~23 tok)

## .claude/skills/sync-docs-workspace/iteration-1/eval-fix-mode/without_skill/outputs/

- `result.md` — sync-docs --fix — Execution Summary (~1162 tok)

## .claude/skills/sync-docs-workspace/iteration-1/eval-fix-mode/without_skill/run-1/

- `grading.json` (~436 tok)
- `timing.json` (~23 tok)

## .claude/skills/sync-docs-workspace/iteration-1/eval-sprint-closeout/

- `eval_metadata.json` (~359 tok)

## .claude/skills/sync-docs-workspace/iteration-1/eval-sprint-closeout/with_skill/outputs/

- `result.md` — sync-docs Eval: Sprint Closeout (~3082 tok)

## .claude/skills/sync-docs-workspace/iteration-1/eval-sprint-closeout/with_skill/run-1/

- `grading.json` (~430 tok)
- `timing.json` (~23 tok)

## .claude/skills/sync-docs-workspace/iteration-1/eval-sprint-closeout/without_skill/outputs/

- `result.md` — Doc Sync Report — Sprint Closeout (2026-03-18) (~1604 tok)

## .claude/skills/sync-docs-workspace/iteration-1/eval-sprint-closeout/without_skill/run-1/

- `grading.json` (~424 tok)
- `timing.json` (~23 tok)

## .claude/skills/sync-docs-workspace/iteration-2/

- `benchmark.json` (~4370 tok)
- `benchmark.md` — Skill Benchmark: sync-docs (~98 tok)

## .claude/skills/sync-docs-workspace/iteration-2/eval-doc-audit/

- `eval_metadata.json` (~208 tok)

## .claude/skills/sync-docs-workspace/iteration-2/eval-doc-audit/with_skill/outputs/

- `result.md` — Doc Audit Report — xtrm-tools (~1773 tok)

## .claude/skills/sync-docs-workspace/iteration-2/eval-doc-audit/with_skill/run-1/

- `grading.json` (~1536 tok)
- `timing.json` (~23 tok)

## .claude/skills/sync-docs-workspace/iteration-2/eval-doc-audit/without_skill/outputs/

- `result.md` — Doc Audit: README.md vs docs/ (~1669 tok)

## .claude/skills/sync-docs-workspace/iteration-2/eval-doc-audit/without_skill/run-1/

- `grading.json` — Declares of (~1378 tok)
- `timing.json` (~23 tok)

## .claude/skills/sync-docs-workspace/iteration-2/eval-fix-mode/

- `eval_metadata.json` (~197 tok)

## .claude/skills/sync-docs-workspace/iteration-2/eval-fix-mode/with_skill/outputs/

- `result.md` — sync-docs --fix Evaluation Result (~1822 tok)

## .claude/skills/sync-docs-workspace/iteration-2/eval-fix-mode/with_skill/run-1/

- `grading.json` (~1071 tok)
- `timing.json` (~23 tok)

## .claude/skills/sync-docs-workspace/iteration-2/eval-fix-mode/without_skill/outputs/

- `result.md` — sync-docs --fix: Evaluation Result (without_skill) (~1603 tok)

## .claude/skills/sync-docs-workspace/iteration-2/eval-fix-mode/without_skill/run-1/

- `grading.json` (~1369 tok)
- `timing.json` (~26 tok)

## .claude/skills/sync-docs-workspace/iteration-2/eval-sprint-closeout/

- `eval_metadata.json` (~254 tok)

## .claude/skills/sync-docs-workspace/iteration-2/eval-sprint-closeout/with_skill/outputs/

- `result.md` — sync-docs Skill Evaluation: Sprint Closeout (~2362 tok)

## .claude/skills/sync-docs-workspace/iteration-2/eval-sprint-closeout/with_skill/run-1/

- `grading.json` (~1791 tok)
- `timing.json` (~23 tok)

## .claude/skills/sync-docs-workspace/iteration-2/eval-sprint-closeout/without_skill/outputs/

- `result.md` — Documentation Sync Report — Sprint Closeout (~2670 tok)

## .claude/skills/sync-docs-workspace/iteration-2/eval-sprint-closeout/without_skill/run-1/

- `grading.json` (~1650 tok)
- `timing.json` (~26 tok)

## .claude/skills/sync-docs-workspace/iteration-3/

- `benchmark.json` (~4313 tok)
- `benchmark.md` — Skill Benchmark: sync-docs (~97 tok)

## .claude/skills/sync-docs-workspace/iteration-3/eval-doc-audit/

- `eval_metadata.json` (~208 tok)

## .claude/skills/sync-docs-workspace/iteration-3/eval-doc-audit/with_skill/outputs/

- `result.md` — Doc Audit — xtrm-tools (~1556 tok)

## .claude/skills/sync-docs-workspace/iteration-3/eval-doc-audit/with_skill/run-1/

- `grading.json` (~1627 tok)
- `timing.json` (~26 tok)

## .claude/skills/sync-docs-workspace/iteration-3/eval-doc-audit/without_skill/outputs/

- `result.md` — Doc Audit: README.md vs docs/ (~1919 tok)

## .claude/skills/sync-docs-workspace/iteration-3/eval-doc-audit/without_skill/run-1/

- `grading.json` (~1446 tok)
- `timing.json` (~25 tok)

## .claude/skills/sync-docs-workspace/iteration-3/eval-fix-mode/

- `eval_metadata.json` (~197 tok)

## .claude/skills/sync-docs-workspace/iteration-3/eval-fix-mode/with_skill/outputs/

- `result.md` — Command Run (~900 tok)

## .claude/skills/sync-docs-workspace/iteration-3/eval-fix-mode/with_skill/run-1/

- `grading.json` (~1344 tok)
- `timing.json` (~26 tok)

## .claude/skills/sync-docs-workspace/iteration-3/eval-fix-mode/without_skill/outputs/

- `result.md` — sync-docs --fix — Result (~909 tok)

## .claude/skills/sync-docs-workspace/iteration-3/eval-fix-mode/without_skill/run-1/

- `grading.json` (~1332 tok)
- `timing.json` (~26 tok)

## .claude/skills/sync-docs-workspace/iteration-3/eval-sprint-closeout/

- `eval_metadata.json` (~254 tok)

## .claude/skills/sync-docs-workspace/iteration-3/eval-sprint-closeout/with_skill/outputs/

- `phase1_context.json` (~4518 tok)
- `phase2_drift.txt` (~254 tok)
- `phase3_analysis.json` (~719 tok)
- `phase4_fix.txt` (~658 tok)
- `phase5_validate.txt` (~169 tok)
- `result.md` — Sprint Closeout — sync-docs Eval (Iteration 3) (~1973 tok)

## .claude/skills/sync-docs-workspace/iteration-3/eval-sprint-closeout/with_skill/run-1/

- `grading.json` (~2086 tok)
- `timing.json` (~26 tok)

## .claude/skills/sync-docs-workspace/iteration-3/eval-sprint-closeout/without_skill/outputs/

- `result.md` — Doc Sync Result — Sprint Closeout (without sync-docs skill) (~1059 tok)

## .claude/skills/sync-docs-workspace/iteration-3/eval-sprint-closeout/without_skill/run-1/

- `grading.json` (~1670 tok)
- `timing.json` (~26 tok)

## .claude/skills/sync-docs/

- `SKILL.md` — sync-docs (~2164 tok)

## .claude/skills/sync-docs/evals/

- `evals.json` (~1295 tok)

## .claude/skills/sync-docs/references/

- `doc-structure.md` — docs/ Structure Guide (~757 tok)
- `schema.md` — docs/ File Schema (~765 tok)

## .claude/skills/sync-docs/scripts/

- `context_gatherer.py` — run, find_project_root, find_main_repo_root, ensure_dolt_server + 7 more (~2069 tok)
- `doc_structure_analyzer.py` — /*.mjs", "policies/*.json"]), (~5329 tok)
- `drift_detector.py` — find_project_root, get_docs_files, extract_frontmatter, extract_globs + 12 more (~5232 tok)
- `validate_doc.py` — extract_frontmatter, extract_headings, make_anchor, generate_index_table + 6 more (~3542 tok)
- `validate_metadata.py` — extract_headings, generate_index_table, inject_index, extract_frontmatter + 5 more (~1618 tok)

## .claude/skills/sync-docs/scripts/changelog/

- `add_entry.py` — ChangeCategory: add_entry, add_entry_to_file, main (~1886 tok)

## .claude/skills/test-planning/

- `SKILL.md` — Test Planning (~5472 tok)

## .claude/skills/test-planning/evals/

- `evals.json` (~819 tok)

## .claude/skills/updating-service-skills/

- `SKILL.md` — Updating Service Skills (~935 tok)

## .claude/skills/updating-service-skills/scripts/

- `drift_detector.py` — URL configuration (~2064 tok)

## .claude/skills/using-quality-gates/

- `SKILL.md` — Using Quality Gates (~1804 tok)

## .claude/skills/using-serena-lsp/

- `README.md` — Project documentation (~58 tok)
- `REFERENCE.md` — Serena Tool Reference (~1123 tok)
- `SKILL.md` — Using Serena LSP Workflow (~912 tok)

## .claude/skills/using-service-skills/

- `SKILL.md` — Using Service Skills (~742 tok)

## .claude/skills/using-service-skills/scripts/

- `cataloger.py` — generate_catalog, main (~689 tok)
- `skill_activator.py` — match_territory, find_service_for_file, find_service_for_command, build_context + 1 more (~1526 tok)
- `test_skill_activator.py` — Tests for skill_activator.py — load_registry integration. (~531 tok)

## .claude/skills/using-service-skills/scripts/.pytest_cache/

- `.gitignore` — Git ignore rules (~10 tok)
- `CACHEDIR.TAG` (~51 tok)
- `README.md` — Project documentation (~76 tok)

## .claude/skills/using-service-skills/scripts/.pytest_cache/v/cache/

- `lastfailed` (~1 tok)
- `nodeids` (~57 tok)

## .claude/skills/using-specialists/

- `SKILL.md` — Specialists Usage (~1388 tok)

## .claude/skills/using-specialists/evals/

- `evals.json` (~904 tok)

## .claude/skills/using-tdd/

- `SKILL.md` — Test-Driven Development Workflow (~2408 tok)

## .claude/skills/using-xtrm/

- `SKILL.md` — XTRM — When to Use What (~1198 tok)

## .claude/skills/xt-debugging/

- `SKILL.md` — xt-debugging (~1275 tok)

## .claude/skills/xt-end/

- `SKILL.md` — xt-end — Autonomous Session Close Flow (~1944 tok)

## .claude/skills/xt-merge/

- `SKILL.md` — merge-prs — Worktree PR Merge Workflow (~2768 tok)

## .claude/tdd-guard/data/

- `test.json` (~388 tok)

## .claude/worktrees/agent-a3d5b923/

- `.gitignore` — Git ignore rules (~128 tok)
- `.mcp.json` (~223 tok)
- `.npmignore` (~42 tok)
- `.smoke-test` (~8 tok)
- `AGENTS.md` — XTRM Agent Workflow (Short) (~3306 tok)
- `CHANGELOG.md` — Change log (~6848 tok)
- `CLAUDE.md` — XTRM Agent Workflow (Short) (~2111 tok)
- `package-lock.json` — npm lock file (~43054 tok)
- `package.json` — Node.js package manifest (~606 tok)
- `README.md` — Project documentation (~1395 tok)
- `ROADMAP.md` — Skills Roadmap (~4620 tok)
- `test-hook.sh` — Test script for skill-suggestion hook (~1210 tok)
- `test-vault-dryrun.js` — Declares testDryRunFunctionality (~1028 tok)
- `update_installer.py` (~326 tok)
- `update_script.py` — read_file, write_file (~81 tok)
- `XTRM-GUIDE.md` — XTRM-Tools Complete Guide (~2968 tok)

## .claude/worktrees/agent-a3d5b923/.beads/

- `.gitignore` — Git ignore rules (~327 tok)
- `.local_version` (~2 tok)
- `config.yaml` — Beads Configuration File (~596 tok)
- `dolt-server.activity` (~3 tok)
- `dolt-server.log` (~2191 tok)
- `interactions.jsonl` (~0 tok)
- `metadata.json` (~48 tok)
- `README.md` — Project documentation (~562 tok)

## .claude/worktrees/agent-a3d5b923/.beads/dolt/

- `.bd-dolt-ok` (~1 tok)
- `config.yaml` — Dolt SQL server configuration (~614 tok)

## .claude/worktrees/agent-a3d5b923/.beads/dolt/.dolt/

- `config.json` (~1 tok)
- `repo_state.json` (~24 tok)

## .claude/worktrees/agent-a3d5b923/.beads/dolt/.dolt/noms/

- `journal.idx` (~68 tok)
- `LOCK` (~0 tok)
- `manifest` (~39 tok)
- `vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv` (~495 tok)

## .claude/worktrees/agent-a3d5b923/.beads/dolt/.dolt/stats/.dolt/

- `config.json` (~1 tok)
- `repo_state.json` (~24 tok)

## .claude/worktrees/agent-a3d5b923/.beads/dolt/.dolt/stats/.dolt/noms/

- `journal.idx` (~98 tok)
- `LOCK` (~0 tok)
- `manifest` (~39 tok)

## .claude/worktrees/agent-a3d5b923/.beads/hooks/

- `post-checkout` — --- BEGIN BEADS INTEGRATION v0.59.0 --- (~88 tok)
- `post-merge` — --- BEGIN BEADS INTEGRATION v0.59.0 --- (~87 tok)
- `pre-commit` — --- BEGIN BEADS INTEGRATION v0.59.0 --- (~131 tok)
- `pre-push` — --- BEGIN BEADS INTEGRATION v0.59.0 --- (~130 tok)
- `prepare-commit-msg` — --- BEGIN BEADS INTEGRATION v0.59.0 --- (~89 tok)

## .claude/worktrees/agent-a3d5b923/.claude-plugin/

- `marketplace.json` (~158 tok)
- `plugin.json` (~64 tok)

## .claude/worktrees/agent-a3d5b923/.claude/

- `service-registry.json` (~13 tok)
- `settings.json` (~603 tok)
- `settings.local.json` (~34 tok)

## .claude/worktrees/agent-a3d5b923/.claude/docs/

- `main-guard-readme.md` — Main Guard (~834 tok)
- `py-quality-gate-readme.md` — PY Quality Gate (~709 tok)
- `quality-gates-readme.md` — Quality Gates (~661 tok)
- `service-skills-set-readme.md` — Service Skills Set (~805 tok)
- `ts-quality-gate-readme.md` — TS Quality Gate (~650 tok)

## .claude/worktrees/agent-a3d5b923/.claude/git-hooks/

- `doc_reminder.py` — get_staged_files, main (~550 tok)
- `skill_staleness.py` — get_push_ranges, get_changed_files, file_touches_service, is_globally_triggered + 2 more (~1876 tok)

## .claude/worktrees/agent-a3d5b923/.claude/hooks/

- `hook-config.json` — Declares assertions (~424 tok)
- `quality-check.cjs` — Node.js Quality Check Hook (~10854 tok)
- `quality-check.py` — URL configuration (~3734 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/creating-service-skills/

- `SKILL.md` — Creating Service Skills (~4295 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/creating-service-skills/references/

- `script_quality_standards.md` — Script Quality Standards for Service Skills (~3783 tok)
- `service_skill_system_guide.md` — Service Skill System: Architecture & Operations Guide (~2872 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/creating-service-skills/scripts/

- `bootstrap.py` — /*", "").replace("/**", "").rstrip("/") (~2600 tok)
- `deep_dive.py` — API router (~3264 tok)
- `scaffolder.py` — scaffold_service_skill, write_skill_md, write_script_stubs, check_container + 6 more (~4288 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/db-expert/

- `SKILL.md` — Database Expert (~1307 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/gitnexus-debugging/

- `SKILL.md` — Debugging with GitNexus (~731 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/gitnexus-exploring/

- `SKILL.md` — Exploring Codebases with GitNexus (~671 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/gitnexus-impact-analysis/

- `SKILL.md` — Impact Analysis with GitNexus (~671 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/gitnexus-refactoring/

- `SKILL.md` — Refactoring with GitNexus (~971 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/gitnexus/gitnexus-cli/

- `SKILL.md` — GitNexus CLI Commands (~842 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/gitnexus/gitnexus-debugging/

- `SKILL.md` — Debugging with GitNexus (~803 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/gitnexus/gitnexus-exploring/

- `SKILL.md` — Exploring Codebases with GitNexus (~768 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/gitnexus/gitnexus-guide/

- `SKILL.md` — GitNexus Guide (~883 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/gitnexus/gitnexus-impact-analysis/

- `SKILL.md` — Impact Analysis with GitNexus (~747 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/gitnexus/gitnexus-refactoring/

- `SKILL.md` — Refactoring with GitNexus (~1040 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/scoping-service-skills/

- `SKILL.md` — Scoping Service Skills ( /scope ) (~1724 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/scoping-service-skills/scripts/

- `scope.py` — find_registry, main (~656 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/test-planning/

- `SKILL.md` — Test Planning (~2472 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/test-planning/evals/

- `evals.json` (~819 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/updating-service-skills/

- `SKILL.md` — Updating Service Skills (~935 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/updating-service-skills/scripts/

- `drift_detector.py` — URL configuration (~2064 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/using-main-guard/

- `SKILL.md` — Using Main Guard (~627 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/using-py-quality-gate/

- `SKILL.md` — Using PY Quality Gate (~681 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/using-quality-gates/

- `SKILL.md` — Using Quality Gates (~1804 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/using-service-skills/

- `SKILL.md` — Using Service Skills (~742 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/using-service-skills/scripts/

- `cataloger.py` — generate_catalog, main (~689 tok)
- `skill_activator.py` — match_territory, find_service_for_file, find_service_for_command, build_context + 1 more (~1526 tok)
- `test_skill_activator.py` — Tests for skill_activator.py — load_registry integration. (~531 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/using-tdd-guard/

- `SKILL.md` — Using TDD Guard (~576 tok)

## .claude/worktrees/agent-a3d5b923/.claude/skills/using-ts-quality-gate/

- `SKILL.md` — Using TS Quality Gate (~572 tok)

## .claude/worktrees/agent-a3d5b923/.claude/tdd-guard/data/

- `instructions.md` — TDD Fundamentals (~697 tok)

## .claude/worktrees/agent-a3d5b923/.dmux-hooks/

- `AGENTS.md` — dmux Hooks System - Agent Reference (~2956 tok)
- `CLAUDE.md` — dmux Hooks System - Agent Reference (~2956 tok)
- `README.md` — Project documentation (~335 tok)

## .claude/worktrees/agent-a3d5b923/.dmux-hooks/examples/

- `post_merge.example` — Example: post_merge hook (~559 tok)
- `run_dev.example` — Example: run_dev hook (~504 tok)
- `run_test.example` — Example: run_test hook (~353 tok)
- `worktree_created.example` — Example: worktree_created hook (~308 tok)

## .claude/worktrees/agent-a3d5b923/.gemini/

- `settings.json` (~339 tok)

## .claude/worktrees/agent-a3d5b923/.githooks/

- `pre-commit` — [jaggers] doc-reminder (~68 tok)
- `pre-push` — [jaggers] skill-staleness (~71 tok)

## .claude/worktrees/agent-a3d5b923/.github/workflows/

- `ci.yml` — " || echo "Eslint not configured yet" (~559 tok)
- `publish.yml` — CI: Publish to npm (~190 tok)

## .claude/worktrees/agent-a3d5b923/.pi/

- `settings.json` (~222 tok)

## .claude/worktrees/agent-a3d5b923/.serena/

- `.gitignore` — Git ignore rules (~2 tok)
- `project.yml` — the name by which the project can be referenced within Serena (~2376 tok)

## .claude/worktrees/agent-a3d5b923/.serena/memories/

- `ssot_cli_hooks_2026-02-03.md` — CLI Hook System (~1298 tok)
- `ssot_cli_mcp_servers_2026-02-21.md` — MCP Servers Configuration and Sync (~2225 tok)
- `ssot_cli_universal_hub_2026-02-19.md` — Universal Configuration Hub Architecture (~1069 tok)
- `ssot_cli_ux_improvements_2026-02-22.md` — CLI UX Improvements — Vsyc-Inspired Enhancements (~3842 tok)
- `ssot_cli_vault_2026-02-03.md` — CLI Vault Sync Architecture (~675 tok)
- `ssot_jaggers-agent-tools_delegating_skill_2026-02-23.md` — Delegating Skill (~1139 tok)
- `ssot_jaggers-agent-tools_documenting_workflow_2026-02-03.md` — Project Documentation Workflow — SSOT (~1567 tok)
- `ssot_jaggers-agent-tools_installer_architecture_2026-02-03.md` — Installer and Sync Architecture - SSOT (~1873 tok)
- `ssot_jaggers-agent-tools_migration_2026-02-01.md` — Hook Migration and Delegation Refactoring - SSOT (~2710 tok)
- `ssot_jaggers-agent-tools_orchestrating_agents_2026-02-03.md` — Orchestrating Agents Architecture - SSOT (~968 tok)
- `ssot_jaggers-agent-tools_service_skills_set_2026-02-23.md` — Service Skills Set — SSOT (~1794 tok)

## .claude/worktrees/agent-a3d5b923/.serena/memories/research/

- `agent-behavioral-testing-idea.md` — Agent Behavioral Testing — Idea / Open Research (~707 tok)
- `tdd-ai-empirical-2026-03-16.md` — TDD in AI-Assisted Coding — Empirical Research Brief (Enriched) (~2216 tok)

## .claude/worktrees/agent-a3d5b923/.unitai/

- `trace.jsonl` (~5321 tok)

## .claude/worktrees/agent-a3d5b923/cli/

- `package-lock.json` — npm lock file (~34874 tok)
- `package.json` — Node.js package manifest (~308 tok)
- `tsconfig.json` — TypeScript configuration (~130 tok)
- `tsup.config.ts` (~130 tok)
- `vitest.config.ts` — Vitest test configuration (~78 tok)

## .claude/worktrees/agent-a3d5b923/cli/.beads/

- `.memory-gate-done` (~0 tok)

## .claude/worktrees/agent-a3d5b923/cli/.gemini/

- `settings.json` (~215 tok)

## .claude/worktrees/agent-a3d5b923/cli/extensions/

- `beads.ts` — Declares logger (~1179 tok)
- `custom-footer.ts` — XTRM Custom Footer Extension (~1540 tok)
- `main-guard-post-push.ts` — Declares logger (~454 tok)
- `main-guard.ts` — Declares logger (~1272 tok)
- `quality-gates.ts` — Declares logger (~597 tok)
- `service-skills.ts` — Declares logger (~1307 tok)
- `xtrm-loader.ts` — Recursively find markdown files in a directory. (~852 tok)

## .claude/worktrees/agent-a3d5b923/cli/extensions/core/

- `adapter.ts` — Checks if the tool event is a mutating file operation (write, edit, etc). (~348 tok)
- `lib.ts` (~23 tok)
- `logger.ts` — Exports LogLevel, LoggerOptions, Logger (~317 tok)
- `runner.ts` — Run a command deterministically with a timeout and optional stdin. (~438 tok)

## .claude/worktrees/agent-a3d5b923/cli/hooks/

- `gitnexus-impact-reminder.py` — URL configuration (~81 tok)

## .claude/worktrees/agent-a3d5b923/cli/lib/

- `atomic-config.js` — Atomic Configuration Handler with Vault Pattern (~2025 tok)
- `config-adapter.js` — Transform canonical MCP config to Gemini/Qwen format (~2207 tok)
- `config-injector.js` — Safely inject hook configuration into settings.json (~772 tok)
- `context.js` — Initialize configuration (persists sync mode preference only) (~656 tok)
- `diff.js` — Calculate MD5 hash of a file or directory (~1481 tok)
- `env-manager.js` — Environment file location: ~/.config/jaggers-agent-tools/.env (~1150 tok)
- `sync-mcp-cli.js` — Agent-specific MCP CLI handlers (~3150 tok)
- `sync.js` — Execute a sync plan based on changeset and mode (~2515 tok)

## .claude/worktrees/agent-a3d5b923/cli/src/

- `index.ts` — __dirname is available in CJS output (tsup target: cjs) (~812 tok)

## .claude/worktrees/agent-a3d5b923/cli/src/adapters/

- `base.ts` — Exports AdapterCapabilities, AdapterConfig (~201 tok)
- `claude.ts` — Exports ClaudeAdapter (~313 tok)
- `registry.ts` — Adapter registry for Claude Code only. (~212 tok)

## .claude/worktrees/agent-a3d5b923/cli/src/commands/

- `claude.ts` — Exports createClaudeCommand (~1392 tok)
- `clean.ts` — Canonical hooks (files in ~/.claude/hooks/) (~3640 tok)
- `end.ts` — Extract issue IDs from commit messages like "reason (jaggers-agent-tools-xxxx)" (~2854 tok)
- `finish.ts` — Exports createFinishCommand (~258 tok)
- `help.ts` — Exports createHelpCommand (~2839 tok)
- `init.ts` — Deep merge settings.json hooks without overwriting existing user hooks. (~10405 tok)
- `install-pi.ts` — List extension directories (contain package.json) in a base directory. (~3307 tok)
- `install-service-skills.ts` — Exports mergeSettingsHooks, installSkills, installGitHooks, installSettings + 2 more (~3140 tok)
- `install.ts` — Exports installOfficialClaudePlugins, installPlugin, createInstallAllCommand, createInstallBasicCommand, createInstallCommand (~5163 tok)
- `pi-install.ts` — List extension directories (contain package.json) in a base directory. (~1313 tok)
- `pi.ts` — Exports createPiCommand (~1651 tok)
- `reset.ts` — Exports createResetCommand (~128 tok)
- `status.ts` — @ts-ignore (~2131 tok)
- `worktree.ts` — Parse `git worktree list --porcelain` output into WorktreeInfo array (~2111 tok)

## .claude/worktrees/agent-a3d5b923/cli/src/core/

- `context.ts` — @ts-ignore (~1090 tok)
- `diff.ts` — Items to ignore from diff scanning (similar to .gitignore) (~1858 tok)
- `interactive-plan.ts` — @ts-ignore (~1665 tok)
- `manifest.ts` — Exports getManifestPath, loadManifest, saveManifest (~249 tok)
- `preflight.ts` — Exports FileItem, McpItem, TargetPlan, OptionalServerItem + 3 more (~1501 tok)
- `rollback.ts` — Exports BackupInfo, createBackup, restoreBackup, cleanupBackup (~238 tok)
- `session-state.ts` — Exports SESSION_STATE_FILE, SESSION_PHASES, SessionPhase, SessionState + 4 more (~1286 tok)
- `sync-executor.ts` — Sync MCP servers for a list of targets, once per unique agent type. (~4864 tok)
- `xtrm-finish.ts` — Exports FinishOptions, FinishResult, runXtrmFinish (~2653 tok)

## .claude/worktrees/agent-a3d5b923/cli/src/tests/

- `policy-parity.test.ts` — Cross-runtime policy parity tests (79m) (~2241 tok)
- `session-flow-parity.test.ts` — ROOT: runHook, withFakeBdDir (~1318 tok)
- `session-state.test.ts` — Declares dir (~1173 tok)
- `xtrm-finish.test.ts` — Declares initRepo (~1833 tok)

## .claude/worktrees/agent-a3d5b923/cli/src/types/

- `config.ts` — Zod schemas: SyncModeSchema, TargetConfigSchema, ChangeSetCategorySchema, ChangeSetSchema + 3 more (~454 tok)
- `models.ts` — Exports Skill, Command, Hook, MCPServer + 3 more (~282 tok)

## .claude/worktrees/agent-a3d5b923/cli/src/utils/

- `atomic-config.ts` — Atomic Configuration Handler with Vault Pattern (~4787 tok)
- `banner.ts` — ── ASCII art ─────────────────────────────────────────────────────────────── (~1846 tok)
- `config-adapter.ts` — ConfigAdapter for Claude Code only. (~1034 tok)
- `config-injector.ts` — Safely inject hook configuration into settings.json (~800 tok)
- `env-manager.ts` — Environment file location: ~/.config/jaggers-agent-tools/.env (~1648 tok)
- `hash.ts` — Exports hashFile, hashDirectory, getNewestMtime (~385 tok)
- `repo-root.ts` — Finds the jaggers-agent-tools repo root by: (~381 tok)
- `sync-mcp-cli.ts` — Extract ${VAR_NAME} references from a list of server config objects (~3886 tok)
- `theme.ts` — Semantic color tokens (~354 tok)
- `worktree-session.ts` — Launch a Claude or Pi session in a sandboxed git worktree. (~1200 tok)

## .claude/worktrees/agent-a3d5b923/cli/test/

- `atomic-config-prune.test.ts` — hooksDir: wrap, wrapNoMatcher (~1300 tok)
- `atomic-config.test.ts` — Declares local (~1508 tok)
- `clean.test.ts` — __dirname: runClean (~1976 tok)
- `config-schema.test.ts` — Declares ROOT (~544 tok)
- `context.test.ts` — Declares candidates (~399 tok)
- `end-worktree.test.ts` — __dirname: run, git (~1849 tok)
- `hooks.test.ts` — __dirname: runHook, parseHookJson, withFakeBdDir, createTempGitRepo (~11044 tok)
- `install-pi.test.ts` — Exports a, b, a (~2850 tok)
- `install-project.test.ts` — Declares guide (~4401 tok)
- `install-service-skills.test.ts` — __dirname in vitest context = cli/test/ (~1762 tok)
- `install-surface.test.ts` — __dirname: run (~805 tok)
- `runtime-subcommands.test.ts` — __dirname: run (~1217 tok)
- `session-launcher.test.ts` — __dirname: run, git, removeWorktree (~1526 tok)

## .claude/worktrees/agent-a3d5b923/cli/test/extensions/

- `beads.test.ts` — Declares result (~1497 tok)
- `extension-harness.ts` — Exports MockUI, MockSessionManager, MockContext, ExtensionHarness (~595 tok)
- `main-guard.test.ts` — Declares result (~593 tok)
- `quality-gates.test.ts` — Declares result (~625 tok)
- `service-skills.test.ts` — Declares beforeStart (~688 tok)
- `xtrm-loader.test.ts` — Declares result (~480 tok)

## .claude/worktrees/agent-a3d5b923/cli/test/hooks/

- `quality-check-hooks.test.ts` — Declares temp (~524 tok)

## .xtrm/

- `memory.md` — Project Memory — xtrm-tools (~232 tok)

## .xtrm/reports/

- `2026-03-31-eee5e2a6.md` — Session Report — 2026-03-31 (continuation) (~3327 tok)
- `2026-04-02-50363f61.md` — Session Report — 2026-04-02 (~2151 tok)

## cli/src/

- `index.ts` — __dirname is available in CJS output (tsup target: cjs) (~1196 tok)

## cli/src/core/

- `machine-bootstrap.ts` — Unified machine-bootstrap phase for managed third-party dependencies. (~4536 tok)

> Manual note 2026-05-05: Published @jaggerxtrm/pi-extensions@0.7.17 with xtrm-ui silent hidden-thinking: compact mode hides thinking with no placeholder; Ctrl+O expansion reveals thinking.

> Manual note 2026-05-07: Specialists defaults are package-owned at runtime; `.specialists/default/` was removed from the repo, and project-only `parallel-review` lives in `.specialists/user/parallel-review.specialist.json`.
> Manual note 2026-05-07: `.pi/npm` is ignored local Pi npm runtime state; the tracked symlink deletion is intentional when `.pi/settings.json` uses `packages: ["npm:@jaggerxtrm/pi-extensions"]`.
- `.wolf/cerebrum.md` / `.wolf/memory.md`: captured Pi Serena global package prerequisite after tool availability issue.
- `.wolf/buglog.json`: added bug-010 for shell backtick command substitution during bd description creation; tracked .xtrm changes were reverted.

- 2026-05-07: Session report path `.xtrm/reports/2026-05-07-986757b.md` is the same-day SSOT handoff; CHANGELOG now uses an `[Unreleased]` block above released versions.

- 2026-05-07: `.beads/export-state.json` is local bd export metadata and should be ignored alongside `.beads/export-state/`.

- 2026-05-08: `cli/src/core/pi-runtime.ts` exports `getXtManagedPiPackages()` and provider-injected `getManagedPiPackageFreshness()` for network-free Pi package freshness classification.

- 2026-05-08: `ensureAlwaysGlobalPiPackages()` now checks all `getXtManagedPiPackages()` entries under global Pi agent npm tree; project `.pi/settings.json` is not proof of global install.

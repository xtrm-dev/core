# Memory

> Chronological action log. Hooks and AI append to this file automatically.
> Old sessions are consolidated by the daemon weekly.
| 22:36 | Created .xtrm/reports/2026-03-31-eee5e2a6.md | — | ~3548 |
| 22:37 | Session end: 1 writes across 1 files (2026-03-31-eee5e2a6.md) | 1 reads | ~3802 tok |
| 22:37 | Session end: 1 writes across 1 files (2026-03-31-eee5e2a6.md) | 1 reads | ~3802 tok |

## Session: 2026-03-31 23:35

| Time | Action | File(s) | Outcome | ~Tokens |
|------|--------|---------|---------|--------|

## Session: 2026-03-31 01:59

| Time | Action | File(s) | Outcome | ~Tokens |
|------|--------|---------|---------|--------|

## Session: 2026-04-01 03:53

| Time | Action | File(s) | Outcome | ~Tokens |
|------|--------|---------|---------|--------|

## Session: 2026-04-01 04:43

| Time | Action | File(s) | Outcome | ~Tokens |
|------|--------|---------|---------|--------|
| 05:47 | Edited cli/src/core/machine-bootstrap.ts | added nullish coalescing | ~319 |
| 05:47 | Edited cli/src/core/machine-bootstrap.ts | modified for() | ~42 |
| 06:01 | Session end: 2 writes across 1 files (machine-bootstrap.ts) | 1 reads | ~361 tok |
| 06:03 | Edited cli/src/index.ts | 6→7 lines | ~120 |

## Session: 2026-04-01 06:06

| Time | Action | File(s) | Outcome | ~Tokens |
|------|--------|---------|---------|--------|
| 00:15 | Created .xtrm/reports/2026-04-02-50363f61.md | — | ~2295 |
| 00:15 | Session end: 1 writes across 1 files (2026-04-02-50363f61.md) | 2 reads | ~2459 tok |
| 00:16 | Session end: 1 writes across 1 files (2026-04-02-50363f61.md) | 2 reads | ~2459 tok |

## Session: 2026-04-02 00:18

| Time | Action | File(s) | Outcome | ~Tokens |
|------|--------|---------|---------|--------|
| 00:22 | Edited .xtrm/memory.md | modified owned() | ~247 |
| 00:22 | Session end: 1 writes across 1 files (memory.md) | 2 reads | ~264 tok |
| 00:22 | Session end: 1 writes across 1 files (memory.md) | 2 reads | ~264 tok |
| 00:24 | Session end: 1 writes across 1 files (memory.md) | 2 reads | ~264 tok |
| 00:24 | Session end: 1 writes across 1 files (memory.md) | 2 reads | ~264 tok |
| 00:25 | Session end: 1 writes across 1 files (memory.md) | 2 reads | ~264 tok |
| 17:20 | Fixed Pi runtime conflict cleanup | cli/src/core/pi-runtime.ts, cli/src/tests/pi-runtime-safeguards.test.ts, docs/xtrm-ui.md, package.json | auto-prune stale npm:pi-dex + package-source fixes | ~820 |
| 17:45 | Created handofffixpublish.md | publish recovery handoff | documented local-agent recovery steps | ~260 |

| 23:36 | Updated session close report | .xtrm/reports/2026-05-04-95d4f878.md, .wolf/anatomy.md | filled xtrm-emr8 + xtrm-ul5a handoff context | ~5200 |
| 23:38 | Closed session report bead | xtrm-vxtc, .xtrm/reports/2026-05-04-95d4f878.md | report marked complete; open issues section updated | ~220 |
| 00:02 | Closed stale Cat B epic | xtrm-sjbc, .xtrm/reports/2026-05-04-95d4f878.md | no open local bd issues remain | ~180 |
| 01:00 | Updated session-close-report skill | .xtrm/skills/default/session-close-report/SKILL.md | prefer same-day SSOT report updates over duplicate reports | ~1200 |
| 10:49 | Updated using-xtrm docs for v0.7.14 commands | .xtrm/skills/default/using-xtrm/SKILL.md, docs/XTRM-GUIDE.md | documented xt update/release/report SSOT surfaces | ~650 |
| 17:45 | Generated session close report | .xtrm/reports/2026-05-07-986757b.md, .wolf/anatomy.md | documented uncommitted substantial work, cleanup blockers, and next priorities for xtrm-tools-be9 | ~4300 |
| 17:50 | Fixed stale skills/default symlink repair | cli/src/core/registry-scaffold.ts, cli/src/tests/registry-scaffold.test.ts, cli/src/tests/install-runInstall.test.ts | preserve only current package symlink; stale valid symlinks are replaced with current payload | ~900 |
| 19:05 | Reconciled dirty runtime migration state | .specialists/default, .pi/settings.json, xtrm-ui, registry, report | package-owned specialists defaults, local Pi npm runtime, xtrm-ui cleanup, validation recorded | ~1800 |
[2026-05-07] Learned: Pi Serena tools require global `npm:pi-serena-tools`; missing package caused Serena tools to be unavailable/disabled in Pi.
[2026-05-07] Fixed accidental shell backtick substitution in bd create command; reverted unintended tracked .xtrm changes and logged bug-010. Use single-quoted heredoc for bead descriptions with backticks.

- 2026-05-07: Session close report updated as same-day SSOT; CHANGELOG gained [Unreleased] entries for session-close-report, releasing, and using-specialists-v3 skill behavior changes.

- 2026-05-07: Ignored `.beads/export-state.json` after bd commit/export recreated it as local metadata during session close.

- 2026-05-08: xtrm-basg added provider-injected Pi package freshness states (`missing`, `current`, `outdated`, `version-unknown`) plus canonical xt-managed Pi package inventory tests.

- 2026-05-08: xtrm-ppwi changed global Pi package assurance to cover every `getXtManagedPiPackages()` entry and updated pi-runtime tests to 25 focused passes.
- 2026-05-08: Repeated shell backtick quoting trap once during xtrm-ppwi close notes; no source damage, but keep using single-quoted bd text only.

- 2026-05-08: xtrm-5nwu wired `xt update` to report global xt Pi package freshness and `--apply` refresh missing/outdated managed packages; targeted update/pi-runtime tests pass 27/27.
- 2026-05-08: Pi process timers running `sp` crashed with exit 127 even with explicit PATH/absolute sp; use foreground `sleep && sp ps` via bash for this session.

- 2026-05-08: xtrm-modr wired xt doctor global Pi package health into text and JSON using piPackages; missing/outdated/version-unknown report remediation, doctor never installs, npm lookup is timeout-bounded.
- 2026-05-08: Repeated shell backtick quoting trap during reviewer resume; always use single-quoted or heredoc payloads for sp/bd text.

- 2026-05-08: Session report .xtrm/reports/2026-05-08-030283f.md summarizes Pi package hardening stack and changelog sync; xtrm-6xus tracks deferred operator docs sync.

- 2026-05-08: Docs drift sync for xtrm-6xus updated docs/XTRM-GUIDE.md, docs/pi-extensions.md, docs/xtrm-directory.md, and docs/cli-architecture.md for xt update/xt doctor global Pi package health.

- 2026-05-08: Same-day session report .xtrm/reports/2026-05-08-030283f.md updated after xtrm-6xus docs sync to include docs validation and final next-priority state.

- 2026-05-08: Merged origin/main into docs branch; npm:pi-mcp-adapter is canonical xt-managed Pi package and must appear in package inventory docs/tests.

- 2026-05-08: User correction — never early-stop specialists and then manually do their work. Let specialists complete; if behavior is poor, fix future bead contracts/prompts with meaningful descriptions, scope, success criteria, constraints, and expected outputs. Diagnose/steer before any stop.

| 23:01 | Fixed xtrm-cplc workspace CLI tarball smoke | cli/src/commands/init.ts, cli/package.json, cli/dist/index.cjs | lazy package-root resolution; cli workspace private; pack/install smoke passed | — |
- 2026-05-13: xtrm-6m4y added xtrm-tools security pipeline root config; local hooks now chain project reminders plus pre-commit security gates, and OSV push checks diff against baseline to avoid blocking old dependency debt.
- 2026-05-13: xtrm-krk0 OSV fix removed unused @artale/pi-procs and bundled tdd-guard deps; cli/vitest.config.ts now loads tdd-guard-vitest only when installed, and OSV/audit/test gates pass clean.
- 2026-05-15: xtrm-ui now prototypes border-only cold-color framing for external Pi tools via ToolExecutionComponent patch, covering Serena/GitNexus/structured_return/process/generic extension tools; structured_return and process get custom compact summaries before frame rendering.
- 2026-05-15: xtrm-ui external tool frame chrome should use plain border-only shapes; do not put tool names in the border/title line because the compact content line already names the tool.
- 2026-05-15: xtrm-ui external tool compaction preserves xtrmOriginalText in details and frame rendering should show that original text when Ctrl+O expanded=true; border is intentionally dimmed/subtle.
- 2026-05-15: xtrm-ui internal Pi component patches must resolve the live Pi package via process argv/global @earendil path before @mario fallback; import.meta.resolve('@mariozechner/pi-coding-agent') can hit stale ~/node_modules and patch the wrong package.
- 2026-05-15: xtrm-ui external frame patch is versioned so /reload can replace old prototype patches; compact external frames should use result.content summary only, not native call/result renderer output.
- 2026-05-15: xtrm-ui external frame pending state now renders a single compact pending summary from tool args, avoiding transient native call+result duplication before tool_result arrives.
- 2026-05-15: xtrm-ui external frames use a compact width cap (44 content columns) in collapsed view; expanded view uses available width for detail.
- 2026-05-15: xtrm-ui compact density should avoid terminal auto-wrap at column 0; keep framed external content at 38 cols and native tool summary subject/meta at 34 cols.
- 2026-05-15: xtrm-ui compact summaries cap native subject/meta segments to avoid unindented terminal wraps; external framed content cap is 38 columns.
- 2026-05-15: xtrm-ui collapsed external frames are single-row inline frames to match native tool vertical density; Ctrl+O expanded keeps the full multi-line box.
- 2026-05-15: one-line underline/overline pseudo-frames are not portable in Pi TUI; use real tight 3-line boxes for collapsed external tools instead.
- 2026-05-15: xtrm-ui non-native tools now use native-density full-line cold tinted backgrounds instead of framed boxes; expanded view tints each full-width line.
- 2026-05-15: xtrm-ui external tool bg rows use the full available tool row width while keeping compact one-line collapsed content; no border/box spacing.
- 2026-05-15: xtrm-ui external tool chrome is user-selectable: /xtrm-ui chrome background|box or /xtrm-ui-external-chrome background|box. Background is default; box keeps the previous tight box style.
- 2026-05-15: sp-terminal-overlay Pi extension provides /sp-feed, /sp-ps, /xtrm-ps, and /xtrm-terminal streaming overlay commands. It uses ctx.ui.custom overlay mode and child_process spawn via shell.
- 2026-05-15: sp-terminal-overlay overlay handle must be scoped outside ctx.ui.custom factory; overlay is centered at 80% width/height; command output uses simple ANSI cursor/clear-screen emulation for repainting dashboards like sp ps --follow.
- 2026-05-15: sp-terminal-overlay crash mitigation throttles stream redraws to 100ms and avoids double-closing overlays; if it crashes again, disable the extension from registry and switch to a widget/status approach.
- 2026-05-15: Pi overlay custom() onHandle object in current runtime may not provide requestRender(); sp-terminal-overlay must use tui.requestRender() only.
- 2026-05-15: sp-terminal-overlay renders a fixed 24-row output body so the 80% centered overlay does not grow/shrink with command output.
- 2026-05-15: xtrm-ui background chrome highlights compact non-native tool-name prefixes with a brighter badge background inside the subtle full-row background.
- 2026-05-15: xtrm-ui background chrome highlights compact non-native tool-name prefixes with a brighter badge background inside the subtle full-row background.
- 2026-05-15: sp-terminal-overlay preserves safe numeric CSI SGR colors for append-only feed output, strips SGR in terminal repaint mode to avoid ANSI-unsafe cursor slicing, and resets rows before borders.
- 2026-05-15: xtrm-ui external badge styling must not add visible padding after truncation; it caused rendered rows to exceed terminal width by 2 columns.
- 2026-05-15: xtrm-ewou merged #257 clean-worktree dependency guidance to main: xtrm does not provision or track node_modules/.venv; use repo bootstrap commands inside worktrees.
- 2026-05-16: xtrm-ui native tool compact flicker fix clears built-in tool active-call tracking on tool_result so renderCall becomes blank before final compact result renders.
- 2026-05-16: xtrm-ui external background chrome aligns with native rows by not adding leading/full-row padding; only the first displayed tool-name token after the bullet gets cold badge background with dark non-bold text.
- 2026-05-16: xtrm-ui prototype patch changes must bump EXTERNAL_TOOL_FRAME_PATCH_VERSION; otherwise /reload keeps the old ToolExecutionComponent wrapper closure and UI tweaks appear unchanged.
- 2026-05-19: sp-terminal-overlay /sp-ps and /xtrm-ps should be snapshot-only (`sp ps`); strip --follow/-f because repaint dashboards loop noisily in the overlay. Keep /sp-feed as streaming.
- 2026-05-19: README now documents v0.7.21 update methodology: install latest xtrm-tools/specialists, remember xt update is dry-run by default, use --apply with --root/--repo, run xt init -y for incomplete repos or missing active skills, and verify issue-triage symlinks.
- 2026-05-21: Docs/changelog updated for @jaggerxtrm/pi-extensions 0.7.22/0.7.23 serena-pool releases; docs/pi-extensions.md now documents shared Serena daemon pooling, deterministic ports, SERENA_MCP_PORT wiring, DEBUG=serena-pool, and owned orphan cleanup.
- 2026-05-21: Local xtrm-ui marker experiment changes tool-result row prefixes from `•` to `›` in packages/pi-extensions/extensions/xtrm-ui while preserving the existing user-input `› ` prefix behavior; installed locally into ~/.pi/agent/npm for visual testing.
- 2026-05-21: using-specialists-v3 now documents bd swarm for epic readiness: validate before dispatch/merge, status during execution, create only on operator confirmation; payload hygiene may fail if packages/pi-extensions/.pi/structured-returns logs exist, remove that runtime artifact dir before release checks.
- 2026-05-27: xtrm-h9hqg added bd auto-stage patch plumbing: cli/src/core/bd-auto-stage-patch.ts flips export.git-add=false and appends an idempotent pre-commit shim respecting core.hooksPath; xt init/update now report patch and dependency maintenance summaries.
- 2026-05-27: xtrm-h9hqg dist smoke found bd v1.0.3 legitimately sets core.hooksPath=.beads/hooks; treat it as valid when .beads/hooks/pre-commit exists and only warn when the target hook file is missing.
- 2026-05-30: planning/test-planning skills require log/telemetry contracts and smoke/E2E command evidence in bead planning; test-planning can run inside specialist chains after executor/debugger work to produce test-writing and test-runner contracts.
- 2026-06-06: xtrm-eg5nb shrank beads-gate memoryPromptMessage to one line; Stop memory gate still uses `memory-gate-done:<sessionId>` ack with saved and nothing-novel forms.
- 2026-06-06: Local fleet sweep normalized 19 non-worktree hook copies under ~/dev and ~/projects; skipped 19 transient .worktrees copies to avoid mutating active specialist/worktree sessions.
- 2026-06-06: agent-docs-maintainer skill added to keep CLAUDE.md/AGENTS.md as compact routing docs: audit first, replace CLI dumps with skill/--help pointers, use CLAUDE vs AGENTS templates, and validate line/command/code-fence bloat.
- 2026-06-06: CLAUDE.md compacted from 635 to 146 lines using agent-docs-maintainer; it now points to skills/CLI help instead of embedding bd/bv/sp/GitNexus manuals.
- 2026-06-06: Agent-docs cleanup should preserve essential commands (bd ready/list/show, sp list/ps/feed/result, GitNexus impact/detect_changes, validation) and remove only full manuals/dumps.
- 2026-06-06: CLAUDE.md guidance updated: Claude Code may use local task-planning features for ephemeral multi-step tracking, but beads remains authoritative for ownership/deps/memory/closure.
- 2026-06-06: Manual fleet sweep copied agent-docs-maintainer to 21 non-worktree repos under ~/dev and ~/projects; repos with registry.json also received agent-docs-maintainer entries, and active symlinks were refreshed.
- 2026-06-06: TaskCreate/TodoWrite-style local task planning is required for non-trivial Claude Code work; beads remains authoritative for issue ownership/deps/memory/closure.
- 2026-06-06: CLAUDE.md clarified: before non-trivial work, Claude must use local task planning alongside normal beads ops; agents should check sp --help/list for specialist availability; use the canonical service-skills skill set for docs/project context.
- 2026-06-06: Latest agent-docs-maintainer sweep propagated service-skills-only docs/context guidance to 21 local repos; delete Python __pycache__ after py_compile before copying skills.
- 2026-06-06: Durable source for xtrm-managed CLAUDE/AGENTS top blocks is the canonical xtrm instruction-template source for the current installation/package; generated project blocks are overwritten by xt update, while GitNexus block is regenerated by GitNexus hooks. Avoid hard-coding machine-specific template paths in user-facing docs.
- 2026-06-07: Managed claude/agents top templates should include compact session catch-up hygiene: check handoff/next-session beads, latest xt reports, recent merged/closed PRs, in-progress beads; run issue-triage when board state is unclear; check service-skills freshness before relying on them. Claude top should explicitly mention TaskCreate/TodoWrite-style planning when available.
- 2026-06-07: Pi runtime tests must isolate temp agent dirs from the host global npm root; `ensureAlwaysGlobalPiPackages` now accepts optional `npmRootDir`, with `null` meaning no global fallback in tests.
- 2026-06-11: agent-docs-maintainer now treats repo identity as first-class: docs that start with managed xtrm/GitNexus/beads boilerplate are flagged, line caps apply to routing/managed content separately from substantive stack overview prose, concise operational command lists are not penalized as manuals, and stale terms can be extended via .xtrm/agent-docs.toml.

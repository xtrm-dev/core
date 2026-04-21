## Summary
Skills runtime split removed. `active/pi` + `active/claude` collapsed into single `active/`. Default tier kept canonical source. Active tier stays materialized merge view.

## Status
partial

## Changes
- `cli/src/core/skills-layout.ts`
  - `resolveActiveRuntimeRoot()` now returns `.xtrm/skills/active` directly.
- `cli/src/core/skills-materializer.ts`
  - removed `PI_NPM_PROVIDED_SKILLS` exclusion.
  - `selectRuntimeSkills()` now returns full set for both runtimes.
  - `rebuildAllRuntimeActiveViews()` now does single rebuild (`claude`) and returns single result.
- `cli/src/core/skills-scaffold.ts`
  - `.claude/skills` symlink target changed to `../.xtrm/skills/active`.
  - activation counts now unified (`activatedPiSkills = activatedClaudeSkills`).
  - deprecation log updated to single active path.
- `cli/src/core/pi-runtime.ts`
  - `PROJECT_SKILLS_ENTRY` changed to `../.xtrm/skills/active`.
- `cli/src/tests/skills-materializer.test.ts`
  - expectations updated for single active root.
- Additional dependent updates to keep runtime consistent:
  - `cli/src/core/skills-runtime-views.ts` migrated to single active view checks.
  - `cli/src/core/init-verification.ts` skills runtime verification switched to single `activeReady`.
  - `cli/src/utils/worktree-session.ts` fallback symlink target switched to `active`.
  - `cli/src/tests/install-integration.test.ts` updated path assertions/mocks.
  - `cli/src/tests/registry-scaffold.test.ts` updated active view/symlink expectations.

## Verification
- Ran: `cd cli && npm run -s typecheck`
  - failed, but failures pre-existing/unrelated (missing `prompts` types, other strict TS errors outside touched area).
- Ran: `cd cli && npm run lint`
  - failed: no `lint` script in `cli/package.json`.

## Risks
- Runtime-specific pack divergence now ignored in materialized active view (`rebuildAllRuntimeActiveViews` uses claude selection only). If state differs by runtime, pi-specific packs no longer materialize separately.
- Some untouched runtime-scoped command flows may still assume dual-runtime semantics at state level.

## Follow-ups
- Decide policy for runtime-specific pack state:
  - either enforce identical `enabledPacks` for claude/pi,
  - or merge both runtime pack sets when materializing single active view.
- Fix repo-wide TS strict failures, then re-run typecheck gate.
- If wanted, I can close bead `xtrm-avqb`, run memory ack, commit, push.

## Beads
- claimed: `xtrm-avqb`
- notes appended with implementation summary
- not closed yet

## Machine-readable block
```json
{
  "summary": "Collapsed skills runtime materialization to single .xtrm/skills/active view, removed pi-specific filtering, rewired Claude/Pi pointers to active root, and updated dependent runtime verification/worktree/test expectations.",
  "status": "partial",
  "issues_closed": [],
  "issues_created": [],
  "follow_ups": [
    "Define single-view materialization policy when enabledPacks differs between claude and pi runtimes.",
    "Resolve existing repository-wide TypeScript strict errors, then re-run typecheck.",
    "Close bead xtrm-avqb after memory ack if user confirms session-close flow."
  ],
  "risks": [
    "Single-view rebuild currently derives from claude runtime selection; pi-only enabled packs in state are ignored.",
    "Runtime-scoped commands may still assume dual-runtime behavior at state layer."
  ],
  "verification": [
    "cd cli && npm run -s typecheck (failed due to pre-existing unrelated strict TS errors)",
    "cd cli && npm run lint (failed: missing lint script)"
  ],
  "files_changed": [
    "cli/src/core/skills-layout.ts",
    "cli/src/core/skills-materializer.ts",
    "cli/src/core/skills-scaffold.ts",
    "cli/src/core/pi-runtime.ts",
    "cli/src/core/skills-runtime-views.ts",
    "cli/src/core/init-verification.ts",
    "cli/src/utils/worktree-session.ts",
    "cli/src/tests/skills-materializer.test.ts",
    "cli/src/tests/install-integration.test.ts",
    "cli/src/tests/registry-scaffold.test.ts"
  ],
  "symbols_modified": [
    "resolveActiveRuntimeRoot",
    "selectRuntimeSkills",
    "rebuildAllRuntimeActiveViews",
    "ensureAgentsSkillsSymlink",
    "PROJECT_SKILLS_ENTRY",
    "checkRuntimeSkillsViews",
    "assertRuntimeSkillsViews",
    "runInitVerification",
    "renderVerificationSummary"
  ],
  "lint_pass": false,
  "tests_pass": false,
  "impact_report": {
    "files_touched": [
      "cli/src/core/skills-layout.ts",
      "cli/src/core/skills-materializer.ts",
      "cli/src/core/skills-scaffold.ts",
      "cli/src/core/pi-runtime.ts",
      "cli/src/core/skills-runtime-views.ts",
      "cli/src/core/init-verification.ts",
      "cli/src/utils/worktree-session.ts",
      "cli/src/tests/skills-materializer.test.ts",
      "cli/src/tests/install-integration.test.ts",
      "cli/src/tests/registry-scaffold.test.ts"
    ],
    "symbols_analyzed": [
      "resolveActiveRuntimeRoot",
      "rebuildAllRuntimeActiveViews",
      "ensureAgentsSkillsSymlink",
      "PROJECT_SKILLS_ENTRY"
    ],
    "highest_risk": "MEDIUM",
    "tool_invocations": 18
  }
}
```
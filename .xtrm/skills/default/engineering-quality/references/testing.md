# Testing strategy

Tests prove behavior at the layer that changed. They are not a coverage-percentage ritual.

This file is the canon for test value, layer, mocks, oracles, telemetry and failure meaning.
Repo rules (AGENTS.md S1-S5, .opencodereview/rule.json) and role prompts project it; they do
not restate it. The procedure that applies it (when to plan tests, layer signals, strategy,
done-when templates, critical-path maps, test priority) is `references/planning-tests.md`.

## Choose the proof layer

| Change | Evidence floor |
|---|---|
| Pure logic/invariant | unit/property/characterization test |
| Bug/regression | smallest test or reproduction that fails before the fix and passes after |
| API/DB/file boundary | contract/integration evidence |
| CLI/shell/runtime wiring | integration + smoke command |
| agent/hook/MCP/workflow | isolated runtime smoke/E2E + lifecycle evidence |
| production/infra | observability, health, rollback and deploy evidence |

Use TDD when the desired behavior is clear enough to encode before implementation,
especially bugs, invariants, parsers, pure logic and well-specified features. Do not force
TDD ceremony while the actual task is discovering what the correct behavior should be.

A regression test should correspond to the confirmed causal mechanism. A test that passes
against the known-bad revision does not prove the regression unless it is protecting a
different explicit invariant.

Mocks are useful for isolation. They do not replace evidence at the only meaningful
external boundary. When practical, include a real contract/smoke path for integrations.

For fixes, run:

1. the minimal failing reproduction;
2. the targeted new/changed tests;
3. callers or integration tests implicated by GitNexus impact;
4. the project-required broader checks appropriate to the risk.

Record skipped/unavailable checks honestly. “All tests pass” must not mean “the one test I
chose passes.”

## Test value (keep / fix / delete)

A test earns its place only by protecting a behaviour whose failure would be wrong data, a
wrong contract, or an unobservable fault. Coverage percentage is not a reason to add one.

- Keep: pins a critical path, a boundary contract, an invariant, or a regression whose
  causal mechanism it reproduces; its expectation is independent of the unit.
- Fix: the behaviour matters but the test cannot fail for the right reason — wrong layer,
  mock echo, shared oracle, or no assertion on the observable signal.
- Delete: it restates a literal, a lookup table, or its own mock; duplicates another test's
  assertions with no distinct input; or exercises no product code (unless it is a recorded
  meta-check). A deletion needs the independent check in `reduction.md`; a test added with a
  bug fix is kept and names its issue in a `# regression: <ref>` comment.

Do not create one test Issue per implementation Issue mechanically. Batch tests that share a
layer and ship/validate together.

## Independent oracle

Derive the expected value from the spec, a hand calculation, or an independent artifact.
Never import the unit's own constant or helper, never call the unit again to build the
expectation, and never assert the value a mock was configured to return.

## Telemetry as testable behaviour

For operational or autonomous paths, assert the event name, required fields, redaction, and
the query or grep location a future agent would use to diagnose failure. Never require
secrets or raw sensitive payloads in logs.

## What a failure would mean

Every planned check names the command or observable artifact, the expected result, safe
setup/cleanup, and what a failure would mean (wrong data, wrong contract, unobservable
fault). A check whose failure cannot be interpreted is not evidence.

## Changelog

- 2026-10-29 — planning-tests.md restored beside this file from the standalone test-planning
  skill (v1.1, removed 2026-09-04 in core 4c82c4be), translated to Substrate. Role prompts
  carry the `test-canon` mandatory rule set, which names both files.
- 2026-10-27 — canon created by MMD-2999 from planning/test-strategy.md, engineering-quality
  references, AGENTS.md S1-S5 and the measured audit rubric. Proven by: preflight on
  b55cf07da resolving `**/test_*.py` (test canon reaches a reviewer); role use to be proven
  by the next review/audit run.

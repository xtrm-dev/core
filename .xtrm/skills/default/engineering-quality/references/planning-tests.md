# Test planning

How to plan the tests for a piece of work, in Substrate terms. The rules a test must meet
(value, oracle, mocks, telemetry, failure meaning) live in `testing.md`; this file is the
procedure that applies them. Restored from the standalone `test-planning` skill (v1.1,
removed in the 2026-09-04 refactor, core `4c82c4be`) and translated from Beads to Substrate.

## When to plan tests

1. **Contract authoring.** When a plan is decomposed into Issues, every implementation Issue
   gets its tests in its own VALIDATION section, or in a batched test Issue (see Batching).
2. **Inside a chain, after the writer.** When an executor or debugger has produced a diff and
   no tests were written, the test-engineer (or the coordinator) runs this procedure before
   the reviewer: read the Issue, the actual changed files and the verification already done;
   name the critical paths the diff introduced or changed; decide what is tested now and what
   is deferred; hand the test writer a concrete contract and hand `test-runner` a separate
   command contract.
3. **At closure.** Before `sb issue close`, compare what was built with what VALIDATION
   planned. Implementation drifts: new subcommands, a different response shape, edge cases
   found on the way, a dependency that turned out local-only. Update the plan or the test
   Issue; if no tests were planned at all, plan them now. The close cites the validation
   evidence (`--validation`).

## Classify the layer

| Layer | What it is | Signals in the Issue |
|---|---|---|
| Core | pure logic: parse, compute, format, validate, state machines | "implement", "compute", "parse", "validate"; data in, data out; no HTTP/DB/files |
| Boundary | crosses a system boundary: HTTP client, API route, DB query, file I/O, queue | "endpoint", "client", "route", "fetch", "query"; URLs, ports, service names, request/response shapes |
| Shell | wires core and boundary into a user-facing feature: CLI, pipeline, command handler | "command", "CLI", "subcommand", `<cli> <verb>`; combines several components |
| Operational / agentic | makes agents, hooks, CI, deploy, monitoring or runtime operations work | "agent", "specialist", "hook", "MCP", "deploy", "health check", "log", "metric", "trace", "smoke", "runbook" |

## Choose the strategy

By layer:

| Layer | Primary strategy | What to assert | Mock policy |
|---|---|---|---|
| Core | unit + property tests | input/output, edge cases, invariants | none needed |
| Boundary | contract tests, live first | schemas, field presence and types, status codes, parameter behaviour | live > recorded fixture > mock |
| Shell | integration + smoke | exit codes, output format, end-to-end wiring, error messages | run the real thing (subprocess or function call) |
| Operational / agentic | smoke + E2E + telemetry assertions | health check, deploy/rollback envelope, hook or chain behaviour, logs and metrics emitted | real command in an isolated temp environment; mock only dangerous external side effects |

By situation (overrides the layer default):

| Situation | Strategy |
|---|---|
| Interface unclear or still moving | TDD: the tests define the contract |
| Contract known up front | spec-first: write the schema assertions first |
| Parser, transform, invariant | property-based: must hold for any valid input |
| Seam between systems | contract test: assert the schema, not the implementation |
| Agent, workflow or deploy change | smoke + E2E: command → side effect or artifact → log/metric → cleanup |
| Logging or observability change | telemetry assertions: event names, fields, redaction, correlation ids, query path |
| Legacy code being wrapped | characterization tests: capture current behaviour before changing it |
| Simple CRUD path | a few examples |

### Live first

1. **Live** — hit the real service and assert the real response. Catches wrong URLs, changed
   schemas, auth problems, network edge cases. Mark the test (e.g. `@pytest.mark.live`) so it
   can be selected or skipped deliberately.
2. **Recorded fixture** — when live access is intermittent: record once, replay. Still checks
   the schema; does not catch drift. Record when the fixture was captured.
3. **Mock** — last resort: no service access, or pure logic with no I/O.

Mocks encode the writer's assumptions; a test built only on them proves the assumptions.

### Smoke and E2E are required for integrated behaviour

Shell, boundary and operational work does not stop at lint, typecheck and unit tests. Plan at
least one smoke check, and E2E or live-contract coverage for every P0/P1 or user-facing
critical path. Static gates (`tsc`, `pyright`, `ruff`, ESLint, schema validation) are evidence
for the reviewer; they are not the test gate.

A smoke or E2E check names: the exact command `test-runner` executes; setup and safe cleanup;
the expected observable result (exit code, output, file, API response, job state, log line,
metric, health result); what a failure would mean; how the failure is classified
(`in_scope`, `pre_existing`, `infrastructure` — the `test-runner` taxonomy); and how logs or
telemetry prove the path ran.

### Telemetry the test must assert

When a future agent would need logs to debug or self-check the feature, the plan requires:

- **Emission points:** start and end, decisions, retries, external calls, failures, fallbacks, cleanup.
- **Fields:** the repo's structured log format first; otherwise `timestamp`, `level`,
  `component`, `event`, the Issue/job/session/request id, `action`, `outcome`, `duration_ms`,
  and a redacted `error`.
- **Location and query:** log file, stdout/stderr, trace JSONL, metrics endpoint, dashboard
  label, specialist feed, CI artifact, or the exact grep.
- **Redaction:** no secrets, tokens, credentials, raw PII or full unredacted payloads.
- **Assertion:** the test or smoke script fails when the event or a required field is missing
  or malformed.

## Write it into Substrate

Tests live in the contract, not in a side list.

- **VALIDATION** lists every check with: command or observable artifact, expected result,
  setup/cleanup, what a failure would mean (see `testing.md`).
- **Batching.** Do not open one test Issue per implementation Issue. When tests need their own
  Issue, batch by layer and phase: one for the phase's core logic, one for its boundary
  contracts, one for its shell integration. Title: `Test: <what> — <strategy>`.
- **Gating.** A test Issue that must pass before the next phase starts gets a `blocks` edge to
  that phase's Issues (`sb issue relate --kind blocks`). Say so in its SCOPE.
- **Priority** starts from the implementation Issue's priority:

  | Implementation risk | Test priority |
  |---|---|
  | security, auth, protocol or schema compatibility | equal (P0) |
  | regression-critical boundary path (routing, exit codes other tools read) | equal (P0–P1) |
  | high-impact core logic (pricing, state transitions) | equal |
  | standard domain logic (config merge, formatters, parsers) | equal or +1 |
  | low-risk internals | +1 |
  | test-debt cleanup | P4 |

  Boundary and shell tests never go below P2: integration tests are load-bearing. A test for a
  P0 fix lands in the same PR as the fix.

## Done-when templates

Paste the matching block into VALIDATION and fill in the `<…>`.

**Core**

```
Layer: core · Strategy: <unit | property | example>
- [ ] positive path: <expected output for valid input>
- [ ] negative path: <expected error/output for invalid input>
- [ ] edge cases: <empty, zero, max boundary, …>
- [ ] invariants: <e.g. output sorted; len(out) == len(in)>
Fixtures: no shared mutable state; deterministic (no random, no wall clock without injection);
each test builds its own input.
```

**Boundary**

```
Layer: boundary · Strategy: <live | recorded fixture | mock — and why>
- [ ] schema/contract: <field presence, types, required vs optional>
- [ ] errors, retry, fallback: <e.g. 404 → empty list; 500 → ServiceError>
- [ ] drift-safe: asserts presence and types, not internal structure
Done when the contract passes live (or against the recorded fixture, with the reason).
```

**Shell**

```
Layer: shell · Strategy: integration + smoke
- [ ] observable outcome: <output format, exit code>
- [ ] failure UX: <error message, non-zero exit, stderr vs stdout>
- [ ] wiring: <core and boundary really called>
- [ ] one real-data scenario when the service is reachable
- [ ] smoke command for test-runner: <exact command + expected output/artifact>
```

**Operational / agentic**

```
Layer: operational · Strategy: smoke + E2E + telemetry
- [ ] workflow smoke: <the command/chain/hook/deploy path runs>
- [ ] E2E critical path: <trigger → action → observable result → cleanup>
- [ ] failure path: <bad config, missing service, non-zero exit, rollback, denied permission>
- [ ] telemetry: <events + fields + redaction + where to query>
- [ ] health/runbook evidence: <health command, dashboard query, artifact path>
- [ ] test-runner contract: <commands, setup, cleanup, failure taxonomy>
```

## Critical paths, not coverage

Every test plan carries three short maps instead of a coverage number:

```
Critical paths covered:
- <path> — risk: <what breaks>
Deferred paths:
- <path> → follow-up: <Issue ref>   (required for P2+ risk; never skip silently)
Debuggability evidence:
- <log/metric/trace event> — how the test proves it exists
```

A critical path is one that touches auth, money, data loss or an external contract; one a
user-facing command in the Issue exercises; or one named in the Issue's SUCCESS.

## Anti-patterns to check

At planning and again at closure:

1. **No assertion.** The test calls code and asserts nothing. "Does not throw" is asserted
   explicitly (`pytest.raises`, `expect(...).not.toThrow()`).
2. **Tautology, literal, shared oracle, mock echo.** The expectation comes from the unit, its
   constants, a restated literal or table, or the value a mock was told to return. Derive it
   independently (`testing.md`, Independent oracle).
3. **Shared mutable state.** Tests share module state, rows, files or config without reset;
   they pass alone and fail in suite order. Use function-scoped fixtures with teardown.
4. **Over-mocking internal collaborators.** Mocks patch code in the module under test, so the
   test checks wiring, not outcome. Mock only at system boundaries.
5. **Cannot fail under a realistic regression.** Remove the logic under test in your head (or
   run the repo's mutation tests where they exist): if the test still passes, it protects
   nothing. Add the negative-path or edge assertion that catches the likely bug.

## Who enforces what

This procedure plans; it does not block. Enforcement belongs elsewhere:

| Concern | Owner |
|---|---|
| strategy, telemetry requirements, templates, anti-pattern flags, test priority | this procedure, written into the contract |
| test-value judgement on a diff (keep / fix / delete) | reviewer gate; seconder only for changed or adjacent tests, bounded |
| running commands and classifying failures | `test-runner` (needs an explicit command contract) |
| implementation-quality second opinion | seconder — not the test gate |
| new TODO/FIXME obligations | obligations-scanner — not the test gate |
| CI pass/fail | CI and the merge guard |
| close without validation evidence | `sb issue close` gate: the close cites `--validation` evidence |
| release decision | reviewer, from test-runner output plus telemetry evidence |

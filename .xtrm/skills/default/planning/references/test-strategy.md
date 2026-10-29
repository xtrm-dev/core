# Test and evidence planning

Read these before writing VALIDATION for a change that needs tests:

- `/engineering-quality` → `references/testing.md`: the rules (layer floor, mocks, oracles,
  test value, telemetry assertions, failure meaning).
- `/engineering-quality` → `references/planning-tests.md`: the procedure (when to plan tests,
  layer signals, strategy by situation, done-when templates, critical-path maps, test
  priority).

What contract authoring adds:

- Every non-trivial contract's VALIDATION section names, per check: the command or
  observable artifact, expected result, safe setup/cleanup, and what a failure would mean.
- Do not create one test Issue per implementation Issue mechanically. Batch tests when they
  share a layer and ship/validate together.
- Static checks alone do not prove integrated behavior.

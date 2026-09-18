# Verification before completion

Do not convert “implemented” into “done” without fresh evidence.

For each `SUCCESS` condition in the durable work contract, identify the command, artifact,
runtime state, trace, metric, or observable behavior that proves it. Run the relevant
checks after the final change, not before the last edit.

Before claiming completion:

1. inspect the final diff/current state;
2. run the required targeted and integration checks;
3. verify the original user-visible/runtime failure path when this was a bug;
4. inspect unresolved reviewer/security/test findings;
5. ensure the intended commit/build/deploy is the version actually being observed;
6. update Journal/Closure evidence so another XTRM participant sees the same truth.
Review evaluates the pinned Issue revision against Git diff, tests, runtime evidence,
Specialist result, and WorkReceipt/provenance — never the worker summary alone.

For regressions, a passing test is not sufficient if the causal chain is still unexplained.
Record what introduced/exposed the problem and why the fix preserves the original valid
intent.

For runtime/deploy work, absence of alerts is not proof by itself. Use the relevant
observable signals and deployment identity. `/sre-ops` owns the production-specific
version when that pack is enabled.

If a required check cannot run, state that explicitly and explain the residual risk.
Do not hide a missing dependency, unavailable environment, or skipped E2E behind a generic
“verified” label.
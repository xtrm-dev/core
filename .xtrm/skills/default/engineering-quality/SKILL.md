---
name: engineering-quality
description: >
  Default engineering discipline for XTRM work: causal debugging, regression/provenance
  tracing, code and PR review, test strategy, verification-before-completion, and
  evidence-backed simplification. Use whenever code or runtime behavior is failing,
  changing, being reviewed, tested, optimized, or about to be declared complete. For
  regressions, reconstruct what changed, why it changed, which worker/commit/deploy
  introduced it, and how that change reaches the symptom before proposing a fix.
---

# Engineering Quality

Engineering quality is not formatting. It is the discipline that keeps XTRM workers from
turning symptoms, plausible diffs, passing mocks, or attractive abstractions into false
confidence.

This skill is default because these rules are useful in ordinary implementation work,
not only in a dedicated audit.

## Route by phase

| Need | Read |
|---|---|
| Bug, regression, crash, wrong output, performance problem | `references/causal-debugging.md` |
| Review a diff/PR or independent worker result | `references/review.md` |
| Decide what/how to test, including TDD | `references/testing.md` |
| About to claim success | `references/verification.md` |
| Reduce complexity/performance waste | `references/reduction.md` |

Load only the relevant reference. Runtime hooks own deterministic lint/typecheck/format
checks; this skill owns engineering judgment.

## Core rule

**Do not jump from symptom to fix. Reconstruct the causal chain first.**

For a regression, the desired investigation shape is:

```text
symptom / alert / failing test
  -> first bad observation
  -> failing code/data/control path
  -> recent change(s) on that path
  -> commit body + diff
  -> PR / Issue / worker that produced the change
  -> why the change was made and what contract it was satisfying
  -> deploy/runtime version that first contained it
  -> evidence that the change can cause the symptom
  -> smallest correct remediation
  -> regression proof
```

The changed line is not automatically the bug. The intent and surrounding contract matter:
a fix that simply reverts behavior without understanding why it was introduced can restore
an older failure.

## XTRM provenance is engineering evidence

XTRM work normally leaves richer history than anonymous commits. Use it.

When relevant, correlate:

- `git log --format=fuller` and complete commit bodies;
- the actual commit diff and parent/base;
- PR body, review discussion, and merge/deploy timestamps;
- Issue contract (pinned revision), Journal entries, dependencies, and Closure reason;
- Specialist/job result or XTRM peer/worktree that authored the change;
- current worktree/session topology when the change is still in progress;
- release/deployment identity and runtime observability.

Commit messages and Journal entries are evidence of *why*. Source and runtime evidence determine
whether that reasoning is still correct. A Specialist result is evidence, not automatic truth;
Closure is post-verification authority, never an executor success side-effect.

## Change discipline

Once root cause is supported:

1. make the smallest change that addresses the cause, not the visible symptom;
2. preserve the valid intent of the original change unless the contract itself was wrong;
3. add or strengthen evidence that would catch the regression;
4. inspect blast radius before modifying shared symbols or contracts;
5. re-run the real failing path and relevant regression checks;
6. update durable work with what actually caused the problem.

Do not bundle unrelated cleanup into a bug fix merely because the area is already open.

## Relationship to other core skills

- `/using-xtrm` owns system-wide work/contract/evidence rules.
- `/gitnexus` provides code-graph evidence for call chains and blast radius.
- `/planning` owns work contracts and test/evidence requirements before dispatch.
- `/starting-and-resuming-work` owns continuity and handoff.
- `/sre-ops` extends the same causal method into production observability and deployment
  reconstruction when that optional pack is enabled.

The same causal standard applies whether the problem is found locally, by CI, by another
agent, or in production.
# Causal debugging

Use for bugs, regressions, crashes, unexpected output, failing tests, integration errors,
and performance regressions.

The objective is not to find suspicious code. It is to reconstruct a causal explanation
that connects an observed failure to the change/state that produced it.

## Phase 1 — characterize the failure

Before editing:

1. Read the complete error, stack trace, failing assertion, logs, or wrong output.
2. Reproduce consistently when possible; record exact inputs/environment/version.
3. Establish the first known bad observation and, if possible, a last known good one.
4. Identify the failing boundary: function, process, request, job, service, data flow, or
   deployment.
5. If intermittent, gather timestamps/correlation IDs and enough examples to identify the
   affected subset.

If it cannot be reproduced, gather more evidence instead of guessing a fix.

## Phase 2 — reconstruct change provenance

For a regression, history is a primary evidence source, not a final afterthought.

Use the bundled deterministic helper when available to collect a bounded candidate set
without repeatedly reconstructing Git commands:

```bash
node <engineering-quality-skill-dir>/scripts/change-provenance.mjs \
  --repo <repo> --path <affected-path> --since '<last-known-good>' --max 40

# Inspect one exact candidate with full body/files:
node <engineering-quality-skill-dir>/scripts/change-provenance.mjs \
  --repo <repo> --sha <commit>
```

It deliberately does **not** identify a culprit. It emits commit bodies, parents,
author/commit timestamps and changed paths for the reasoning layer to correlate with the
failure.

Manual Git equivalents remain useful:

```bash
git log --format=fuller --decorate --date=iso -- <affected-path>
git show --format=fuller <sha>
git log -p -- <affected-path>
git blame -L <start>,<end> <file>
```

When the regression window is bounded and a deterministic reproduction exists, use
`git bisect` rather than manually guessing among many commits.

For each credible change, reconstruct:

```text
commit
  -> complete commit subject/body and actual diff
  -> authoring branch/worktree/peer when recoverable
  -> PR and review/discussion
  -> Issue revision / dependencies / Journal / Closure reason (with provenance: claim, commits, PRs)
  -> Specialist or agent result when that work produced the change
  -> original problem, constraints and intended success condition
```

Use `gh`, `sb`, XTRM worktree/topology state, and `sp result` or current equivalents when
those surfaces exist. (`bd`/`bv` describe the retired Beads board; use them only for
migration/history work.) Exact commands are runtime-dependent; use live help.

The commit body is valuable because XTRM agents normally record reasoning and scope. But
it is not authority: compare stated intent with the actual diff and current contract.

Classify candidate relationship precisely:

- **introduced by** — the change added the defective behavior/assumption;
- **exposed by** — the change validly activated or reached a pre-existing defect;
- **correlated with** — nearby in time/path, but no causal mechanism proven.

Do not simply revert the newest commit. A changed line may be correct and only expose an
older assumption elsewhere. Understand why the change existed before undoing it.

## Phase 3 — trace code/data/control flow

Use `/gitnexus` plus targeted source reads to connect candidate changes to the symptom.

```text
query error/symptom
  -> identify process and suspect symbols
  -> inspect callers/callees and data/control flow
  -> inspect recent changes to those symbols/processes
  -> read source to confirm actual behavior
```

For bad values, trace backwards until the value is created or corrupted. For missing
behavior, trace forward to where the expected action should occur. At component
boundaries, verify what enters and exits rather than assuming config/data propagation.

Ask:

- Where is the first point state becomes wrong?
- What exact input/state reaches that point?
- Which caller/upstream component supplied it?
- Did a recent commit change that assumption, ordering, schema, timeout, or default?
- Which downstream callers depend on old/new behavior?

## Phase 4 — build one falsifiable hypothesis

State it explicitly:

```text
I think <change/state> causes <symptom> because <observed causal mechanism>.
If true, <minimal experiment/evidence> should show <expected result>.
```

Test one variable at a time. Do not pile speculative fixes together. When a hypothesis
fails, discard it and incorporate the new evidence.

## Phase 5 — compare with working behavior

Find a working comparison when useful: earlier commit, sibling code path, unaffected
request/service, previous deployment, or equivalent implementation.

List relevant differences and explain which one can produce the symptom. Avoid “that
cannot matter” assumptions until evidence rules the difference out.

For an RCA with a tempting recent change, deliberately search for a red herring: a newer
commit touching the same file, a deploy-adjacent change outside the path, or a healthy
execution that uses the suspected path. A causal explanation should survive that check.

## Phase 6 — fix the cause

Once cause is confirmed:

1. create/strengthen the smallest reproduction or regression test when practical;
2. make one targeted fix;
3. preserve valid intent of the change that introduced/exposed the regression;
4. re-run the original failing case;
5. run affected regression/integration checks;
6. inspect GitNexus blast radius for shared-symbol changes;
7. record the causal chain in durable work.

A useful root-cause note:

```text
Last good / first bad:
Introduced / exposed / correlated by:
Commit / PR / Issue revision / worker:
Original intent:
Mechanism:
Evidence and counterevidence:
Fix:
Regression proof:
```

## Performance regressions

Measure before optimizing. Compare current bad state with a known-good baseline and trace
the changed hot path. Use language/runtime profilers when needed, then correlate the
hotspot with recent commits and callers via GitNexus. A slower release plus nearby commit
is correlation until profile/control-flow evidence explains the cost.

## Stop conditions

Stop and reconsider architecture/assumptions when repeated fixes fail for different
reasons or reveal widening hidden coupling. Three failed fixes without a stable causal
model is evidence the hypothesis or architecture is wrong, not a reason for a fourth
speculative patch.

Never replace causal investigation with “try this and see” under time pressure. Fast
incident response benefits more, not less, from knowing which change to revert or repair.
# Review

Review the work contract and actual diff/result, not the author's summary.

## Evidence order

1. Read the durable Substrate Issue contract (pinned revision) when one exists.
2. Read the actual diff and relevant current source.
3. Inspect existing review threads/automated findings and verify them against this revision.
4. Use GitNexus impact evidence for changed shared symbols/processes.
5. Check tests and runtime evidence against the claimed success conditions.
6. For a regression/fix PR, verify the causal explanation in `causal-debugging.md` rather than accepting “this seems to fix it.”

Prioritize correctness, state/resource safety, compatibility, migrations, failure behavior,
security boundaries, observability, rollback/recovery, and missing behavioral evidence.

For large diffs, split review lenses or use independent reviewers when that increases
coverage, but keep one integrated final verdict. Multiple reviewers producing overlapping
lists without synthesis is not stronger review.

Bot/LLM findings are leads. Confirm the cited line/symbol and mechanism before blocking
work. If rejecting a material finding, record why it is invalid.

A useful issue states:

```text
location
problem
why it matters / failure mechanism
evidence
required correction or contract conflict
```

Do not turn subjective style preferences into blockers unless they violate an enforced
project convention or materially affect readability/maintenance.

Final review should distinguish blocking findings, non-blocking follow-ups, and external
blocks. Never reinterpret a valid failing test/security/contract gate as advisory because
the implementation looks plausible.
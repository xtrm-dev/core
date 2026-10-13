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

## ocr delegation lane (explicit scope only)

OFF unless the pinned contract or scope explicitly names ocr delegation evidence, AgentRun
evidence, or both. When unnamed, review exactly as above.

Delegation is LLM-free on the OCR side: `ocr` supplies deterministic file selection and rule
resolution; all review judgment stays in this document. Do not call `ocr review` here.

1. `ocr delegate preview --format json [--from <ref> --to <ref> | --commit <hash>]` — mode,
   refs, reviewable files, and excluded files with their reason.
2. `ocr delegate rule --format json <reviewable paths>` — resolved rule groups, grouped by
   content.
3. Read the diffs with `git --no-pager diff` or `git show` for the reported mode.
4. Report a per-file reviewed-or-skipped checklist with a concrete skip reason per skip, JSON
   comments carrying `path`, `content`, line range, `category` and `severity`, and coverage
   accounting (total, reviewed, skipped, coverage rate).

Delegation output is evidence, never the verdict; do not invent gate semantics on top of it.
The `open-code-review` skill is vendored as a default skill: its delegation contract is
`references/delegate.md` under `~/.xtrm/skills/default/open-code-review/`.

## AgentRun evidence (explicit scope only)

Inspect before running: call the agentrun tool with `describe`, then `inspect` with the
workflow and its input. Run only the inspected definition, with the input only. Code, call and
shell nodes and mutating tools run only after the operator issues the trusted-run command for
that run — never assume it. Experimental workflow flags stay off by default. The receipt is the
inspected revision digest plus the run result, or the failure evidence when a run fails; record
it verbatim and invent nothing.
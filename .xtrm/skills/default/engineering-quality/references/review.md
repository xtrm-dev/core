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

## ocr delegation lane (every review of a git range)

ON for every review that has a git range to review (a diff, a commit or a PR); the contract
does not need to name it. The AgentRun evidence lane below stays explicit-scope-only.

Delegation is LLM-free on the OCR side: `ocr` supplies deterministic file selection and rule
resolution; all review judgment stays in this document. Do not call `ocr review` here: it
calls a model, needs a configured provider, and is not part of this lane.

A repo may carry `.opencodereview/rule.json`. Its `include` list restores files that OCR
excludes by default, most importantly test files (`**/test_*.py`, `*_test.go`, `*.test.ts`);
without it a reviewer sees the tests as excluded `default_path` files and reports that as a
coverage gap. Without the file only OCR's generic per-language rules apply; say so.

1. `ocr delegate preview --format json [--from <ref> --to <ref> | --commit <hash>]` — mode,
   refs, reviewable files, and excluded files with their reason.
2. `ocr delegate rule --format json <reviewable paths>` — resolved rule groups, grouped by
   content.
3. Read the diffs with `git --no-pager diff` or `git show` for the reported mode.
4. Report a per-file reviewed-or-skipped checklist with a concrete skip reason per skip, JSON
   comments carrying `path`, `content`, line range, `category` and `severity`, and coverage
   accounting (total, reviewed, skipped, coverage rate).

Delegation output is evidence, never the verdict; do not invent gate semantics on top of it.
In Pi, run the OCR steps inside one codemode cell (`tools.bash` fan-out, digest returned;
see the `codemode` skill); in Claude Code, batch them into one Bash call.
The `open-code-review` skill is vendored as a default skill: its delegation contract is
`references/delegate.md` under `~/.xtrm/skills/default/open-code-review/`.

Prove the coverage accounting instead of reporting it:
`node <engineering-quality-skill-dir>/scripts/ocr-preflight.mjs check --preview <preview.json>
--ledger <ledger.json> [--findings <findings.json>]` exits 1 on a missing, extra or duplicate
`(path, status)`, a skip without a reason, a finding outside the reviewable set, a bad enum or
line range, or a summary that does not recompute. It prints excluded counts next to
`coverage_rate`: 100% of one reviewable file with three `.md` files excluded is not a full review.

## Writer pre-flight (explicit scope only — no OCR LLM)

OFF unless the pinned contract or scope explicitly names ocr delegation evidence, AgentRun
evidence, or both. When unnamed, review exactly as above and ignore this lane.

OCR's system rules are prose checklists for a model; OCR runs no static analysis. A writer
gets its deterministic value without `ocr review` token cost:

1. `node <engineering-quality-skill-dir>/scripts/ocr-preflight.mjs preflight [--from <ref> --to
   <ref> | --commit <sha>]` — reviewable files, excluded files by reason, and one resolved rule
   checklist per group. It writes `preview.json` and `rules.json` for the `check` step.
   The digest keeps each checklist's first line; the full text is in `rules.json`. Read it
   for Go, Python and Rust (substantive, 6-11 KB); the JS/TS default rule is frontend-oriented.
2. Apply each group's checklist to your own diff while it is still cheap to change.
3. Run the repo's own lint, typecheck and tests; those are the deterministic defect checks.
4. Before handoff, record your self-review as a ledger and run `check`.

Steps 1 and 3 run in one codemode cell (`codemode` skill, "writer pre-flight"). A repo with no
linter or typecheck has a gap in its floor: see `quality-baseline.md`.

Reviewers and seconders run the delegation lane above as independent scrutiny; the writer
pre-flight does not replace it. `ocr review` is optional and needs a configured provider.

## AgentRun evidence (explicit scope only)

Inspect before running: call the agentrun tool with `describe`, then `inspect` with the
workflow and its input. Run only the inspected definition, with the input only. Code, call and
shell nodes and mutating tools run only after the operator issues the trusted-run command for
that run — never assume it. Experimental workflow flags stay off by default. The receipt is the
inspected revision digest plus the run result, or the failure evidence when a run fails; record
it verbatim and invent nothing.
## Merge gate and reviewer routing (CORE-2530)

A PR merges only with a review by the reviewer App (**`xtrm-reviewer[bot]`**) at its current
head. GitHub Actions is billing-locked and the organisation is on the Free plan, so nothing on
GitHub enforces it: the check runs on the agent's machine.

The merge guard is **on by default for launched sessions**: the launcher exports
`XTRM_MERGE_GUARD=on` (a plain shell does not), and `XTRM_MERGE_GUARD=off` reaches the workers
explicitly. With it off, both the `gh` shim and the Claude Code hook pass the merge through and
say so on stderr. Rules, refusals and the override: `using-xtrm/references/agent-identities.md`.

- `gh pr merge` first runs `xt identity merge-check`. It refuses when the bot's latest review is
  missing, is at an older head, or requested changes. A `COMMENT` (PARTIAL) review passes only
  with a later coordinator decision, for that head, in the Issue Journal. The refusal text names
  the allowed reviewer paths; `XTRM_MERGE_GUARD_OVERRIDE=<reason>` is for the coordinator and the
  operator, is logged, and journals a decision on the Issue.
- The tier rule — HIGH or critical needs a Claude-backed reviewer — lives in the reminder
  (`~/.xtrm/config/reviewer-routing.md`, installed by `xt identity setup`).
- The `gh` shim (`xt identity setup` installs it as `~/.local/bin/gh`) carries the merge guard and
  turns `gh pr review` into a formal review pinned to the reviewed head when the agent runs as the
  reviewer role. It also handles `gh pr create`: the created PR is attached to the Issue named in
  its `xtrm issue=` marker (T1 then T2), fail-open. The create reminder below is the Claude Code
  hook's, so Pi and Codex agents get no reminder.
- The Claude Code hook `xtrm-review-gate` (policy `policies/xtrm-review-gate.json`) runs the same
  guard as a PreToolUse check: it tokenises the Bash command and gates only a simple command whose
  argv is `gh … pr … merge`, then hands that argv to `xt identity merge-check --gh-args`. Text in
  quotes, heredocs or another program's arguments never triggers it, and the PR it checks is the
  PR the shim resolves. A branch target without `--repo` is refused by design: neither the hook nor
  the CLI guesses a repository for it. The hook is **Claude Code only**; Pi and Codex rely on the
  shim.

For a review, read the pushed head and post one review at that head: PASS -> APPROVE,
PARTIAL -> COMMENT, FAIL -> REQUEST_CHANGES. A stale approval is not evidence.

Client-side only: any agent that holds the operator's `gh` login can call the GitHub API directly,
and `gh api …/pulls/N/merge` is refused only for the reviewer role by the shim. The guard catches
errors and stale or missing reviews; it is not protection against a hostile agent on the same unix
user. The hook parses one command string. It gates the common spellings — `/usr/bin/gh`,
`command gh`, `env X=1 gh`, `sudo gh`, `time gh`, `nohup gh`, `exec gh`, `xargs gh`, a leading `!`,
`(`, `{`, `then`/`do`/`else`, quoted `'pr'`/`"gh"`, `g\h`, and CRLF line endings — and it treats a
`$(…)` substitution as a command boundary, so the merge is still gated even though the substitution's
value is not seen. Not gated and not parsed: `sudo -u root gh` (a value between `sudo` and `gh`),
`timeout`, `nice`, `stdbuf`, `setsid`, `watch`, `parallel`, `busybox` and `find -exec`; the shim is
the backstop for those. `xargs gh pr merge` takes its target from stdin, so the hook checks the cwd
PR instead of the piped one. A target the resolver cannot read statically (`$PR`) is refused with a
message asking for an explicit PR number, and an argv over 100 kB is reported as too large to
inspect. Backticks, `eval` and `sh -c` strings are invisible to the hook. When the reviewer App is
unavailable the guard blocks merges and the override is the documented way out.

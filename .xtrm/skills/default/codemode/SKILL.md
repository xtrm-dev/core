---
name: codemode
description: >
  Programmatic tool calling via codemode: batch independent tool calls, filter large
  results, and run classifiers in one JavaScript cell. Use when a task needs several
  tool reads/greps/inspections, output that must be filtered before the model sees it,
  or a loop-with-a-decision over tool results. Not for local Python compute or
  pre-edit history (use the persistent python kernel), single tool calls, or
  project test suites (use the project's runner).
---

# Codemode

One cell instead of one model round trip per operation. Raw JavaScript runs as an
async function body: top-level `await`/`return` work, every session tool is a
`tools.*` method, failures reject with `Error`. **Only the script's output reaches
context** — fan out with `Promise.allSettled`, filter in-script, return the digest.

## Route first

- Several independent tool calls, or output needing filtering → codemode (this skill).
- Local compute over loaded data, pre-edit history (`preflight`), probing real Python
  modules → persistent `python` kernel.
- Both at once → compose: `tools.python` from inside codemode hits the same kernel
  (verified: set in cell, read in cell, re-read from the direct tool).
- Single tool call, two plain edits, project tests → skip the cell entirely.

## Cell discipline

- Fan out independent calls with `Promise.allSettled()`; `await` in order for
  dependent steps. Small cross-cell state via `store()`/`load()`.
- Filter before returning: slice, count, group, summarize; return counts, top-N,
  deltas. Never raw dumps unless asked.
- Await everything the answer needs — unawaited promises are discarded at cell end.
  `// @options` line goes first or the call fails.
- Tool calls are real and non-undoable; partial output survives failure — read it
  before retrying. Keep destructive ops in their own verified call.
- The sandbox has no fs/network/timers: shell fan-out goes through `tools.bash`;
  codemode orchestrates, it does not replace the shell.
- `models.classify` for typed judgments over gathered JSON (routing, triage);
  check `stopReason`/`errorMessage`. Paid tiers can 402 — fall back to free
  classifiers; thin state rightly returns no-match.

## Discover tools before assuming absence

A missing tool is usually undiscovered, not absent. When the task needs a
capability your list doesn't show, run one cell in this order: `ALL_TOOLS`
for the census, `searchTools("<task words>")` to narrow (it also loads
what it finds into the session), `describeTool("<exact name>")` for the
description plus the full argument schema. Names alone don't teach usage —
only `describeTool` gives you the contract. Note: `tool_search` loads do
not survive a session restart; re-discover or fall back to codemode methods.

## Pattern: writer pre-flight (explicit scope only — no OCR LLM)

OFF unless the pinned contract or scope explicitly names ocr delegation evidence, AgentRun
evidence, or both. When unnamed, ignore this pattern and review exactly per
`engineering-quality/references/review.md` above the lane sections.

One cell gives a writer OCR's deterministic scaffolding plus the repo's own checks,
with no `ocr review` token cost (see `engineering-quality/references/review.md`):

```js
const out = (r) => (typeof r === "string" ? r : r.output); // shape varies by release
const { homedir } = await import("node:os");
const { join } = await import("node:path");
// ~ never expands inside a JS string; resolve from homedir instead (CORE-2402).
const pf = join(homedir(), ".xtrm", "skills", "default", "engineering-quality", "scripts", "ocr-preflight.mjs");
const [pre, lint] = await Promise.allSettled([
  tools.bash({ command: `node ${pf} preflight --from origin/main --to HEAD` }),
  tools.bash({ command: "<repo lint && typecheck> 2>&1 | tail -40" }),
]);
const lintOut = lint.status === "fulfilled" ? out(lint.value) : lint.reason.message;
if (pre.status === "rejected") return { preflight_error: pre.reason.message, lint: lintOut };
const d = JSON.parse(out(pre.value));
store("ocr_preflight", d.files);
return { reviewable: d.reviewable, excluded: d.excluded_by_reason, checklists: d.rule_groups, lint: lintOut };
```

Apply the checklists, then run `ocr-preflight.mjs check` on your ledger. Fixes go in a
later cell: they change the diff, so rerun `preflight` before `check`.
Reviewers run the same cell for the ocr delegation lane and add `check` on their ledger.

## Runtime variance (verified, not documented)

Tool surfaces differ between Pi releases. Read `references/runtime-shapes.md`
before assuming resolve shapes or globals, and probe cheaply (5-line cells)
when a call fails: the error text is the contract.

Python kernel limits (120 s cell timeout kills the kernel and its state, 20,000-char
output cap, not sandboxed, `skillbridge`, `_AUDIT`): `references/kernel-mechanics.md`.

## Evaluation record

Built from a live session (2026-10-12/13): ~15 tool calls collapsed into 6 cells
for a repo/service survey; Jev Choice+bool routing with 402 fallback and thin-state
`none`; shared-kernel proof (612→1224→1836); failure-led fixes (resolve-shape
mismatch corrected the batching doctrine itself). Failing cells that teach the
contract beat re-reading docs.

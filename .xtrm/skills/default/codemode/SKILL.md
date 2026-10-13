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

## Runtime variance (verified, not documented)

Tool surfaces differ between Pi releases. Read `references/runtime-shapes.md`
before assuming resolve shapes or globals, and probe cheaply (5-line cells)
when a call fails: the error text is the contract.

## Evaluation record

Built from a live session (2026-10-12/13): ~15 tool calls collapsed into 6 cells
for a repo/service survey; Jev Choice+bool routing with 402 fallback and thin-state
`none`; shared-kernel proof (612→1224→1836); failure-led fixes (resolve-shape
mismatch corrected the batching doctrine itself). Failing cells that teach the
contract beat re-reading docs.

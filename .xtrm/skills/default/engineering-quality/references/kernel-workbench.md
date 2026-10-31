# Kernel workbench

Use when the work is repeated data handling, one-shot python through bash, a
probe-before-fix decision, or pre-edit history — not for one-off commands or
two plain edits.

Mechanics (prelude, output caps, audit seam, options) live in
`packages/pi-extensions/extensions/python-kernel/README.md` and are not
repeated here. This reference owns the judgment: when the kernel wins, what to
prove first, and where it lies to you.

## When the kernel beats one-shots

Reach for the persistent kernel when the task is a loop with a decision or a
parse-then-act step that will run more than twice: chained text-munging
pipelines, repeated log/export sweeps, or successive python one-shots through
bash. Load once into a named variable, then filter across cells — never
re-fetch per question.

If two plain edits would finish it, skip the script. Script-fiddling is a
failure mode, not leverage: the smallest correct change wins over a clever
harness built for a one-off.

## Probe before fix

Reproduce the bug before writing the fix. Probe the real module with synthetic
inputs in the cheapest live surface, then edit:

- Python: probe in the kernel; after editing source on disk, reload or run via
  subprocess rather than trusting the old import.
- TypeScript/JavaScript: no persistent kernel — one-shot eval in the project's
  runner, watch mode or a scratch script for iteration.
- Compiled languages: no REPL culture — a throwaway probe test or main under a
  scratch path with the project toolchain, then delete it.
- SQL: query the live shape directly; schema and data beat guessing from
  migrations.

A probe that cannot fail is not evidence. A fix without a failing-first
reproduction is a guess with a diff attached.

## Preflight before edit

Progressive retrieval, never bulk. Retrieve on demand at the moment of need:
before modifying a file, when a bug arises, or when GitNexus flags a
file/symbol as critical or medium impact.

The default is file-scoped preflight for that file only — its commit bodies,
pending diff, and memory keys as a bounded digest — never a blind corpus
search. Zero commits means a wrong path, not empty history; digests, never raw
corpora. The same per-file corpus feeds the commit description when the work
lands. Write durable findings back so the next session retrieves instead of
re-deriving.

## Forensics: shrink the pile first

For large logs or outputs, parse and group by failure signature; compare
consecutive runs as sets (same failures versus new failures) and report only
the delta, never walls of raw output. When a payload could be huge, filter and
summarize before reporting: counts, top-N, and matching lines rather than full
dumps.

## Hazards: persistent state lies

State that survives across cells can silently test yesterday's code: stale
imports after a disk edit, a drifted working directory, and partial side
effects from aborted cells. When files changed on disk after the kernel last
ran, distrust in-memory copies or start fresh.

## Project runner wins

For the project's own tests, scripts, and CLIs, keep the project's documented
runner rather than the kernel or a global tool. Treat failures from that native
environment as the relevant result.

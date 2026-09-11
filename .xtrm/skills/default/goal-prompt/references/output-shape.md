# Output shape — goal-prompt templates

Moved from the skill root to keep the root within its line budget; the root
`SKILL.md` points here for the exact templates. Source: global `goal-prompt`
`SKILL.md` "Output shape" section, verbatim.

Inline (source fits the cap cleanly):

```text
/goal <short title> (<work/key>)

CONTEXT (verified)
- pinned state the agent starts from

PROBLEM
- what is wrong/missing and why this exists

SUCCESS — all of:
1. observed end states, each checkable

SCOPE
- what the agent may touch

NON_GOALS
- what it must not absorb

CONSTRAINTS
- order, invariants, ownership, safety

VALIDATION
- exact checks / evidence per step

OUTPUT
- final durable result; then stop

STOP PREDICATE (last line — testable from transcript)
- e.g. "Condition holds when the final assistant message contains <named artifact>
  with <field> filled."
```

Original-first (long source): objective-led spine, READ-FIRST header, file demoted to
evidence:

```text
/goal <short title> (<work/key>)

OBJECTIVE
- one imperative sentence: what must be true when done

READ FIRST — <absolute path> (verbatim source of truth for detail/evidence; NOT the
objective — the objective is this prompt's first block)
Precedence: file wins on evidence; this prompt wins on objective/success/stop.
Flag conflicts, don't silently resolve.

CONTEXT (verified)
... (spine unchanged)
```

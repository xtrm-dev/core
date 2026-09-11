---
name: goal-prompt
description: >
  Transform an inbound prompt (status report, handoff narrative, bug/issue notes,
  progress update) into one actionable, agent-ready goal prompt — and nothing else.
  Use when the user says "make this a goal prompt", "transform this to a prompt for an
  agent", "/goal", or hands over a narrative that another agent must execute on its own.
  The output is a self-contained, copy-pasteable prompt that a fresh agent can run
  without the source conversation. Long source prompts switch to original-first mode:
  the source is persisted verbatim to a refs file, read first, and the compressed
  prompt runs on top with explicit precedence (file wins on conflict). Shares the
  planning skill's contract primitives, but is scoped to a single issue/goal: it never
  creates board state or decomposes epics.
---

# Goal Prompt

## What this skill does

One transform, one output: the inbound prompt becomes a single goal-ready prompt. It does
not fix the underlying work, search the repo, touch beads, or verify upstream claims
beyond what the source already states.

## Transform rules

1. **Faithful facts.** Keep every concrete fact exactly as given: SHAs, PR/issue numbers,
   gate states, versions, ownership, ordering. Never invent claims.
2. **Compress, don't invent.** Drop hedging, repetition, and narrative color. Keep
   requirements, ordering, gates, evidence expectations, ownership, and warnings.
3. **Self-contained.** A fresh agent must execute without the source chat transcript.
   The original text is reachable either inline (short sources) or by path (long
   sources, original-first mode below).
4. **Refs file is overflow-only.** Steps, directives, HARD STOP lists, and ordering
   belong INSIDE the `/goal` condition — the condition is re-shown at every Stop
   checkpoint and is the ambient anti-drift surface. Push content into a refs file
   only when it physically will not fit the harness cap, and only for verbatim source
   that would be lossy to compress. Never demote the plan itself to a file the agent
   has to re-read every turn.
5. **Fit the receiver's length limit — hard harness cap: 4000 characters for the
   COMPLETE goal prompt** (title + READ-FIRST + precedence + spine). Treat it as an
   absolute receiver constraint, not a default. When a source cannot be faithfully
   distilled within it, original-first mode still applies, but the complete injected
   prompt must fit — the refs file carries all depth, and the spine prefers
   §-pointers into that verbatim file over dropping requirements.
6. **Stale-source warnings.** When the source itself flags outdated information (e.g. an
   external comment older than a gate re-run), carry it as an explicit warning: what is
   stale, what to trust instead, when to re-check.
7. **Objective always in the spine.** The objective, success gates, and stop condition
   must be readable from the spine alone — never only from a referenced file. A spine
   that merely says "read the file and do what it says" is a pointer, not a goal;
   rework it. The file supplies depth and evidence; the spine supplies direction.

## Long source prompts — original-first mode

Compression loses nuance. For a genuinely long source, do not grind the spine down until
requirements are at risk. Persist the original verbatim and run the spine on top.

Trigger: the source content no longer fits the cap without cutting or degrading an
enumerated requirement (invariant, gate, field, area, value, owner).

Procedure:
1. If the user passes a source file path: verify it exists, read it, use that path.
2. If the source was pasted: save it verbatim to `<skill dir>/refs/<slug>.source.md`
   (`slug` = issue/PR or short title), report the absolute path in your reply.
3. Build the prompt:
   - Objective line first: one imperative sentence stating what must be true when done
     (the outcome), placed at the very top — before READ FIRST, so a skim always hits
     it. Example: "Objective: PR #123 has a submitted, genuinely independent exact-head
     security review and an unambiguous merge-readiness verdict."
   - Then `READ FIRST — <absolute path to original> (verbatim source of truth for
     detail and evidence; NOT the objective — the objective is in this prompt).`
   - Precedence rule: on any conflict between this prompt and the file, the file wins
     for evidence; the objective/success/stop definitions in this prompt win for
     direction. Flag the conflict in the handoff.
   - Then the normal compressed spine. The spine keeps the objective, all success
     gates, the stop condition, and all numbered required fields; nuance the spine
     cannot hold lives in the file — never dropped from both.
4. Cap accounting: 4000 is a hard harness limit for the COMPLETE prompt, READ-FIRST
   header included. If the objective + gates + stop + verification tokens cannot fit in
   the remaining budget, use §-pointers into the refs file for enumerations (never
   vacuous pointers) — and never exceed 4000.

Fidelity accounting — every enumerated item from the source appears either in the spine
or verbatim in the file. If an item is in neither, the transform failed.

Direction accounting — the objective, each success gate, and the stop condition must
stand in the spine without the file. Skim test: read only the spine; if a fresh agent
cannot state what to do, what done looks like, and when to stop, the transform failed.

## Map narrative to the goal shape

```text
verdict / what is wrong or missing      -> PROBLEM
end states / gates / acceptance         -> SUCCESS
files, PRs, systems the agent may touch -> SCOPE
"do not", "separate issue", "later"     -> NON_GOALS
order, invariants, ownership, safety    -> CONSTRAINTS
checks / commands / evidence            -> VALIDATION
final artifact / durable result         -> OUTPUT
```

Lead with a `CONTEXT (verified)` block that pins the exact starting state (current main
SHA, PR heads, green/red gates), so the recipient starts from a confirmed position instead
of re-deriving it.

## Primitive sharing with planning

Use the seven-section contract shape from
`~/dev/core/.xtrm/skills/default/planning/references/contracts.md`
(PROBLEM/SUCCESS/SCOPE/NON_GOALS/CONSTRAINTS/VALIDATION/OUTPUT) and its quality test:
could a fresh competent worker execute this without the current chat? If not, the missing
piece goes into the goal prompt or a referenced path.

Division of labor: the `planning` skill serves the higher-level coordinator — boards,
decomposition, multi-issue sequencing. This skill serves single-issue dispatch: one
bounded work item, one goal prompt, no board state.

## Output shape

Read `references/output-shape.md` for the exact inline and original-first templates.
Summary: inline mode emits `/goal <title>` plus CONTEXT/PROBLEM/SUCCESS/SCOPE/
NON_GOALS/CONSTRAINTS/VALIDATION/OUTPUT and ends with a one-sentence STOP PREDICATE
naming a transcript-visible artifact. Original-first mode leads with OBJECTIVE, then a
READ FIRST header with the verbatim path and the file-wins-on-evidence /
prompt-wins-on-direction precedence rule, then the same spine.

## Stop-hook predicate shape

Read `references/stop-predicate.md` for the full predicate contract. Summary: the
condition has two zones — steps/directives/ordering (guidance, re-shown every
checkpoint) and the LAST-line stop predicate (the only pass/fail criterion, testable
from the transcript alone naming an emitted artifact). An honest-failure emission must
satisfy the predicate; never enumerate SUCCESS gates inside it.

## Self-injection — start-of-work re-entry (tmux send-keys)

The goal prompt is by design injectable into an agent's own tmux pane: OBJECTIVE +
READ FIRST + gates is the skim-safe minimum, and a thin spine survives pane injection
where multi-line bodies corrupt. Read `references/self-injection.md` for mechanics and
guardrails; use `scripts/self-inject.sh` to submit. Inject only at a safe checkpoint
(start, idle, milestone — never mid-flight), only well-formed goal output with a stop
predicate, never auto-reinject on completion, prefer native continuation APIs when
available, and verify the pane target first.

## Test before handing over

- Every concrete token from the source appears; nothing invented; one bounded item.
- No long file inlined; complete prompt ≤ 4000 characters, counted.
- A fresh agent could run it without this conversation.
- Original-first: refs file exists, READ-FIRST path exact, precedence present,
  every enumerated item in spine or file, spine-only skim keeps objective/gates/stop.
- Predicate test: LAST line names a transcript artifact; honest failure satisfies it.

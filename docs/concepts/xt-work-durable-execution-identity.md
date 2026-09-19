# Concept: durable execution identity and `xt work`

Status: parked / unvalidated concept (note CORE-2304, 2026-09-18: `starting-and-resuming-work` folded into `using-xtrm`; body below is a historical record, not the current routing)

This document captures a proposed XTRM work-lifecycle surface that is intentionally **not part of the current runtime contract yet**. The prototype implementation was explored on the skills-v4 branch and then removed from the active change set pending real local behavioral testing with Pi/Claude and an independent agent audit.

## Motivation

XTRM currently enforces a useful invariant: repository mutation requires a claimed Bead. The gate is deliberately strict because anonymous agent work is hard to recover, audit, coordinate, or hand off.

The current friction is that a worker encountering the gate may understand only the prohibition, not the intended compliant path. This is especially noticeable for small edits, where requiring a full planning pass would be excessive, and for Pi sessions where agents may try to work around the gate instead of establishing durable work identity.

The underlying principle is:

> Every mutating worker should have a durable execution identity before it changes the repository.

Today that identity can be represented by a claimed Bead. A future XTRM substrate may make execution identity a first-class runtime entity.

## Two distinct work shapes

### Contract-quality planned work

Substantial, ambiguous, high-risk, multi-worker, or delegated work should continue to use `/planning` and produce a real work contract.

Baseline fields:

```text
PROBLEM
SUCCESS
SCOPE
NON_GOALS
CONSTRAINTS
VALIDATION
OUTPUT
```

Add `SCRUTINY` and other constraints/evidence requirements when appropriate.

For tracked substantial work, the Bead remains the prompt: important requirements should not live only in chat history or an orchestrator's private context.

### Lightweight execution check-in

A small, bounded, local edit should not require a fake seven-section planning exercise merely to satisfy the mutation gate.

A lightweight execution/check-in identity would exist to capture:

- what this worker is doing;
- what existing issue or initiative it relates to;
- what evidence will prove completion;
- meaningful progress/state transitions;
- blockers or material scope changes;
- final evidence/result.

If the work grows, becomes ambiguous, or is handed to another worker, the lightweight record is no longer sufficient and should route through `/planning`.

## Proposed high-level CLI

A future stable facade could look like:

```bash
xt work start --bead <id>
xt work start "<small bounded task>" --validation "<proof>"
xt work resume <id>
xt work status [id]
xt work note "<meaningful progress>" [--bead <id>]
xt work done [id] --reason "<validated result>"
xt work guide
```

The important design choice is that agents learn the XTRM lifecycle through `xt work`, not raw Beads mechanics. Today the implementation could delegate to Beads; later the same command family could target a first-class substrate execution entity without reteaching every worker.

## Relationship to existing work

A lightweight execution identity that serves an existing Bead should normally use a **non-blocking** relationship. It should not misuse dependency edges merely to mean "this session is working on that issue".

Actual blocking dependencies must remain semantically meaningful for scheduling and readiness.

Potential future substrate shape:

```text
Execution / WorkRun
  ├── worker identity
  ├── contract refs
  ├── related work refs
  ├── workspace/session identity
  ├── lifecycle state
  ├── progress events
  ├── evidence
  └── result
```

## Skill ownership if adopted

The durable invariant belongs in `using-xtrm`, not primarily in a separate continuity skill.

Proposed responsibility split:

```text
using-xtrm
  ├── no anonymous mutation
  ├── establish durable execution identity
  ├── lightweight vs contract-quality work boundary
  ├── meaningful progress/evidence discipline
  └── route substantial work to /planning

planning
  └── create/promote contract-quality work and dependencies

continuity (folded into using-xtrm per CORE-2304)
  └── re-entry, takeover, context-pressure continuation, stalled-lane recovery

multiplexing
  └── coordinate multiple workers/identities

engineering-quality
  └── prove the resulting work is correct
```

The continuity half would therefore become narrower rather than disappearing — folded into `using-xtrm` per CORE-2304.

## Why a CLI may be preferable to more prompt text

A CLI surface is easier to evolve and query than duplicating long lifecycle instructions across skills, system prompts, CLAUDE.md, AGENTS.md, Pi extensions, templates, and downstream repositories.

A command such as `xt work guide` could expose the current authoritative lifecycle contract on demand. This is analogous to the broader XTRM/Mercury direction of making capabilities discoverable through maintained runtime/tool surfaces rather than repeatedly injecting large static instruction blocks.

## Progress journal semantics

Progress should record state transitions, not tool activity.

Bad journal:

```text
read file
edited function
ran test
opened another file
```

Useful journal:

```text
root cause established: stale registry is the only affected path
implementation complete; integration validation remains
test exposed a pre-existing unrelated failure
scope expanded to include runtime session synchronization
```

A separate ceremonial handoff document should not be required when the durable work record, repository, commits, tests, PR, and worker results already contain the needed continuation state.

## Critical runtime constraint discovered during prototype

A naive CLI wrapper around `bd update --claim` is insufficient.

Current Pi/Claude gates bind claims to a runtime/session identity through hook/extension behavior. If `xt work` shells out to `bd` internally, those nested commands may not be visible to the top-level PostToolUse lifecycle hooks. The CLI can therefore claim a Bead successfully while the current runtime session still appears unclaimed and remains blocked.

Any future implementation must explicitly integrate with runtime session identity rather than merely wrap Beads commands.

The same concern applies to close/memory semantics. Pi and Claude currently have different enforcement timing, and a facade must preserve or deliberately reconcile those contracts rather than silently bypass them.

## Required local validation before adoption

Do not propagate this concept into canonical agent instructions until it passes real local testing.

### Mechanical tests

- build/typecheck;
- CLI unit tests;
- Beads relation semantics;
- packaged guide availability;
- Claude claim-sync behavior;
- Pi extension claim/cache behavior;
- close, memory, commit, and stop gate preservation.

### Real agent behavioral test

Preferred harness: Pi.

Start a test session with no active claim and give the agent an ordinary small-edit prompt without telling it about `xt work` explicitly, for example:

> In this repository, make a small bounded documentation correction: update one inaccurate sentence in the test README so it matches current CLI behavior. Verify the change. Do not make unrelated changes.

Observe whether the worker naturally follows gate remediation into legitimate durable identity rather than bypassing the gate or performing Beads archaeology.

Expected behavior:

```text
attempted edit
  -> blocked: no durable work identity
  -> establish lightweight tracked work
  -> same runtime session becomes authorized
  -> edit
  -> validate
  -> record meaningful progress/evidence when useful
  -> close through normal lifecycle
```

### Failure conditions

- attempts to bypass/disable the gate;
- manually mutates claim KV as a workaround;
- `xt work start` succeeds but the same Pi/Claude session remains blocked;
- creates duplicate execution identities;
- turns tiny edits into heavyweight planning rituals;
- lightweight work is accidentally treated as dispatchable contract-quality work;
- progress notes become tool-call spam;
- resume creates a new identity instead of continuing the old one;
- close bypasses memory/commit lifecycle;
- relationship edges accidentally block planned work.

### Independent audit

After the real session test, use a fresh agent to review:

- implementation;
- lifecycle doctrine;
- test transcript;
- resulting Bead/work state;
- repository diff and evidence;
- interaction with `/planning` and `/using-xtrm` continuity.

The auditor should explicitly look for confusing semantics, lifecycle bypasses, session-identity bugs, unnecessary ceremony, duplicate state, stale instructions, and migration risks.

Only a clean audit should trigger propagation into canonical surfaces.

## Propagation set if the concept passes

Potential teaching/documentation surfaces to reconcile only after validation:

```text
agent-contract.md
  -> agents-top.md / claude-top.md
  -> generated AGENTS.md / CLAUDE.md
  -> using-xtrm
  -> using-xtrm continuity
  -> planning
  -> README
  -> hooks / Pi runtime docs
  -> templates / downstream consumer surfaces
```

Avoid adding the same detailed procedure to all of them. Prefer a compact invariant plus discovery through the maintained CLI/runtime surface.

## Decision status

Parked.

The concept is promising because it keeps the strict "no claimed work, no mutation" invariant while making legitimate small-work tracking cheap and creating a migration seam toward the future substrate. It is **not approved for runtime rollout** until real local behavioral testing and independent audit demonstrate that the agent experience is better and the lifecycle gates remain correct.

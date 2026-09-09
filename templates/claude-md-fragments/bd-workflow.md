---
name: bd-workflow
version: 1.2.0
description: targeted Beads workflow + XTRM lifecycle gates
---
# XTRM Agent Workflow

> Full reference: `/using-xtrm` skill (or `XTRM-GUIDE.md` where present).
> `bd prime` is an opt-in full-context diagnostic only; it is not a required SessionStart step.

## Session start

Use targeted retrieval instead of a bulk context dump:

```bash
bd list --status=in_progress
bd ready
bd search "<task terms>"
bd show <id>
bd update <id> --claim
```

Use `bv --robot-triage --format toon` only when graph-aware prioritization is needed. Never run bare `bv` in an agent session.

## Active gates

| Gate | Trigger | Required action |
|---|---|---|
| Edit | repository mutation without claimed work | claim an existing Bead before editing |
| Commit | commit while claimed work is unresolved | close/acknowledge work first |
| Stop | session attempts to end with unresolved claimed work | reconcile/close according to current runtime gate |
| Dispatch | another worker will consume `contract:draft` work | `/planning` → promote to a contract-quality ready Bead first |

Hooks/extensions own deterministic enforcement. `/using-xtrm` owns judgment and routing.

## Durable work contract

For work another worker may consume, the Bead is the prompt. Baseline contract fields:

```text
PROBLEM
SUCCESS
SCOPE
NON_GOALS
CONSTRAINTS
VALIDATION
OUTPUT
```

Add `SCRUTINY` or other requirements when they materially affect correctness. Draft capture is allowed, but drafts are not dispatchable.

## Dependencies and relationships

```bash
bd dep add <issue> <depends-on>     # real blocking/sequencing dependency
bd dep relate <a> <b>               # non-blocking related-work edge
bd dep tree <id>
bd blocked
```

Do not use blocking edges merely to mean "related to".

## Current execution routing

- coherent local work → current session;
- bounded fresh-context question → native subagent when available;
- long-lived isolated peer → `xt pi|claude|codex` + `/multiplexing`;
- governed role-shaped work → `/using-specialists`;
- deterministic mechanics → script/tool/runtime primitive.

Prefer native/runtime messaging over tmux scraping. Exact CLI syntax belongs to current `--help`, not this fragment.

## Code intelligence and validation

Use `/gitnexus` when code-graph context materially reduces uncertainty. For debugging/review/testing/verification, route through `/engineering-quality`.

Before completion, verify the intended state, required validation, durable work state, and unresolved workers/replies/risks. Do not bypass a valid runtime gate merely to continue.

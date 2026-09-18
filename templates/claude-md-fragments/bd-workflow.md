---
name: bd-workflow
version: 2.0.0
description: targeted Substrate workflow + XTRM lifecycle gates (bd-workflow name retained for compatibility)
---
# XTRM Agent Workflow

> Full reference: `/using-xtrm` skill (or `XTRM-GUIDE.md` where present).
> Substrate owns durable work; `bd`/`bv` below describe the retired Beads board (migration/history only).

## Session start

Use targeted retrieval instead of a bulk context dump:

```bash
sb issue ready
sb issue show <ref>
sb issue list
sb issue claim <ref> --holder <who>
sb issue resume <ref>            # Resume Capsule: revision + checkpoint + Journal delta
sb journal show <ref> | sb journal latest <ref>
```

Resume from durable Substrate state, never from compacted chat memory.

## Active gates

| Gate | Trigger | Required action |
|---|---|---|
| Edit | repository mutation without claimed work | claim an existing Issue (`sb issue claim`) before editing |
| Commit | commit while claimed work is unresolved | close/acknowledge work first |
| Stop | session attempts to end with unresolved claimed work | reconcile/close according to current runtime gate |
| Dispatch | another worker will consume draft work | `/planning` → attest to a contract-quality ready Issue first |

Hooks/extensions own deterministic enforcement. `/using-xtrm` owns judgment and routing.

## Durable work contract

For work another worker may consume, the Issue (pinned revision) is the prompt. Baseline contract fields:

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
sb issue relate --from <a> --to <b> --kind blocks          # real blocking/sequencing dependency
sb issue relate --from <a> --to <b> --kind relates_to      # non-blocking related-work edge
sb issue tree [--root <ref>]
```

New work discovered mid-execution: independently durable (assign/block/resume/review/close)
-> child Issue (`sb issue create --parent <ref>`); otherwise a Journal entry on the owner.
Never mutate the contract for routine progress.

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

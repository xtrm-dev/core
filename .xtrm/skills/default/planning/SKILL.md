---
name: planning
description: >
  Turn intent, a bug, feature, audit, PRD, or existing backlog into durable XTRM work
  contracts. Use when work needs decomposition, an Issue must be made dispatchable, an
  existing board is stale/duplicated, tests or operational evidence need planning, or a
  captured draft is about to be handed to another worker. This skill owns contract
  authoring and board structure for every XTRM worker, not only Specialists.
---

# Planning

Planning produces executable contracts, not a large plan document.

The invariant comes from `/using-xtrm`: anything another worker may consume must be a
usable durable contract. This skill explains how to create and maintain those contracts.

## Pick the smallest planning mode

```text
idea for later only
  -> draft capture

one bounded task, scope understood
  -> write/promote one contract

feature/PRD/multi-step work
  -> ground current state, decompose by ownership/ship boundary, wire dependencies

messy existing board
  -> board triage

implementation needs proof strategy
  -> test/telemetry planning

high-cost or ambiguous design
  -> premortem before dispatch
```

Do not create an epic because planning feels incomplete without one. Use only the
structure the work actually needs.

## Ground before structuring

For non-draft work, verify the current repository/runtime state before creating a board.
Recent merged work may already satisfy or invalidate the request.

Use GitNexus, targeted reads, recent commits/PRs, current Substrate Issue state, and current CLI
help as appropriate. The goal is enough evidence to name real ownership and validation,
not an archaeology ritual.

## Contract authoring

Read `references/contracts.md` whenever creating or promoting work for another agent.
It defines draft vs ready state and the baseline seven-section contract.

A contract should tell the recipient what must be true, not micromanage an implementation
that has not been investigated yet. Prescribe a mechanism only when it is itself a
constraint.

## Decompose around ownership and integration

Prefer one work item per coherent change/ship boundary. Split when items can be owned,
validated, or delivered independently. Merge items that necessarily change and ship
together.

Before parallelizing, build a shallow overlap map:

```text
worker A -> files/services/state it may mutate
worker B -> files/services/state it may mutate
```

Shared mutable ownership means sequence, consolidate, or explicitly assign an integration
owner. Parallelism without ownership separation creates merge/reconciliation work rather
than saving time.

## Dependencies

Use blocking dependencies only for real sequencing. Use non-blocking relationship types
for context, validation, discovery, or related work when supported by the current Substrate
CLI (`sb issue relate --kind blocks|relates_to|discovered_from|supersedes|duplicates`).
Check live `sb ... --help` instead of preserving a frozen list of flags here.

## Test and operational evidence

Every non-trivial implementation contract must say how success will be observed.
Read `references/test-strategy.md` when the work crosses a boundary, changes agent/runtime
behavior, needs smoke/E2E evidence, or requires telemetry/log assertions.

Static checks alone do not prove integrated behavior.

## Existing board cleanup

Read `references/board-triage.md` when the backlog is duplicated, stale, weakly related,
or hard to sequence. Do not rewrite graph relationships from title similarity alone.

## Large spec / multi-repo work

Read `references/spec-to-board.md`. The board is the deliverable; any plan document is a
compact map for humans, not a second project-management database.

## Risk framing

Read `references/premortem.md` when a wrong plan is expensive, irreversible, security
sensitive, cross-repo, or based on uncertain assumptions.

## Handoff

A completed planning pass leaves:

- current durable Issue(s);
- clear ready vs draft state;
- dependencies/ownership that match reality;
- validation/evidence expectations;
- first actionable item or explicit blocker;
- no hidden requirements that exist only in this conversation.
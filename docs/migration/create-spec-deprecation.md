# `/create-spec` Deprecation Notice

> **Status (2026-06-04):** No `/create-spec` skill ships in xtrm-tools today.
> This document is a preemptive contract: any future `/create-spec` skill MUST
> conform to the rules below, or it will conflict with the `xt spec` lifecycle.

## Why

`xt spec` is the canonical PRD-level intake surface. It writes a `spec.yaml`
artifact, validates it, transforms it into a planner-bead XML
`<change-contract>`, and dispatches the planner specialist. The planner does
the actual decomposition into bd swarm / molecule / test issues via the
planning + test-planning skills.

A parallel `/create-spec` skill that also produces bd issues (or markdown
proposals) would create a second source of truth — operators would not know
which artifact governs the work. The lifecycle (`draft → validate → apply →
status → archive`) collapses if two surfaces can fork it.

## Rules

If a `/create-spec` skill is later added (e.g. as a Claude Code slash command
for ergonomic intake), it MUST:

1. **Produce a `spec.yaml`, not markdown.** Output goes through `xt spec
   draft` and stops at the yaml artifact.
2. **Never call `bd create`, `bd update`, or `bd dep`.** Decomposition is the
   planner's job, invoked via `xt spec apply` — not the slash command's.
3. **Display a deprecation banner** on every invocation that points to
   `xt spec draft` / `xt spec validate` / `xt spec apply` for the rest of the
   lifecycle.
4. **Log `{event: "create_spec_invoked", deprecated: true, redirect:
   "xt_spec_draft"}`** as a structured stderr event so observability can track
   usage and the eventual removal cost.

## Grace period

If `/create-spec` ships, it lives for **two releases** under the rules above.
After that, evaluate removal in a follow-up bead.

## Until then

Operators authoring specs today should use:

```bash
xt spec draft "<feature description>" [--template minimal|full] [--out path]
xt spec validate <path>
# (xt spec apply / status / archive land in MVP2 + MVP3)
```

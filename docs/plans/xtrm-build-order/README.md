# XTRM Build Order — plan source and PRD

This directory holds the programme plan for the XTRM agent tooling system, in two forms:

| File | Role |
| --- | --- |
| `index.html` | The page source. The only editable copy of the plan. |
| `PRD.md` | The plan as a PRD. Hand-written preamble, then a body generated from `index.html`. |
| `README.md` | This file. |

The rendered mirror is <https://aware-soul-37hw.here.now/>, published from `index.html` in this directory. The mirror carries no authority of its own.

Read `PRD.md` for the plan itself: what it is, whose plan it is, the ruling and version history, and the authority order between Substrate Issues, Jira XT tickets, this PRD and the mirror.

## Update flow

1. Edit `docs/plans/xtrm-build-order/index.html`.
2. Run `npm run plan:md` to regenerate the body of `PRD.md`. The preamble above the marker line is hand-written; the generator never rewrites it.
3. Run `npm run plan:md:check`. It fails when the body is stale, when a step from `index.html` is missing from `PRD.md`, or when step headings are out of page order.
4. Commit `index.html` and `PRD.md` in one PR; publish `index.html` to here.now afterwards.

The generator is `scripts/plan-to-md.mjs`: Node standard library only, no network, deterministic output.

## What the generated body carries

Every phase heading, every step (number, title, status chips, refs, "Brings", "Why here"), every ruling and state box with its date label, every measurement table, the figures, the legend and the page footer, in page order.

The per-step "Your notes" boxes are not in `index.html`: they are live Site Data on the here.now page. They are omitted from `PRD.md` by design; read them on the page.

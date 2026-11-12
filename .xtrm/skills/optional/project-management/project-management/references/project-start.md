# Starting a project

Moved from SKILL.md sections "Shape of a project" and "1. Start". Read when starting a project or creating its epics, themes, stories and sprints.

## Shape of a project

```
Substrate                              Jira (project $PM_JIRA_PROJECT)
  Project epic          ───── 1:1 ───  Epic (project)
                                         │ Relates (an Epic cannot have a parent)
  Theme epic (child)    ───── 1:1 ───  theme Epic (label $PM_JIRA_LABEL + substrate:<theme ref>, in a sprint)
                                           ├ theme Story (sprint deliverable)
    Worker task                            │ (leaf: Substrate only, never mirrored)
    Worker task                            └ window Tasks
  Operator step / window               Task (label window), parent = its theme Epic, in the sprint
```

- Theme epic and theme Epic are 1:1 and carry each other's key (label `substrate:<ref>`; an `sb issue note`). A theme is a result a person recognises,
  one sprint deliverable.
- Worker tasks stay in Substrate; the Story lists their refs. A Jira ticket per worker task was the failure this shape replaces.
- Window Tasks sit under their theme Epic; the project Epic only Relates to theme Epics. Keep a theme Epic under ~15-20 children; above ~20 use
  Stories as window parents.
- **Every Jira ticket is a self-contained brief** (operator, 2026-10-25): whole idea first, then pointers (`$PM_SB_PREFIX-n`, PR numbers); "see
  <ref>" alone is enriched from Substrate.
- Template `references/jira.md` "Ticket description"; duplicate check before filing (skill `board-audit`).
- **The Epic is an ADR-style brief** (context, decision, rejected alternatives, consequences), written in Jira; the Substrate epic contract carries
  the same content in the seven fields (`references/substrate.md`).
- **Owners.** Jira: summary, brief, sprint, assignee, priority, epic link, calendar. Substrate: contract, readiness, attestation, claim, journal,
  provenance, closure. Edit a field where it lives.

## 1. Start

1. `sb issue create --project <id> --title "..." --kind epic --scrutiny MEDIUM --contract '<json>'` with a full contract (JSON in
   `references/substrate.md`). SUCCESS is the finish line.
2. Themes and worker tasks in one step: `sb plan check`, then `sb plan apply` (piped, no file).
3. Attest every contract before dispatch: `sb issue attest <ref> --outcome ready --policy default --attested-by <who>`; an edit bumps the revision and
   needs a new attestation.
4. Create the Jira Epic, one Story per theme, assign sprints (`references/jira.md`). Append a `decision` entry: Jira keys, sprint plan, modes.

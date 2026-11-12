# Worked example: CORE-2377, one-command install and update

First project run with this model's lessons (journal CORE-2377 seq 4, 5, 7).

## What went wrong first

The coordinator opened Jira XT-114 with ten subtasks XT-115..124, one per Substrate issue CORE-2378..2387, plus `PLAN.md` and
`COORDINATOR-JOURNAL.md`. Jira copied Substrate and the plan lived in files Substrate replaces.

## The corrected shape

Substrate: project epic **CORE-2377** (plan, decisions, questions, evidence are its journal), worker issues beneath. Jira: parent **XT-114**, one
subtask per theme:

| Jira theme | Substrate refs it lists |
|---|---|
| XT-125 Pi runtime and packages | CORE-2378, 2379, 2385, 2386 |
| XT-126 Install and update flow | CORE-2380, 2383, 2384, 2370 |
| XT-127 Global state | CORE-2381 |
| XT-128 Releases and publishing (operator approval) | CORE-2382 |
| XT-129 Picker and xtmux | CORE-2387 |

Open questions were one `blocker` entry (seq 6); rulings were `decision` entries (seq 3, 5, 7).

## The same project in this skill's model

- The board's Jira project (`$PM_JIRA_PROJECT`): an Epic for the project, Stories for the five themes, each in a weekly sprint.
- Substrate: CORE-2377 stays the project epic; each theme becomes a child epic (`sb issue create --kind epic --parent CORE-2377`) and CORE-2378..
  move under it. The Story lists refs. Operator approvals (the publish in CORE-2382) are Tasks related to the Story.
- Findings: a child issue, `relate --kind discovered_from`, ref added to the Story. Workers: one pane each in the tiled `workers` window, named for
  their issue. Handoff: a `handoff` entry plus `sb issue resume CORE-2377`.

# Worked example: CORE-2377, one-command install and update

The first programme run with this model's lessons (journal CORE-2377 seq 4, 5, 7).

## What went wrong first

The coordinator opened Jira XT-114 with ten subtasks XT-115..124, one per Substrate issue
CORE-2378..2387, and a programme folder with `PLAN.md` and `COORDINATOR-JOURNAL.md`. Jira became a
copy of Substrate, and the plan lived in files that Substrate already replaces.

## The corrected shape

Substrate: programme epic **CORE-2377** (the plan, decisions, open questions and evidence are its
journal), with the worker issues beneath it. Jira: parent **XT-114**, one subtask per theme:

| Jira theme | Substrate refs it lists |
|---|---|
| XT-125 Pi runtime and packages | CORE-2378, 2379, 2385, 2386 |
| XT-126 Install and update flow | CORE-2380, 2383, 2384, 2370 |
| XT-127 Global state | CORE-2381 |
| XT-128 Releases and publishing (operator approval) | CORE-2382 |
| XT-129 Picker and xtmux | CORE-2387 |

Open questions were one `blocker` entry (seq 6). Rulings were `decision` entries (seq 3, 5, 7).

## The same programme in this skill's model

- Jira project ISSUE: Epic for the programme; Stories for the five themes, each in a weekly sprint.
- Substrate: CORE-2377 stays the programme epic. Each theme becomes a child epic
  (`sb issue create --kind epic --parent CORE-2377`), and CORE-2378.. move under their theme.
  The Story lists the refs, never one ticket per ref. Operator approvals (the publish in CORE-2382)
  are Tasks related to the Story, in the sprint.
- Findings during the run: a child issue, `relate --kind discovered_from`, and its ref added to the
  matching Story.
- Workers: one window each in the coordinator's tmux session, named for the issue they own.
- Handoff: a `handoff` entry on CORE-2377 plus `sb issue resume CORE-2377`.

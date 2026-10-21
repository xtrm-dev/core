# Jira: the operator's view

Site `https://mercuryintel.atlassian.net`. Tool: `scripts/jira.py` (REST, token read from
`~/.secrets/atlassian-api-token.txt` by default; override with `JIRA_TOKEN_FILE`, `JIRA_EMAIL`,
`JIRA_SITE`; never printed). acli cannot set an issue's parent or put it in a sprint, so use `jira.py`.

## Which project

Two software projects, configured alike (2026-10-16). Use the label `prog:<programme>` to separate
programmes inside one project.

| Project | Holds | Board | Sprints | Issue types |
|---|---|---|---|---|
| **ISSUE** (id 10000) | Mercury and market-data programmes | 1 | weekly, "MMD Sprint n" | Epic, Story, Task, Bug, Subtask |
| **XT** (id 10066) | xtrm tooling programmes (XT-131, XT-132, XT-91) | 34 | "XT: Sprint 1" (id 40) and on | Epic, Story, Task, Bug, Feature, Request, Spike, Sottotask |

The old business project XTRM moved to XT (same numbers: XTRM-132 is XT-132) and is to be
archived. Do not write to it. Check live before relying on this table:
`jira.py GET /rest/api/3/project/<KEY>` (issueTypes) and `jira.py GET /rest/agile/1.0/board/<id>/sprint`.

**GitHub for Jira** is installed for project ISSUE, so ISSUE issues show the development panel
(branches, commits, PRs that carry the key). XT is not checked yet: read the dev panel once before
relying on it. The panel is evidence only: Substrate still drives every status move, and smart
commits and Jira Automation stay off.

Binding rule: every PR body ends with a `Jira binding: ISSUE-NNN, ...` footer line naming its
governing tickets (titles keep the Substrate id; worker branch names already carry the Jira key
via `<story-key>-<slug>`). The integration matches on the key, so the footer backfills each
ticket's dev panel without mirroring execution state into Jira. Merged PRs gain the footer
retroactively by body edit (no code change, no re-review). Check it the same way: empty dev
panel on a ticket with merged PRs means no branch, commit or PR body carries the key yet.

Custom fields on both projects (global ids, added to every type except subtasks):

| Field | Id | Use |
|---|---|---|
| Window start (UTC) | `customfield_10237` | datetime; production and operator windows |
| Window end (UTC) | `customfield_10238` | datetime |
| Entity | `customfield_10239` | single select: Coordinator, Worker, Keeper, Human (who acts) |
| Start date | `customfield_10015` | date; drives the calendar view |
| Sprint | `customfield_10020` | read only through the agile API |

## The model

| Jira | Is | Rule |
|---|---|---|
| **Epic** | the programme | one per programme; 1:1 with the Substrate programme epic |
| **Story** | a theme: a result a person recognises | 1:1 with a Substrate theme epic; `parent` = the Epic; assigned to a sprint |
| **Task** | an operator action or production window: approval, release | related to its Story (Relates link), in the sprint; never a worker task |
| **Bug** | a defect worth an operator's attention | Substrate `bug` kind |
| (none) | worker tasks (task, followup, decision leaves) | live in Substrate only; listed in the Story description |

A research theme is a Spike on XT, or a Story with label `kind:spike` on ISSUE (no Spike type there).
Every non-Epic issue has a parent: the board check is "no non-epic issue without a parent".

Why: Jira is read by people who ask "what is done, what is next, what do you need from me".
Ten engineering tasks are noise to them. One Story per theme, in a sprint, answers the question.

Existing examples: Epic ISSUE-184 (Feedor) with Stories ISSUE-252..257, Epic ISSUE-198 (MMD),
Epic ISSUE-228 (Economic Data) with Stories ISSUE-230..234 in "MMD Sprint 2".

## Story description (plain language)

```
<one sentence: what changes for users / the operator, and when>

Substrate theme: CORE-2400 (sb issue show CORE-2400)
Work: CORE-2401, CORE-2402, CORE-2403
Needs from the operator: <approval / decision, or "none">
Evidence: <PR numbers, results; updated as the theme progresses>
```

Label namespaces: `area:`, `repo:`, `prog:`, `kind:`, and `substrate:<REF>` as the sync marker. Add
`substrate:<theme-ref>` and `prog:<programme>` so a script can find it (search by label before creating:
this prevents duplicate tickets). Put the Jira key back on Substrate once:
`sb issue note <theme> "Jira: ISSUE-260" --kind note`.

## Sprints

- Weekly. A sprint has a name, dates and a goal (existing: "MMD Sprint 2 - build in shadow",
  2026-10-15..10-21).
- A Story sits in the sprint where it will finish and moves with its slot. At sprint close, open
  Stories carry to the next sprint, and the coordinator journals a `milestone` on the epic.
- The coordinator's `/goal` horizon is the current sprint.
- Create: `POST /rest/agile/1.0/sprint` `{"name":..., "originBoardId":<1 or 34>, "startDate":..., "endDate":..., "goal":...}`.
  Move issues: `POST /rest/agile/1.0/sprint/<id>/issue` `{"issues": ["ISSUE-260"]}`.
  Read an issue's sprint: field `customfield_10020`.

## Read the board first

Statuses, transition names and enabled features differ between boards and change over time. Never
rely on a status list written in a skill. Before the first Jira write of a programme, build a profile
of the board with `jira.py` and act on what it returns:

| Question | Read |
|---|---|
| Which issue types exist? Is there a Subtask type? | `GET /rest/api/3/project/<KEY>` (`issueTypes`) |
| Which statuses, and in which category? | `GET /rest/api/3/project/<KEY>/statuses`; match the category by `statusCategory.key` (`new`, `indeterminate`, `done`): names are localised (Da completare, In corso, Completato) |
| Which move is allowed from this status, and where does it lead? | `GET /rest/api/3/issue/<K>/transitions` (read the target `to.name`, not the transition name) |
| Which columns does the board show? | `GET /rest/agile/1.0/board/<id>/configuration` |
| Are sprints on? Which exist, with dates and goals? | `GET /rest/agile/1.0/board/<id>/sprint`; the sprint field is `customfield_10020` on ISSUE (look it up with `/rest/api/3/field`) |
| Which custom fields exist (sprint, Substrate ref, readiness)? | `GET /rest/api/3/field` |
| Which labels and namespaces are in use? | `GET /rest/api/3/label`, or a JQL count per `prog:` label |
| Does the dev panel show this issue's work (GitHub for Jira, ISSUE only)? | `GET /rest/dev-status/latest/issue/summary?issueId=<id>` (an internal Jira endpoint, not in the public API; it worked on ISSUE on 2026-10-15). Zero PRs means no branch, commit or PR carries the key yet |
| How is the programme already laid out? | JQL: `parent = <Epic> ORDER BY key`, and the Epic's Stories with their sprints |

Print only what you need; responses over 6,000 characters are cut, so import `jira.py` and filter
(see the recipes below). Then record the result once, as a `finding` on the programme epic: types
used, the status chosen for each Substrate event, sprint ids, whether the dev panel shows data.

**Pick statuses by meaning.** Substrate is the only status driver (no Jira Automation, no smart
commits). Until `sb jira` exists, the coordinator moves each item by hand on the day of the event.
For each event, choose the board's status that means this, using its category to break ties:

| Substrate event | The board status should mean | Category |
|---|---|---|
| Contract attested, no blockers | ready to start | To Do |
| Claim acquired | being worked | In Progress |
| PR bound and open | in review | In Progress |
| PR merged, deploy pending | merged, waiting for production | In Progress |
| Closure `completed` | done | Done |
| Closure `completed` with a follow-up | done with follow-up (link the follow-up) | Done |
| Deferred | parked | To Do, not Done |
| Blocking edge open | blocked | In Progress |
| Closure `cancelled` or `wont_fix` | will not do | Done, with a resolution |

If the board has no status for an event, use the nearest one and add a comment saying what it
stands for; ask the operator before adding a status or changing a category.

**Transition ids (read 2026-10-17).** Both projects have the same ten statuses, and every
transition is global (allowed from any status). Move with the id, never the name: the same id
leads to different statuses in the two projects.

| Event (status meaning) | Status shown (Italian UI) | XT id | ISSUE id |
|---|---|---|---|
| To Do | Da completare | 21 | 11 |
| ready | Pronto | 51 | 44 |
| being worked | In corso | 61 | 21 |
| in review | In revisione | 71 | 31 |
| merged, waiting for production | Waiting Production | 81 | 43 |
| blocked | Blocked | 91 | 101 |
| parked | Deferred (To Do category) | 101 | 41 |
| done | Completata | 41 | 45 |
| done with follow-up | Done with Follow-up | 111 | 42 |
| will not do | Won't Do | 121 | 111 |

Before the first move of a programme, re-read the ids: `GET /rest/api/3/issue/<K>/transitions`
(the `to.name` field is the target). If they differ from this table, trust the live read and record
it in the board-profile finding. Move: `POST /rest/api/3/issue/<K>/transitions`
`{"transition": {"id": "<id>"}}`.

## Windows on the Jira calendar

Jira is the only calendar (operator decision, 2026-10-16). No Google Calendar events, no Google
Tasks. A production or operator window is:

- a **Task** with label `window`;
- **parent = the Story** of the theme it belongs to (create the Story first if none exists). Do not parent windows directly to the programme Epic except for true programme-level events;
- all four date fields set: `customfield_10237` and `customfield_10238` (exact UTC times),
  Start date `customfield_10015` and `duedate`. The calendar view reads only the two date
  fields, so a window without them is invisible there;
- Entity `customfield_10239` = who acts (Keeper or Coordinator; Human for an operator step);
- the window owner keeps it current: the keeper if the programme has one, otherwise the
  coordinator.
- the summary carries NO date or time — dates live in the four fields above, never in the
  title. Pattern: `MMD window: <what> (<scope>)`. Re-dating a window never rewrites the title
  except to remove a date that slipped in.
- every window change (re-date, scope change, close-out) gets a comment stating why it
  changed, old → new times in UTC, and whose ruling authorized it. A window whose times moved
  without such a comment is an unauthorised move.

### PR readiness rule (mandatory)

Every pull request that changes runtime behaviour, config, schema, serving paths, or that can be
included in a deploy/promotion **must** have one of the following before it is considered ready
for merge:

1. A window Task that covers its merge and subsequent deploy, or
2. An explicit exception: label `no-window` on the PR (or a comment “no production window needed”)
   for pure documentation, pure tests, or pure non-behavioural refactors.
3. The ticket key for Github/Jira tracking, to the one it is linked to.

A PR that has neither is untracked. It must not be included in a promotion window. Coordinators
and AgentRun workflows must flag open PRs that lack both a covering window and a `no-window`
exception.

Health checks, must return 0 (replace the project key):
`project = ISSUE AND labels = window AND (duedate is EMPTY OR cf[10237] is EMPTY)`;
`project = ISSUE AND labels = window AND summary ~ "10-*"` (no dates in titles);
`project = ISSUE AND labels = window AND parent is EMPTY` (windows must have a Story parent).
## What is manual today, what XTRM-639 automates

Manual now: creating Epic and Stories, copying keys and PR numbers, appending the PR-body
binding footer, status moves, sprint moves, the daily report comment. Planned in `sb jira` and the agent host: the binding between a Jira item and a
Substrate issue, status moves from Substrate events, closures and receipts as comments and remote
links, a polling inbox, a brief-edit drift proposal (a Jira edit never rewrites a contract),
sprint-aware `sb issue ready`. Do these by hand per this page; when `sb jira` lands, replace the step,
not the model.

## Recipes (jira.py)

```
jira.py GET  /rest/api/3/issue/K?fields=summary,status,parent,customfield_10020
jira.py POST /rest/api/3/issue body.json        # create (Epic, or Story with "parent":{"key":"ISSUE-n"})
jira.py PUT  /rest/api/3/issue/K body.json      # edit fields
jira.py POST /rest/api/3/issue/K/transitions body.json   # {"transition":{"id":"61"}}; ids above
jira.py comment K text.txt                      # plain text; ADF is built for you
```

Create body (descriptions are ADF; reuse `adf()` from `jira.py`, or build with Python):

```
{"fields": {"project": {"key": "ISSUE"}, "issuetype": {"name": "Story"},
  "parent": {"key": "ISSUE-184"}, "summary": "...", "labels": ["substrate:CORE-2400"],
  "description": <ADF doc>}}
```

- Bodies and comment text are temporary inputs: write them to the scratchpad, never to the repo.
- `jira.py` prints only the first 6,000 characters of a response. For large reads, import it:
  `import importlib.util as u; s=u.spec_from_file_location('j','jira.py'); m=u.module_from_spec(s);
  s.loader.exec_module(m); st,data=m.call('GET', path)` and filter in Python.
- Re-read the issue after each write.
- A create script must have no import-time side effects. A re-import once created eight
  duplicate tickets.

When appropriate and/or requested, the Jira API can be used for more mutations.

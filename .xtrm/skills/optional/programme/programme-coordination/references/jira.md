# Jira: the operator's view

Site `https://mercuryintel.atlassian.net`. Tool: `scripts/jira.py` (REST, token read from
`~/.secrets/atlassian-api-token.txt` by default; override with `JIRA_TOKEN_FILE`, `JIRA_EMAIL`,
`JIRA_SITE`; never printed). acli cannot set an issue's parent or put it in a sprint, so use `jira.py`.

## Which project

Use project **ISSUE** (board 1, SCRUM). It has Epic, Story, Task, Subtask, weekly sprints and a
board. Project **XTRM** is a business project with only Task and Sottotask, two statuses
(Da completare, Completata) and no sprints: it cannot show themes or sprints. The operator's
direction (Jira XTRM-110, Substrate XTRM-639) is ISSUE as the planning board, with the label
`prog:<programme>` to separate programmes. Still open there: move XTRM work into ISSUE or make XTRM a
software project, and whether GitHub for Jira is installed. Check live before relying on this: `jira.py GET /rest/api/3/project/ISSUE` (issueTypes) and
`jira.py GET /rest/agile/1.0/board/1/sprint`.

## The model

| Jira | Is | Rule |
|---|---|---|
| **Epic** | the programme | one per programme; 1:1 with the Substrate programme epic |
| **Story** | a theme: a result a person recognises | 1:1 with a Substrate theme epic; `parent` = the Epic; assigned to a sprint |
| **Task** | an operator action or production window: approval, release | related to its Story (Relates link), in the sprint; never a worker task |
| **Bug** | a defect worth an operator's attention | Substrate `bug` kind |
| (none) | worker tasks (task, followup, decision leaves) | live in Substrate only; listed in the Story description |

A research theme is a Story with label `kind:spike` (ISSUE has no Spike type). Every non-Epic issue has
a parent: the board check is "no non-epic issue without a parent".

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
- Create: `POST /rest/agile/1.0/sprint` `{"name":..., "originBoardId":1, "startDate":..., "endDate":..., "goal":...}`.
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
| Is the dev panel connected (GitHub for Jira)? | `GET /rest/dev-status/latest/issue/summary?issueId=<id>` (an internal Jira endpoint, not in the public API; it worked on ISSUE on 2026-10-15). Zero PRs and no tools means not connected |
| How is the programme already laid out? | JQL: `parent = <Epic> ORDER BY key`, and the Epic's Stories with their sprints |

Print only what you need; responses over 6,000 characters are cut, so import `jira.py` and filter
(see the recipes below). Then record the result once, as a `finding` on the programme epic: types
used, the status chosen for each Substrate event, sprint ids, whether the dev panel is on.

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
stands for; ask the operator before adding a status or changing a category. Jira XTRM-110 proposes
names for ISSUE (Pronto, In corso, In Review, waiting-production, Completata, complete-with-followup,
Deferred, Blocked, Won't Do), but the board may not have them yet: the profile decides.

## What is manual today, what XTRM-639 automates

Manual now: creating Epic and Stories, copying keys and PR numbers, status moves, sprint moves, the
daily report comment. Planned in `sb jira` and the agent host: the binding between a Jira item and a
Substrate issue, status moves from Substrate events, closures and receipts as comments and remote
links, a polling inbox, a brief-edit drift proposal (a Jira edit never rewrites a contract),
sprint-aware `sb issue ready`. Do these by hand per this page; when `sb jira` lands, replace the step,
not the model.

## Recipes (jira.py)

```
jira.py GET  /rest/api/3/issue/K?fields=summary,status,parent,customfield_10020
jira.py POST /rest/api/3/issue body.json        # create (Epic, or Story with "parent":{"key":"ISSUE-n"})
jira.py PUT  /rest/api/3/issue/K body.json      # edit fields
jira.py transition K "In corso"
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

# Jira: the operator's view

Site `$JIRA_SITE`. Tool `scripts/jira.py` (REST; the operator token is read from the file `$JIRA_TOKEN_FILE`, account `$PM_OPERATOR_EMAIL`;
`JIRA_EMAIL` overrides the account; never printed). Every board-specific value below (project key, board id, status names, transition ids,
custom field ids) is a setting in the pack config: `references/setup.md`. acli cannot set a parent or a sprint: use `jira.py`.

Identity: agent processes (`SUBSTRATE_HOLDER` set, or a claude/pi/codex ancestor) act as the `xtrm-bot` account
(`~/.xtrm/identities/atlassian-agent/identity.json`; `acli` through a shim in `~/.local/bin`; `xt jira setup`, `xt jira doctor`).
`XTRM_JIRA_AS=operator` forces the operator; explicit `JIRA_EMAIL` or `JIRA_TOKEN_FILE` wins. An agent never falls back to the operator once the
identity exists.

## Which project

Agent comments start `[agent:<holder> | run:<id>]` (`[agent:<runtime>-<worktree dir> | run:<id> | fallback]` without `SUBSTRATE_HOLDER`); agent
creates, edits and transitions add label `actor=agent`. Labels: `area:`, `repo:`, `prog:`, `kind:`, `substrate:<REF>`. `jira.py comment` prints
`POSTED_TEXT <json string>` (the exact text posted); as a module `post_comment(key, text)` returns `(status, response, posted_text)`. Write variables: Phase 2 section below.

The project's board is Jira project `$PM_JIRA_PROJECT`, board id `$PM_JIRA_BOARD_ID`. When one Jira project holds several projects, separate
them with label `prog:<project>`; a second Jira project (for example one for tooling) is configured alike and read the same way.

EXAMPLE (neutral names; read your own with "Read the board first"):

| Project | Holds | Board | Sprints | Issue types |
|---|---|---|---|---|
| **PROJ** (id 10000) | the product projects | 1 | weekly, "PROJ Sprint n" | Epic, Story, Task, Bug, Subtask |
| **TOOLS** (id 10066) | tooling | 34 | "TOOLS: Sprint 1" on | Epic, Story, Task, Bug, Feature, Request, Spike, Subtask |

Binding rule: every PR body ends with `Jira binding: <PROJECT>-NNN, ...` naming its governing tickets (branches carry the key via `<story-key>-<slug>`).
The footer backfills the dev panel without mirroring execution state; merged PRs get it by body edit. An empty panel on a ticket with merged PRs means
no branch, commit or PR body carries the key. On a board not checked yet, read the dev panel once before relying on it.

Custom fields: the ids are per tenant, so they live in the config object `custom_fields` (role -> `customfield_<n>`); `GET /rest/api/3/field` finds
them. Below, `<window_start>` means the id stored under that role.

| Field | Config role (`custom_fields.<role>`) | Use |
|---|---|---|
| Window start (UTC) | `window_start` | datetime; production and operator windows |
| Window end (UTC) | `window_end` | datetime |
| Entity | `entity` | single select: Coordinator, Worker, Keeper, Human (who acts); option ids in `entity_options` |
| Start date | `start_date` | date; drives the calendar view |
| Sprint | `sprint` | read only through the agile API |

## The model

An archived project is never written to. Shape example: an Epic `PROJ-184` with Stories `PROJ-252..257` in "PROJ Sprint 2".

- **Task** = an operator action or production window, related to its Story (Relates), in the sprint, never a worker task. **Bug** = a defect worth the
  operator's attention.
- Worker tasks (task, followup, decision leaves) live in Substrate only, listed in the Story description.
- A research theme is a Spike where the board has that type, else a Story with label `kind:spike`. Every non-Epic issue has a parent (board check:
  no non-epic issue without a parent).

### Team-managed project: hierarchy

Story, Task, Bug and Feature are all level 0, so a Task cannot have a Story as parent. Instead:
- One theme **Epic** per theme (takes a sprint, no parent). Windows are parented to it; the old theme Story becomes its child; theme Epics are
  `Relates`-linked to the project Epic.
- A Story cannot become an Epic in place (the allowed types exclude Epic): create new Epics and reparent. Structural changes (new Epics, reparenting)
  pilot on one theme first: create, move, re-read the calendar fields (byte-identical), read children by search `parent=<key>`; then theme by theme,
  stop at the first failure, roll back only that row (parent back to the project Epic; new Epics closed Won't Do).

## Ticket description (every Jira ticket, plain language)

```
Context: <the problem: what is wrong or missing, how it was found, why it matters for data correctness>
Outcome: <success: what is true when the work is done>
Scope: <what this ticket changes>
Not in scope: <what it leaves alone>
Constraints and decisions: <limits, what was decided and why; each rejected alternative with one line why not>
How we check it: <the live checks and their pass/stop criteria>
Deliverable and window: <output; for a window: when (UTC), make target, DRY first, rollback>
Substrate ref: <theme or issue ref> (sb issue show <ref>); work refs; related tickets (duplicates, depends-on)
```

SKILL.md rule 46 (operator, 2026-11-06): these are the /planning sections in plain words. The ticket is a brief for a human, not a copy of the
Substrate journal: evidence and progress stay in the journal and in comments. One ticket per operator-visible deliverable or window, never one per
worker task. A follow-up named to the operator exists first as a Jira row with window fields (or explicitly "dates only") and a Substrate issue.

Every PR reference in Jira text is a full clickable URL, for example `https://github.com/$PM_REPO_SLUG/pull/1120`, never
`$PM_REPO_NAME#1120` or a bracketed number (operator, 2026-10-29). A PR-link comment starts 'PR-link https://github.com/<org>/<repo>/pull/<n>';
matchers accept the old `$PM_REPO_NAME#<n>` form until old comments are rewritten.

## Sprints

- Weekly, with name, dates, goal ("PROJ Sprint 2 - build in shadow", 2026-10-15..10-21). A Story sits in the sprint where it will finish; at close,
  open Stories carry over and the coordinator journals a `milestone`. The `/goal` horizon is the current sprint.
- Create: `POST /rest/agile/1.0/sprint` `{"name":..., "originBoardId":<$PM_JIRA_BOARD_ID>, "startDate":..., "endDate":..., "goal":...}`. Move:
  `POST /rest/agile/1.0/sprint/<id>/issue` `{"issues": ["<KEY>"]}`. Read an issue's sprint: field `custom_fields.sprint`.

## Read the board first

Statuses and transitions differ per board and change: never rely on a status list in a skill. Before the first Jira write of a project build a
profile with `jira.py GET`:
- issue types `/rest/api/3/project/<KEY>`; statuses `/rest/api/3/project/<KEY>/statuses`, matched by `statusCategory.key` (`new`, `indeterminate`,
  `done`) because names are localised (an Italian UI shows Da completare, In corso, Completato). Store the names in the config: `done_statuses`,
  `active_statuses`, `terminal_statuses`.
- allowed moves `/rest/api/3/issue/<K>/transitions` (read the target `to.name`); columns `/rest/agile/1.0/board/<id>/configuration`; sprints
  `/rest/agile/1.0/board/<id>/sprint`; fields `/rest/api/3/field`; labels `/rest/api/3/label`.
- dev panel (where the board has one) `/rest/dev-status/latest/issue/summary?issueId=<id>` (internal, worked 2026-10-15); layout JQL
  `parent = <Epic> ORDER BY key`.

**Pick statuses by meaning** (the event-to-status table). Substrate is the only status driver; until `sb jira` exists the coordinator orders each move
on the day of the event and the board helper writes it, choosing the board status that means this (category breaks ties):

| Substrate event | The board status should mean | Category |
|---|---|---|
| Contract attested, no blockers | ready to start | To Do |
| Claim acquired | being worked | In Progress |
| PR bound and open | in review | In Progress |
| PR merged, deploy pending | merged, waiting for production | In Progress |
| Closure `completed` | done | Done |
| Closure `completed` with a follow-up | done with follow-up (link it) | Done |
| Deferred | parked | To Do, not Done |
| Blocking edge open | blocked | In Progress |
| Closure `cancelled` or `wont_fix` | will not do | Done, with a resolution |

No status for an event: use the nearest and comment what it stands for; ask the operator before adding a status or changing a category.

**Transition ids.** Move with the id, never the name: the same id leads to different statuses per project (one id meant Blocked on one board and
Deferred on another). The board's ids live in the config object `transitions` (status name as the board shows it -> id), written once from the
live read and journaled as a `finding`.

EXAMPLE of the shape (neutral English names; the ids are illustrative, never copy them):

| Event (status meaning) | Status shown | Example id |
|---|---|---|
| To Do | To Do | 11 |
| ready | Ready | 44 |
| being worked | In Progress | 21 |
| in review | In Review | 31 |
| merged, waiting for production | Waiting Production | 43 |
| blocked | Blocked | 101 |
| parked | Deferred (To Do category) | 41 |
| done | Done | 45 |
| done with follow-up | Done with Follow-up | 42 |
| will not do | Won't Do | 111 |

Re-read the ids before the first move of a project (`GET /rest/api/3/issue/<K>/transitions`, `to.name`); if they differ trust the live read and
record it. Move: `jira.py transition-by-id <KEY> <id>` or `jira.py transition <KEY> "<status name>"`, the id checked live (Phase 2 section below).

## Windows on the Jira calendar

Jira is the only calendar (operator, 2026-10-16): no Google Calendar events, no Google Tasks. A production or operator window is:
- a **Task** with label `window`, **parent = its theme Epic** (the theme **Story** on a board where a Task can take a Story parent; create the
  parent first); not the project Epic,
  except project-level events;
- all four dates set: `<window_start>` and `<window_end>` (the exact slot, written with that date's offset in `$PM_TIMEZONE`, by zoneinfo,
  reported in UTC), Start date `<start_date>` and `duedate`. The calendar reads only
  Start date and `duedate`: without them the window is invisible;
- Entity `<entity>` = who acts (Keeper or Coordinator, Coordinator = the option id in `entity_options.Coordinator` only; Human for an operator step); kept current by the
  keeper if the project has one, else the coordinator, written by the board helper;
- a summary with NO date or time: `$PM_SB_PREFIX window: <what> (<scope>)`; re-dating never rewrites the title except to remove a date that slipped in. Add the
  prefix to an existing title only when the window is touched for another reason (no bulk renames).
- a comment on every change (re-date, scope, close-out) with why, old -> new UTC times and whose ruling authorized it; times moved without it are an
  unauthorised move.

### Window discipline (added 2026-10-22)

- One plan per day in one place; mark off-plan windows on the row (two live plans read as misses).
- Print the same-day overlap check in the comment before any re-date (silent double-bookings survive otherwise).
- Clear the slot fields in the same edit that blocks a window and record the old slot in the comment (a blocked window must not advertise a slot).
- Close a window on a coordinator Verified OK comment, never on a deploy having started (a tool verdict is a claim).
- Call a passed slot with no record unrecorded, not failed, and re-check late (early flags misfire).
- Compute the UTC offset per date with zoneinfo in `$PM_TIMEZONE` (in a central European zone 2026-10-25 flips +0200 to +0100): a wrong offset moves the window an hour.
- Clear a slot field with PUT null and re-read: the API returns 204 either way.

### PR readiness rule (mandatory)

A PR that itself deploys (a make target, a restart, a schema change) **must** have a window Task covering its merge and deploy before merge-ready. A
master-only PR needs no window of its own (SKILL.md rule 49): it rides the promotion that carries it and says so in its body. Pure docs, pure tests and
non-behavioural refactors carry label `no-window` (or a comment "no production window needed"). A PR with none is untracked and stays out of every
promotion. Board checks flag open PRs lacking a covering window or a master-only note.

Health checks, must return 0 (`<n>` is the number of `custom_fields.window_start`):
`project = $PM_JIRA_PROJECT AND labels = window AND (duedate is EMPTY OR cf[<n>] is EMPTY)`;
`project = $PM_JIRA_PROJECT AND labels = window AND summary ~ "10-*"` (no dates in titles);
`project = $PM_JIRA_PROJECT AND labels = window AND parent is EMPTY` (windows need a theme Epic parent).

## What is manual today, what XTRM-639 automates

Manual now: Epics and Stories, keys and PR numbers, the PR-body binding footer, status moves, sprint moves, the daily report comment. `sb jira` will
take the binding between a Jira item and a Substrate issue, status moves from Substrate events, closures and receipts as comments and remote links, a
polling inbox and a brief-edit drift proposal (a Jira edit never rewrites a contract), sprint-aware `sb issue ready`. When it lands, replace the step,
not the model.

## Recipes (jira.py)

`jira.py GET|POST|PUT <path> [body.json]`; `comment <KEY> <text-file>` (plain text; ADF is built for you); `transition`, `transition-by-id`, `link`.

- Create: `jira.py POST /rest/api/3/issue body.json` with
`{"fields": {"project": {"key": "<PM_JIRA_PROJECT>"}, "issuetype": {"name": "Story"}, "parent": {"key": "<EPIC-KEY>"}, "summary": "...", "labels": ["substrate:<REF>"], "description": <ADF doc>}}`;
  edit with `PUT /rest/api/3/issue/K`; move with `jira.py transition` or `transition-by-id`; link with `jira.py link <BLOCKER> <BLOCKED> [type]`.
- Descriptions are ADF (reuse `adf()` from `jira.py`). Bodies and comment text go in the scratchpad, never the repo.
- `jira.py` truncates CLI output at 6000 chars: import it as a module for searches
  (`import importlib.util as u; s=u.spec_from_file_location('j','jira.py'); m=u.module_from_spec(s); s.loader.exec_module(m); st,data=m.call('GET', path)`)
  and filter in Python. Search with `/rest/api/3/search/jql` (v2 search returns 410).
- Read the row fresh before writing, re-read after, post corrections as new comments. Unpack helper returns as `status, body`; inspect live state
  before retrying after a crash.
- Batch scripts are files with absolute UTC targets and a single sleeper (Pi BashBackground-only ceiling 7,200,000 ms); read newest-first lists by id.
- Jira allows one reply level: a reply to a reply falls back to the thread root. A text-only comment flattener drops ADF inline cards: read the ADF
  before routing an operator comment (11-04).
- A create script has no import-time side effects: a re-import once created eight duplicate tickets. More mutations through the API only when
  appropriate and/or requested.

## Batch change log (method ruling MMD-2930, 2026-10-26)

Every board reorganisation or mutation batch is recorded durably, not only in lane state files (`$PM_LANE_DIR`).
- **Record:** one Substrate batch issue per reorganisation; its `result` entry lists every change: key, field, before, after, reason.
- **Jira:** each touched ticket gets label `jira-batch:<sb-ref>`; one JQL (`labels = "jira-batch:<sb-ref>"`) lists the batch; Jira's history holds the
  field diffs.
- **Status board "Modifiche Jira":** a derived view only; the keeper writes one doc per batch in `jirabatches`: `{ref, at, by, count, jql, plain_it}`.
  The board helper applies the label in the same write, on the coordinator's word.

## Write guards and checked verbs (MMD-3546 Phase 2)

Every guard runs on a `POST` or a `PUT`; reads are unchanged. A refusal prints its catalogue line, `REFUSED [<event>]` plus what to do, so a
failure teaches the rule instead of showing a bare HTTP code. Each event has a positive and a negative control against a mock Jira on 127.0.0.1
(`JIRA_SITE`), so no control reaches the live board.

| Verb | Use |
|---|---|
| `jira.py transition <KEY> "<status name>"` | move to a status name, resolved against the moves this row offers now |
| `jira.py transition-by-id <KEY> <id>` | move to an id read from this ticket in this run |
| `jira.py link <BLOCKER> <BLOCKED> [type]` | create a link, the direction named once (default type Blocks) |

- **TX-01** a status name this row does not offer is refused, and the live moves are printed.
- **TX-02** an id this row does not offer now is refused, because one id means different statuses per project (one id meant Blocked on one
  board and Deferred on another). `transition-by-id` reads `GET /rest/api/3/issue/<K>/transitions` in the same process, prints `move '<status>' (id <id>) read
  live from <KEY> in this run`, and only then moves.
- **LK-01** a Blocks link is read inward-to-outward, so `link` sends `inwardIssue` = the blocker and `outwardIssue` = the blocked ticket. A raw
  body must declare `_blocks: {"blocker": "<KEY>", "blocked": "<KEY>"}`; the declaration is checked against both ends, then stripped.
- **LK-02/LK-03** the created link is re-read at `GET /rest/api/3/issueLink/<id>`, and its direction is printed before the link is reported.

Both move verbs run one checked path: the label `actor=agent` first (TX-06 prints, and the move continues, when the label fails), the move with no
comment in the body (TX-04 refuses one, because Jira answers 204 and drops it), then a re-read of the status and the label (TX-05 reports the status
it read, never the one you asked for). Jira can apply a transition a moment after it answers 204, so the re-read repeats up to 5 times over
about 2 s before the move is called unverified; a move that the re-read still does not show is reported `UNVERIFIED` and **exits 3**, a signal
distinct from a failed or refused move (exit 1): the transition may still apply, so a caller must not retry it. A refused or failed write exits 1;
a read keeps the caller's exit status. Module use runs the same guards through `call()`, and `transition`/`transition-by-id` return the same status
and text as the CLI prints (409 for an unverified move). `--dry-run` on `post-guard.py` runs the same SC-03 credential check as the write, so a
preview never prints a credential-shaped value.

A hand-built body is still accepted and still checked: `POST /rest/api/3/issue/<K>/transitions` needs an id this process read live from that
ticket, and a comment inside it is refused. The other Phase 2 guards: SC-03 a body that looks like a credential is refused, and only the pattern
name and the length are printed; DP-02 a create whose exact summary or `substrate:` label already exists is refused with the existing key.

### Write variables

| Variable | Effect |
|---|---|
| `JIRA_DEPLOY_EVIDENCE` | the production evidence for a move to a production status (config `production_statuses`; TX-07) |
| `JIRA_FORCE_WRITE=1` | skips the other-writer check once, for a change you have READ (OW-02) |

- **TX-07 (a warning, not a refusal)** a move to a production status (`production_statuses`, else `done_statuses` plus Waiting Production) with no proof of what runs in production prints the warning and
  continues. The proof is the running image SHA and the merge commit, both read and both pasted into the move comment: being merged on master, or
  promoted to stable, says nothing about the image that serves traffic. Pass the text as `JIRA_DEPLOY_EVIDENCE`, or as the `evidence` argument of
  `transition`/`transition_by_id` (the argument wins). Text with no 7-40 hex SHA does not satisfy the check.
- **OW-02** `JIRA_FORCE_WRITE=1` bypasses the other-writer check once. Use it only after the body you write quotes the foreign comment with its id
  and UTC time, and only for a change you have read. The bypass prints the OW-02 text, so it leaves a record.
- Without either variable: another writer's change inside 60 minutes refuses a field edit or an assignee change (OW-01) and a move (OW-03), and
  a row this process already wrote is not another writer's. `post-guard.py` applies the same 60-minute rule to a comment.

Comments still go through `post-guard.py`; `jira.py` refuses a direct `POST .../comment` unless `POST_GUARD_ACTIVE=1`, which only that tool sets.

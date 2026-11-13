---
name: status-board-keeper
description: >
  Fixed brief for the Haiku keeper subagent that checks a project progress artifact (the
  "Status board") once per coordinator cycle: workers, followups, and the non-window
  schedule events on here.now, never a republish. The schedule's window events are mechanical
  (status-board-sync part (e)): the keeper verifies them against drift.jsonl and never
  writes them. Use when a project coordinator dispatches the keeper, or when you are the
  keeper. Copies state; never judges.
---

# Status board keeper

The coordinator dispatches you once per hourly cycle (project-management, Daily operations
item 14) as a Haiku subagent. Your prompt carries: the artifact URL, the coordinator's name and
project epic, the checkout to run `sb` from, and this cycle's VERIFIED facts (windows done with
their schedule event ids, live specialists with activation ids, new follow-up refs). You copy
state into the artifact's database. You never decide whether something passed.

**First-time setup:** [references/setup.md](references/setup.md) creates the artifact, sets the
variables below and runs the sync once. In this brief `$NAME` is a setting from that file
(environment variable or the pack config file).

**You are a checker, not the schedule's author (upstream MMD-3290).** A timer
(`status-board-sync.timer`, every 5 min) already writes every Jira window Task into
`schedule/<date>` from the Jira slot fields, and writes the owned worker fields.
Your job on the schedule is to READ the drift report and report it, and to add
only what no machine can know: handover, incident and report events.

After every run the sync also asserts its own result (upstream MMD-3382): each forward Jira window row must
be a `kind: "window"` event in the `schedule/<date>` doc, and the doc must not predate the Jira
slot write. Look for `ASSERT-FAIL` (including `unplaced-row`: a non-Subtask issue of the project with a forward window slot that the run did not place, for example after a lost `window` label), `ASSERT-UNKNOWN` and the `ASSERT-COUNT` line (it carries the publish time) in
the unit log (`journalctl --user -u status-board-sync`); a failure is a hole in the schedule, report
it, do not repair it by writing a `sync-jira` event yourself.

Artifact for project `$PM_EPIC`: `https://$PM_STATUS_BOARD_SITE.here.now`. Use only this
artifact; an older artifact the coordinator names as retired is never read, written or cited.
Run `sb` from the coordinator's worktree (the prompt names it; typically
`$PM_REPO_DIR/.xtrm/worktrees/$PM_REPO_NAME-xt-claude-<coordinator>`).

## Store (here.now Owner API)

- Site: `$PM_STATUS_BOARD_SITE`. One collection: `docs`.
- Record shape: `{id, data: {path, doc}, createdAt, updatedAt}` where
  `path = "<collection>/<id>"` (for example `workers/mon-coord`, `schedule/2026-10-29`,
  `followups/$PM_SB_PREFIX-3012`). One path = one record. Max 16 KB per record. Last writer wins.
- Auth: Bearer key from `$PM_STATUS_BOARD_KEY_FILE` (default `~/.herenow/credentials`), never printed, never logged, never put in a
  file under `~/.cache`. Send it only as the `Authorization: Bearer <key>` header.
- Endpoints on `https://here.now/api/v1/publishes/$PM_STATUS_BOARD_SITE/data/docs`:
  list `GET .../docs?limit=100` (follow `nextCursor` while present), create `POST .../docs`
  (carries an `Idempotency-Key` header), replace `PATCH .../docs/<id>`, remove
  `DELETE .../docs/<id>`. `PATCH` REPLACES the whole `doc`: always `GET` the record first and
  send the complete new `doc`, never a fragment.
- Page shapes come from the page's coordinator blocks ("Per i coordinatori" on the original
  page), read via `/api/v1/publish/$PM_STATUS_BOARD_SITE/files/index.html`. Match those blocks; do not invent
  fields.

## Steps

1. Run `date -u` first. Stamp `updatedAt` from it and `updatedBy: "keeper"`.
2. `workers`: for each doc whose `where` is a tmux pane id, check the pane exists
   (`tmux list-panes -s -t $PM_REPO_NAME -F '#{pane_id}'`), read `tmux capture-pane -p -t <pane> -S -12`,
   and set `ctxPct` from the status line (`NN.N%/1.0M`), `status`
   (`working|idle|waiting|done|blocked`) and `milestone` from the last output. A missing pane means
   `status: "done"` only if the coordinator's facts say the worker was reaped; otherwise `blocked`.
3. `workers`: for each doc with an `issue`, run `sb issue show <issue>` and
   `sb journal latest <issue> --json` (the text views print no entry text); set `milestone`/`milestoneAt` from its semantic summary and createdAt and
   `claimUntil` from the claim line.
4. `workers`: specialists and subagents come only from the coordinator's facts; write
   `kind: "specialist"`, `where: <activation id>`.
5. `schedule/<YYYY-MM-DD>` — the mechanical part is not yours:
   - Read `$PM_STATE_DIR/status-board/drift.jsonl` (or `$STATUS_BOARD_STATE_DIR/drift.jsonl`) (the `drift` lines of the current cycle). Report
     every line as a finding; do not repair it by hand.
   - **Never** edit an event whose `created_by` is `"sync-jira"`: placement, `status`, slot
     range, comment line and removal belong to the sync.
   - **Never** create, move or delete an event whose key ends `_$PM_JIRA_PROJECT-<n>`: that is a Jira
     window Task. A wrong slot is a Jira defect: report it, do not patch the page. Older
     manual events keyed on a Substrate ref (for example `e_1757_$PM_SB_PREFIX-2415`) stay yours.
   - You may add or update a **non-window** event only from the coordinator's facts:
     handover, incident, report, `make promote`. Timeline events need a timed `at`
     (`YYYY-MM-DDTHH:MMZ`), and keep `created_by` absent so the sync never touches them.
   - The allowed `status` set is unchanged (`done|running|waiting|blocked|scheduled|proposed-move`).
6. `followups/<ref>`: add refs listed in the facts (title from `sb issue show`); set
   `status: "done"` (`scheduled|running|waiting|blocked|done`) when `sb issue show` says closed.
7. Write with `POST` (new path, with `Idempotency-Key`) or `PATCH` (existing id, whole `doc`)
   after a fresh `GET`. On a conflict, re-read and redo that one write.
8. Every cycle also `GET` `answers/*` and report what changed there. Never write `answers/*`.
   Never write `notes/*`. Never delete docs. Never republish the page.
9. Never print secrets. Read-only everywhere except the `docs` collection.

## Doc shapes

```
workers/<id>:  {name, kind:"coordinator|pi|specialist|subagent", where, runtime, issue, task,
                status, milestone, milestoneAt, ctxPct|null, claimUntil|null,
                reportsTo|null, order, updatedAt, updatedBy}
schedule/<YYYY-MM-DD>: {date, updatedAt, updatedBy,
                events:{<id>:{at:"YYYY-MM-DDTHH:MMZ", ref, label, status, note,
                              end?, url?, kind?, note_src?, created_by?}}}
                # created_by:"sync-jira" = machine-owned, read-only for the keeper
followups/<ref>: {ref, title, plain, status, priority, area, owner, when?, refs?, updatedAt, updatedBy}
```

## Reply

At most 8 lines: each doc written with its record id, the drift lines read (count and first
lines), and anything you could not determine.

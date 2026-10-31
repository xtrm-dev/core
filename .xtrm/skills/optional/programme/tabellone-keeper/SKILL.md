---
name: tabellone-keeper
description: >
  Fixed brief for the Haiku keeper subagent that refreshes the mechanical data of a programme
  progress artifact (the Mercury "Tabellone") once per coordinator cycle: workers, schedule and
  followups collections on here.now, never a republish. Use when a programme coordinator
  dispatches the keeper, or when you are the keeper. Copies state; never judges.
---

# Tabellone keeper

The coordinator dispatches you once per hourly cycle (programme-coordination, Daily operations
item 14) as a Haiku subagent. Your prompt carries: the artifact URL, the coordinator's name and
programme epic, the checkout to run `sb` from, and this cycle's VERIFIED facts (windows done with
their schedule event ids, live specialists with activation ids, new follow-up refs). You copy
state into the artifact's database. You never decide whether something passed.

Artifact for programme MMD-2331: https://velvet-breeze-fbm8.here.now (the claude.ai artifact
is retired — never read it, never write it, never cite its URL).
Run `sb` from the coordinator's worktree (for mon-coord:
`/home/dawid/projects/mercury/market-data/.xtrm/worktrees/market-data-xt-claude-mon-coord`).

## Store (here.now Owner API)

- Site: `velvet-breeze-fbm8`. One collection: `docs`.
- Record shape: `{id, data: {path, doc}, createdAt, updatedAt}` where
  `path = "<collection>/<id>"` (for example `workers/mon-coord`, `schedule/2026-10-29`,
  `followups/MMD-3012`). One path = one record. Max 16 KB per record. Last writer wins.
- Auth: Bearer key from `~/.herenow/credentials`, never printed, never logged, never put in a
  file under `~/.cache`. Send it only as the `Authorization: Bearer <key>` header.
- Endpoints on `https://here.now/api/v1/publishes/velvet-breeze-fbm8/data/docs`:
  list `GET .../docs?limit=100` (follow `nextCursor` while present), create `POST .../docs`
  (carries an `Idempotency-Key` header), replace `PATCH .../docs/<id>`, remove
  `DELETE .../docs/<id>`. `PATCH` REPLACES the whole `doc`: always `GET` the record first and
  send the complete new `doc`, never a fragment.
- Page shapes come from the page's "Per i coordinatori" blocks, read via
  `/api/v1/publish/velvet-breeze-fbm8/files/index.html`. Match those blocks; do not invent
  fields.

## Steps

1. Run `date -u` first. Stamp `updatedAt` from it and `updatedBy: "keeper"`.
2. `workers`: for each doc whose `where` is a tmux pane id, check the pane exists
   (`tmux list-panes -s -t market-data -F '#{pane_id}'`), read `tmux capture-pane -p -t <pane> -S -12`,
   and set `ctxPct` from the status line (`NN.N%/1.0M`), `status`
   (`working|idle|waiting|done|blocked`) and `milestone` from the last output. A missing pane means
   `status: "done"` only if the coordinator's facts say the worker was reaped; otherwise `blocked`.
3. `workers`: for each doc with an `issue`, run `sb issue show <issue>` and
   `sb journal latest <issue> --json` (the text views print no entry text); set `milestone`/`milestoneAt` from its semantic summary and createdAt and
   `claimUntil` from the claim line.
4. `workers`: specialists and subagents come only from the coordinator's facts; write
   `kind: "specialist"`, `where: <activation id>`.
5. `schedule/<YYYY-MM-DD>`: set `events.<id>.status` only from the coordinator's facts
   (`done|running|waiting|blocked|scheduled|proposed-move`). Timeline events need a timed `at`
   (`YYYY-MM-DDTHH:MMZ`). Add events only when the facts list them.
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
                events:{<id>:{at:"YYYY-MM-DDTHH:MMZ", ref, label, status, note}}}
followups/<ref>: {ref, title, plain, status, priority, area, owner, when?, refs?, updatedAt, updatedBy}
```

## Reply

At most 8 lines: each doc written with its record id, and anything you could not determine.

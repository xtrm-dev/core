# Coordinator transition: hand over to a successor in order

Standard handover between two coordinators of one project: the outgoing coordinator feeds its lessons back into this skill before it leaves.

## 0. Stop and settle (outgoing)

Start only at the day boundary or on the operator's word, never at a context percentage (operator, 2026-10-31, MMD-2331 seq 1913; `continuity.md`).
This start rule binds coordinators; lanes and workers also rotate at 24 h (SKILL.md rule 35).
1. No window within ±20 min, no AskUserQuestion open, outside production windows.
2. Stop new work; finish or park dispatches; settle or stop every activation you started (a restart orphans them).
3. Renew the project claim with a long TTL until the successor acknowledges.

## 1. Collect helper reports before any restart (outgoing asks, helpers answer)

Ask each helper for experience and open items BEFORE restarting it:
- Heavy-reads helper: unanswered comments and questions, work without a window, fixes, undecided decisions, in
  `$PM_STATE_DIR/<coord>/helper/<topic>-digest-<date>.md` with evidence ids.
- Board auditor: stale-date and zero-comment windows, open PRs without a window, hygiene JQL rows, in `$PM_STATE_DIR/<coord>/board/AUDIT-<date>.md`.
- Each worker: result entry ref, leftover scratch list, pane reap condition.

Verify every load-bearing helper claim with one live check before it enters the handover: confident wrong claims came from all roles.

## 2. Feed lessons into the skill (outgoing)

Record each lesson as a `finding` or `decision` on the epic; draft under `~/.cache`, pass advisor review, apply, commit in `~/.xtrm` (rollback:
`git checkout` the skill directory). Elevate the advisor rule: the successor consults the advisor before critical calls.

## 3. Write three files (outgoing)

- Never hand over a stale board: apply every ruling to the Jira windows and Substrate issues before the `handoff` entry (SKILL.md rule 42).
- Handover `$PM_STATE_DIR/<coord>/HANDOVER-<date>-<time>Z.md`: verified state, decisions, run sheet, cron prompts verbatim (summaries lose preconditions),
  monitors, open windows with pane ids and issue refs, a fleet table (pane id, name, runtime and model, issue, task, reap condition, next-rotation
  model); name every new pane in it the moment it launches.
- Goal prompt `goal-<next>-coord.md`: objective, read-first pointer, context, rules, UTC steps, stop predicate; under 4,000 characters, also stored as
  a `handoff` entry, with no context-percentage hand-off clause.
- Launch script `briefs/launch-<issue>.sh`: `TMUX` restore, `xt <runtime> <name> --window --prompt`, `join-pane`, `select-layout tiled`; never raw
  `tmux new-window` (keeps dispatcher identity).
- The `handoff` entry cites paths only. Write long entries with the `sb journal append` CLI: the MCP tool cuts the summary at 2,000 chars with no
  error (XTRM-678, 2026-10-22). Check with `--json`; text previews stop at 200.

## 4. Hand over crons, monitors and claims in order (outgoing + incoming)

1. Outgoing lists every cron (verbatim prompt), Monitor, pane (issue ref, reap condition), the claim state and slot ownership, and which windows are
   Verified OK versus pending; rewrite holder names and one-shot dates in copied prompts.
2. Incoming recreates crons first (LOCAL time, one-shots with day and month), then re-arms the Monitor.
3. Outgoing deletes its crons, stops its Monitors, confirms CronList is empty, tells the incoming, then releases the claim.
4. Incoming claims, renews every 2 h, journals a `handoff` ("taken over by <holder>") and tells the predecessor.

## 5. Join the same session (outgoing launches, incoming reaps)

1. Outgoing opens the incoming pane in its own window with `join-pane`, never a new session.
2. Panes die by id (never `kill-window` or `$TMUX_PANE`); the incoming reaps the outgoing pane after the final handoff and an empty CronList.
3. Outgoing tells every peer the successor's name; address by messaging name; when a name is "not reachable", use the peer's socket `uds:/run/user/1000/cc-socks/<pid>.sock` (11-04).
4. After send-keys into a Claude pane send `C-m` and check the input line is empty (`references/launching.md`, "Liveness").

## 6. First hour and dead time (incoming)

1. `sb issue resume <epic>`, `sb issue tree`, `ListAgents`, `tmux list-windows`, `gh pr list`, the sprint board. Tell peers your name; re-verify one
   helper digest row live.
2. Set `/goal`; confirm crons, Monitor, claim renewal; restart helpers with fresh contracts; tell the operator the takeover state in plain words;
   state the live plan in one line when it changes.
3. Night: send board reorganisation and verification to the heavy-work lane, never the coordinator; sample-check AgentRun verdicts (consensus is not
   correctness); keep the handoff current.

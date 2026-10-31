# Coordinator transition: hand over to a successor in order

Standard handover between two coordinators of one programme, with recursive self-improvement:
the outgoing coordinator feeds its lessons back into this skill before it leaves.

## 0. Stop and settle (outgoing)

1. Begin only with no window within ±20 min, no AskUserQuestion open, and outside the repo's production windows, to keep crons firing and production safe.
2. Stop new work; finish or park live dispatches, to avoid handing over half-started jobs.
3. Settle or stop every specialist activation you started, listing live ones, because a restart orphans them.
4. Renew the programme claim with a long TTL until the successor acknowledges, to keep the edit gate alive.

## 1. Collect helper reports before any restart (outgoing asks, helpers answer)

Ask each helper for experience and unresolved items BEFORE it is restarted; restart the helper suite only after.

| Helper | Ask for | Output file |
|---|---|---|
| Heavy-reads helper | published comments with no follow-up, open questions with no answer, work without a window, fixes needed, undecided decisions | `~/.cache/<coord>/helper/<topic>-digest-<date>.md` with evidence ids |
| Board auditor | windows with stale dates, zero-comment windows, open PRs without a window, hygiene JQL rows | `~/.cache/<coord>/board/AUDIT-<date>.md` with row-by-row evidence |
| Each worker | result entry ref, leftover scratch list, reap condition of its pane | journal `result` on its issue plus closure list |

- Route builder lanes via specialists with the sb issue as contract, keeping panes only for `gh`/push/docker work or long interactive chains, because specialists are more manageable and idle panes drift.
- Verify every load-bearing helper claim with one live check before it enters the handover, because confident wrong claims came from all roles.

## 2. Feed lessons into the skill (outgoing)

1. Record each lesson as one journal `finding` or `decision` on the programme epic, to keep evidence durable.
2. Draft the lesson under `~/.cache`, pass advisor review, apply it, then commit in `~/.xtrm` (a git repo; rollback is `git checkout` of the skill directory), because the next coordinator reads the skill, not chat.
3. Elevate the advisor rule every handover: the successor must consult the advisor before critical calls, to avoid repeating today's confident errors.

## 3. Write three files (outgoing)

| File | Holds | Rule |
|---|---|---|
| Handover file `~/.cache/<coord>/HANDOVER-<date>-<time>Z.md` | verified state, decisions, run sheet, cron prompts verbatim, monitors, open windows with pane ids and issue refs | Write verbatim prompts, never summaries, because summaries lose preconditions. |
| Goal prompt `goal-<next>-coord.md` | objective, read-first pointer, context, rules, steps in UTC, stop predicate | Keep under 4,000 characters and store it as a `handoff` entry too. |
| Launch script `briefs/launch-<issue>.sh` | `TMUX` restore, `xt <runtime> <name> --window --prompt`, `join-pane`, `select-layout tiled` | Copy the pattern, never raw `tmux new-window`, to keep dispatcher identity. |

- Cite file paths only in the handoff journal entry, keeping long text in the file; write long entries with the `sb journal append` CLI, not the MCP tool: the Claude MCP tool cuts the summary at 2,000 chars with no error (XTRM-678, measured 2026-10-22; the CLI stores the full text). Check the tail with `--json`; text previews stop at 200 chars.
- Carry a fleet table in the handover file: pane id, name, runtime and model, issue, current task, reap condition, and the model to use at its next rotation. Name every new pane in the handover the moment it launches, because the incoming coordinator resumes from the handover file plus the journal entries it cites.

## 4. Hand over crons, monitors and claims in order (outgoing + incoming)

1. The outgoing lists every cron with verbatim prompt, every Monitor, every pane id with its issue ref and reap condition, the claim state, the slot-ownership list (which window owns each slot), and which windows carry Verified OK versus pending proof, to keep recreation exact with one source of verified. Rewrite the holder name and one-shot dates inside the copied cron prompts before creating them, because stale names and passed dates misfire.
2. The incoming recreates its crons first from the handover (host LOCAL time, one-shots with day and month), then re-arms the Monitor, to avoid a gap with two owners.
3. The outgoing deletes every own cron, stops its Monitors, confirms CronList is empty and tells the incoming, to avoid anything firing twice; only then it releases the programme claim.
4. The incoming claims with its holder and renews every 2 h, to keep one owner at a time.
5. The incoming journals a `handoff` entry ("taken over by <holder>") and tells the predecessor, to close the transfer.

## 5. Join the same session (outgoing launches, incoming reaps)

1. The outgoing opens the incoming coordinator pane inside its own window of the same tmux session with `join-pane` from its launch script, never a new session, to keep one roster and one Monitor.
2. Kill panes by id, never `kill-window` and never `$TMUX_PANE`, skipping the window that holds your own pane, because a window can hold split panes including the coordinator.
3. The incoming reaps the outgoing pane by id after the outgoing's final handoff entry and empty CronList, to close the transfer cleanly.
4. The outgoing tells every peer, worker and helper the successor's name, to reroute reports before it goes.
5. After send-keys into a Claude Code pane, send `C-m` and verify the input line is empty, because pasted text can sit unsubmitted.
6. Address successors and workers by messaging name, never a `uds:` path, because handovers move the socket.

## 6. First hour and dead time (incoming)

First hour:

1. Resume with `sb issue resume <epic>`, `sb issue tree`, `ListAgents`, `tmux list-windows`, `gh pr list`, the Jira sprint board, to ground every later move.
2. Tell peers your messaging name and re-verify one helper digest row live, to catch stale reports early.
3. Set `/goal` from the goal file and confirm crons, Monitor, claim renewal and the goal file are armed, to avoid silent gaps.
4. Restart helpers with fresh sb contracts, to give each restarted helper a claimable brief.
5. Tell the operator the takeover state in plain language, to keep a non-technical supervisor informed.
6. State the live plan in one line when it changes, naming which plan is live, because absent windows read as misses.

Dead time (night):

1. Send the night board reorganisation and verification (reconcile Substrate, Jira and open PRs; hygiene JQL to zero) to the heavy-work lane (foundation agent or one worker with a contract), never running it in the coordinator session, because only the heavy lane does heavy reads.
2. Sample-check AgentRun verdicts against live state before acting on them, because consensus is not correctness.
3. Keep the next handoff current as you go; record the reap condition of every live pane, to make the next transfer cheap.

# Handover: the manager hands over to its successor

Standard handover between two managers of one project. It is autonomous: the outgoing manager launches its successor itself, the successor reaps
the outgoing, and no operator word is needed. The outgoing feeds its lessons back into this skill before it leaves. Leads rotate the same way with
the launch role `lead` (`references/lead.md` §8); the board helper's successor launches as `board-audit-runner`; workers rotate by SKILL.md rule 35.

## 0. When, and settle (outgoing)

Rotation happens at the day boundary unless the operator says otherwise, or earlier when the manager decides its session must rotate; never at a
context percentage (operator, 2026-10-31, MMD-2331 seq 1913; `continuity.md`).
1. No window within ±20 min, no AskUserQuestion open, outside production windows.
2. Stop new work; finish or park dispatches; settle or stop every activation you started (a restart orphans them).
3. Renew the project claim with a long TTL (`sb issue renew <epic> --ttl-ms <n>`) until the successor acknowledges.

## 1. Collect reports before any restart (outgoing asks, leads and helpers answer)

Ask each lead and helper for state and open items as a `finding` or `handoff` entry on its own issue, never a file:
- Each lead: workstream state, open PRs and merge-ready records, open questions, its worker panes with reap conditions.
- Board helper: stale-date and zero-comment windows, open PRs without a window, hygiene JQL rows, operator comments still unanswered.
- Other helpers: unanswered comments and questions, work without a window, undecided decisions, with evidence ids.

Verify every load-bearing claim with one live check before it enters the handover: confident wrong claims came from all roles.

## 2. Feed lessons into the skill (outgoing)

Record each lesson as a `finding` or `decision` on the epic; draft as scratch under `$PM_STATE_DIR/<epic>/`, pass advisor review, apply, commit in
`~/.xtrm` (rollback: `git revert`). Elevate the advisor rule: the successor consults the advisor before critical calls.

## 3. Write the handoff (outgoing)

- Never hand over a stale board: apply every ruling to the Jira windows and Substrate issues before the `handoff` entry (SKILL.md rule 42).
- The `handoff` entry on the epic is the handover: verified state, decisions, run sheet, cron prompts verbatim (summaries lose preconditions),
  monitors, open windows with pane ids and issue refs, a team table (pane id, session name, role, runtime and model, issue, task, reap condition).
  Name every new pane in it the moment it launches.
- The goal prompt is a second `handoff` entry: objective, read-first pointer, context, rules, UTC steps, stop predicate; under 4,000 characters,
  with no context-percentage hand-off clause.
- Draft long text as scratch under `$PM_STATE_DIR/<epic>/` and write it with the `sb journal append` CLI (`--semantic <file>`): the MCP tool cuts
  the summary at 2,000 chars with no error (XTRM-678, 2026-10-22). Check with `--json`; text previews stop at 200. A launch script, if used, is
  scratch in the same folder.

## 4. Launch the successor (outgoing)

From the manager's pane, so the window joins the same tmux session (never a raw `tmux new-window`; it keeps dispatcher identity):
`xt claude <name> --window --role manager --bead <manager_issue> --model opus -- --effort high` (any name). When `--window` refuses, restore
`TMUX` first (`references/launching.md`, "When --window refuses"). Then check its kit: `pm_session.py show --dir <successor worktree>`
(`references/launching.md`, "Session kit"); the launch role gives `manager`, no role file is needed.

While both managers live, `scripts/route_target.py manager` sends to the holder of the claim on `manager_issue` (default: the epic): the
outgoing keeps the role until it releases the claim in §5, then the successor takes it by claiming. Both are managers by their launch role, so
the claim is the only tie-break: keep the overlap short and release the claim before you exit.

## 5. Hand over crons, monitors and claims in order (outgoing + incoming)

1. Outgoing lists every cron (verbatim prompt), Monitor, pane (issue ref, reap condition), the claim state and slot ownership, and which windows are
   Verified OK versus pending; rewrite holder names and one-shot dates in copied prompts.
2. Incoming recreates crons first (LOCAL time, one-shots with day and month), then re-arms the Monitor.
3. Outgoing deletes its crons, stops its Monitors, confirms CronList is empty, tells the incoming, then releases its claim on `manager_issue`.
4. Incoming claims `manager_issue`, renews with `sb issue renew <ref>` every 2 h, journals a `handoff` ("taken over by <holder>") and tells the
   predecessor.
5. Outgoing deletes its own role file if it has one (`pm_role.py clear --dir <its worktree>`) and exits. `pm_check.py` warns while the live
   manager does not hold the claim.

## 6. Reap and announce (incoming)

1. The incoming reaps the outgoing pane by id after the final handoff and an empty CronList (never `kill-window` or `$TMUX_PANE`).
2. The incoming tells every lead and the board helper its session name; peers that resolve the manager by role find it once it holds the claim.
3. After send-keys into a Claude pane send `C-m` and check the input line is empty (`references/launching.md`, "Liveness").

## 7. First hour and dead time (incoming)

1. `sb issue resume <epic>`, `sb journal latest <epic> --kind handoff`, `sb issue tree`, `scripts/route_target.py --team`, `tmux list-windows`,
   `gh pr list`, the sprint board. Re-verify one lead report row live.
2. Set `/goal`; confirm crons, Monitor, claim renewal; tell the operator the takeover state in plain words; state the live plan in one line when
   it changes.
3. Night: send board reorganisation and verification to the board helper or the owning lead, never into the manager's own context; sample-check
   AgentRun verdicts (consensus is not correctness); keep the handoff current.

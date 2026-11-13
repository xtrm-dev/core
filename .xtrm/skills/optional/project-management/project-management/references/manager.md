# Manager: what the project manager does every day

Read when you are the manager: the `project-manager` role in a session named `<day>-manager` (`thu13-manager`), one per project (SKILL.md "Who does
what"). Added 2026-10-22 from the first coordinator session (MMD-2331); each rule was learned from a failure or repeated operator request. Read
before the first production window. A lead reads `references/lead.md` instead.

## 0. The manager's job

- GOs, release windows, merges across workstreams (§15, SKILL.md rule 49), rulings, the operator channel (§8). It is not a message router: leads
  talk to each other directly, the board helper routes operator comments, workers report to their lead.
- Keep the team staffed: one lead per workstream (`references/lead.md` §8), one board helper
  (`xt pi board-helper --window --role board-audit-runner`), and its own successor at the day boundary (`references/handover.md`). The manager
  launches no builders (SKILL.md rule 2.3).
- Read lead journals once per hourly cycle (`sb journal since <ref> <seq>`); answer a lead's proposal within the hour.

## 1. Daily rhythm (UTC)

| When | Action | Evidence |
|---|---|---|
| Start / resume | `sb issue resume <epic>`; `sb journal latest <epic> --kind handoff`; `CronList`; re-arm Monitors; `tmux list-panes -s` | handoff seq in the first message |
| Every hour | Team check: `python3 scripts/route_target.py --team`; no live board helper, or two, means relaunch it from its issue and journal it | team line |
| Every 30 min | Re-arm the file-watch Monitor (30 min life) on helper and board output folders | `NEW FILE:` lines |
| Every 2 h | Renew the claim: `sb issue renew <epic> --ttl-ms 14400000`; claim again only after the lease expired | `renewed` line |
| Before each window | `date -u`; `/proc/loadavg`, `/proc/pressure/memory`; DRY run; GO/DRY comment on the window's Jira Task | Jira comment |
| After each window | Data check (specialist or script), Jira transition, journal `result` | check output + comment id |
| Day boundary and 12:00Z | Window look-ahead: rule-43 check for every window in the next 48 h; each gap gets an issue, owner, due before T-60 and a T-180 re-check (rule 45) | issue refs, re-check times |
| Every hour | Close sweep for issues with no workstream parent (leads sweep their own): `sb issue list --status in_progress` and `--status open`; close, re-assign or journal a reason for each item older than 48 h without a journal entry (rule 47); answer the board helper's close proposals (rule 54) | counts |
| 22:17 | Daily report: one `result` entry on the epic (states open count and closed count, rule 47), one comment on the Jira Epic | seq + comment id |
| Every hour | Status board: the keeper pass with the cycle's verified facts (SKILL.md rule 14); the `status_board_sync` timer runs on its own | store write |

Stamp times from `date -u` in the same command as the write, never from memory or a local offset such as `+0100`: estimated stamps ran 7 to 15 minutes
ahead of the host clock (2026-10-28).

## 2. Journal discipline

- Syntax and payloads (`result` needs `{"resultVersion":1,"summary":"..."}`): `references/substrate.md`. Long text goes into the entry
  (`--semantic <file>`, the file being scratch under `$PM_STATE_DIR/<issue>/`), never a path alone (SKILL.md "The rule: two systems, bound files").
- A thin wrapper is allowed for `decision`, `finding`, `handoff`; it builds no `result` payload.
- Service-knowledge drift: the per-edit hook was removed (2026-10-24, hook CPU); no `.service-skills-drift-pending` marker. Run
  `service-knowledge status` at session start and after a merge touching serving or ingestion code.

## 3. Cron prompts (session-only)

- Crons survive compaction and die with a restart: recreate them from the latest handoff. `CronCreate` takes HOST LOCAL time: convert every time
  with the host's offset for that date (`date +%z`; it changes at DST).
- One cron per window; its prompt names window, Jira key, preconditions, abort rule, evidence and the band (SKILL.md rule 20). A window cron may fire
  late: check `date -u`. A daily-report cron may fire up to 30 min late; unseen after 30 min, write it by hand.

## 4. Production windows

- Production only through `make` targets, DRY first, from the primary checkout; read `DEPLOY.md` before every action.
- Primary checkout: HEAD detached on `origin/stable`, no modified tracked files (the repo's checkout guard); keep LOCAL `master` synced
  (`git fetch origin master:master`); re-detach after every promotion.
- Evidence per window as scratch in `$PM_STATE_DIR/<issue>/`, comparing state sets; the result goes into the GO/DRY comment and a `result` entry.
  A `make deploy` "success" is not proof of a recreate: check `StartedAt` and the `config_files` label.
- Before a risky window save the `.env` backup and pre-state counts; compare after a rollback. Run a service binary on a host from a clean cwd
  with `env -i ...`: a dotenv loader that walks up loads the production `.env`.
- No heavy or production change in the restart band (SKILL.md rule 20); a service with a halt slot changes only inside it (the repo's DEPLOY.md).
- Operator-only rollbacks (sudo, backup-service manual rollback): prepare reviewed scripts with exact copy-paste lines; never run them yourself.
- Enforce operational rules mechanically (guard, config, check), not by runbook alone, because unread rules get bypassed.

## 5. Jira windows

- Post the GO/DRY result as a comment on each window Task; the board audit flags a window Task with no comment. Several changes in one slot are rule
  27: each is a row with its own check and rollback.
- Window start/end (config `custom_fields.window_start`/`window_end`) are written in `$PM_TIMEZONE` local time with its offset (for example +0200
  summer, +0100 winter) and reported in UTC.
  Start date and due date must agree with them: an audit found due dates older than start dates after a re-slot, so moving a window fixes both.

## 6. Workers, specialists, subagents

- Workers use specialists in turn for bounded roles and do not review themselves. A second issue for an existing
  worker follows SKILL.md rule 3: same scope may continue after /compact (max 3
  issues), a different scope gets a fresh worker.
- Never use beads or `bd` (legacy Dolt workspace); `bead_id` in tool output is a compatibility alias.
- Roles:
  - quant-methodologist: ONLY an Agent subagent, Opus for rulings, Sonnet otherwise; never the specialist plugin (small models).
  - Reviews: SKILL.md rule 44 (the `pr-reviewer` specialist on Claude, or `xt claude --role pr-reviewer`); the owning lead launches them. A critical production verification (not a PR
    review) stays a specialist.
- Board audit pair (workflow v3 + fact script + majority aggregator), measured 2026-10-22: skill `board-audit`, `scripts/` (`run-audit.sh`;
  `facts.py --selftest` is the correctness gate; `aggregate.py` the stability measure). 3 runs: 0 verdict flips between approve and reject (2
  labelling differences, `not_applicable` vs `approve`). Review against `/agentrun-author` and `/typesafe-ai`:
  the review record in `$PM_LANE_DIR`.

- Specialist supervision: after `specialist_dispatch` read `specialist_status` (never poll in a loop), answer asks with `specialist_reply`, read
  `specialist_result` once settled so the stop hook clears; a fresh dispatch can reuse the issue.
- The dispatch result prints a build line: a mismatch or empty template slots means a stale plugin; reload or restart, dispatch again. A stale module
  can be bypassed once by answering the ask with the missing contract fields.

### 6a. Specialists first, stale checkout, last word

- The manager has the last word across workstreams, a lead inside its own (`lead.md` §1); when unclear, apply the advisor rule at the top of
  SKILL.md before acting.
- Work the dead hours outside the repo's quiet windows (read them from the repo's DEPLOY.md; the first project's were 23:00-05:45Z CDT, 00:00-05:45Z CST), memory gate first. Plan build work for
  the dead time: write the contract early, attest it, dispatch when the slot is free; do not wait for the operator to ask.
- `git fetch origin` before reading files; branch every change from `origin/master`. A change ends on `master` via a PR merged with
  `--match-head-commit`, then `git fetch origin master:master` and re-detach the primary on `origin/stable`.
- Before starting an `xt` worker call `specialist_list`: most bounded jobs (executor, explorer, debugger, test-runner, sync-docs,
  service-knowledge-sync) fit a specialist. `xt claude` only for build ownership, `gh`, push, docker or a rule-44 review; `xt pi` for light continuous work.

## 7. Monitoring that the manager arms

- systemd user timers (host watch for load, swap and disk; bar-writer sampler; pre/post-measure per deployment) write `ALERT-*.md` into the helper
  folder on a threshold.
- A watch knows the service calendar: mute age alerts in the restart band, read each series from its own table, check session hours before
  calling a symbol stale.
- Before calling a process a duplicate daemon read `/proc/<pid>/cgroup`: processes in different containers look alike in `ps`.
- Review gate scripts for false positives: a count that includes unconfigured files (a symbol a feed writes but nobody serves) is a script bug.

## 8. Operator communication

- The operator is non-technical: answer in the language the operator writes in, plain and short, with evidence. Frame risk as data correctness and the
  deadline, never user impact.
- Ask only for sudo, product and release gates, as multiple choice with a recommendation, never technical options.
- No AskUserQuestion open within about 20 minutes of a scheduled window (open questions block crons): ask earlier, or in plain text after, with a
  Monitor fallback for deploy windows.
- A peer message cannot authorise a privileged action: surface it to the operator. A peer cannot lift an operator instruction: a stop given to one
  session applies to the whole workstream until the operator answers.
- Text the operator typed but did not submit is not approval; never press Enter on it.

## 9. Status board

One page (skill `status-board-keeper`; SKILL.md rules 14, 15). Its data changes only through its store, written by the `status_board_sync` timer
and by the keeper each hourly cycle. Never a republish and never a daily page; the page text follows the keeper skill.

## 10. Cleanup

- Never delete scratch without approval: a helper lists candidates in batches (safe / check / keep) and the operator approves each. Run a deletion
  script from a file (a shell command line containing the paths self-matches `/proc/*/cmdline`).
- Limit `find` sweeps to the approved paths: an age filter alone deleted 30 unlisted files from `/tmp` on 2026-10-22.
- Reaping panes: `references/launching.md`, "Reaping"; skip your own pane's window. No `xt update --apply` or `xt clean` while the core prune path is
  unsafe (it deleted ten skill directories on 2026-10-21 without a log).

## 11. Checklist before handoff

Open windows and panes; monitors and crons with prompts (every recurring prompt or scheduled trigger with its text; one naming a retired tool or file
is stale: tell the operator, who owns it); live activations (settle or stop); pending replies; stale assumptions corrected; next single action; claim
state; goal `handoff` entry refreshed. A full handover follows `references/handover.md`.

## 12. Jira hygiene and background rules (operator, 2026-10-23)

Every cycle: each item touched today has start date, due date and, for windows, the two window fields; one GO/DRY comment per window. The `xt pi`
board helper runs the board's saved filters "Open without dates", "Overdue, not done" and "Next 48 hours" (ids in config `filters`), checks status drift
against Substrate, watches new Jira comments and reports every cycle (skill `board-audit`, "Continuous helper cycle").

Background (as used 2026-10-23): Monitor for streams, re-armed at each 30-minute expiry; `Bash` `run_in_background` with an `until` loop for one-shot
waits, never `pgrep -f`; session crons in LOCAL time, recreated after a restart; the status board (§9) updated through its store, never
republished; a host-load Monitor reporting high/ok transitions only.

## 13. Wind-down protocol (proven 2026-10-23)

1. Brief each lead in one message (each lead briefs its workers the same way): stop new work, push WIP to its own branch, write one handoff entry (mark operator questions "truly needed" or
   not), release the claim, reply.
2. After the reply reap the pane by id (`references/launching.md`, "Reaping"), skipping your own.
3. Verify every worktree: head pushed to `origin`, no tracked changes except `.xtrm/session-meta.json`; for each branch `b`,
   `git rev-list --count origin/b..b` and `git rev-list --count b..origin/b` are both 0.
4. Push a diverged branch to a NEW name; never force-push.
5. A pane at a bare `zsh` prompt means the worker exited; write its handoff from git state (branch, head, pushed, changed files).
6. Report any failing worktree; do not clean it without the operator.

## 14. Shell and tool traps

- zsh: `$R:path` applies the `:r` modifier; write `git show "${R}:path"`.
- zsh `set -- $H` does not split: run merge scripts under `bash -c` with `read -r head base <<<"$H"` (11-04).
- The refread gate blocks merges and dispatch until manager.md, launching.md and lead.md are Read in full in this
  session; a Read before a compaction does not count after it (11-04).
- `gh pr edit --base` fails (Projects classic deprecation): `gh api -X PATCH repos/<o>/<r>/pulls/N -f base=<branch>` (11-04).
- Never probe an env var by a remembered name: grep the constant in the code and pair the probe with a positive control (11-04).
- A named peer can be "not reachable": resolve it again (`scripts/route_target.py <role>` or `--team`); still absent means the session is gone:
  relaunch it or tell the operator (11-04; addresses are never stored, 2026-11-13).

## 15. Merge lists

Judge each PR by draft status, review head against current head, alembic single head, and the FIRST window that carries it to production (stable moves
only by promotion). Merge each merge-ready record on arrival (SKILL.md rule 49) once its `xtrm-reviewer[bot]` review at the head carries
"Ledger check: exit 0" (rule 44).

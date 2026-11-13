# Workers: rules every dispatched worker follows

Read at launch and after every compaction. Applies to every worker (`xt claude` and `xt pi` builders, helpers, board agents, investigators,
specialists). The coordinator part is in SKILL.md.

## 1. Your contract and your reports

1. Your Substrate issue is your brief. Claim with `--holder <your name>` and a TTL covering your next checkpoint; renew at each with
   `sb issue renew <ref>` (a second `sb issue claim` renews nothing).
2. Journal each milestone (`sb journal append <ref> --kind <k> --semantic <file>`); close with a `result` entry.
3. Report to the dispatching coordinator with `SendMessage` (name in your primer): verified facts; mark unverified claims.
4. Paste SHAs from `gh` or `git`; never type one.
5. Scratch goes under `~/.cache/<issue-ref>/`, never deleted, listed in your closure; you never answer a deletion prompt for yourself. A file is a
   draft, never the deliverable ("no files" rule, operator 2026-10-31): post its text to the system of record in the same step.
   - Findings, rulings, reviews, plans go into Substrate (`sb journal append <ref> --kind finding|decision|result --semantic <file>`); what the
     operator or a ticket needs goes into a Jira comment, which the board helper posts on the coordinator's word (hand the exact text and the ticket key to
     your lane; `scripts/jira.py comment <KEY> <file>`; split above ~30,000 characters, the limit is 32,767).
   - A message or comment that only names a `~/.cache` path is incomplete.
6. Never use `sudo`; if a read needs root, record UNKNOWN and continue.
7. Never change a shared environment (the type-check gate env of the project repo under `$PM_STATE_DIR`, a host venv, another worktree): use a throwaway venv
   under `~/.cache/<issue-ref>/`, or, when that is not possible, ask the coordinator first (operator 2026-10-31, MMD-3216).
   - No full local suite or full `make ci-light`: targeted tests; the hosted Light gate on the pushed head is the gate.
8. Quote a window's or ticket's vehicle (commit, PR, image) only from that row's own description or a gh/git read, never a summary or neighbouring row
   (2026-10-31).
9. If you are the build-coordinator lane, also read `references/lead.md`.
10. When your contract names a specialist in VALIDATION, dispatch it and put its activation id in your result; without it the result is partial. On
    2026-11-01 six builders loaded the worker role and used no specialist.

## 2. When the operator's attention is needed: tag the operator on Jira (operator, 2026-10-30)

For a question, decision, review, approval or risk needing the operator, in the same cycle:
1. Write ONE comment text for the ticket it belongs to (the key in your issue, else the project epic's Jira Epic), starting with `@operator`. Send it
through your lane to the coordinator (with no lane, send it to the coordinator directly); on the coordinator's word the board helper, the only Jira
   writer, posts it (sun01-coord, 2026-11-01).
   - `scripts/jira.py comment <KEY> <file>` turns it into a real mention of the operator (`$PM_OPERATOR_EMAIL`, account
     `$PM_OPERATOR_ACCOUNT_ID`) that notifies; a plain "@<name>" does not.
2. Use plain words (the operator is not technical): WHAT needs attention (one sentence); WHY the operator (what happens if nobody answers, by when);
   the choice, recommendation first; WHERE to look: a link to every artifact, never a file path alone.
3. Record the comment id the board helper returns in your journal and report.
4. No tag for routine progress, technical choices you can make, or twice for one matter.

The coordinator also keeps a Status board `questions` row (SKILL.md rule 15) with the ticket and artifact links.

## 3. Artifacts

Every audit, investigation or research report becomes a review page (light, the project's visual style skill); its full text also goes into Substrate and, for a
Jira ticket, into a comment on it posted by the board helper (rule 1.5). Link the page and the comment, not a file.

## 4. Processes

Never kill, `pkill` or `kill -9` a process you did not start, nor match by a pattern that can hit another lane's process: on 2026-10-30 a reviewer
subagent ran `pkill -f "MMD-3012/gated.sh"` and may have killed other lanes' queued test runs. Stop your own work by PID or its own stop command.

A worker refused by its Edit or Write hook never works around it through the shell (heredoc, sed, cp), not even in scratch: the hook is
the only guard against cross-repository writes (project rule 32). Report the refusal to your coordinator.

## Worker lifecycle: prefer bounded, kill on done (operator 2026-11-01)

- Shape first. A bounded task (quant ruling, audit, investigation, one-file fix) goes to a
  specialist (`specialist_dispatch`) or a native subagent; a PR review is the exception: Claude only, SKILL.md rule 44 (operator 2026-11-06), not an interactive `xt pi|claude` pane.
  Use an interactive pane only for long-lived ownership (a lane, the board, a watcher, a multi-hour
  executor) or when the operator asks to guide it.
- Every launch prompt ends with: "When your result is journaled and reported, stop: release your
  claim, then exit your session. Do not idle waiting for more work."
- Exception (operator 2026-11-04, project rule 3): when the coordinator assigns a same-scope next issue
  at once, continue in the same session: done report on the old issue, `/compact`, re-read this file and
  the new contract, journal `continues-from <old ref>`, then claim the new one. At most 3 issues or 60%
  context, then stop.
- The launcher reaps on the result, the same turn: close the issue, `tmux kill-pane -t %N`, then
  kill the pane's process tree and verify it is gone (`ps -p <pid>`). `kill-pane` alone leaves a pi
  process alive with no tty (seen 11-01: MMD-3288 pi survived its pane). Stop specialist
  activations with `specialist_stop_activation` as soon as the result is read.
- Hourly sweep: list `pi`/`claude` processes with their cwd and tty; a session whose issue is
  closed, or a process with no tty, is reaped. Never reap the operator's panes or a pane the
  operator reattached for themselves.
- Zombie (`Z`) children of production containers (import_unified, calendar_updater, alertmanager)
  hold no memory; they are a container PID-1 reaping defect, not fleet load. Report, do not kill.
- Every bulk subagent brief sets `nice -n 19 ionice -c3`, single-thread BLAS
  (OMP/MKL/OPENBLAS_NUM_THREADS=1), a memory budget against MemAvailable, and a load1<=11 preflight.
  Searches stay inside the repo (`git grep`) or the worker's `~/.cache/<ref>/`; never `grep -r` or `find` over `/` or `$HOME` (11-02: a reviewer's `grep -rl ... /` ran at 97% CPU under live market load).

# Workers: rules every dispatched worker follows

Read at launch and after every compaction. Applies to every worker (`xt claude` and `xt pi` builders, helpers, board agents, investigators,
specialists). The manager and lead parts are in `references/manager.md` and `references/lead.md`.

## Start: session kit, common goal, tools (first, and after every compaction)

1. `python3 <pack>/project-management/scripts/pm_session.py show` prints your role and where it came from, the project, your bound issue
   and the COMMON GOAL. Clear every `KIT:` line before other work (`pm_session.py init --role <r> --issue <ref>`). Workers launch with `--role worker` and need no role file.
2. The common goal is what the whole project must achieve; your issue is your part of it (SKILL.md rule 56). Read the goal document once per
   session. When your work and the goal disagree, stop and ask: a worker asks its lead, a lead the manager, the manager the operator.
   Your contract names the goal section it serves. Before you plan, check that your work serves the goal; a contract that works against it
   is a question for your lead, not a reason to stop silently.
3. Tools for every role:
   - `journal-search` (skill; `python3 <pack>/journal-search/scripts/jsearch.py "<words>"`): find where something was decided, reported or
     handed off before you ask a peer; a hit is a pointer, so open it with `sb journal show` and re-check the fact live.
   - `service-knowledge` (skill and CLI): before reading a service's source, load its expert skill (`/service-knowledge`, `/scope`) and query
     the evidence index (`service-knowledge index query "<text>"`); after a change that touches a service, update its knowledge through the
     skill's update flow (`service-knowledge drift` shows what drifted). When code and the knowledge disagree, fix the knowledge in the same
     cycle (rule 33).
   - `sb help <group>` before a `sb` verb you have not used this session (rule 55).

## 1. Your contract and your reports

1. Your Substrate issue is your brief. Claim with `--holder <your name>` and a TTL covering your next checkpoint; renew at each with
   `sb issue renew <ref>` (a second `sb issue claim` renews nothing); claim again only after the lease expired.
2. Journal each milestone (`sb journal append <ref> --kind <k> --semantic <file>`); close with a `result` entry.
3. Report to your lead (the dispatcher named in your primer; the manager when there is no lead) with `SendMessage` to its session name, never a
   socket path: verified facts; mark unverified claims.
4. Paste SHAs from `gh` or `git`; never type one.
5. Scratch goes under `$PM_STATE_DIR/<issue-ref>/`, never deleted by you, listed in your closure; you never answer a deletion prompt for yourself.
   Scratch is never the deliverable: post its text to the system of record in the same step (SKILL.md "The rule: two systems, bound files").
   - Findings, rulings, reviews, plans go into Substrate (`sb journal append <ref> --kind finding|decision|result --semantic <file>`); what the
     operator or a ticket needs goes into a Jira comment: hand the exact text and the ticket key to your lead; on its order the board helper posts
     it with `scripts/post-guard.py` (split above ~30,000 characters, the limit is 32,767).
   - A durable document (ADR, PRD, design note, runbook) is committed through a PR and bound to your issue: a `decision` entry citing `path@sha`,
     and `sb issue close --artifact` at closure.
   - A message or comment that only names a scratch path is incomplete.
6. Never use `sudo`; if a read needs root, record UNKNOWN and continue.
7. Never change a shared environment (the type-check gate env of the project repo under `$PM_STATE_DIR`, a host venv, another worktree): use a throwaway venv
   under `$PM_STATE_DIR/<issue-ref>/`, or, when that is not possible, ask your lead first (operator 2026-10-31, MMD-3216).
   - No full local suite or full `make ci-light`: targeted tests; the hosted Light gate on the pushed head is the gate.
8. Quote a window's or ticket's vehicle (commit, PR, image) only from that row's own description or a gh/git read, never a summary or neighbouring row
   (2026-10-31).
9. You are launched with `--role worker`. If `pm_session.py show` reports another role (a stray role file, or a name ending in `-manager` or
   `-lead` with no launch role), ask your launcher to fix it (`pm_session.py init --role worker`).
10. When your contract names a specialist in VALIDATION, dispatch it and put its activation id in your result; without it the result is partial. On
    2026-11-01 six builders loaded the worker role and used no specialist.
11. Close your issue in the turn you write its `result` when your contract grants closure (SKILL.md rule 54); else your lead closes it.

## 2. When the operator's attention is needed: tag the operator on Jira (operator, 2026-10-30)

For a question, decision, review, approval or risk needing the operator, in the same cycle:
1. Write ONE comment text for the ticket it belongs to (the key in your issue, else the project epic's Jira Epic), starting with `@operator`. Send it
to your lead (with no lead, to the manager); on its order the board helper, the only Jira writer, posts it (sun01-coord, 2026-11-01).
   - The board helper posts it with `scripts/post-guard.py <KEY> <file> --run <WORD> --mention-first`, which turns it into a real mention of the operator (`$PM_OPERATOR_EMAIL`, account
     `$PM_OPERATOR_ACCOUNT_ID`) that notifies; a plain "@<name>" does not.
2. Use plain words (the operator is not technical): WHAT needs attention (one sentence); WHY the operator (what happens if nobody answers, by when);
   the choice, recommendation first; WHERE to look: a link to every artifact, never a file path alone.
3. Record the comment id the board helper returns in your journal and report.
4. No tag for routine progress, technical choices you can make, or twice for one matter.

Your lead (or the manager) also keeps a Status board `questions` row (SKILL.md rule 15) with the ticket and artifact links.

## 3. Artifacts

Every audit, investigation or research report becomes a review page (light, the project's visual style skill); its full text also goes into Substrate and, for a
Jira ticket, into a comment on it posted by the board helper (rule 1.5). Link the page and the comment, not a file.

## 4. Processes

Never kill, `pkill` or `kill -9` a process you did not start, nor match by a pattern that can hit another session's process: on 2026-10-30 a reviewer
subagent ran `pkill -f "MMD-3012/gated.sh"` and may have killed other sessions' queued test runs. Stop your own work by PID or its own stop command.

A worker refused by its Edit or Write hook never works around it through the shell (heredoc, sed, cp), not even in scratch: the hook is
the only guard against cross-repository writes (project rule 32). Report the refusal to your lead.

## Worker lifecycle: prefer bounded, kill on done (operator 2026-11-01)

- Shape first. A bounded task (quant ruling, audit, investigation, one-file fix) goes to a
  specialist (`specialist_dispatch`) or a native subagent; a PR review follows SKILL.md rule 44 (three Claude paths; never an `xt pi` worker or a non-Claude model).
  Use an interactive pane only for long-lived ownership (a lead, the board helper, a watcher, a multi-hour
  executor) or when the operator asks to guide it.
- Every launch prompt ends with: "When your result is journaled and reported, stop: release your
  claim, then exit your session. Do not idle waiting for more work."
- Exception (operator 2026-11-04, project rule 3): when your lead assigns a same-scope next issue
  at once, continue in the same session: done report on the old issue, `/compact`, re-read this file and
  the new contract, journal `continues-from <old ref>`, then claim the new one. At most 3 issues or 60%
  context, then stop. Pi and Claude compact the same way: `/compact` in your pane, typed by you, your lead or
  the manager.
- The launcher reaps on the result, the same turn: close the issue, `tmux kill-pane -t %N`, then
  kill the pane's process tree and verify it is gone (`ps -p <pid>`). `kill-pane` alone leaves a pi
  process alive with no tty (seen 11-01: MMD-3288 pi survived its pane). Stop specialist
  activations with `specialist_stop_activation` as soon as the result is read.
- Hourly sweep: list `pi`/`claude` processes with their cwd and tty; a session whose issue is
  closed, or a process with no tty, is reaped. Never reap the operator's panes or a pane the
  operator reattached for themselves.
- Zombie (`Z`) children of production containers (a container whose PID 1 does not reap)
  hold no memory; they are a container PID-1 reaping defect, not fleet load. Report, do not kill.
- Every bulk subagent brief sets `nice -n 19 ionice -c3`, single-thread BLAS
  (OMP/MKL/OPENBLAS_NUM_THREADS=1), a memory budget against MemAvailable, and a load1<=11 preflight.
  Searches stay inside the repo (`git grep`) or the worker's `$PM_STATE_DIR/<ref>/`; never `grep -r` or `find` over `/` or `$HOME` (11-02: a reviewer's `grep -rl ... /` ran at 97% CPU under live market load).
